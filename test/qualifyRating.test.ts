import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  qualifyRating,
  ratingBucket,
  explainRating,
  RATING_OK_MIN,
  RATING_WARN_MIN,
  QUALIFY_MIN_LINES,
  QUALIFY_LIMITED_DATA_LINES,
} from '../app/lib/qualify/rating.js';

test('rating: the score IS the allowed% (clamped) — volume never bends it (value-first, 2026-07-19b)', () => {
  assert.equal(qualifyRating(71), 71);
  assert.equal(qualifyRating(90), 90); // a 90% reads 90 no matter how small the facility is
  assert.equal(qualifyRating(55), 55);
  assert.equal(qualifyRating(20), 20);
  assert.equal(qualifyRating(0), 0);
});

test('rating: a small high-% facility scores ABOVE a large mid-% one (the whole point of the model)', () => {
  // No volume term → 90% simply beats 71%; ranking is by merit, not size.
  assert.ok(qualifyRating(90)! > qualifyRating(71)!);
  assert.equal(ratingBucket(qualifyRating(90)), 'ok'); // and it wears green
});

test('rating: null / NaN pct → null → neutral (never a fabricated badge)', () => {
  assert.equal(qualifyRating(null), null);
  assert.equal(qualifyRating(NaN), null);
  assert.equal(ratingBucket(null), 'neutral');
});

test('rating: clamped to [0,100] (allowed > billed edge, and never negative)', () => {
  assert.equal(qualifyRating(200), 100);
  assert.equal(qualifyRating(-5), 0);
});

test('rating: badge buckets on the allowed% (ok ≥ 50, warn 30–50, danger < 30)', () => {
  assert.equal(ratingBucket(qualifyRating(90)), 'ok'); // 90
  assert.equal(ratingBucket(qualifyRating(50)), 'ok'); // boundary
  assert.equal(ratingBucket(qualifyRating(42)), 'warn'); // 42
  assert.equal(ratingBucket(qualifyRating(30)), 'warn'); // boundary
  assert.equal(ratingBucket(qualifyRating(20)), 'danger'); // 20
  // exact boundaries, asserted through the exported constants
  assert.equal(ratingBucket(RATING_OK_MIN), 'ok');
  assert.equal(ratingBucket(RATING_OK_MIN - 0.01), 'warn');
  assert.equal(ratingBucket(RATING_WARN_MIN), 'warn');
  assert.equal(ratingBucket(RATING_WARN_MIN - 0.01), 'danger');
});

test('explainRating: value-first sentence; flags "limited data" below the soft threshold', () => {
  const thin = explainRating(90, 4); // below QUALIFY_LIMITED_DATA_LINES
  assert.equal(thin.rawPct, 90);
  assert.equal(thin.lineCount, 4);
  assert.equal(thin.limitedData, true);
  assert.match(thin.sentence, /90% allowed/);
  assert.match(thin.sentence, /small sample|early signal/);

  const solid = explainRating(55, 400); // well above the soft threshold
  assert.equal(solid.limitedData, false);
  assert.match(solid.sentence, /55% allowed/);
  assert.match(solid.sentence, /400 claim lines/);

  const none = explainRating(null, 5);
  assert.equal(none.rawPct, null);
  assert.match(none.sentence, /neutral/);
});

test('floor + limited-data constants are sane (floor kills flukes; the soft flag sits above it)', () => {
  assert.ok(QUALIFY_MIN_LINES >= 1);
  assert.ok(QUALIFY_LIMITED_DATA_LINES >= QUALIFY_MIN_LINES);
});
