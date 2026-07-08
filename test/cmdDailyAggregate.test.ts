/**
 * Hermetic tests for the CMD daily-deposit aggregation (aggregateDailyDeposits) and the
 * customer→facility map (CMD_EXPLORER_CUSTOMERS). No DB, no network, no PHI.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateDailyDeposits, dropFuturePaymentRows } from '../src/collections/cmdExplorer.js';
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

test('dropFuturePaymentRows: drops future Payment Received dates; keeps today, past, and blank', () => {
  const today = '2026-07-08';
  const rows = [
    row({ 'Payment Received': '2026-07-08', 'Check Payment': '$1.00' }), //  today → keep
    row({ 'Payment Received': '01/02/2026', 'Check Payment': '$1.00' }), //  past  → keep
    row({ 'Payment Received': '', 'Check Payment': '$1.00' }), //            blank → keep (unpaid line)
    row({ 'Payment Received': '2026-07-09', 'Check Payment': '$1.00' }), //  tomorrow → drop
    row({ 'Payment Received': '12/30/2026', 'Check Payment': '$1.00' }), //  far future → drop (the bug)
  ];
  const { kept, dropped } = dropFuturePaymentRows(rows, today);
  assert.equal(dropped, 2);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((r) => r['Payment Received']),
    ['2026-07-08', '01/02/2026', ''],
  );
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
