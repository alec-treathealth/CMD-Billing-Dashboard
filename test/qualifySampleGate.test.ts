import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ratingSampleTier,
  QUALIFY_RATING_MIN_PATIENTS,
  QUALIFY_RATING_CONFIDENT_PATIENTS,
} from '../app/lib/qualify/sampleGate.js';

// The ONE distinct-patient gate both the ranking (hotfix), the KPI tiles, and BOTH surfaces
// (desktop + mobile) consume — so desktop/mobile parity rests on this single boundary function.
// Locking it here means a threshold change is a loud, deliberate edit.

test('sampleGate thresholds are the ratified 3 / 10', () => {
  assert.equal(QUALIFY_RATING_MIN_PATIENTS, 3);
  assert.equal(QUALIFY_RATING_CONFIDENT_PATIENTS, 10);
});

test('ratingSampleTier: < 3 patients → insufficient (boundary at 3)', () => {
  for (const n of [0, 1, 2]) assert.equal(ratingSampleTier(n), 'insufficient', `${n} patients → insufficient`);
});

test('ratingSampleTier: 3-9 patients → thin (both boundaries)', () => {
  for (const n of [3, 4, 9]) assert.equal(ratingSampleTier(n), 'thin', `${n} patients → thin`);
});

test('ratingSampleTier: >= 10 patients → full', () => {
  for (const n of [10, 11, 100, 5000]) assert.equal(ratingSampleTier(n), 'full', `${n} patients → full`);
});

test('ratingSampleTier: non-finite / negative fails TOWARD suppression (never a false-confident tier)', () => {
  for (const n of [Number.NaN, -1, -5, Number.POSITIVE_INFINITY < 0 ? 0 : -0]) {
    // -0, NaN, negatives all clamp to 0 → insufficient
    assert.equal(ratingSampleTier(n as number), 'insufficient');
  }
  assert.equal(ratingSampleTier(2.9), 'insufficient', '2.9 truncates to 2 → insufficient');
  assert.equal(ratingSampleTier(3.9), 'thin', '3.9 truncates to 3 → thin');
});
