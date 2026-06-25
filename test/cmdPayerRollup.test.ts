import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateRollup } from '../src/collections/cmdPayerIngest.js';
import {
  cmdPayerMonth,
  cmdPayerMonthSql,
  rollupRowsToMonthResult,
} from '../src/collections/cmdPayerRollup.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';
import type { QueryExecutor } from '../src/queries/types.js';
import type { CollectionsQueryContext } from '../src/collections/daily.js';

/** Build a report row keyed by the live CMD report header names. */
function row(fields: Partial<Record<string, string>>): CmdReportRow {
  return {
    'Charge From Date': '',
    'Charge Primary Payer Name': '',
    'Facility Name': '',
    'Charge/Debit Amount': '',
    'Payment Allowed Amount': '',
    'Charge Insurance Payments': '',
    ...fields,
  } as CmdReportRow;
}

// --- aggregateRollup (CSV rows → rollup tuples) -----------------------------

test('aggregateRollup: sums same (payer, facility, month); counts lines', () => {
  const { tuples, stats } = aggregateRollup([
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '$1,000.00', 'Payment Allowed Amount': '$600.00', 'Charge Insurance Payments': '$400.00' }),
    row({ 'Charge From Date': '05/20/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '$500.00', 'Payment Allowed Amount': '$300.00', 'Charge Insurance Payments': '$250.00' }),
  ]);
  assert.equal(tuples.length, 1);
  assert.deepEqual(tuples[0], {
    payer_name: 'ANTHEM',
    facility_name: 'CAMH',
    service_year: 2026,
    service_month: 5,
    total_charge: 1500,
    total_allowed: 900,
    total_paid: 650,
    charge_line_count: 2,
  });
  assert.equal(stats.rows_aggregated, 2);
  assert.equal(stats.rows_skipped_no_date, 0);
  assert.deepEqual(stats.months, ['2026-05']);
});

test('aggregateRollup: splits by facility and by month; reports cardinality', () => {
  const { tuples, stats } = aggregateRollup([
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '100' }),
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'TBH', 'Charge/Debit Amount': '200' }),
    row({ 'Charge From Date': '04/01/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '300' }),
  ]);
  assert.equal(tuples.length, 3);
  assert.equal(stats.distinct_payers, 1);
  assert.equal(stats.distinct_facilities, 2);
  assert.deepEqual(stats.months, ['2026-04', '2026-05']);
});

test('aggregateRollup: blank payer/facility collapse to the empty sentinel', () => {
  const { tuples } = aggregateRollup([
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': '', 'Facility Name': '', 'Charge/Debit Amount': '100' }),
  ]);
  assert.equal(tuples[0]!.payer_name, '');
  assert.equal(tuples[0]!.facility_name, '');
});

test('aggregateRollup: rows with an unparseable/missing date are skipped and counted', () => {
  const { tuples, stats } = aggregateRollup([
    row({ 'Charge From Date': '', 'Charge Primary Payer Name': 'ANTHEM', 'Charge/Debit Amount': '100' }),
    row({ 'Charge From Date': 'not-a-date', 'Charge Primary Payer Name': 'ANTHEM', 'Charge/Debit Amount': '100' }),
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '100' }),
  ]);
  assert.equal(tuples.length, 1);
  assert.equal(stats.rows_total, 3);
  assert.equal(stats.rows_aggregated, 1);
  assert.equal(stats.rows_skipped_no_date, 2);
});

test('aggregateRollup: parses $/comma/parens money and rounds sums to cents', () => {
  const { tuples } = aggregateRollup([
    row({ 'Charge From Date': '05/01/2026', 'Charge Primary Payer Name': 'P', 'Facility Name': 'F', 'Charge/Debit Amount': '0.10', 'Payment Allowed Amount': '(50.00)', 'Charge Insurance Payments': '0.20' }),
    row({ 'Charge From Date': '05/02/2026', 'Charge Primary Payer Name': 'P', 'Facility Name': 'F', 'Charge/Debit Amount': '0.20', 'Payment Allowed Amount': '$50.00', 'Charge Insurance Payments': '0.10' }),
  ]);
  // 0.10 + 0.20 = 0.30 (float-clean), allowed -50 + 50 = 0, paid 0.20 + 0.10 = 0.30
  assert.equal(tuples[0]!.total_charge, 0.3);
  assert.equal(tuples[0]!.total_allowed, 0);
  assert.equal(tuples[0]!.total_paid, 0.3);
});

// --- rollupRowsToMonthResult (DB rows → {summary, by_facility}) -------------

test('rollupRowsToMonthResult: sums facilities per payer; derives gap/write-down; sorts', () => {
  const result = rollupRowsToMonthResult(
    [
      { payer_name: 'ANTHEM', facility_name: 'CAMH', total_charge: '1000', total_allowed: '600', total_paid: '400', charge_line_count: '3' },
      { payer_name: 'ANTHEM', facility_name: 'TBH', total_charge: '500', total_allowed: '300', total_paid: '250', charge_line_count: '2' },
      { payer_name: 'CIGNA', facility_name: 'CAMH', total_charge: '4000', total_allowed: '2000', total_paid: '1500', charge_line_count: '5' },
    ],
    2026,
    5,
  );

  // by_facility keeps grain; derived columns correct.
  assert.equal(result.by_facility.length, 3);
  const camhAnthem = result.by_facility.find((r) => r.payer_name === 'ANTHEM' && r.facility_name === 'CAMH')!;
  assert.equal(camhAnthem.total_write_down, 400); // 1000 - 600
  assert.equal(camhAnthem.total_collection_gap, 600); // 1000 - 400

  // Summary sums facilities per payer and sorts by total_charge desc (CIGNA first).
  assert.equal(result.summary.by_payer[0]!.payer_name, 'CIGNA');
  const anthem = result.summary.by_payer.find((r) => r.payer_name === 'ANTHEM')!;
  assert.equal(anthem.total_charge, 1500);
  assert.equal(anthem.total_paid, 650);
  assert.equal(anthem.claim_count, 5);
  assert.equal(anthem.total_collection_gap, 850); // 1500 - 650
  assert.equal(anthem.avg_collection_rate, round2(650 / 1500));
  assert.equal(result.summary.rows_analyzed, 10);
});

test('rollupRowsToMonthResult: empty payer/facility sentinel maps back to null', () => {
  const result = rollupRowsToMonthResult(
    [{ payer_name: '', facility_name: '', total_charge: '0', total_allowed: '0', total_paid: '0', charge_line_count: '1' }],
    2026,
    5,
  );
  assert.equal(result.summary.by_payer[0]!.payer_name, null);
  assert.equal(result.by_facility[0]!.facility_name, null);
  // 0 charge → avg rate is null, not a divide-by-zero.
  assert.equal(result.summary.by_payer[0]!.avg_collection_rate, null);
});

// --- cmdPayerMonth (reader over a fake executor) ----------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function makeFake(dataRows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

function ctxWith(executor: QueryExecutor, audit: string[]): CollectionsQueryContext {
  return {
    executor,
    createdBy: 'test',
    now: () => new Date('2026-06-24T00:00:00.000Z'),
    audit: (line) => audit.push(line),
  };
}

test('cmdPayerMonth: exact parameterized SQL, maps result, emits non-PHI audit', async () => {
  const { executor, calls } = makeFake([
    { payer_name: 'ANTHEM', facility_name: 'CAMH', total_charge: '1000', total_allowed: '600', total_paid: '400', charge_line_count: '3' },
  ]);
  const audit: string[] = [];
  const result = await cmdPayerMonth(2026, 5, ctxWith(executor, audit));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sql, cmdPayerMonthSql());
  assert.deepEqual(calls[0]!.params, [2026, 5]);

  assert.equal(result.year, 2026);
  assert.equal(result.month, 5);
  assert.equal(result.summary.by_payer[0]!.payer_name, 'ANTHEM');
  assert.equal(result.by_facility[0]!.facility_name, 'CAMH');

  assert.equal(audit.length, 1);
  const line = JSON.parse(audit[0]!);
  assert.equal(line.event, 'cmd_payer_month');
  assert.deepEqual(line.args_shape, { year: 2026, month: 5, payers: 1, facility_rows: 1 });
  // The audit line carries no payer/facility VALUES — shape counts only.
  assert.ok(!audit[0]!.includes('ANTHEM'));
  assert.ok(!audit[0]!.includes('CAMH'));
});

test('cmdPayerMonth: rejects out-of-range year/month before any query', async () => {
  const { executor, calls } = makeFake([]);
  const audit: string[] = [];
  await assert.rejects(() => cmdPayerMonth(1999, 5, ctxWith(executor, audit)), /year must be an integer/);
  await assert.rejects(() => cmdPayerMonth(2026, 0, ctxWith(executor, audit)), /month must be an integer/);
  await assert.rejects(() => cmdPayerMonth(2026, 13, ctxWith(executor, audit)), /month must be an integer/);
  assert.equal(calls.length, 0);
});
