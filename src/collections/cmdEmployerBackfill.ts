/**
 * CMD → collections.cmd_explorer_rows.employer_name BACKFILL (one-shot, local, migration 0101).
 *
 * TWO SOURCES, one matching implementation:
 *
 *   # --source=api (default report = CMD_EXPLORER_REPORT_ID) — pulls the saved filter's window
 *   # once per customer across the tenant roster. DRY RUN:
 *   node --max-old-space-size=4096 --env-file=.env --import tsx \
 *     src/collections/cmdEmployerBackfill.ts --tenant=bxr --source=api --filter=10148846
 *
 *   # --source=csv — one already-exported file:
 *   node --max-old-space-size=4096 --env-file=.env --import tsx \
 *     src/collections/cmdEmployerBackfill.ts --tenant=bxr --file="Derek Automation.csv"
 *
 *   # then, only if the match rate is what you expect, add --commit to either form.
 *
 * ⚠ THE API SOURCE HOLDS CMD'S PARTNER SLOT. CMD runs ONE report at a time per partner, so this
 * pull contends with the production crons. Do not run it inside the :41–:59 CMD quiet window or
 * near the hourly explorer/census slots (:00 :15 :30 :35), and never run two copies at once.
 *
 * ⚠ CMD SAVED FILTERS ARE REPORT-SCOPED. A filter saved under a different report returns INVALID
 * CRITERIA for every customer — the 2026-08-01 census incident, and again the 2026-08-17 catch-up
 * one. --report and --filter must be a pairing that exists in the CMD UI together.
 *
 * WHY THIS EXISTS: the hourly explorer cron is `INSERT ... ON CONFLICT (row_fingerprint) DO NOTHING`,
 * so it can only ever put an employer on rows it INSERTS. Every row already in the table — 650,696
 * of them as of 2026-08-15, 622,489 from CSV seeds — would stay null forever without a backfill.
 *
 * ── THE MATCHING KEY, AND WHY IT IS THE ONLY ONE ────────────────────────────────────────────────
 * Rows are matched on `row_fingerprint`, recomputed here from the CSV. That is not a preference:
 *   · charge_id is NULL on 100% of the 622,489 CSV-seeded rows (measured 2026-08-15) and is not
 *     unique even on the API rows (14,373 distinct across 16,831 populated), so it cannot join.
 *   · row_fingerprint is unique across all 650,696 rows — zero duplicates, measured — and is
 *     exactly what the ingest already dedups on.
 *
 * SO THE CSV MUST CARRY ALL 14 FINGERPRINT COLUMNS, not just an employer and an id. The fingerprint
 * hashes charge date, payment received, CPT, revenue code, patient name, member id, group number,
 * charge amount, allowed, insurance payments, adjustments, balance due, payer and facility. In
 * practice that means re-exporting the SAME report with the employer column added.
 *
 * ── WHY IT REUSES mapRow INSTEAD OF HASHING HERE ───────────────────────────────────────────────
 * The fingerprint is only useful if it is byte-identical to the one ingest wrote. Reimplementing
 * the hash would mean reimplementing every normalization it depends on — the money coercion, the
 * date parser that accepts both M/D/YYYY and ISO, normalizeMemberId, the em-dash CPT placeholder,
 * the per-field lowercasing — and any one of them drifting produces a SILENT miss, not an error.
 * So this feeds the CSV through the exact production chain: parseReportCsv → (Indigo alias) →
 * mapReportRows → mapRow. If that chain changes, this script changes with it for free.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────────────────────
 * · DRY-RUN BY DEFAULT. `--commit` is required to write, and the dry run reports the match rate,
 *   which is the number that decides whether committing is safe at all. A low rate means a
 *   normalization mismatch, NOT "those rows are missing" — stop and diagnose rather than commit a
 *   partial fill, because a silent partial is indistinguishable from a complete one afterwards.
 * · FILLS ONLY NULLS (`and employer_name is null`). Never overwrites a value the cron already
 *   wrote from the live report, which is fresher than any CSV. This also makes the script
 *   IDEMPOTENT — re-running it is a no-op, so an interrupted run is safe to resume.
 * · NEVER touches row_fingerprint, any money column, or the encrypted PHI columns. It cannot: the
 *   writer role's grant from 0101 is column-scoped to `update (employer_name)`.
 * · Tenant-scoped on every UPDATE. Fingerprints exclude business_entity_id by the 0028 ruling, so
 *   scoping is what guarantees a BXR file can never write an Indigo row.
 * · Non-PHI output only: counts, and employer names (ruled non-PHI 2026-08-14). Never a patient
 *   name, member id, or group number — those pass through mapRow and are dropped here.
 */
import { readFileSync } from 'node:fs';
import { cmdReportRows, parseReportCsv, type CmdApiConfig, type CmdReportRow } from './cmdPayer.js';
import { aliasIndigoFacilityColumn, mapReportRows } from './cmdExplorer.js';
import { mapRow } from './cmdExplorerSeed.js';
import { makeClient } from './db.js';
import { withTenant } from '../veris/withTenant.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';
import { BXR_CUSTOMERS, INDIGO_CUSTOMERS } from './cmdCustomers.js';
import { blindIndexesForRowSafe } from './blindIndex.js';

/** How many (fingerprint, employer) pairs go in one UPDATE round trip. */
const BATCH = 500;

export interface Args {
  commit: boolean;
  /** 'csv' reads one exported file; 'api' pulls the report per customer across the roster. */
  source: 'csv' | 'api';
  /** csv mode only. */
  file: string;
  /** api mode only — the saved filter whose window to backfill. REQUIRED, no default: a filter is
   *  the only thing that bounds the pull, and defaulting it would silently backfill some other
   *  window than the operator intended. */
  filterId: string;
  /** api mode only — defaults to CMD_EXPLORER_REPORT_ID. CMD saved filters are report-SCOPED, so a
   *  filter from a different report returns INVALID CRITERIA (the 2026-08-01 census incident). */
  reportId: string;
  tenant: 'bxr' | 'indigo';
  /**
   * Which key joins the report to the table.
   *   'charge'      (DEFAULT) — charge identity. Reaches historical rows; see ChargeKey.
   *   'fingerprint' — the locked 14-field row_fingerprint. Exact, but only matches rows that were
   *                   themselves written from the SAME report shape (17.5% of the BXR history as
   *                   measured 2026-08-17). Kept for the CSV path and for diagnosis.
   */
  key: 'charge' | 'fingerprint';
}

export function parseArgs(argv: string[]): Args {
  let commit = false;
  let source: 'csv' | 'api' = 'csv';
  let file = '';
  let filterId = '';
  let reportId = '';
  let tenant: 'bxr' | 'indigo' | '' = '';
  let key: 'charge' | 'fingerprint' = 'charge';
  for (const arg of argv.slice(2)) {
    if (arg === '--commit') commit = true;
    else if (arg.startsWith('--key=')) {
      const k = arg.slice('--key='.length).toLowerCase();
      if (k !== 'charge' && k !== 'fingerprint') throw new Error(`--key must be charge or fingerprint (got ${k})`);
      key = k;
    }
    else if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
    else if (arg.startsWith('--filter=')) filterId = arg.slice('--filter='.length).trim();
    else if (arg.startsWith('--report=')) reportId = arg.slice('--report='.length).trim();
    else if (arg.startsWith('--source=')) {
      const s = arg.slice('--source='.length).toLowerCase();
      if (s !== 'csv' && s !== 'api') throw new Error(`--source must be csv or api (got ${s})`);
      source = s;
    } else if (arg.startsWith('--tenant=')) {
      const t = arg.slice('--tenant='.length).toLowerCase();
      if (t !== 'bxr' && t !== 'indigo') throw new Error(`--tenant must be bxr or indigo (got ${t})`);
      tenant = t;
    }
  }
  if (tenant === '') throw new Error('--tenant=bxr|indigo is required');
  if (source === 'csv' && file === '') throw new Error('--file=<path to the CMD CSV export> is required for --source=csv');
  if (source === 'api') {
    if (filterId === '') throw new Error('--filter=<saved filter id> is required for --source=api (no default — it is what bounds the window)');
    reportId = reportId || (process.env.CMD_EXPLORER_REPORT_ID?.trim() ?? '');
    if (reportId === '') throw new Error('--report=<report id> is required for --source=api when CMD_EXPLORER_REPORT_ID is unset');
  }
  return { commit, source, file, filterId, reportId, tenant, key };
}

/**
 * One row's CHARGE IDENTITY — the grain collections.cmd_explorer_charge_rollup already groups by,
 * minus the tenant (which is passed separately).
 *
 * WHY THIS EXISTS: row_fingerprint cannot reach historical rows. Measured 2026-08-17 against the
 * full BXR history (filter 10148846, 153,989 rows): only 17.5% of fingerprints matched, and the
 * ones that did were essentially the rows the 07:52 catch-up had just written from the SAME report.
 * Field-by-field comparison of old-vs-new rows for the same charge showed revenue_code 100%,
 * patient_balance_due 99.7%, adjustments 99.5%, allowed 92.4%, insurance 92.0%, and member_id +
 * group_number agreeing via their blind indexes — leaving patient_name (field #5 of the locked 14)
 * as the only unexplained input. It could not be measured directly: the plaintext is libsodium-
 * encrypted and patient_name_bidx is NULL on 77% of the old rows (0067's name backfill was never
 * applied), so that is an inference, not a measurement.
 *
 * Charge identity sidesteps the question entirely — it contains NO name and NO posting-snapshot
 * money column. It is also the semantically correct grain: an employer is a property of the CLAIM,
 * not of an individual payment snapshot, so every snapshot of one charge shares one employer.
 */
export interface ChargeKey {
  memberIdBidx: string;
  chargeDate: string;
  cptCode: string;
  revenueKey: string; // COALESCE(revenue_code, '') — matches the rollup's revenue_key
  facility: string;
  chargeAmount: string;
}

export interface BackfillPlan {
  /** CSV data rows parsed. */
  parsed: number;
  /** Rows mapRow accepted (a skip means a required field was blank/unparseable). */
  mapped: number;
  /** Per-reason skip counts from mapRow — labels only, never cell values. */
  skips: Record<string, number>;
  /** Rows that carried a non-blank employer — the only ones worth writing. */
  withEmployer: number;
  /** (fingerprint → employer) for every mapped row carrying an employer. */
  pairs: Map<string, string>;
  /** (charge identity → employer), deduped. The --key=charge path's input. */
  chargeKeys: Map<string, { key: ChargeKey; employer: string }>;
  /** Charge identities the SOURCE disagreed with itself about (two employers, one charge). Counted
   *  rather than silently resolved — a nonzero value means the report is ambiguous, not that the
   *  matcher is broken. */
  chargeConflicts: number;
}

/** Stable string form of a charge identity, for in-process dedup. The unit separator cannot occur
 *  in any component (they are dates, codes, facility mnemonics and decimal strings). */
function chargeKeyString(k: ChargeKey): string {
  return [k.memberIdBidx, k.chargeDate, k.cptCode, k.revenueKey, k.facility, k.chargeAmount].join('');
}

/**
 * Parse + map a CSV into the fingerprint→employer pairs to write. PURE: no DB, no I/O beyond the
 * file read, so the whole plan (including the skip breakdown) is inspectable in a dry run.
 *
 * Indigo's export labels the facility column "Customer Name"; aliasIndigoFacilityColumn rewrites it
 * to "Facility Name" IN PLACE exactly as the Indigo cron does. Without it mapRow would reject every
 * row as `facility: missing` and the run would report a 0% match rate that looks like a
 * normalization bug rather than a missing alias.
 */
export function planEmployerBackfill(csvText: string, tenant: 'bxr' | 'indigo', sourceLabel: string): BackfillPlan {
  return planEmployerBackfillFromRows(parseReportCsv(csvText), tenant, sourceLabel);
}

/**
 * The same planner, from ALREADY-PARSED report rows — the API path's entry point.
 *
 * Split out so the CSV and API sources share ONE matching implementation. The fingerprint is only
 * useful if it is byte-identical to the one ingest wrote, so having two copies of this loop is the
 * single most dangerous kind of drift here: it would fail SILENTLY as a low match rate, which the
 * dry-run text explicitly tells the operator to read as a normalization bug.
 */
export function planEmployerBackfillFromRows(
  raw: readonly CmdReportRow[],
  tenant: 'bxr' | 'indigo',
  sourceLabel: string,
): BackfillPlan {
  const rows = tenant === 'indigo' ? aliasIndigoFacilityColumn(raw as CmdReportRow[]) : raw;
  const full = mapReportRows(rows as CmdReportRow[]);

  const skips: Record<string, number> = {};
  const pairs = new Map<string, string>();
  const chargeKeys = new Map<string, { key: ChargeKey; employer: string }>();
  let mapped = 0;
  let withEmployer = 0;
  let chargeConflicts = 0;

  for (const f of full) {
    const res = mapRow(f, sourceLabel);
    if (!res.ok) {
      skips[res.label] = (skips[res.label] ?? 0) + 1;
      continue;
    }
    mapped += 1;
    const emp = res.row.employer_name ?? null;
    if (emp === null || emp === '') continue;
    withEmployer += 1;
    // LAST WRITE WINS on a duplicate fingerprint. A fingerprint is unique in the TABLE, but one CSV
    // can legitimately contain the same logical row twice (overlapping exports), and identical
    // content hashes identically — so this collapses duplicates rather than issuing two UPDATEs
    // for the same row. Differing employers on one fingerprint would mean the source disagrees with
    // itself; that is surfaced as a count below rather than silently resolved.
    pairs.set(res.row.row_fingerprint, emp);

    // Charge identity. member_id_bidx is derived here the same way the ingest derives it
    // (blindIndexesForRowSafe over the SAME normalized member id mapRow produced), so the token
    // is byte-identical to the one stored — the whole reason this reuses the production chain.
    const bidx = blindIndexesForRowSafe(res.row.member_id, res.row.group_number);
    const mb = bidx.member_id_bidx;
    if (mb !== null && mb !== '') {
      const key: ChargeKey = {
        memberIdBidx: mb,
        chargeDate: res.row.charge_date,
        cptCode: res.row.cpt_code,
        revenueKey: res.row.revenue_code ?? '',
        facility: res.row.facility,
        chargeAmount: res.row.charge_amount,
      };
      const ks = chargeKeyString(key);
      const prior = chargeKeys.get(ks);
      // Every posting snapshot of one charge carries the same employer, so a repeat is expected and
      // collapses. A DIFFERENT employer on one charge means the SOURCE disagrees with itself —
      // surfaced as a count, first-write-wins, never silently overwritten.
      if (prior === undefined) chargeKeys.set(ks, { key, employer: emp });
      else if (prior.employer !== emp) chargeConflicts += 1;
    }
  }

  return { parsed: rows.length, mapped, skips, withEmployer, pairs, chargeKeys, chargeConflicts };
}

/**
 * Apply the plan. Returns how many rows were actually updated — which is NOT the pair count:
 * a pair whose fingerprint is absent from the table, or whose row already has an employer, updates
 * nothing. That gap IS the match-rate signal, so it is measured rather than assumed.
 *
 * One UPDATE per batch via unnest, not one per row: 622k round trips would take hours and hold a
 * connection open the whole time.
 */
export async function applyEmployerBackfill(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  pairs: Map<string, string>,
  businessEntityId: string,
): Promise<number> {
  const entries = [...pairs.entries()];
  let updated = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const fps = slice.map(([fp]) => fp);
    const emps = slice.map(([, e]) => e);
    // `and employer_name is null` makes this idempotent AND non-destructive: a value already
    // written by the live cron is fresher than any CSV and is left alone.
    // Tenant scope is not optional — row_fingerprint deliberately excludes business_entity_id
    // (0028), so without it a BXR file could in principle write an Indigo row.
    const { rowCount } = await db.query(
      'update collections.cmd_explorer_rows t set employer_name = v.employer ' +
        'from (select unnest($1::text[]) as fp, unnest($2::text[]) as employer) v ' +
        'where t.row_fingerprint = v.fp ' +
        'and t.business_entity_id = $3::uuid ' +
        'and t.employer_name is null',
      [fps, emps, businessEntityId],
    );
    updated += rowCount ?? 0;
  }
  return updated;
}

/** CMD credentials + pairing for one customer. Secrets come from env only and are never logged. */
function cmdConfigFor(customerId: string, reportId: string, filterId: string): CmdApiConfig {
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
    reportId,
    filterId,
    auth,
    pollIntervalMs: Number(process.env.CMD_POLL_INTERVAL_MS) || 5_000,
    maxPollAttempts: Number(process.env.CMD_POLL_ATTEMPTS) || 100,
  };
}

/** Fold one customer's plan into the running total. Pairs merge across customers because a
 *  fingerprint is unique table-wide, not per-facility. */
function mergePlan(into: BackfillPlan, add: BackfillPlan): void {
  into.parsed += add.parsed;
  into.mapped += add.mapped;
  into.withEmployer += add.withEmployer;
  into.chargeConflicts += add.chargeConflicts;
  for (const [label, n] of Object.entries(add.skips)) into.skips[label] = (into.skips[label] ?? 0) + n;
  for (const [fp, emp] of add.pairs) into.pairs.set(fp, emp);
  // Charge identity includes member_id_bidx and facility, so cross-customer collision is not a
  // concern; a repeat across customers would be the same claim seen twice.
  for (const [ks, v] of add.chargeKeys) {
    const prior = into.chargeKeys.get(ks);
    if (prior === undefined) into.chargeKeys.set(ks, v);
    else if (prior.employer !== v.employer) into.chargeConflicts += 1;
  }
}

/**
 * API source: pull the saved report ONCE PER CUSTOMER and fold the plans together.
 *
 * SEQUENTIAL, not parallel — CMD allows ONE report at a time per partner, so concurrent runs
 * contend for the same slot and can starve the production crons. This is also why the operator
 * should not run it inside the :41–:59 CMD quiet window or near the hourly explorer slots.
 */
async function planFromApi(tenant: 'bxr' | 'indigo', reportId: string, filterId: string): Promise<BackfillPlan> {
  const customers = tenant === 'bxr' ? BXR_CUSTOMERS : INDIGO_CUSTOMERS;
  const merged: BackfillPlan = {
    parsed: 0, mapped: 0, skips: {}, withEmployer: 0,
    pairs: new Map(), chargeKeys: new Map(), chargeConflicts: 0,
  };
  console.log(`pulling report ${reportId} / filter ${filterId} across ${customers.length} ${tenant} customers (sequential)`);
  for (const [i, c] of customers.entries()) {
    const rows = await cmdReportRows(cmdConfigFor(c.customerId, reportId, filterId));
    const p = planEmployerBackfillFromRows(rows, tenant, 'employer-backfill-api');
    mergePlan(merged, p);
    // Counts and the facility CODE only — never a cell value.
    console.log(`  [${i + 1}/${customers.length}] ${c.facilityCode}: rows=${p.parsed} mapped=${p.mapped} employer=${p.withEmployer}`);
  }
  return merged;
}

/**
 * PHASE 1 of the charge-identity path, run as **claims_reader**: resolve charge identities to the
 * row_fingerprints of the rows that still need an employer.
 *
 * ⚠ THE ROLE SPLIT IS THE DESIGN, NOT AN ACCIDENT. Matching on charge identity means READING
 * member_id_bidx, charge_date, cpt_code, revenue_code, facility and charge_amount — six columns
 * cmd_rollup_writer deliberately cannot SELECT (0103 grants it exactly three:
 * business_entity_id, employer_name, row_fingerprint). Rather than widen the writer's read surface
 * over a PHI table to six more columns, the SEMANTIC match happens as the reader — which is what
 * the standing rule wants anyway ("reads run as claims_reader") — and the WRITE is then keyed on
 * row_fingerprint, which the writer can already read. No new grant, no new migration.
 *
 * Returns (fingerprint → employer), so the existing applyEmployerBackfill applies it unchanged.
 * One charge fans out to EVERY snapshot row of that charge, which is correct: they are all the same
 * claim and all share the employer.
 */
export async function resolveChargeKeyTargets(
  readDb: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  chargeKeys: Map<string, { key: ChargeKey; employer: string }>,
  businessEntityId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = [...chargeKeys.values()];
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const { rows } = await readDb.query(
      'select t.row_fingerprint, v.employer from (' +
        'select unnest($1::text[]) as mb, unnest($2::date[]) as cd, unnest($3::text[]) as cpt, ' +
        'unnest($4::text[]) as rev, unnest($5::text[]) as fac, unnest($6::numeric[]) as amt, ' +
        'unnest($7::text[]) as employer' +
        ') v join collections.cmd_explorer_rows t ' +
        'on t.member_id_bidx = v.mb and t.charge_date = v.cd and t.cpt_code = v.cpt ' +
        "and coalesce(t.revenue_code, '') = v.rev and t.facility = v.fac and t.charge_amount = v.amt " +
        'where t.business_entity_id = $8::uuid and t.employer_name is null',
      [
        slice.map((e) => e.key.memberIdBidx),
        slice.map((e) => e.key.chargeDate),
        slice.map((e) => e.key.cptCode),
        slice.map((e) => e.key.revenueKey),
        slice.map((e) => e.key.facility),
        slice.map((e) => e.key.chargeAmount),
        slice.map((e) => e.employer),
        businessEntityId,
      ],
    );
    for (const r of rows) {
      const fp = r['row_fingerprint'];
      const emp = r['employer'];
      if (typeof fp === 'string' && typeof emp === 'string') out.set(fp, emp);
    }
  }
  return out;
}

/**
 * READ-ONLY match measurement for the dry run. Answers the only question that decides whether
 * committing is safe, WITHOUT writing anything.
 *
 * The dry run used to stop at "how many pairs did the report yield", which is a property of the
 * REPORT alone — it says nothing about whether those fingerprints exist in the table. The match
 * rate was therefore first observable at --commit time, i.e. after the write. That is backwards for
 * a one-shot, per-row-irreversible fill, so this measures it up front.
 *
 * Returns:
 *   present  — fingerprints that exist in this tenant at all. THE normalization signal: a low
 *              number means the CSV/API normalizes differently than ingest did, NOT missing data.
 *   fillable — of those, how many still have employer_name IS NULL. This is what --commit would
 *              actually update; the gap between present and fillable is rows the cron already filled.
 */
export async function measureBackfillMatch(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  pairs: Map<string, string>,
  businessEntityId: string,
): Promise<{ present: number; fillable: number }> {
  const fps = [...pairs.keys()];
  let present = 0;
  let fillable = 0;
  for (let i = 0; i < fps.length; i += BATCH) {
    const slice = fps.slice(i, i + BATCH);
    const { rows } = await db.query(
      'select count(*)::int as present, ' +
        'count(*) filter (where t.employer_name is null)::int as fillable ' +
        'from collections.cmd_explorer_rows t ' +
        'where t.row_fingerprint = any($1::text[]) and t.business_entity_id = $2::uuid',
      [slice, businessEntityId],
    );
    const r = rows[0];
    // pg returns ::int as a number, but count(*) without the cast would be a STRING (int8) — the
    // cast above is load-bearing, not cosmetic.
    present += Number(r?.present ?? 0);
    fillable += Number(r?.fillable ?? 0);
  }
  return { present, fillable };
}

async function main(): Promise<void> {
  const { commit, source, file, filterId, reportId, tenant, key } = parseArgs(process.argv);
  const entityId = tenant === 'bxr' ? BXR_ENTITY_ID : INDIGO_ENTITY_ID;

  // sourceLabel only reaches mapRow's source_file field, which this script never writes — the
  // fingerprint does not include it, so any stable string is fine.
  const plan =
    source === 'api'
      ? await planFromApi(tenant, reportId, filterId)
      : planEmployerBackfill(readFileSync(file, 'utf8'), tenant, 'employer-backfill');

  console.log(source === 'api' ? `tenant=${tenant} report=${reportId} filter=${filterId} key=${key}` : `tenant=${tenant} file=${file} key=${key}`);
  console.log(`  parsed rows      : ${plan.parsed}`);
  console.log(`  mapped ok        : ${plan.mapped}`);
  console.log(`  with employer    : ${plan.withEmployer}`);
  console.log(`  distinct fps     : ${plan.pairs.size}`);
  console.log(`  distinct charges : ${plan.chargeKeys.size}${plan.chargeConflicts > 0 ? `  (⚠ ${plan.chargeConflicts} charge(s) carried CONFLICTING employers in the source — first wins)` : ''}`);
  const skipTotal = Object.values(plan.skips).reduce((a, b) => a + b, 0);
  if (skipTotal > 0) {
    console.log(`  skipped          : ${skipTotal}`);
    for (const [label, n] of Object.entries(plan.skips).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${label}: ${n}`);
    }
  }

  const url = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();

  if (!commit) {
    console.log('\nDRY-RUN — nothing will be written.');
    // MEASURE AS THE READER, NOT THE WRITER. Two independent reasons:
    //   1. The standing rule: reads run as claims_reader, writes as the narrow writer role.
    //   2. It would not work as the writer anyway. cmd_rollup_writer has NO table SELECT on
    //      collections.cmd_explorer_rows (measured 2026-08-17: SELECT false on the table,
    //      false on business_entity_id and employer_name, true only on row_fingerprint), so the
    //      measuring query raises 42501 `permission denied for table cmd_explorer_rows`.
    const readUrl = process.env.CLAIMS_READER_DATABASE_URL?.trim();
    if (!readUrl) {
      console.log('CLAIMS_READER_DATABASE_URL not set, so the MATCH RATE cannot be measured.');
      console.log('The counts above describe the REPORT only — they say nothing about whether these');
      console.log('fingerprints exist in the table. Set the var to get the number that matters.');
      return;
    }
    // Read-only. Still inside withTenant: the SELECT is subject to the same RLS policies as the
    // write, so measuring outside the tenant GUC would report 0 present and read as a total
    // normalization failure — the same false signal migration 0102 was needed to remove.
    const pool = makeClient(readUrl);
    try {
      if (key === 'charge') {
        const targets = await withTenant(pool, entityId, (client) =>
          resolveChargeKeyTargets(client, plan.chargeKeys, entityId),
        );
        const pctC = (n: number) => (plan.chargeKeys.size === 0 ? 0 : Math.round((n / plan.chargeKeys.size) * 1000) / 10);
        console.log(`\n  KEY = charge identity (member_id_bidx, charge_date, cpt, revenue, facility, charge_amount)`);
        console.log(`  charges in report    : ${plan.chargeKeys.size}`);
        console.log(`  ROWS --commit would fill : ${targets.size}`);
        console.log(`  (one charge fans out to every snapshot row of that charge — ${pctC(targets.size)}% of charges, rows can exceed charges)`);
      } else {
        const { present, fillable } = await withTenant(pool, entityId, (client) =>
          measureBackfillMatch(client, plan.pairs, entityId),
        );
        const pct = (n: number) => (plan.pairs.size === 0 ? 0 : Math.round((n / plan.pairs.size) * 1000) / 10);
        console.log(`\n  KEY = row_fingerprint (exact 14-field match)`);
        console.log(`  fingerprints matched : ${present} of ${plan.pairs.size} pairs (${pct(present)}%)`);
        console.log(`  of those, fillable   : ${fillable} (${pct(fillable)}%) — employer_name still null`);
        console.log(`  already populated    : ${present - fillable}`);
      }
      console.log('\n  Nothing was written. Re-run with --commit to apply.');
    } finally {
      await pool.end();
    }
    return;
  }

  if (!url) throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit; never hardcode or log it)');
  const pool = makeClient(url);
  try {
    // ⚠ withTenant IS MANDATORY, NOT TIDINESS. collections.cmd_explorer_rows has RLS ENABLED and
    // cmd_rollup_writer is NOT rolbypassrls, so every policy on it keys off the transaction-local
    // GUC `app.business_entity_id`. Running the UPDATE on a bare pool leaves that GUC unset and the
    // UPDATE matches ZERO rows — with NO error, because RLS filters rather than raises.
    //
    // That failure is indistinguishable from a fingerprint mismatch in the output, which is exactly
    // the wrong place to start debugging: this script's own dry-run text tells the operator a low
    // match rate means a normalization problem. It measured 0 rows once for this reason before
    // migration 0102 added the UPDATE policy.
    //
    // withTenant also BEGINs a transaction and read-back-verifies the GUC took on this pooled
    // backend before any query runs, which matters on the 6543 transaction pooler where a different
    // backend can serve each transaction.
    const updated = await withTenant(pool, entityId, (client) =>
      applyEmployerBackfill(client, plan.pairs, entityId),
    );
    const rate = plan.pairs.size === 0 ? 0 : Math.round((updated / plan.pairs.size) * 1000) / 10;
    console.log(`\n  rows updated     : ${updated} of ${plan.pairs.size} pairs (${rate}%)`);
    if (updated < plan.pairs.size) {
      console.log('  NOTE: the shortfall is pairs whose fingerprint is not in this tenant, or whose');
      console.log('  row already had an employer. Both are expected in small numbers; a LARGE gap');
      console.log('  means the CSV normalizes differently than the ingest did — investigate.');
    }
  } finally {
    await pool.end();
  }
}

// Only run as a CLI, so the pure helpers above stay importable by tests.
if (process.argv[1] !== undefined && process.argv[1].endsWith('cmdEmployerBackfill.ts')) {
  main().catch((e) => {
    console.error('employer backfill failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
