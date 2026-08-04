/**
 * THE POLICY RATING — the one number on the readout bar answering "does this payer pay us".
 *
 * The invariant under test is RECONCILIATION: the bar's number must be the patient-weighted mean of
 * exactly the ratings the cards below display. If the bar can say 22 while every card reads 60+, the
 * rep cannot tell which is lying, and this whole surface is built on not making that mistake.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivePolicyRating, deriveTopRanks } from '../lib/qualify/policyRating';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { QUALIFY_RATING_MIN_PATIENTS } from '../lib/qualify/sampleGate';
import type { QualifyFacility } from '../lib/qualify/contract';

function fac(name: string, ratingV2: number | null, distinctPatients: number): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1,
    name,
    facilityKey: name.toLowerCase(),
    city: null,
    state: null,
    pctAllowedOfBilled: ratingV2,
    rating: ratingV2,
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount: distinctPatients * 8,
    distinctPatients,
    confirmedClaims: distinctPatients * 8,
    estimateClaims: 0,
    unknownClaims: 0,
    careSetting: null,
    entity: 'BXR',
    ratingV2,
    iqBand: ratingV2 === null ? null : ratingV2 >= 50 ? '50' : '30',
  };
}

test('THE INVARIANT: the bar is the patient-weighted mean of the cards, and lands between them', () => {
  // 70 on 30 patients, 40 on 10 → (70*30 + 40*10) / 40 = 62.5 → 63
  const r = derivePolicyRating([fac('ALPHA', 70, 30), fac('BETA', 40, 10)]);
  assert.equal(r.rating, 63);
  assert.equal(r.ratedCount, 2);
  assert.equal(r.patients, 40);
  // Between the extremes it averages — a mean outside its own inputs would be the defect this guards.
  assert.ok(r.rating! <= 70 && r.rating! >= 40);
  assert.match(r.basis, /patient-weighted across 2 rated facilities/);
});

test('weighting is by PATIENTS, not lines — a high-volume thin facility cannot dominate', () => {
  // Same ratings, but BETA carries 10x the lines of ALPHA and only a third of the patients.
  const lineHeavy = { ...fac('BETA', 40, 10), lineCount: 4000 };
  const r = derivePolicyRating([fac('ALPHA', 70, 30), lineHeavy]);
  assert.equal(r.rating, 63, 'line count must not enter the weighting');
});

test('a facility the CARD refuses to rate is excluded here too — no number without visible support', () => {
  // 2 patients is below QUALIFY_RATING_MIN_PATIENTS: the card renders '—', so it cannot be averaged.
  assert.ok(QUALIFY_RATING_MIN_PATIENTS > 2);
  const r = derivePolicyRating([fac('ALPHA', 70, 30), fac('THIN', 4, 2)]);
  assert.equal(r.rating, 70, 'the suppressed facility contributed nothing');
  assert.equal(r.ratedCount, 1);
  assert.equal(r.patients, 30);
  // Unrated (null) facilities are likewise absent rather than counted as zero.
  assert.equal(derivePolicyRating([fac('ALPHA', 70, 30), fac('NONE', null, 40)]).rating, 70);
});

test('nothing rateable → NULL and "Not rated", never 0 — "cannot say" is not "pays nothing"', () => {
  for (const set of [[], [fac('NONE', null, 40)], [fac('THIN', 90, 1)]]) {
    const r = derivePolicyRating(set);
    assert.equal(r.rating, null);
    assert.equal(r.band, null);
    assert.equal(r.verdict, 'Not rated');
    assert.equal(r.ratedCount, 0);
    assert.equal(r.basis, 'no facility clears the sample floor');
  }
});

test('the band and verdict come from the IQ scale the cards use — one vocabulary, not two', () => {
  assert.equal(derivePolicyRating([fac('A', 70, 20)]).verdict, 'Strong · 65%+');
  assert.equal(derivePolicyRating([fac('A', 55, 20)]).verdict, 'Solid · 50%+');
  assert.equal(derivePolicyRating([fac('A', 35, 20)]).verdict, 'Watch · 30%+');
  assert.equal(derivePolicyRating([fac('A', 20, 20)]).verdict, 'Weak · 15%+');
  assert.equal(derivePolicyRating([fac('A', 5, 20)]).verdict, 'Avoid · 0%');
  assert.equal(derivePolicyRating([fac('A', 70, 20)]).band, '65');
});

test('singular grammar at one facility; never NaN on any input', () => {
  assert.match(derivePolicyRating([fac('A', 70, 20)]).basis, /across 1 rated facility$/);
  for (const set of [[], [fac('A', 0, 20)], [fac('A', 100, 3)]]) {
    const r = derivePolicyRating(set);
    assert.ok(r.rating === null || Number.isFinite(r.rating), 'never NaN');
  }
});

// ── The ranks table ──────────────────────────────────────────────────────────────────────────────

test('ranks: sorted best-first, numbered from 1, capped, with a non-dollar evidence caption', () => {
  const rows = deriveTopRanks(
    [fac('MID', 50, 12), fac('TOP', 80, 20), fac('LOW', 20, 8), fac('OK', 60, 15), fac('MEH', 35, 11), fac('LAST', 10, 9)],
    5,
  );
  assert.deepEqual(rows.map((r) => r.name), ['TOP', 'OK', 'MID', 'MEH', 'LOW']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(rows[0]?.evidence, '20 patients · 160 lines');
  assert.ok(!JSON.stringify(rows).includes('$'), 'the table is dollar-free for every role');
});

test('ranks obey the SAME gate as the bar — a card showing "—" is not a row here', () => {
  const rows = deriveTopRanks([fac('GOOD', 70, 20), fac('THIN', 99, 1), fac('NONE', null, 30)]);
  assert.deepEqual(rows.map((r) => r.name), ['GOOD']);
});

test('ranks: singular patient grammar, empty set, and limit 0 are all handled', () => {
  assert.equal(deriveTopRanks([fac('ONE', 70, 1)]).length, 0, 'below the floor');
  assert.match(deriveTopRanks([fac('THREE', 70, 3)])[0]?.evidence ?? '', /^3 patients/);
  assert.deepEqual(deriveTopRanks([]), []);
  assert.deepEqual(deriveTopRanks([fac('A', 70, 20)], 0), []);
});

test('ranks never disagree with the bar: rank 1 is >= the policy rating for a rated set', () => {
  const set = [fac('TOP', 80, 20), fac('MID', 40, 10)];
  const top = deriveTopRanks(set)[0]!;
  const bar = derivePolicyRating(set);
  assert.ok(top.rating >= bar.rating!, 'the best facility cannot rate below the weighted mean');
});

test('non-dollar by construction: no dollar field is read, so blind and sighted agree exactly', () => {
  const sighted = [fac('ALPHA', 70, 30), fac('BETA', 40, 10)];
  // The server strips these two for admissions_seat; the derivation must not notice.
  const blind = sighted.map((f) => ({ ...f, billedAmount: null, allowedAmount: null }));
  assert.deepEqual(derivePolicyRating(blind), derivePolicyRating(sighted.map((f) => ({ ...f, billedAmount: 500000, allowedAmount: 250000 }))));
});
