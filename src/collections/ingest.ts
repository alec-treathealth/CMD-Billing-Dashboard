/**
 * Phase 6 collections ingest orchestrator.
 *
 *   tsx src/collections/ingest.ts                  # DRY-RUN, all 10 workbooks (no DB writes)
 *   tsx src/collections/ingest.ts --files=CAMH,TREAT_FRCA
 *   tsx src/collections/ingest.ts --commit --files=CAMH,TREAT_FRCA   # real load
 *
 * DRY-RUN (default) parses + classifies + coerces + writes the (gitignored)
 * failed/skipped reports and prints counts + PHI-safe spot-checks, but makes NO
 * database connection and writes NOTHING. --commit lands raw + typed rows as
 * claims_admin (idempotent). Logs carry COUNTS ONLY — never raw cell values/PHI.
 */
import { getOAuthClient } from '../auth.js';
import { loadConfig } from '../config.js';
import { WORKBOOKS } from './config.js';
import {
  insertDaily, insertNegotiation, insertPaymentLines, insertRollup,
  makeClient, rawKey, upsertRaw, type Db,
} from './db.js';
import { CollectionsReport } from './report.js';
import { classifyShape, parseTab, type Tab } from './shapes.js';
import { listTabs, readTab } from './sheets.js';
import type { PaymentLineRow, Shape, TypedRecord, Workbook } from './types.js';

interface Counts { raw: number; daily: number; payment_line: number; negotiation: number; rollup: number; unresolvedFacility: number; }
const zero = (): Counts => ({ raw: 0, daily: 0, payment_line: 0, negotiation: 0, rollup: 0, unresolvedFacility: 0 });

// PHI-SAFE spot-check accumulators (only de-identified derivations are ever printed).
interface Spot {
  datesParsed: number; sawSingleDigit: boolean; sawZeroPadded: boolean;
  dateExampleMD: string | null; dateExamplePadded: string | null;
  commaNames: number; commaSplitOk: number; commaMisaligned: number;
  memberWithInternalWs: number; memberWsExample: string | null; memberNormWithWs: number;
  facilityTag: Map<string, number>; // "group|facility" -> count
  negotiationRows: number;
}
const newSpot = (): Spot => ({ datesParsed: 0, sawSingleDigit: false, sawZeroPadded: false, dateExampleMD: null, dateExamplePadded: null, commaNames: 0, commaSplitOk: 0, commaMisaligned: 0, memberWithInternalWs: 0, memberWsExample: null, memberNormWithWs: 0, facilityTag: new Map(), negotiationRows: 0 });

function recordPaymentSpot(spot: Spot, row: PaymentLineRow, rawHeader: Record<string, unknown>): void {
  // Mixed-date evidence comes from the verbatim raw value (the typed value is ISO).
  for (const key of ['Charge From Date', 'Charge Primary Payment Date']) {
    const rawDate = String(rawHeader[key] ?? '').trim();
    const m = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(rawDate);
    if (!m) continue;
    spot.datesParsed += 1;
    const padded = (m[1] ?? '').length === 2 && (m[2] ?? '').length === 2;
    if (padded) { spot.sawZeroPadded = true; spot.dateExamplePadded ??= `${rawDate} -> (iso ${key === 'Charge From Date' ? row.service_date : row.payment_date})`; }
    else { spot.sawSingleDigit = true; spot.dateExampleMD ??= `${rawDate} -> (iso ${key === 'Charge From Date' ? row.service_date : row.payment_date})`; }
  }
  if (row.patient_name && row.patient_name.includes(',')) {
    spot.commaNames += 1;
    if ((row.patient_last ?? '') !== '' && (row.patient_first ?? '') !== '') spot.commaSplitOk += 1;
    // Alignment proof: with the comma name present, the money/payer cells still resolved.
    const moneyOk = row.charge_amount !== undefined && row.allowed_amount !== undefined;
    if (!moneyOk || (row.payer_name ?? '') === '') spot.commaMisaligned += 1;
  }
  if (row.member_id_raw && /\s/.test(row.member_id_raw)) {
    spot.memberWithInternalWs += 1;
    spot.memberWsExample ??= `raw_len=${row.member_id_raw.length} norm_len=${row.member_id_norm?.length ?? 0}`;
    if (row.member_id_norm && /\s/.test(row.member_id_norm)) spot.memberNormWithWs += 1;
  }
}

function tagFacility(spot: Spot, group: string | null, facility: string | null): void {
  const k = `${group ?? '-'}|${facility ?? 'NULL'}`;
  spot.facilityTag.set(k, (spot.facilityTag.get(k) ?? 0) + 1);
}

function parseArgs(argv: string[]): { commit: boolean; files: string[] | null } {
  const commit = argv.includes('--commit');
  const fArg = argv.find((a) => a.startsWith('--files='));
  const files = fArg ? fArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
  return { commit, files };
}

async function processTab(
  db: Db | null, workbook: Workbook, tab: Tab, report: CollectionsReport, counts: Counts, spot: Spot,
): Promise<void> {
  const shape: Shape | null = classifyShape(workbook, tab);
  if (shape === null) {
    if (!tab.rows.every((r) => r.every((c) => (c ?? '').trim() === ''))) {
      report.skip({ source_file_id: workbook.sheetId, workbook: workbook.code, source_tab: tab.title, reason: 'no recognized shape (header signature not found)' });
    }
    return;
  }
  const { raws, typed, unresolvedFacility } = parseTab(workbook, tab, workbook.sheetId, shape, report);
  const rawByRow = new Map(raws.map((r) => [r.source_row_num, r.raw]));
  counts.raw += raws.length;
  counts.unresolvedFacility += unresolvedFacility;

  for (const t of typed) {
    counts[t.shape] += 1;
    if (t.shape === 'payment_line') { recordPaymentSpot(spot, t.row, rawByRow.get(t.rowNum) ?? {}); tagFacility(spot, t.row.source_group_code, t.row.facility_code); }
    else if (t.shape === 'daily') tagFacility(spot, t.row.source_group_code, t.row.facility_code);
    else if (t.shape === 'negotiation') { spot.negotiationRows += 1; tagFacility(spot, t.row.source_group_code, t.row.facility_code); }
  }

  if (!db) return; // dry-run: no writes
  const idByKey = await upsertRaw(db, raws);
  const idFor = (t: TypedRecord): number => {
    const id = idByKey.get(rawKey(workbook.sheetId, tab.title, t.rowNum));
    if (id === undefined) throw new Error(`no raw id for ${workbook.code}/${tab.title} row ${t.rowNum}`);
    return id;
  };
  const daily = typed.filter((t) => t.shape === 'daily').map((t) => ({ rawId: idFor(t), row: (t as Extract<TypedRecord, { shape: 'daily' }>).row }));
  const pl = typed.filter((t) => t.shape === 'payment_line').map((t) => ({ rawId: idFor(t), row: (t as Extract<TypedRecord, { shape: 'payment_line' }>).row }));
  const nw = typed.filter((t) => t.shape === 'negotiation').map((t) => ({ rawId: idFor(t), row: (t as Extract<TypedRecord, { shape: 'negotiation' }>).row }));
  const ru = typed.filter((t) => t.shape === 'rollup').map((t) => ({ rawId: idFor(t), row: (t as Extract<TypedRecord, { shape: 'rollup' }>).row }));
  if (daily.length) await insertDaily(db, daily);
  if (pl.length) await insertPaymentLines(db, pl);
  if (nw.length) await insertNegotiation(db, nw);
  if (ru.length) await insertRollup(db, ru);
}

async function main(): Promise<void> {
  const { commit, files } = parseArgs(process.argv.slice(2));
  const selected = WORKBOOKS.filter((w) => (files ? files.includes(w.code) : true));
  if (selected.length === 0) throw new Error(`No workbooks matched --files=${files?.join(',')}`);

  const auth = await getOAuthClient();
  const report = new CollectionsReport(commit ? 'commit' : 'dryrun');
  const db = commit ? makeClient(loadConfig().claimsAdminDatabaseUrl) : null;
  const spot = newSpot();
  const perFile = new Map<string, Counts>();

  try {
    for (const wb of selected) {
      const counts = zero();
      perFile.set(wb.code, counts);
      const tabs = await listTabs(wb.sheetId, auth);
      console.log(`[collections] ${commit ? 'LOAD' : 'dry-run'} ${wb.code} (${tabs.length} tabs)…`);
      for (const title of tabs) {
        const tab = await readTab(wb.sheetId, title, auth);
        await processTab(db, wb, tab, report, counts, spot);
      }
    }
  } finally {
    await report.close();
    if (db) await db.end();
  }

  console.log(`\n=== Collections ${commit ? 'load' : 'DRY-RUN'} summary (counts only — no PHI) ===`);
  for (const [code, c] of perFile) {
    console.log(`  ${code}: raw=${c.raw} daily=${c.daily} payment_lines=${c.payment_line} negotiation=${c.negotiation} rollup=${c.rollup} facility_unresolved=${c.unresolvedFacility}`);
  }
  console.log(`  Failed-coercion rows: ${report.failures} (${report.failPath})`);
  console.log(`  Skipped tabs: ${report.skips} (${report.skipPath})`);

  console.log('\n=== Spot-checks (PHI-safe; de-identified derivations only) ===');
  console.log(`  mixed dates: parsed=${spot.datesParsed} sawM/D/YYYY=${spot.sawSingleDigit} sawMM/DD/YYYY=${spot.sawZeroPadded}`);
  console.log(`    example M/D/YYYY: ${spot.dateExampleMD ?? 'n/a'} | example MM/DD/YYYY: ${spot.dateExamplePadded ?? 'n/a'}`);
  console.log(`  embedded-comma names: total=${spot.commaNames} split_into_last+first=${spot.commaSplitOk} misaligned(money/payer)=${spot.commaMisaligned}`);
  console.log(`  member-id internal whitespace: had_ws=${spot.memberWithInternalWs} norms_still_with_ws=${spot.memberNormWithWs} example=${spot.memberWsExample ?? 'n/a'}`);
  console.log(`  negotiation rows (client_name stored unsplit; no last/first columns exist): ${spot.negotiationRows}`);
  console.log('  facility tagging (source_group_code | facility_code -> rows):');
  for (const [k, n] of [...spot.facilityTag.entries()].sort()) console.log(`    ${k} -> ${n}`);
}

main().catch((err) => {
  console.error('[collections] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
