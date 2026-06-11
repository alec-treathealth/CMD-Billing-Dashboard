/**
 * Phase 1 ingest orchestrator.
 *
 * Per source sheet:
 *   1. read cells (structured, never CSV) and validate header shape,
 *   2. land EVERY row verbatim in claims_raw (idempotent on the unique key),
 *   3. explicit check-then-insert into typed `claims` for rows not yet present,
 *   4. write any coercion failure to the gitignored JSONL report (PHI-safe).
 *
 * Logs carry COUNTS ONLY — never raw cell values / PHI.
 */
import { getOAuthClient } from './auth.js';
import { loadConfig, SHEET_SOURCES } from './config.js';
import {
  fetchExistingClaimRawIds,
  insertClaims,
  makeClient,
  upsertClaimsRaw,
  type Db,
  type RawRowInsert,
} from './db.js';
import { coerceRow } from './normalize.js';
import { CoercionReport } from './report.js';
import { buildColumnOrder, readSheet, toRawRow } from './sheets.js';
import type { SheetSource, TypedClaim } from './types.js';

interface FileStats {
  year: number;
  sourceRows: number;
  rawUpserted: number;
  claimsInserted: number;
  skippedExisting: number;
  coercionFailures: number;
}

async function ingestSource(
  db: Db,
  auth: Awaited<ReturnType<typeof getOAuthClient>>,
  source: SheetSource,
  report: CoercionReport,
): Promise<FileStats> {
  const { header, rows } = await readSheet(source.sheetId, source.tab, auth);
  const columnOrder = buildColumnOrder(header); // throws loud on shape drift

  // 1. Land every row verbatim in claims_raw.
  const rawInserts: RawRowInsert[] = rows.map(({ rowNum, cells }) => ({
    source_year: source.year,
    source_file_id: source.sheetId,
    source_row_num: rowNum,
    raw: toRawRow(cells, columnOrder),
  }));
  const idByRowNum = await upsertClaimsRaw(db, rawInserts);

  // 2. Explicit check-then-insert for typed claims (idempotent, debuggable).
  const allRawIds = [...idByRowNum.values()];
  const existing = await fetchExistingClaimRawIds(db, allRawIds);

  const toInsert: TypedClaim[] = [];
  let skippedExisting = 0;
  let coercionFailures = 0;

  for (const { rowNum, cells } of rows) {
    const rawId = idByRowNum.get(rowNum);
    if (rawId === undefined) {
      throw new Error(`No claims_raw id for source_row_num ${rowNum} (file ${source.sheetId}).`);
    }
    if (existing.has(rawId)) {
      skippedExisting += 1; // already typed in a previous run
      continue;
    }
    const row = toRawRow(cells, columnOrder);
    const result = coerceRow(row, {
      source_file_id: source.sheetId,
      source_row_num: rowNum,
      source_year: source.year,
    });
    if (!result.ok) {
      report.writeAll(result.failures);
      coercionFailures += 1;
      continue;
    }
    toInsert.push({ claims_raw_id: rawId, ...result.claim });
  }

  const claimsInserted = await insertClaims(db, toInsert);

  return {
    year: source.year,
    sourceRows: rows.length,
    rawUpserted: idByRowNum.size,
    claimsInserted,
    skippedExisting,
    coercionFailures,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = makeClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const auth = await getOAuthClient();
  const report = new CoercionReport('ingest');

  const stats: FileStats[] = [];
  try {
    for (const source of SHEET_SOURCES) {
      // eslint-disable-next-line no-console
      console.log(`[ingest] reading ${source.year} (${source.sheetId})…`);
      stats.push(await ingestSource(db, auth, source, report));
    }
  } finally {
    await report.close();
  }

  // Counts only — no PHI.
  console.log('\n=== Ingest summary (counts only — no PHI) ===');
  for (const s of stats) {
    console.log(
      `  ${s.year}: source_rows=${s.sourceRows} raw_landed=${s.rawUpserted} ` +
        `claims_inserted=${s.claimsInserted} skipped_existing=${s.skippedExisting} ` +
        `coercion_failures=${s.coercionFailures}`,
    );
  }
  const tot = stats.reduce(
    (a, s) => ({
      sourceRows: a.sourceRows + s.sourceRows,
      claimsInserted: a.claimsInserted + s.claimsInserted,
      coercionFailures: a.coercionFailures + s.coercionFailures,
    }),
    { sourceRows: 0, claimsInserted: 0, coercionFailures: 0 },
  );
  console.log(
    `  TOTAL: source_rows=${tot.sourceRows} claims_inserted=${tot.claimsInserted} ` +
      `coercion_failures=${tot.coercionFailures}`,
  );
  console.log(`  Failed-coercion report: ${report.path} (${report.count} rows)`);
  console.log(
    '  Expectation: raw row count == total source rows; ' +
      'claims count == raw minus failed-coercion count.',
  );
}

main().catch((err) => {
  // Generic, no PHI. Detail belongs in the report file, not stdout.
  console.error('[ingest] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
