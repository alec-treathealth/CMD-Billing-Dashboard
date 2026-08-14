/**
 * ONE-SHOT backfill: stamp collections.cmd_explorer_rows.employer_name (migration 0101) for rows
 * ingested BEFORE the owner added 'Primary Ins Emp Name' to the live explorer report layout
 * (2026-08-14). New rows carry it at ingest (cmdExplorer HEADERS → mapRow → INSERT); this fills the
 * history behind them.
 *
 * ⚠ THE SOURCE FILTER IS SINGLE-USE — RULED BY ALEC 2026-08-14. Report 10050915 / filter 10148786
 * ("Payments from Insurance with Entered Date Updated") exists to backfill employer ONCE per
 * customer. DO NOT wire it into a cron, a route, or any recurring job. Forward coverage comes from
 * the hourly explorer report, whose layout now carries the column (same report + filter ids as
 * before — the cron is unchanged).
 *
 * HOW THE JOIN WORKS, AND WHY IT IS THIS SHAPE. The backfill report is PAYMENT-grain and carries
 * `Patient Full Name`; cmd_explorer_rows carries the patient name ENCRYPTED (libsodium) plus, since
 * 0066, a keyed-HMAC `patient_name_bidx`. So the join key is the name TOKEN, computed in-process:
 *   HMAC(normalize('Patient Full Name'))  ⟷  cmd_explorer_rows.patient_name_bidx
 * The plaintext name from the CSV is used only to compute that token in memory — never written,
 * never logged. Employer is per-PATIENT (their primary insurance), so every row of a matched
 * patient WITHIN THE SAME TENANT is stamped with it.
 *
 * ⚠ PRECONDITION — patient_name_bidx COVERAGE. Measured ~0.07% (the 0066 backfill has never been
 * run), so WITHOUT `cmdNameBidxBackfill.ts --commit` first, this walks the whole table and matches
 * almost nothing. Run that first (it is the same precondition migration 0067 has always carried),
 * then run this. This CLI reports its match rate loudly precisely so a skipped precondition is
 * impossible to miss.
 *
 * SEMANTICS: employer is stamped AS OF this run. A patient who later changes jobs is not
 * retroactively restated — accepted by the owner (see 0101's column COMMENT).
 *
 * PHI: the CSV holds names (PHI) in volatile memory only. Nothing PHI is printed — output is
 * counts, and the per-customer CSV row count. The CMD credentials come from env and are never
 * logged. Employer names themselves are a plan-level dimension (like payer), stored plaintext.
 *
 * CONNECTION: the 0066 ladder verbatim (BLIND_INDEX_* envs win, else CLAIMS_READER_DATABASE_URL /
 * DATABASE_URL). ⚠ RUN AS THE OWNER (postgres) — 0101 mints NO app-role UPDATE grant, deliberately,
 * because no app path ever writes this column (same posture the 0066 runbook settled on).
 *
 * SAFETY: dry-run by default; --commit writes. Idempotent + resumable — it only ever fills rows
 * whose employer_name IS NULL, so a re-run after an interruption resumes, and a completed run is a
 * no-op. Per-customer: a failure on one customer does not roll back earlier ones.
 *
 *   tsx src/collections/cmdEmployerBackfill.ts                       # dry run, all BXR customers
 *   tsx src/collections/cmdEmployerBackfill.ts --commit               # write
 *   tsx src/collections/cmdEmployerBackfill.ts --customer 10027973    # one customer
 *
 * AFTER a completed run: refresh the rollup so the grid + picker see it —
 *   select collections.refresh_cmd_explorer_charge_rollup();   -- as cmd_rollup_writer
 * (or wait for the hourly :45 job, which refreshes both matviews).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sanitizeConnectionString, verifyFullSsl } from '../ssl.js';
import { patientNameBlindIndex } from './blindIndex.js';
import { cmdReportRows, type CmdApiConfig } from './cmdPayer.js';
import { BXR_CUSTOMERS } from './cmdCustomers.js';

/** The employer-bearing report + its SINGLE-USE filter (see the header). */
const EMPLOYER_REPORT_ID = '10050915';
const EMPLOYER_FILTER_ID = '10148786';
/** CSV header carrying the employer, and the one carrying the patient name we tokenize. */
const EMPLOYER_HEADER = 'Primary Ins Emp Name';
const PATIENT_NAME_HEADER = 'Patient Full Name';
/** Update batch size (matches the 0066 backfill). */
const BATCH = 500;

/** Minimal non-overriding .env loader (matches the seed + 0066 CLIs; exported values win). */
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    text = readFileSync(join(here, '..', '..', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Direct-connection host derived from SUPABASE_URL (https://<ref>.supabase.co → db.<ref>…). */
function supabaseDbHost(): string | undefined {
  const u = process.env.SUPABASE_URL?.trim();
  if (!u) return undefined;
  const host = u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `db.${host}` : undefined;
}

/** Build the backfill pool — the 0066 resolution ladder verbatim. */
function buildPool(): pg.Pool {
  const opts = { ssl: verifyFullSsl(), max: 4, application_name: 'employer-backfill' } as const;
  const rawPw = process.env.BLIND_INDEX_PGPASSWORD;
  if (rawPw) {
    const host =
      process.env.BLIND_INDEX_PGHOST?.trim() ||
      (process.env.BLIND_INDEX_DB_URL ? new URL(process.env.BLIND_INDEX_DB_URL).hostname : undefined) ||
      supabaseDbHost();
    if (!host) throw new Error('cannot resolve DB host (set BLIND_INDEX_PGHOST or SUPABASE_URL)');
    return new pg.Pool({
      host,
      port: Number(process.env.BLIND_INDEX_PGPORT ?? 5432),
      user: process.env.BLIND_INDEX_PGUSER?.trim() || 'postgres',
      password: rawPw,
      database: process.env.BLIND_INDEX_PGDATABASE?.trim() || 'postgres',
      ...opts,
    });
  }
  const url = (process.env.BLIND_INDEX_DB_URL ?? process.env.CLAIMS_READER_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
  if (!url) throw new Error('BLIND_INDEX_DB_URL or BLIND_INDEX_PGPASSWORD must be set (never log it)');
  return new pg.Pool({ connectionString: sanitizeConnectionString(url), ...opts });
}

/** CMD API config for one customer, pinned to the single-use employer report + filter. */
function cmdConfigFor(customerId: string): CmdApiConfig {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdApiConfig['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else throw new Error('CMD credentials not set (CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)');
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId,
    reportId: EMPLOYER_REPORT_ID,
    filterId: EMPLOYER_FILTER_ID,
    auth,
  };
}

/** Case-insensitive cell read (the report's header casing is not guaranteed stable). */
function cell(row: Record<string, string>, header: string): string | null {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header.toLowerCase()) {
      const t = (v ?? '').trim();
      return t === '' ? null : t;
    }
  }
  return null;
}

/**
 * Build token → employer for one customer's CSV. LAST non-null wins per token: the report is
 * payment-grain, so a patient appears many times; ordering within the export is not guaranteed
 * meaningful, and any of their rows carries the same primary-insurance employer.
 */
function employerByNameToken(rows: Record<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const name = cell(r, PATIENT_NAME_HEADER);
    const employer = cell(r, EMPLOYER_HEADER);
    if (name === null || employer === null) continue;
    const token = patientNameBlindIndex(name); // in-memory only; the plaintext never leaves this scope
    if (token !== null) out.set(token, employer);
  }
  return out;
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  if (!process.env.INDEX_HMAC_KEY) throw new Error('INDEX_HMAC_KEY must be set (to compute name tokens)');
  const only = (() => {
    const i = argv.indexOf('--customer');
    return i === -1 ? undefined : argv[i + 1];
  })();
  const customers = only ? BXR_CUSTOMERS.filter((c) => c.customerId === only) : BXR_CUSTOMERS;
  if (customers.length === 0) throw new Error(`no BXR customer matches --customer ${only ?? ''}`);

  const db = buildPool();
  try {
    const who = await db.query<{ current_user: string }>('select current_user');
    console.log(
      `connected as ${who.rows[0]?.current_user} — ${commit ? 'COMMIT' : 'DRY RUN'} — ` +
        `${customers.length} customer(s), report ${EMPLOYER_REPORT_ID} / filter ${EMPLOYER_FILTER_ID} (SINGLE-USE)`,
    );

    // Coverage precondition (see the header): a near-zero bidx population means the 0066 name
    // backfill has not been run and this backfill would match almost nothing.
    const cov = await db.query<{ total: string; with_bidx: string }>(
      `select count(*)::text as total,
              count(patient_name_bidx)::text as with_bidx
         from collections.cmd_explorer_rows`,
    );
    const total = Number(cov.rows[0]?.total ?? 0);
    const withBidx = Number(cov.rows[0]?.with_bidx ?? 0);
    const pct = total === 0 ? 0 : (withBidx / total) * 100;
    console.log(`patient_name_bidx coverage: ${withBidx}/${total} rows (${pct.toFixed(2)}%)`);
    if (pct < 50) {
      console.log(
        '⚠ COVERAGE IS LOW — run `tsx src/collections/cmdNameBidxBackfill.ts --commit` FIRST, or this\n' +
          '  backfill can only stamp the small slice that already has a name token.',
      );
      if (commit && !argv.includes('--force')) {
        throw new Error('refusing to --commit with <50% name-token coverage (pass --force to override)');
      }
    }

    let grandMatched = 0;
    let grandUpdated = 0;
    for (const c of customers) {
      let rows: Record<string, string>[];
      try {
        rows = (await cmdReportRows(cmdConfigFor(c.customerId))) as Record<string, string>[];
      } catch (e) {
        console.log(`  ${c.facilityCode} (${c.customerId}): FETCH FAILED — ${(e as Error).message}`);
        continue;
      }
      const map = employerByNameToken(rows);
      console.log(`  ${c.facilityCode} (${c.customerId}): ${rows.length} report rows → ${map.size} patients with an employer`);
      if (map.size === 0) continue;

      // Stamp in batches of tokens. Only NULL employer_name rows are touched (idempotent/resumable),
      // and only within this customer's tenant (business_entity_id from the roster).
      const entries = [...map.entries()];
      let matched = 0;
      let updated = 0;
      for (let i = 0; i < entries.length; i += BATCH) {
        const slice = entries.slice(i, i + BATCH);
        const params: unknown[] = [c.businessEntityId];
        const tuples = slice.map(([token, employer]) => {
          const b = params.length;
          params.push(token, employer);
          return `($${b + 1}::text, $${b + 2}::text)`;
        });
        if (commit) {
          const res = await db.query(
            `update collections.cmd_explorer_rows t
                set employer_name = v.employer
              from (values ${tuples.join(', ')}) as v(token, employer)
              where t.patient_name_bidx = v.token
                and t.business_entity_id = $1::uuid
                and t.employer_name is null`,
            params,
          );
          updated += res.rowCount ?? 0;
        } else {
          const res = await db.query<{ n: string }>(
            `select count(*)::text as n
               from collections.cmd_explorer_rows t
               join (values ${tuples.join(', ')}) as v(token, employer) on t.patient_name_bidx = v.token
              where t.business_entity_id = $1::uuid
                and t.employer_name is null`,
            params,
          );
          updated += Number(res.rows[0]?.n ?? 0);
        }
        matched += slice.length;
      }
      console.log(`    ${matched} tokens → ${updated} row(s) ${commit ? 'stamped' : 'would be stamped'}`);
      grandMatched += matched;
      grandUpdated += updated;
    }

    console.log(
      `\n${commit ? 'DONE' : 'DRY RUN COMPLETE'}: ${grandMatched} patient tokens, ` +
        `${grandUpdated} row(s) ${commit ? 'stamped' : 'to stamp'}.` +
        (commit
          ? '\nNow refresh the rollup so the grid + picker see it:\n' +
            '  select collections.refresh_cmd_explorer_charge_rollup();   -- as cmd_rollup_writer'
          : '\nRe-run with --commit to write.'),
    );
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
