/**
 * Overflow diagnostic for the 2024 ingest failure ("numeric field overflow").
 * Reads the 2024 sheet, runs the REAL normalizer in memory, and flags rows that
 * would overflow a target column. Does NOT change any data or any normalizer.
 *
 * Target column limits (Postgres):
 *   - money numeric(12,2): max |value| = 9,999,999,999.99  -> overflow at |v| >= 1e10
 *   - collection_rate numeric(6,4): max |value| = 99.9999  -> overflow at |rate| >= 100
 * (The collection_rate is GENERATED as paid_amount/allowed_amount when
 *  allowed_amount <> 0, so a small/negative/reversal allowed_amount blows it up.)
 *
 * Output discipline: raw cell values are PHI-bearing -> full detail goes to the
 * gitignored reports/ dir; stdout gets counts, columns, and a few non-identifying
 * numeric examples only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOAuthClient } from './auth.js';
import { SHEET_SOURCES } from './config.js';
import { coerceRow } from './normalize.js';
import { buildColumnOrder, readSheet, toRawRow } from './sheets.js';

const MONEY_MAX = 1e10; // numeric(12,2) overflow threshold
const RATE_MAX = 100; // numeric(6,4) overflow threshold
const MONEY_COLUMNS = [
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
] as const;

interface Offender {
  source_row_num: number;
  rules: string[];
  // raw cell values for the money columns (PHI-bearing -> report file only)
  raw: Record<string, string>;
  parsed: { allowed: number | null; paid: number | null; rate: number | null };
  bigMoney: { column: string; value: number }[];
}

async function main(): Promise<void> {
  const source = SHEET_SOURCES.find((s) => s.year === 2024);
  if (!source) throw new Error('2024 source not found');

  const auth = await getOAuthClient();
  const { header, rows } = await readSheet(source.sheetId, source.tab, auth);
  const order = buildColumnOrder(header);

  let coercionFailures = 0;
  let rateOverflow = 0;
  let moneyOverflow = 0;
  let moneyLargeButLegal = 0; // in [1e8, 1e10) — to address the 1e8 figure in the ask
  const offenders: Offender[] = [];

  for (const { rowNum, cells } of rows) {
    const rawRow = toRawRow(cells, order);
    const res = coerceRow(rawRow, {
      source_file_id: source.sheetId,
      source_row_num: rowNum,
      source_year: source.year,
    });
    if (!res.ok) {
      coercionFailures += 1; // never reaches the claims insert, can't overflow
      continue;
    }
    const c = res.claim;
    const allowed = c.allowed_amount === null ? null : Number(c.allowed_amount);
    const paid = c.paid_amount === null ? null : Number(c.paid_amount);

    const rules: string[] = [];

    // Money overflow (numeric(12,2)).
    const bigMoney: { column: string; value: number }[] = [];
    for (const col of MONEY_COLUMNS) {
      const v = c[col] === null ? null : Number(c[col]);
      if (v === null) continue;
      if (Math.abs(v) >= MONEY_MAX) bigMoney.push({ column: col, value: v });
      else if (Math.abs(v) >= 1e8) moneyLargeButLegal += 1;
    }
    if (bigMoney.length > 0) {
      rules.push(`money_overflow(${bigMoney.map((b) => b.column).join(',')})`);
      moneyOverflow += 1;
    }

    // collection_rate overflow (numeric(6,4)): only when allowed<>0 and paid present.
    let rate: number | null = null;
    if (allowed !== null && allowed !== 0 && paid !== null) {
      rate = paid / allowed;
      if (Math.abs(rate) >= RATE_MAX) {
        rules.push('collection_rate_overflow');
        rateOverflow += 1;
      }
    }

    if (rules.length > 0) {
      offenders.push({
        source_row_num: rowNum,
        rules,
        raw: {
          allowed_amount: rawRow.allowed_amount,
          paid_amount: rawRow.paid_amount,
          charge_debit_amount: rawRow.charge_debit_amount,
          adjustment: rawRow.adjustment,
          balance_due_pt: rawRow.balance_due_pt,
        },
        parsed: { allowed, paid, rate },
        bigMoney,
      });
    }
  }

  // Full detail -> gitignored report (PHI-bearing).
  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join('reports', `diagnose-2024-overflow-${stamp}.jsonl`);
  writeFileSync(reportPath, offenders.map((o) => JSON.stringify(o)).join('\n') + (offenders.length ? '\n' : ''));

  // stdout: counts + columns + a few NON-identifying numeric examples.
  console.log('\n=== 2024 overflow diagnostic (counts/columns only — no PHI) ===');
  console.log(`  source rows scanned:        ${rows.length}`);
  console.log(`  coercion failures (skipped): ${coercionFailures}`);
  console.log(`  rows w/ money_overflow (|v|>=1e10): ${moneyOverflow}`);
  console.log(`  money values in [1e8,1e10) (legal): ${moneyLargeButLegal}`);
  console.log(`  rows w/ collection_rate_overflow (|paid/allowed|>=100): ${rateOverflow}`);
  console.log(`  total offending rows:        ${offenders.length}`);
  console.log(`  full detail (PHI):           ${reportPath}`);

  const examples = offenders.slice(0, 5);
  if (examples.length > 0) {
    console.log('\n  Examples (source_row_num + offending magnitudes; identifiers withheld):');
    for (const o of examples) {
      const r = o.parsed.rate;
      console.log(
        `    row ${o.source_row_num}: ${o.rules.join(' & ')} | ` +
          `allowed=${o.parsed.allowed} paid=${o.parsed.paid} ` +
          `rate=${r === null ? 'n/a' : r.toFixed(2)}` +
          (o.bigMoney.length ? ` bigMoney=${JSON.stringify(o.bigMoney)}` : ''),
      );
    }
  }
}

main().catch((err) => {
  console.error('[diagnose] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
