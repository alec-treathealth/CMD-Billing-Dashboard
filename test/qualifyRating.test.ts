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

test('rating: approved worked examples (prior 30, K 25 — reweighted 2026-07-18)', () => {
  near(qualifyRating(60, 3)!, 33.2143); // tiny volume, high pct → still dampened (amber)
  near(qualifyRating(55, 400)!, 53.5294); // real volume, solid pct → near true (green)
  near(qualifyRating(30, 100)!, 30); // typical → sits at the prior
  near(qualifyRating(20, 200)!, 21.1111); // real volume, low pct → red
  near(qualifyRating(45, 30)!, 38.1818); // borderline → amber (< 40 green cut)
});

test('rating: ordering invariant — a tiny-volume high-pct cell can neither outrank NOR out-color a solid one (Q-G ranks by rating; MUST fail the build if K/cutoffs regress it)', () => {
  const tinyHigh = qualifyRating(60, 3)!; // 60% earned on only 3 lines — the classic false-positive shape
  const solid = qualifyRating(55, 400)!; // 55% earned on real volume
  // (1) rank: the tiny-volume high-pct cell must sort BELOW the solid one.
  assert.ok(tinyHigh < solid, `tiny-volume 60%@3 (${tinyHigh}) must rank below solid 55%@400 (${solid})`);
  // (2) color: and it must NOT wear the same green. Asserted THROUGH ratingBucket, which reads
  //     RATING_OK_MIN / RATING_WARN_MIN — no rating threshold is hardcoded here, so lowering K or
  //     moving the cutoffs far enough to break the property fails THIS assertion automatically.
  assert.notEqual(ratingBucket(tinyHigh), 'ok', 'a tiny-volume high-pct cell must never read green');
  assert.equal(ratingBucket(solid), 'ok', 'a solid cell must still read green');
});

test('rating: badge buckets follow the approved STRICT cutoffs (25 / 40, applied to the rating)', () => {
  assert.equal(ratingBucket(qualifyRating(55, 400)), 'ok'); // 53.5
  assert.equal(ratingBucket(qualifyRating(60, 3)), 'warn'); // 33.2
  assert.equal(ratingBucket(qualifyRating(20, 200)), 'danger'); // 21.1
  // Stricter-green decision (recalibrated 2026-07-18): 45%@30 = 38.2 is AMBER, not green — green must
  // mean green on a lead surface. (Under the 40 green cut this borderline case stays 'warn'.)
  assert.equal(ratingBucket(qualifyRating(45, 30)), 'warn'); // 38.2 < 40
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
