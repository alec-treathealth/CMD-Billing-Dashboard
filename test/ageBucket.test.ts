import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGE_BUCKETS,
  ageBucketForCharge,
  ageDays,
  bucketForAgeDays,
} from '../src/collections/ageBucket.js';

test('AGE_BUCKETS is the CMD closed set of 8, contiguous and exhaustive', () => {
  assert.equal(AGE_BUCKETS.length, 8);
  assert.deepEqual(
    AGE_BUCKETS.map((b) => b.code),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  );
  // labels are CMD-verbatim (worklist-sheet reconciliation depends on exact strings)
  assert.equal(AGE_BUCKETS[0]!.label, 'a) Less than 30 days');
  assert.equal(AGE_BUCKETS[7]!.label, 'h) Over 1 year');
  // contiguous: each bucket starts one day after the previous ends
  for (let i = 1; i < AGE_BUCKETS.length; i++) {
    const prev = AGE_BUCKETS[i - 1]!;
    assert.notEqual(prev.maxDays, null, `bucket ${prev.code} must be bounded`);
    assert.equal(AGE_BUCKETS[i]!.minDays, prev.maxDays! + 1);
  }
  assert.equal(AGE_BUCKETS[7]!.maxDays, null); // only 'h' is open-ended
});

test('bucketForAgeDays maps every band incl. boundaries', () => {
  const cases: Array<[number, string]> = [
    [0, 'a'], [29, 'a'], [30, 'a'], // day 30 resolves into 'a' (documented boundary)
    [31, 'b'], [60, 'b'],
    [61, 'c'], [90, 'c'],
    [91, 'd'], [120, 'd'],
    [121, 'e'], [150, 'e'],
    [151, 'f'], [180, 'f'],
    [181, 'g'], [365, 'g'],
    [366, 'h'], [10_000, 'h'],
  ];
  for (const [days, code] of cases) {
    assert.equal(bucketForAgeDays(days)?.code, code, `age ${days}d → ${code}`);
  }
});

test('bucketForAgeDays floors fractional days', () => {
  assert.equal(bucketForAgeDays(30.9)?.code, 'a');
  assert.equal(bucketForAgeDays(365.9)?.code, 'g');
});

test('bucketForAgeDays returns null on invalid input (lenient, never throws)', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, -1, -0.5]) {
    assert.equal(bucketForAgeDays(bad as number), null, `${String(bad)} → null`);
  }
});

test('ageDays computes whole days at UTC midnight', () => {
  assert.equal(ageDays('2026-06-28', '2026-07-28'), 30);
  assert.equal(ageDays('2026-07-28', '2026-07-28'), 0);
  assert.equal(ageDays('2025-07-28', '2026-07-28'), 365);
  assert.equal(ageDays('2025-07-27', '2026-07-28'), 366);
});

test('ageDays accepts a Date as-of (normalized to its UTC calendar day)', () => {
  assert.equal(ageDays('2026-06-28', new Date('2026-07-28T23:59:59Z')), 30);
});

test('ageDays is null when either date is absent or unparseable', () => {
  assert.equal(ageDays(null, '2026-07-28'), null);
  assert.equal(ageDays(undefined, '2026-07-28'), null);
  assert.equal(ageDays('', '2026-07-28'), null);
  assert.equal(ageDays('07/28/2026', '2026-07-28'), null); // not ISO
  assert.equal(ageDays('2026-13-40', '2026-07-28'), null); // impossible date
  assert.equal(ageDays('2026-06-28', 'not-a-date'), null);
  assert.equal(ageDays('2026-06-28', new Date('nope')), null);
});

test('ageDays is negative for a future service date (then unbucketed)', () => {
  assert.equal(ageDays('2026-08-28', '2026-07-28'), -31);
  assert.equal(ageBucketForCharge('2026-08-28', '2026-07-28'), null);
});

test('ageBucketForCharge composes date math + bucketing', () => {
  assert.equal(ageBucketForCharge('2026-06-28', '2026-07-28')?.code, 'a'); // 30d
  assert.equal(ageBucketForCharge('2026-01-01', '2026-07-28')?.code, 'g'); // 208d
  assert.equal(ageBucketForCharge('2024-01-01', '2026-07-28')?.code, 'h'); // > 1yr
  assert.equal(ageBucketForCharge(null, '2026-07-28'), null);
});
