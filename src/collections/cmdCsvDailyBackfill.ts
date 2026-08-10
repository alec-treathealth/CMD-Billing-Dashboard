/**
 * CMD CSV → daily_collections BACKFILL (one-shot, local). Reconstructs historical
 * collections.daily_collections (Check+EFT deposits by facility/day) from a CMD export CSV
 * that carries the Check Payment + EFT Payment columns — for tenants/facilities whose daily
 * history was never loaded (the seed only populated cmd_explorer_rows; the cron only covers the
 * current month).
 *
 *   # Indigo — full seed CSV (facility col = "Customer Name", aliased):
 *   node --max-old-space-size=4096 --env-file=.env --import tsx src/collections/cmdCsvDailyBackfill.ts \
 *     --tenant=indigo --file="Indigo Seed Data/Indigo Seed Data.csv" [--commit]
 *
 *   # BXR — Dallas only, from the all-BXR "Derek" export (facility col = "Facility Name"):
 *   node --env-file=.env --import tsx src/collections/cmdCsvDailyBackfill.ts \
 *     --tenant=bxr --only=DMH --file="Derek Historical Report Data/Derek Automation.csv" [--commit]
 *
 * REUSES the exact cron/read helpers: parseReportCsv + aggregateDailyDeposits (Check+EFT by
 * Payment-Received date) + the same future-date guard (dropFuturePaymentRows) + the tenant-scoped,
 * span-scoped, idempotent write (replaceCmdDailyForFacility via withTenant). A backfilled day and a
 * cron day for the same facility/date are byte-identical; the current-month cron span-replaces its
 * window on top, leaving earlier months intact. `--only` restricts the write to specific
 * facility_codes so a multi-facility export never clobbers facilities that already have history.
 *
 * facility_code: daily_collections keys facilities by CMD code (BXR short code; Indigo numeric id).
 * The CSV carries only the facility NAME, mapped via the per-tenant NAME_BY_CODE maps below (mirror
 * migration 0034 + collections.facilities). FOLLOW-UP: unify these into one source (facilityName on
 * the roster). Any CSV name not in the map is REPORTED and skipped — never silently dropped.
 *
 * SECURITY: writes as least-privilege cmd_rollup_writer over verify-full TLS; creds/URL from env
 * only, never logged. Non-PHI output only (day counts + summed deposit dollars).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportCsv } from './cmdPayer.js';
import { aliasIndigoFacilityColumn, aggregateDailyDeposits, dropFuturePaymentRows, type CmdDailyDeposit } from './cmdExplorer.js';
import { replaceCmdDailyForFacility, makeClient } from './db.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

/**
 * Indigo facility_code (CMD customer id) -> name. Mirrors migration 0034 / the
 * `collections.facilities` seed, and DELIBERATELY INCLUDES DEFUNCT FACILITIES — it does NOT
 * mirror INDIGO_CUSTOMERS, which is the live polling roster.
 *
 * That divergence is required, not drift: this script labels HISTORICAL deposit rows, so it must
 * name every facility that existed during the period being backfilled, including accounts closed
 * since. Narrowing it to the active roster would leave older rows unlabelled.
 *
 * Currently 32 entries against the roster's 29. The extra three are exactly the retired-but-owned
 * facilities enumerated in INDIGO_RETIRED_CUSTOMERS (cmdCustomers.ts): 10035467 RESTORED HOPE
 * RECOVERY, 10036020 MADISON RECOVERY CENTER, 10036030 MISSOURI BEHAVIORAL HEALTH. Do not "fix"
 * the gap by deleting them here.
 */
const INDIGO_NAME_BY_CODE: Readonly<Record<string, string>> = {
  '10026460': '405 RECOVERY', '10029373': 'ADDICTION FREE RECOVERY SERVICES', '10029528': 'ADOLESCENT MENTAL HEALTH',
  '10031413': 'BRITE RECOVERY', '10028848': 'CALIFORNIA TREATMENT COLLECTIVE', '10028842': 'COVENANT HILLS TREATMENT CENTERS',
  '10021230': 'CROWN VIEW CO-OCCURRING INSTITUTE - 612335', '10023916': 'CROWN VIEW PSYCHIATRIC INSTITUTE',
  '10020687': 'HEALTHY LIFE RECOVERY', '10026624': 'HILLSIDE HORIZON FOR TEENS', '10033859': 'INTO THE LIGHT',
  '10032291': 'KIN WELLNESS', '10030095': 'KNOX RECOVERY', '10036020': 'MADISON RECOVERY CENTER',
  '10024431': 'MENTAL HEALTH CENTER OF SAN DIEGO', '10030319': 'MENTAL HEALTH MODESTO',
  '10034979': 'MENTAL HEALTH TREATMENT AND STABILIZATION CENTER OF SACRAMENTO', '10036030': 'MISSOURI BEHAVIORAL HEALTH',
  '10034230': 'MY TEEN MENTAL HEALTH', '10026125': 'MY TIME RECOVERY, LLC', '10033867': 'NEW ORIGINS',
  '10034901': 'NEXT FRONTIER RECOVERY', '10021573': 'OPUS HEALTH', '10031652': 'ORANGE COUNTY MENTAL HEALTH',
  '10035467': 'RESTORED HOPE RECOVERY', '10028595': 'REVIVAL MENTAL HEALTH', '10026159': 'SADDLEBACK RECOVERY',
  '10028219': 'SHINE MENTAL HEALTH', '10025950': 'SILICON VALLEY RECOVERY, LLC', '10033531': 'THE EDGE TREATMENT CENTER',
  '10033708': 'THE FORGE RECOVERY CENTER', '10031547': 'VISALIA RECOVERY CENTER',
};

/** BXR facility_code -> name, as the name appears in the "Derek" export. Mirrors collections.facilities.
 *  Only DMH is needed today (the sole BXR facility missing daily history); add others if backfilling more. */
const BXR_NAME_BY_CODE: Readonly<Record<string, string>> = {
  DMH: 'DALLAS MENTAL HEALTH LLC',
};

interface TenantCfg { entityId: string; nameByCode: Readonly<Record<string, string>>; alias: boolean; }
const TENANTS: Record<string, TenantCfg> = {
  indigo: { entityId: INDIGO_ENTITY_ID, nameByCode: INDIGO_NAME_BY_CODE, alias: true },
  bxr: { entityId: BXR_ENTITY_ID, nameByCode: BXR_NAME_BY_CODE, alias: false },
};

function loadDotEnvIfPresent(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '..', '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq === -1) continue;
      const k = t.slice(0, eq).trim(); if (!k || k in process.env) continue;
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch { /* rely on exported env */ }
}

function parseArgs(argv: string[]): { commit: boolean; file?: string; tenant?: string; only?: Set<string> } {
  let commit = false; let file: string | undefined; let tenant: string | undefined; let only: Set<string> | undefined;
  for (const arg of argv.slice(2)) {
    if (arg === '--commit') commit = true;
    else if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
    else if (arg.startsWith('--tenant=')) tenant = arg.slice('--tenant='.length);
    else if (arg.startsWith('--only=')) only = new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
  }
  return { commit, file, tenant, only };
}

const f = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const { commit, file, tenant, only } = parseArgs(process.argv);
  if (!file) throw new Error('--file="<csv>" is required');
  if (!tenant || !TENANTS[tenant]) throw new Error('--tenant=indigo|bxr is required');
  const cfg = TENANTS[tenant]!;
  const nameToCode = new Map<string, string>();
  for (const [code, name] of Object.entries(cfg.nameByCode)) nameToCode.set(name, code);

  console.log(`CSV daily backfill — ${commit ? 'COMMIT' : 'DRY-RUN'} — tenant=${tenant}${only ? ` only=[${[...only].join(',')}]` : ''} — ${basename(file)}`);

  const parsed = parseReportCsv(readFileSync(file, 'utf8'));
  if (parsed.length === 0) throw new Error('no data rows parsed from the CSV');
  if (cfg.alias) aliasIndigoFacilityColumn(parsed);

  // Same future-date guard as the cron (drops data-entry typos like the 12/30/2026 REVIVAL row).
  const todayIso = new Date().toISOString().slice(0, 10);
  const { kept: rows, dropped: futureDropped } = dropFuturePaymentRows(parsed, todayIso);
  if (futureDropped > 0) console.log(`Dropped ${futureDropped} future-dated row(s) (guard, as-of ${todayIso}).`);

  const byName = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = (row['Facility Name'] ?? '').toString().trim();
    if (name === '') continue;
    const b = byName.get(name); if (b) b.push(row); else byName.set(name, [row]);
  }

  const perFacility: { name: string; code: string; daily: CmdDailyDeposit[]; deposit: number }[] = [];
  const unmapped: { name: string; rows: number }[] = [];
  let minDate: string | null = null, maxDate: string | null = null;
  for (const [name, groupRows] of byName) {
    const code = nameToCode.get(name);
    if (!code) { unmapped.push({ name, rows: groupRows.length }); continue; }
    if (only && !only.has(code)) continue; // allowlist: skip facilities we're not backfilling
    const daily = aggregateDailyDeposits(groupRows, code);
    if (daily.length === 0) continue;
    const deposit = daily.reduce((s, d) => s + Number(d.gross_amount), 0);
    for (const d of daily) { if (minDate === null || d.payment_date < minDate) minDate = d.payment_date; if (maxDate === null || d.payment_date > maxDate) maxDate = d.payment_date; }
    perFacility.push({ name, code, daily, deposit });
  }
  perFacility.sort((a, b) => b.deposit - a.deposit);

  let totDays = 0, totDeposit = 0, totDeleted = 0, totInserted = 0;
  const db = commit ? makeClient(process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim() ?? (() => { throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit)'); })()) : null;
  try {
    for (const p of perFacility) {
      totDays += p.daily.length; totDeposit += p.deposit;
      if (db) { const { deleted, inserted } = await replaceCmdDailyForFacility(db, p.code, p.daily, cfg.entityId); totDeleted += deleted; totInserted += inserted; }
      console.log(`  ${p.name} (${p.code}): days ${p.daily.length}, deposit $${f(p.deposit)}`);
    }
  } finally { if (db) await db.end(); }

  console.log(`TOTAL: facilities ${perFacility.length}, daily-days ${totDays}, deposit $${f(totDeposit)}, span ${minDate ?? '-'}..${maxDate ?? '-'}` + (commit ? `, deleted ${totDeleted}, inserted ${totInserted}` : ''));
  if (!only && unmapped.length > 0) {
    console.log('UNMAPPED facility names (NOT in NAME_BY_CODE — NOT backfilled; reconcile the map):');
    for (const u of unmapped.sort((a, b) => b.rows - a.rows)) console.log(`  "${u.name}" — ${u.rows} rows`);
  }
  if (!commit) console.log('DRY-RUN — no rows written. Re-run with --commit to load.');
}

main().catch((err) => { console.error('csv daily backfill failed:', err instanceof Error ? err.message : String(err)); process.exit(1); });
