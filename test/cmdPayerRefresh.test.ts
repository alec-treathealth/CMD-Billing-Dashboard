import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_SIZE,
  filterTuplesToWindow,
  refreshCmdPayerRollup,
  windowMonths,
} from '../src/collections/cmdPayerRefresh.js';
import type { RollupTuple } from '../src/collections/cmdPayerIngest.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';
import type { Db } from '../src/collections/db.js';

const tuple = (year: number, month: number, payer = 'ANTHEM', facility = 'CAMH'): RollupTuple => ({
  payer_name: payer,
  facility_name: facility,
  service_year: year,
  service_month: month,
  total_charge: 100,
  total_allowed: 60,
  total_paid: 40,
  charge_line_count: 1,
});

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

// --- windowMonths -----------------------------------------------------------

test('windowMonths: current month + prior (newest first), default size', () => {
  // 2026-06-24 (UTC); default window is current + 2 prior.
  const w = windowMonths(new Date('2026-06-24T08:00:00Z'));
  assert.equal(DEFAULT_WINDOW_SIZE, 3);
  assert.deepEqual(w, [
    { year: 2026, month: 6 },
    { year: 2026, month: 5 },
    { year: 2026, month: 4 },
  ]);
});

test('windowMonths: wraps across the year boundary', () => {
  const w = windowMonths(new Date('2026-01-15T08:00:00Z'), 3);
  assert.deepEqual(w, [
    { year: 2026, month: 1 },
    { year: 2025, month: 12 },
    { year: 2025, month: 11 },
  ]);
});

test('windowMonths: size is clamped to at least 1', () => {
  assert.deepEqual(windowMonths(new Date('2026-06-10T00:00:00Z'), 0), [{ year: 2026, month: 6 }]);
  assert.deepEqual(windowMonths(new Date('2026-06-10T00:00:00Z'), -5), [{ year: 2026, month: 6 }]);
});

test('windowMonths: uses UTC (late-day local does not roll the month)', () => {
  // 2026-03-31T23:00Z is still March in UTC.
  assert.equal(windowMonths(new Date('2026-03-31T23:00:00Z'), 1)[0]!.month, 3);
});

// --- filterTuplesToWindow ---------------------------------------------------

test('filterTuplesToWindow: keeps only in-window months', () => {
  const months = [
    { year: 2026, month: 6 },
    { year: 2026, month: 5 },
  ];
  const kept = filterTuplesToWindow(
    [tuple(2026, 6), tuple(2026, 5), tuple(2026, 4), tuple(2025, 6)],
    months,
  );
  assert.deepEqual(
    kept.map((t) => `${t.service_year}-${t.service_month}`).sort(),
    ['2026-5', '2026-6'],
  );
});

// --- refreshCmdPayerRollup (orchestration) ----------------------------------

/** Fake Db that records the months deleted and tuples inserted by writeRollup. */
function fakeDb(): { db: Db; deletedPairs: Array<[number, number]>; insertedCount: number } {
  const deletedPairs: Array<[number, number]> = [];
  let insertedCount = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (/^\s*delete/i.test(sql) && params) {
        for (let i = 0; i < params.length; i += 2) {
          deletedPairs.push([Number(params[i]), Number(params[i + 1])]);
        }
        return { rowCount: 0, rows: [] };
      }
      if (/^\s*insert/i.test(sql) && params) {
        // 8 columns per row in writeRollup's INSERT.
        const n = params.length / 8;
        insertedCount += n;
        return { rowCount: n, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const db = { connect: async () => client } as unknown as Db;
  return { db, get deletedPairs() { return deletedPairs; }, get insertedCount() { return insertedCount; } };
}

test('refreshCmdPayerRollup: writes only windowed months, returns non-PHI stats', async () => {
  const fake = fakeDb();
  // Live report spans in-window (June, May 2026) and out-of-window (Jan 2026) months.
  const rows: CmdReportRow[] = [
    row({ 'Charge From Date': '06/03/2026', 'Charge Primary Payer Name': 'ANTHEM', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '$1,000.00', 'Payment Allowed Amount': '$600.00', 'Charge Insurance Payments': '$400.00' }),
    row({ 'Charge From Date': '05/12/2026', 'Charge Primary Payer Name': 'CIGNA', 'Facility Name': 'BHOP', 'Charge/Debit Amount': '$500.00', 'Payment Allowed Amount': '$300.00', 'Charge Insurance Payments': '$250.00' }),
    row({ 'Charge From Date': '01/09/2026', 'Charge Primary Payer Name': 'AETNA', 'Facility Name': 'CAMH', 'Charge/Debit Amount': '$900.00', 'Payment Allowed Amount': '$500.00', 'Charge Insurance Payments': '$450.00' }),
  ];

  const stats = await refreshCmdPayerRollup({
    fetchRows: async () => rows,
    writeDb: fake.db,
    now: new Date('2026-06-24T08:00:00Z'), // window: Jun, May, Apr 2026
    windowSize: 3,
  });

  // Jan 2026 is outside the window — never touched (not deleted, not counted).
  assert.deepEqual(stats.months, ['2026-05', '2026-06']);
  assert.equal(stats.rows_fetched, 3);
  assert.equal(stats.rollup_rows_written, 2);
  assert.equal(stats.distinct_payers, 2);
  assert.equal(stats.distinct_facilities, 2);

  const deleted = fake.deletedPairs.map(([y, m]) => `${y}-${m}`).sort();
  assert.deepEqual(deleted, ['2026-5', '2026-6']);
  assert.ok(!deleted.includes('2026-1'), 'out-of-window month must not be deleted');
  assert.equal(fake.insertedCount, 2);
});

test('refreshCmdPayerRollup: empty live report writes nothing', async () => {
  const fake = fakeDb();
  const stats = await refreshCmdPayerRollup({
    fetchRows: async () => [],
    writeDb: fake.db,
    now: new Date('2026-06-24T08:00:00Z'),
  });
  assert.deepEqual(stats.months, []);
  assert.equal(stats.rollup_rows_written, 0);
  assert.equal(fake.deletedPairs.length, 0, 'no months to refresh => no deletes');
});
