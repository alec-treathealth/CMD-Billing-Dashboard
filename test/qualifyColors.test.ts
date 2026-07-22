import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFacilityBucketMap, caseBucket, bucketClass } from '../app/components/qualify/colors.js';
import { qualifyRating, ratingBucket } from '../app/lib/qualify/rating.js';
import type { QualifyFacility } from '../app/lib/qualify/contract.js';

/** Minimal QualifyFacility with rating computed from (pct, lineCount) exactly as the action does. */
function fac(name: string, pct: number | null, lineCount: number, rank = 1): QualifyFacility {
  return {
    rank,
    name,
    facilityKey: name.toLowerCase(),
    city: null,
    state: null,
    pctAllowedOfBilled: pct,
    rating: qualifyRating(pct),
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount,
    confirmedClaims: lineCount, // neutral coverage: everything confirmed (Phase-1 tests vary this)
    estimateClaims: 0,
    unknownClaims: 0,
    careSetting: null,
  };
}

test('bucketClass maps each bucket to its namespaced status class', () => {
  assert.equal(bucketClass('ok'), 'q-ok');
  assert.equal(bucketClass('warn'), 'q-warn');
  assert.equal(bucketClass('danger'), 'q-danger');
  assert.equal(bucketClass('neutral'), 'q-neutral');
});

test('buildFacilityBucketMap keys by facility name → its rating bucket (= allowed% band, value-first)', () => {
  const solid = fac('SOLID', 55, 400); // 55% → ok
  const high = fac('HIGH', 90, 4); // 90% → ok — value-first: a small high-% facility still reads GREEN
  const mid = fac('MID', 42, 200); // 42% → warn
  const map = buildFacilityBucketMap([solid, high, mid]);
  assert.equal(map.get('SOLID'), 'ok');
  assert.equal(map.get('HIGH'), 'ok');
  assert.equal(map.get('MID'), 'warn');
  assert.equal(ratingBucket(high.rating), 'ok'); // 90% is green regardless of volume
});

test('a case inherits its parent facility bucket; unknown/absent parent → neutral (never raw pct)', () => {
  const map = buildFacilityBucketMap([fac('SOLID', 55, 400)]);
  assert.equal(caseBucket(map, 'SOLID'), 'ok');
  assert.equal(caseBucket(map, 'NOT LISTED'), 'neutral');
  assert.equal(caseBucket(map, null), 'neutral');
});

test('name collision with DISAGREEING buckets resolves to neutral — a case can never fake green', () => {
  const green = fac('DUPE', 60, 500); // ok
  const red = fac('DUPE', 12, 500); // danger
  assert.equal(ratingBucket(green.rating), 'ok');
  assert.equal(ratingBucket(red.rating), 'danger');
  const map = buildFacilityBucketMap([green, red]);
  assert.equal(map.get('DUPE'), 'neutral'); // ambiguous → neutral, NOT the greener one
  assert.equal(caseBucket(map, 'DUPE'), 'neutral');
});

test('name collision with AGREEING buckets keeps that bucket', () => {
  const map = buildFacilityBucketMap([fac('SAME', 55, 400), fac('SAME', 58, 500)]); // both ok
  assert.equal(map.get('SAME'), 'ok');
});
