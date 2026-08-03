/**
 * Hermetic tests for the CMD daily-deposit aggregation (aggregateDailyDeposits) and the
 * customer→facility map (CMD_EXPLORER_CUSTOMERS). No DB, no network, no PHI.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateDailyDeposits,
  dropFuturePaymentRows,
  FUTURE_PAYMENT_HORIZON_DAYS,
} from '../src/collections/cmdExplorer.js';
import { CMD_EXPLORER_CUSTOMERS } from '../src/collections/cmdCustomers.js';
import { FACILITY_CODES } from '../src/collections/config.js';

const row = (o: Record<string, string>): Record<string, string> => o;

test('aggregateDailyDeposits: sums check+eft by payment date; skips no-date and zero-deposit days', () => {
  const rows = [
    row({ 'Payment Received': '01/14/2026', 'Check Payment': '$100.00', 'EFT Payment': '$0.00' }),
    row({ 'Payment Received': '01/14/2026', 'Check Payment': '$0.00', 'EFT Payment': '$50.00' }),
    row({ 'Payment Received': '2026-01-15', 'Check Payment': '$0.00', 'EFT Payment': '$200.00' }),
    row({ 'Payment Received': '', 'Check Payment': '$999.00', 'EFT Payment': '$0.00' }), //   no date → skip
    row({ 'Payment Received': '01/16/2026', 'Check Payment': '$0.00', 'EFT Payment': '$0.00' }), // $0 → skip
  ];
  assert.deepEqual(aggregateDailyDeposits(rows, 'CAMH'), [
    { facility_code: 'CAMH', payment_date: '2026-01-14', checks_amount: '100.00', eft_amount: '50.00', gross_amount: '150.00' },
    { facility_code: 'CAMH', payment_date: '2026-01-15', checks_amount: '0.00', eft_amount: '200.00', gross_amount: '200.00' },
  ]);
});

test('aggregateDailyDeposits: preserves reversals (parenthesized negatives) and sorts by date', () => {
  const out = aggregateDailyDeposits(
    [
      row({ 'Payment Received': '03/02/2026', 'Check Payment': '($25.00)', 'EFT Payment': '$0.00' }),
      row({ 'Payment Received': '03/01/2026', 'Check Payment': '$10.00', 'EFT Payment': '$5.00' }),
    ],
    'DMH',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]?.payment_date, '2026-03-01');
  assert.equal(out[1]?.payment_date, '2026-03-02');
  assert.equal(out[1]?.gross_amount, '-25.00');
});

test('aggregateDailyDeposits: empty input → no rows', () => {
  assert.deepEqual(aggregateDailyDeposits([], 'TBH'), []);
});

// CONTRACT CHANGED 2026-08-02: the guard was "drop anything after today", which also discarded
// CMD's real forward-dated deposits (live Indigo held 08/03-08/05 rows worth six figures on
// 08/02). It is now a HORIZON: near-future rows are ingested, and whether a surface SHOWS them is
// a read-side decision. The typo class this guard exists for still gets dropped.
test('dropFuturePaymentRows: keeps near-future rows inside the horizon; still drops the typo class', () => {
  const today = '2026-07-08'; // horizon 14 ⇒ cutoff 2026-07-22
  const rows = [
    row({ 'Payment Received': '2026-07-08', 'Check Payment': '$1.00' }), //  today → keep
    row({ 'Payment Received': '01/02/2026', 'Check Payment': '$1.00' }), //  past  → keep
    row({ 'Payment Received': '', 'Check Payment': '$1.00' }), //            blank → keep (unpaid line)
    row({ 'Payment Received': '2026-07-09', 'Check Payment': '$1.00' }), //  tomorrow → KEEP (real deposit)
    row({ 'Payment Received': '12/30/2026', 'Check Payment': '$1.00' }), //  far future → drop (the bug)
  ];
  const { kept, dropped } = dropFuturePaymentRows(rows, today, 14);
  assert.equal(dropped, 1, 'only the far-future typo is dropped');
  assert.deepEqual(
    kept.map((r) => r['Payment Received']),
    ['2026-07-08', '01/02/2026', '', '2026-07-09'],
  );
});

test('dropFuturePaymentRows: the horizon boundary is inclusive, the day past it is not', () => {
  const today = '2026-07-08';
  const rows = [
    row({ 'Payment Received': '2026-07-22', 'Check Payment': '$1.00' }), // exactly +14 → keep
    row({ 'Payment Received': '2026-07-23', 'Check Payment': '$1.00' }), // +15        → drop
  ];
  const { kept, dropped } = dropFuturePaymentRows(rows, today, 14);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((r) => r['Payment Received']), ['2026-07-22']);
});

test('dropFuturePaymentRows: horizon crosses a month boundary by real calendar days', () => {
  // Guards against a naive "same month" or string-slice implementation.
  const rows = [row({ 'Payment Received': '2026-08-05', 'Check Payment': '$1.00' })];
  assert.equal(dropFuturePaymentRows(rows, '2026-07-31', 14).dropped, 0, '+5 days across the month end is inside');
  assert.equal(dropFuturePaymentRows(rows, '2026-07-08', 14).dropped, 1, '+28 days is outside');
});

test('dropFuturePaymentRows: the SHIPPED default is the 14-day horizon', () => {
  // The paired read-split (futurePaymentBound in daily.ts) is what makes ingesting these rows
  // safe: Collections bounds at today, Overview does not. Setting this back to 0 is the kill
  // switch if forward-dated deposits prove unreliable.
  const rows = [row({ 'Payment Received': '2026-07-09', 'Check Payment': '$1.00' })];
  assert.equal(FUTURE_PAYMENT_HORIZON_DAYS, 14);
  assert.equal(dropFuturePaymentRows(rows, '2026-07-08').dropped, 0, 'tomorrow is real money, keep it');
  assert.equal(
    dropFuturePaymentRows([row({ 'Payment Received': '12/30/2026', 'Check Payment': '$1.00' })], '2026-07-08').dropped,
    1,
    'the typo class is still dropped',
  );
});

test('dropFuturePaymentRows: horizon 0 restores the original strict today-cutoff', () => {
  const rows = [
    row({ 'Payment Received': '2026-07-08', 'Check Payment': '$1.00' }),
    row({ 'Payment Received': '2026-07-09', 'Check Payment': '$1.00' }),
  ];
  const { kept, dropped } = dropFuturePaymentRows(rows, '2026-07-08', 0);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((r) => r['Payment Received']), ['2026-07-08']);
});

test('dropFuturePaymentRows: guarded rows never reach daily aggregation (future gross excluded)', () => {
  const today = '2026-07-08';
  const rows = [
    row({ 'Payment Received': '07/07/2026', 'Check Payment': '$100.00', 'EFT Payment': '$0.00' }),
    row({ 'Payment Received': '12/30/2026', 'Check Payment': '$33705.00', 'EFT Payment': '$0.00' }),
  ];
  const { kept } = dropFuturePaymentRows(rows, today);
  const daily = aggregateDailyDeposits(kept, '10028595');
  assert.equal(daily.length, 1);
  assert.equal(daily[0]?.payment_date, '2026-07-07');
  assert.equal(daily.some((d) => d.payment_date >= '2026-12-01'), false, 'no December row survives the guard');
});

test('CMD_EXPLORER_CUSTOMERS: 15 unique customers → real, unique facility codes', () => {
  assert.equal(CMD_EXPLORER_CUSTOMERS.length, 15);
  assert.equal(new Set(CMD_EXPLORER_CUSTOMERS.map((c) => c.customerId)).size, 15, 'customer ids unique');
  assert.equal(new Set(CMD_EXPLORER_CUSTOMERS.map((c) => c.facilityCode)).size, 15, 'facility codes unique');
  for (const c of CMD_EXPLORER_CUSTOMERS) {
    assert.ok(FACILITY_CODES.has(c.facilityCode), `${c.facilityCode} is a seeded facility code`);
    assert.ok(/^\d+$/.test(c.customerId), `${c.customerId} is a numeric customer id`);
  }
});
