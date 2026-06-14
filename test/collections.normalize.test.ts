import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeMemberId,
  normalizeMoney,
  normalizePct,
  reconFlags,
} from '../src/collections/normalize.js';

test('money: daily blank/"$ -" -> 0, phi -> null', () => {
  assert.deepEqual(normalizeMoney(' $ -   ', 'daily'), { ok: true, value: '0.00' });
  assert.deepEqual(normalizeMoney('', 'daily'), { ok: true, value: '0.00' });
  assert.deepEqual(normalizeMoney(' $ -   ', 'phi'), { ok: true, value: null });
  assert.deepEqual(normalizeMoney('', 'phi'), { ok: true, value: null });
});

test('money: strips $ and commas, preserves sign, parentheses negative', () => {
  assert.deepEqual(normalizeMoney('$ 5,288.25 ', 'phi'), { ok: true, value: '5288.25' });
  assert.deepEqual(normalizeMoney('-$1,660.05', 'phi'), { ok: true, value: '-1660.05' });
  assert.deepEqual(normalizeMoney('($1,660.05)', 'phi'), { ok: true, value: '-1660.05' });
  assert.equal(normalizeMoney('abc', 'phi').ok, false);
});

test('member id: trims, upper-cases, removes ALL internal whitespace, strips leading -', () => {
  assert.deepEqual(normalizeMemberId('AB1234567 89'), { raw: 'AB1234567 89', norm: 'AB123456789' });
  assert.deepEqual(normalizeMemberId('-11724767'), { raw: '-11724767', norm: '11724767' });
  assert.deepEqual(normalizeMemberId(' pge081 '), { raw: 'pge081', norm: 'PGE081' });
  assert.deepEqual(normalizeMemberId(''), { raw: null, norm: null });
});

test('percentage: strips %, divides by 100; bare number stored as-is', () => {
  assert.deepEqual(normalizePct('24.54%'), { ok: true, value: '0.2454' });
  assert.deepEqual(normalizePct('60.00%'), { ok: true, value: '0.6000' });
  assert.deepEqual(normalizePct('0.33'), { ok: true, value: '0.3300' });
  assert.deepEqual(normalizePct(''), { ok: true, value: null });
  assert.equal(normalizePct('n/a').ok, false);
});

test('recon soft flags never throw and are null when inputs missing', () => {
  assert.deepEqual(reconFlags('100.00', '40.00', '40.00', '60.00'), { recon_ok: true, paid_gt_allowed: false });
  assert.deepEqual(reconFlags('100.00', '30.00', '50.00', '60.00'), { recon_ok: false, paid_gt_allowed: true });
  assert.deepEqual(reconFlags(null, null, null, null), { recon_ok: null, paid_gt_allowed: null });
});
