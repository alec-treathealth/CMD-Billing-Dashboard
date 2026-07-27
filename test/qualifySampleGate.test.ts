import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ratingSampleTier,
  ratingEvidencePips,
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

// ── EVIDENCE GAUGE pip count (readout) — breakpoints derive from the 3/10 gate thresholds ────────────
test('ratingEvidencePips: 0 clients → 0 pips (no matches)', () => {
  assert.equal(ratingEvidencePips(0), 0);
});

test('ratingEvidencePips: 1-2 (insufficient) → 1 pip', () => {
  for (const n of [1, 2]) assert.equal(ratingEvidencePips(n), 1, `${n} → 1`);
});

test('ratingEvidencePips: 3-9 (thin) → 2 pips (both boundaries)', () => {
  for (const n of [3, 4, 9]) assert.equal(ratingEvidencePips(n), 2, `${n} → 2`);
});

test('ratingEvidencePips: 10-29 (full) → 3 pips (both boundaries)', () => {
  for (const n of [10, 11, 29]) assert.equal(ratingEvidencePips(n), 3, `${n} → 3`);
});

test('ratingEvidencePips: >= 30 (3× confident floor) → 4 pips', () => {
  for (const n of [30, 41, 100, 5000]) assert.equal(ratingEvidencePips(n), 4, `${n} → 4`);
});

test('ratingEvidencePips: pip breakpoints stay pinned to the gate thresholds (loud on a change)', () => {
  // 3rd pip lights at the confident floor; 4th at 3× it — so the pips and rating suppression move together.
  assert.equal(ratingEvidencePips(QUALIFY_RATING_MIN_PATIENTS), 2, 'MIN_PATIENTS → thin → 2 pips');
  assert.equal(ratingEvidencePips(QUALIFY_RATING_CONFIDENT_PATIENTS), 3, 'CONFIDENT_PATIENTS → full → 3 pips');
  assert.equal(ratingEvidencePips(QUALIFY_RATING_CONFIDENT_PATIENTS * 3), 4, '3× CONFIDENT → 4 pips');
});

test('ratingEvidencePips: non-finite / negative / fractional → floor toward fewer pips', () => {
  for (const n of [Number.NaN, -1, -100, Number.NEGATIVE_INFINITY]) assert.equal(ratingEvidencePips(n as number), 0);
  assert.equal(ratingEvidencePips(2.9), 1, '2.9 truncates to 2 → 1 pip');
  assert.equal(ratingEvidencePips(9.9), 2, '9.9 truncates to 9 → 2 pips');
});
