/**
 * Pure-module tests for the Collections (CPT × Revenue-code) ranking + facility confidence scoring
 * (src/collections/comboRanking.ts).
 *
 * THE REFERENCE FIXTURE: the eight combos from the WP3 build spec (2026-08-31), with n and
 * observed %-allowed quoted verbatim from the reference drill-in. The reference CHARGED dollars
 * were not quoted, so they are reconstructed here from the spec's own S targets — validated two
 * ways: (1) sorted by charge DESC they reproduce the spec's "was" (pre-ranking) order exactly, and
 * (2) for the four CPTs with a single visible combo the pooled prior collapses to a_obs, making S
 * construction-independent — those four S values are asserted against the spec's targets to ±2.
 * The full 1→8 expected ORDER is the load-bearing contract and is asserted exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMBO_SHRINKAGE_K,
  CONFIDENCE_MIN_LINES,
  comboScore,
  confidenceBand,
  confidenceComposite,
  facilityConfidence,
  perCptPriors,
  rankCombos,
  recencyWeight,
  shrunkRate,
} from '../src/collections/comboRanking';

test('K shrinks over charge lines — 12, not Qualify patient-count 25', () => {
  assert.equal(COMBO_SHRINKAGE_K, 12);
});

test('shrunkRate: exact hand-computed shrinkage', () => {
  // n = K → exact midpoint weighting: (12·0.5 + 12·0.7)/24 = 0.6
  assert.ok(Math.abs(shrunkRate(12, 0.5, 0.7) - 0.6) < 1e-12);
  // n = 0 → pure prior; n → large → approaches observed.
  assert.ok(Math.abs(shrunkRate(0, 0.9, 0.3) - 0.3) < 1e-12);
  assert.ok(Math.abs(shrunkRate(1_000_000, 0.9, 0.3) - 0.9) < 1e-3);
});

test('recencyWeight: half-life semantics, and null → 1 (no decay)', () => {
  assert.equal(recencyWeight(0), 1);
  assert.ok(Math.abs(recencyWeight(45) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyWeight(90) - 0.25) < 1e-12);
  assert.equal(recencyWeight(null), 1);
  assert.equal(recencyWeight(undefined), 1);
  // A negative age (clock skew / future-dated line) must not INFLATE the weight past 1.
  assert.equal(recencyWeight(-10), 1);
});

test('comboScore: exact hand-computed A / E / S', () => {
  const s = comboScore({ n: 12, charged: 1200, aObs: 0.5, aPrior: 0.7, ageDays: null });
  assert.ok(Math.abs(s.aHat - 0.6) < 1e-12);
  assert.ok(Math.abs(s.recentDollars - 720) < 1e-9); // A = 1200 × 0.6 × 1
  assert.ok(Math.abs(s.perLineDollars - 60) < 1e-9); // E = 1200 × 0.6 / 12
  // S = 720^0.7 × 60^0.3 = 341.65 (hand-derived via logs)
  assert.ok(Math.abs(s.score - 341.65) < 0.05);
});

test('comboScore: unscorable inputs score 0, never NaN', () => {
  for (const bad of [
    { n: 10, charged: 1000, aObs: null, aPrior: 0.5 }, // SQL-guarded null rate
    { n: 0, charged: 1000, aObs: 0.5, aPrior: 0.5 }, // no lines
    { n: 10, charged: 0, aObs: 0.5, aPrior: 0.5 }, // no dollars
  ]) {
    const s = comboScore(bad);
    assert.equal(s.score, 0);
    assert.ok(Number.isFinite(s.score));
  }
});

test('perCptPriors: dollar-weighted pooling per CPT; null cpt / null rate excluded', () => {
  const priors = perCptPriors(
    [
      { cpt: 'A', count: 1, charge: 100, pct_allowed: 80 },
      { cpt: 'A', count: 1, charge: 300, pct_allowed: 40 },
      { cpt: 'B', count: 1, charge: 100, pct_allowed: null }, // unusable → B falls back
      { cpt: null, count: 1, charge: 100, pct_allowed: 90 }, // null bucket never pools
    ],
    0.25,
  );
  // A: (100×0.8 + 300×0.4) / 400 = 0.5
  assert.ok(Math.abs((priors.get('A') ?? 0) - 0.5) < 1e-12);
  assert.equal(priors.get('B'), undefined); // no pooled evidence → caller fallback applies
});

// ── The reference fixture (w held at 1.0 — no service-date aggregate in the payload) ─────────────

const REFERENCE = [
  // Spec "was" order = charge DESC (validated: reconstructed charges sort exactly this way).
  { cpt: 'H0017', revenue: '158', count: 32, charge: 183_545, pct_allowed: 53.73, pct_paid: null },
  { cpt: 'H0017', revenue: '0158', count: 29, charge: 170_470, pct_allowed: 72.57, pct_paid: null },
  { cpt: 'H0018', revenue: '0158', count: 24, charge: 139_157, pct_allowed: 15.53, pct_paid: null },
  { cpt: 'H0010', revenue: '0126', count: 19, charge: 118_703, pct_allowed: 25.76, pct_paid: null },
  { cpt: 'H0018', revenue: '1001', count: 18, charge: 105_325, pct_allowed: 41.39, pct_paid: null },
  { cpt: 'H2013IOP', revenue: '0905', count: 18, charge: 97_367, pct_allowed: 75.0, pct_paid: null },
  { cpt: 'H2012IOP', revenue: '0906', count: 25, charge: 89_977, pct_allowed: 8.76, pct_paid: null },
  { cpt: 'H2018', revenue: '913', count: 14, charge: 81_276, pct_allowed: 75.0, pct_paid: null },
];

test('reference fixture: full expected order 1→8 (w = 1.0)', () => {
  const ranked = rankCombos(REFERENCE, 47.3 /* selection-wide fallback; unused — every CPT pools */);
  const order = ranked.map((r) => `${r.row.cpt}/${r.row.revenue}`);
  assert.deepEqual(order, [
    'H0017/0158',
    'H0017/158',
    'H2013IOP/0905',
    'H2018/913',
    'H0018/1001',
    'H0010/0126',
    'H0018/0158',
    'H2012IOP/0906',
  ]);
  // Strictly descending scores — no accidental tie carrying the order.
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1]!.score.score > ranked[i]!.score.score);
  }
});

test('reference fixture: single-combo CPTs reproduce the spec S targets (construction-independent)', () => {
  const ranked = rankCombos(REFERENCE, null);
  const byKey = new Map(ranked.map((r) => [`${r.row.cpt}/${r.row.revenue}`, r.score.score]));
  // For a CPT with one visible combo the pooled prior equals a_obs, so S = charged·a_obs·n^-0.3
  // exactly — independent of the charge reconstruction for the other rows.
  const targets: [string, number][] = [
    ['H2013IOP/0905', 30_683],
    ['H2018/913', 27_616],
    ['H0010/0126', 12_641],
    ['H2012IOP/0906', 3_001],
  ];
  for (const [key, s] of targets) {
    const got = byKey.get(key);
    assert.ok(got !== undefined && Math.abs(got - s) <= 2, `${key}: expected S≈${s}, got ${got}`);
  }
});

test('rankCombos: display-only — rows returned by reference, unscorable rows stay last and stable', () => {
  const a = { cpt: 'X', revenue: '1', count: 5, charge: 100, pct_allowed: null };
  const b = { cpt: 'Y', revenue: '2', count: 5, charge: 100, pct_allowed: null };
  const c = { cpt: 'Z', revenue: '3', count: 5, charge: 100, pct_allowed: 50 };
  const ranked = rankCombos([a, b, c], null);
  assert.equal(ranked[0]!.row, c); // identity preserved — drill values untouched
  assert.deepEqual(
    ranked.slice(1).map((r) => r.row),
    [a, b], // input order kept among score-0 rows
  );
});

// ── Formula 2 — facility confidence ──────────────────────────────────────────────────────────────

test('confidenceBand: thresholds, boundaries inclusive per spec', () => {
  assert.equal(confidenceBand(1.2), 'Strong');
  assert.equal(confidenceBand(1.15), 'Strong');
  assert.equal(confidenceBand(1.0), 'Expected');
  assert.equal(confidenceBand(0.95), 'Expected');
  assert.equal(confidenceBand(0.9), 'Watch');
  assert.equal(confidenceBand(0.8), 'Watch');
  assert.equal(confidenceBand(0.79), 'Review');
});

test('confidenceComposite: dollar-weighted, hand-computed; empty → null', () => {
  // (1000×0.8×0.9 + 3000×0.4×0.5) / 4000 = (720 + 600) / 4000 = 0.33
  const c = confidenceComposite([
    { charged: 1000, aHat: 0.8, pHat: 0.9 },
    { charged: 3000, aHat: 0.4, pHat: 0.5 },
  ]);
  assert.ok(c !== null && Math.abs(c - 0.33) < 1e-12);
  assert.equal(confidenceComposite([]), null);
});

test('facilityConfidence: < 40 lines → insufficient, NO band; otherwise Z = C_f / C_peer', () => {
  const f = [{ charged: 1000, aHat: 0.8, pHat: 0.9 }]; // C_f = 0.72
  const p = [{ charged: 1000, aHat: 0.6, pHat: 1.0 }]; // C_peer = 0.60
  const gated = facilityConfidence(f, p, CONFIDENCE_MIN_LINES - 1);
  assert.deepEqual(gated, { z: null, band: null, insufficient: true });
  const ok = facilityConfidence(f, p, CONFIDENCE_MIN_LINES);
  assert.ok(ok.z !== null && Math.abs(ok.z - 1.2) < 1e-12);
  assert.equal(ok.band, 'Strong');
  assert.equal(ok.insufficient, false);
});
