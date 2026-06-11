import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coerceRow,
  normalizeCode,
  normalizeDate,
  normalizeMemberId,
  normalizeMoney,
  normalizeOptionalText,
  splitPatientName,
} from '../src/normalize.js';
import { buildColumnOrder, toRawRow } from '../src/sheets.js';
import {
  HEADER_2024,
  HEADER_2025,
  ROW_BAD_DATE_2024,
  ROW_BAD_MONEY_2025,
  ROW_COVENANT_HILLS_2024,
  ROW_TRUNCATED_2025,
  ROW_VANGUARD_2024,
} from './fixtures.js';

const ORDER_2024 = buildColumnOrder(HEADER_2024);
const ORDER_2025 = buildColumnOrder(HEADER_2025);
const ctx = { source_file_id: 'FIXTURE', source_row_num: 2, source_year: 2024 };

test('money: confirmed real FORMATTED_VALUE negative form "-$1,660.05" parses', () => {
  // Real 2026 data renders the minus OUTSIDE the dollar sign. This is the
  // canonical fixture form.
  assert.deepEqual(normalizeMoney('-$1,660.05'), { ok: true, value: '-1660.05' });
  // Robustness: the alternate placement also parses (strip of $/, is
  // order-independent), so a stray "$-1,660.05" can't silently misparse.
  assert.deepEqual(normalizeMoney('$-1,660.05'), { ok: true, value: '-1660.05' });
});

test('money: positives, thousands, parens-negative, blank, bad', () => {
  assert.deepEqual(normalizeMoney('$1,200.00'), { ok: true, value: '1200.00' });
  assert.deepEqual(normalizeMoney('$1,234,567.89'), { ok: true, value: '1234567.89' });
  assert.deepEqual(normalizeMoney('800'), { ok: true, value: '800.00' });
  assert.deepEqual(normalizeMoney('($500.00)'), { ok: true, value: '-500.00' });
  assert.deepEqual(normalizeMoney('   '), { ok: true, value: null });
  assert.deepEqual(normalizeMoney(''), { ok: true, value: null });
  assert.equal(normalizeMoney('abc').ok, false);
  assert.equal(normalizeMoney('$1.2.3').ok, false);
});

test('date: M/D/YYYY and MM/DD/YYYY both accepted; ISO output', () => {
  assert.deepEqual(normalizeDate('3/5/2024'), { ok: true, value: '2024-03-05' });
  assert.deepEqual(normalizeDate('03/12/2024'), { ok: true, value: '2024-03-12' });
  assert.deepEqual(normalizeDate('12/31/2025'), { ok: true, value: '2025-12-31' });
  assert.deepEqual(normalizeDate(''), { ok: true, value: null });
});

test('date: invalid calendar / wrong format / out of range fail', () => {
  assert.equal(normalizeDate('2/30/2024').ok, false); // Feb 30
  assert.equal(normalizeDate('13/1/2024').ok, false); // month 13
  assert.equal(normalizeDate('2024-03-05').ok, false); // ISO not accepted as input
  assert.equal(normalizeDate('3/5/24').ok, false); // 2-digit year
});

test('codes: blank -> NULL, never empty string', () => {
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode('   '), null);
  assert.equal(normalizeCode(' H0015 '), 'H0015');
});

test('optional text: blank -> NULL', () => {
  assert.equal(normalizeOptionalText(''), null);
  assert.equal(normalizeOptionalText('GRP123'), 'GRP123');
});

test('member id: numeric negative -> abs norm; alphanumeric kept as-is, upper', () => {
  // Numeric negatives drop the leading '-' (absolute value for matching).
  assert.deepEqual(normalizeMemberId('-11724767'), { raw: '-11724767', norm: '11724767' });
  // Real alphanumeric id (2026) — stored as-is, upper-cased, NO abs() applied.
  assert.deepEqual(normalizeMemberId('PGE081'), { raw: 'PGE081', norm: 'PGE081' });
  assert.deepEqual(normalizeMemberId(' pge081 '), { raw: 'pge081', norm: 'PGE081' });
  assert.deepEqual(normalizeMemberId(''), { raw: null, norm: null });
});

test('patient name: split on FIRST comma', () => {
  assert.deepEqual(splitPatientName('SMITH, JOHN'), { last: 'SMITH', first: 'JOHN' });
  assert.deepEqual(splitPatientName("O'BRIEN, MARY ANN"), { last: "O'BRIEN", first: 'MARY ANN' });
  assert.deepEqual(splitPatientName('SMITH, JR, JOHN'), { last: 'SMITH', first: 'JR, JOHN' });
  assert.deepEqual(splitPatientName('MADONNA'), { last: 'MADONNA', first: '' });
});

test('coerceRow: Covenant Hills 2024 — blank codes -> NULL, negative member -> positive norm', () => {
  const res = coerceRow(toRawRow(ROW_COVENANT_HILLS_2024, ORDER_2024), ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.claim.hcpcs_code, null);
  assert.equal(res.claim.revenue_code, null);
  assert.equal(res.claim.member_id_raw, '-11724767');
  assert.equal(res.claim.member_id_norm, '11724767');
  assert.equal(res.claim.date_of_service, '2024-03-05');
  assert.equal(res.claim.patient_last, 'SMITH');
  assert.equal(res.claim.patient_first, 'JOHN');
});

test('coerceRow: Vanguard embedded comma did NOT shift money/payer columns', () => {
  const res = coerceRow(toRawRow(ROW_VANGUARD_2024, ORDER_2024), ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.claim.employer_name, 'THE VANGUARD GROUP, INC.');
  assert.equal(res.claim.charge_amount, '3500.00');
  assert.equal(res.claim.allowed_amount, '-1660.05'); // negative money survived
  assert.equal(res.claim.paid_amount, '2000.00');
  assert.equal(res.claim.payer_name, 'Anthem Blue Cross'); // not shifted
  assert.equal(res.claim.date_of_service, '2024-03-12');
});

test('coerceRow: truncated row -> blank required payer is a coercion failure', () => {
  const res = coerceRow(toRawRow(ROW_TRUNCATED_2025, ORDER_2025), {
    ...ctx,
    source_year: 2025,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.failures.some((f) => f.column === 'payer_name' && /blank/.test(f.reason)));
});

test('coerceRow: unparseable money is reported and row skipped', () => {
  const res = coerceRow(toRawRow(ROW_BAD_MONEY_2025, ORDER_2025), { ...ctx, source_year: 2025 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  const f = res.failures.find((x) => x.column === 'charge_debit_amount');
  assert.ok(f);
  assert.equal(f?.raw_value, 'abc');
});

test('coerceRow: invalid calendar date is reported and row skipped', () => {
  const res = coerceRow(toRawRow(ROW_BAD_DATE_2024, ORDER_2024), ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.failures.some((f) => f.column === 'date_of_service'));
});

test('coerceRow: failure carries full report shape {file,row,column,raw,reason}', () => {
  const res = coerceRow(toRawRow(ROW_BAD_MONEY_2025, ORDER_2025), { ...ctx, source_year: 2025 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  const f = res.failures[0]!;
  assert.deepEqual(Object.keys(f).sort(), [
    'column',
    'raw_value',
    'reason',
    'source_file_id',
    'source_row_num',
  ]);
});
