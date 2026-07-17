import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  qualifyRating,
  ratingBucket,
  QUALIFY_RATING_PRIOR,
  RATING_OK_MIN,
  RATING_WARN_MIN,
} from '../app/lib/qualify/rating.js';

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('rating: approved worked examples (prior 30, K 50)', () => {
  near(qualifyRating(60, 3)!, 31.6981); // tiny volume, high pct → dampened
  near(qualifyRating(55, 400)!, 52.2222); // real volume, solid pct → near true
  near(qualifyRating(30, 100)!, 30); // typical → sits at the prior
  near(qualifyRating(20, 200)!, 22); // real volume, low pct → red
  near(qualifyRating(45, 30)!, 35.625);
});

test('rating: the ordering invariant (60%@3 must NOT outrank 55%@400 — Q-G ranks by rating)', () => {
  assert.ok(qualifyRating(60, 3)! < qualifyRating(55, 400)!, 'tiny-volume 60% ranks below solid 55%');
});

test('rating: badge buckets follow the approved STRICT cutoffs (26 / 38, applied to the rating)', () => {
  assert.equal(ratingBucket(qualifyRating(55, 400)), 'ok'); // 52.2
  assert.equal(ratingBucket(qualifyRating(60, 3)), 'warn'); // 31.7
  assert.equal(ratingBucket(qualifyRating(20, 200)), 'danger'); // 22
  // Stricter-green decision (2026-07-17): 45%@30 = 35.6 is AMBER, not green — green must mean green
  // on a lead surface. (Under the earlier 34 cutoff this borderline case would have been 'ok'.)
  assert.equal(ratingBucket(qualifyRating(45, 30)), 'warn'); // 35.6 < 38
  // exact boundaries
  assert.equal(ratingBucket(RATING_OK_MIN), 'ok');
  assert.equal(ratingBucket(RATING_OK_MIN - 0.01), 'warn');
  assert.equal(ratingBucket(RATING_WARN_MIN), 'warn');
  assert.equal(ratingBucket(RATING_WARN_MIN - 0.01), 'danger');
});

test('rating: null pct → null → neutral (never a fabricated prior-colored badge)', () => {
  assert.equal(qualifyRating(null, 100), null);
  assert.equal(ratingBucket(null), 'neutral');
});

test('rating: lineCount 0 → the pure prior (defensive); large n → converges to raw pct', () => {
  assert.equal(qualifyRating(85, 0), QUALIFY_RATING_PRIOR); // no volume → prior
  near(qualifyRating(55, 1_000_000)!, 55, 0.01); // n >> K → shrink vanishes
});

test('rating: monotone in pct for fixed n (pct stays the dominant driver of order)', () => {
  const n = 50;
  assert.ok(qualifyRating(40, n)! < qualifyRating(60, n)!);
  assert.ok(qualifyRating(60, n)! < qualifyRating(80, n)!);
});

test('rating: output clamped to [0,100]', () => {
  assert.equal(qualifyRating(200, 100_000), 100); // allowed > billed edge → clamp
  assert.ok(qualifyRating(0, 100)! >= 0);
});
