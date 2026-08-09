/**
 * THE POLICY RATING — the one number on the readout bar answering "does this payer pay us".
 *
 * The invariant under test is RECONCILIATION: the bar's number must be the patient-weighted mean of
 * exactly the ratings the cards below display. If the bar can say 22 while every card reads 60+, the
 * rep cannot tell which is lying, and this whole surface is built on not making that mistake.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivePolicyRating, deriveTopRanks, qualifyRanksHeading } from '../lib/qualify/policyRating';
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

// ── THE RANKS STRIP vs THE GRID (S1 review, 2026-08-08) ──────────────────────────────────────────
//
// The strip re-sorts by ratingV2 ALONE while the grid sorts availability-first, so on a book with a
// full facility the two disagree ON THE SAME SCREEN: the grid shows an open house at rank 1 above a
// full house at rank 2, and the strip led with the full one. Worse, the strip renders for
// `active === 'ranks'` — the ordering question — directly under prose the prompt now makes say that
// facility is full and ranked below. The old comment claimed this "can never disagree with the
// cards"; it could, and did.
//
// RESOLVED BY CAPTION, NOT BY RE-SORTING, because the strip's question is a genuinely different one:
// "which of these PAYS best" is a rating question, and answering it in bed order would leave nothing
// on screen that answers it at all. So the strip keeps its rating order, says out loud that it is
// ordered that way, and carries each row's bed state so a full leader cannot read as a placement.

test('ranks rows carry BED STATE, so the strip can never present a full house as a placement', () => {
  const rows = deriveTopRanks([
    { ...fac('FULL TOP', 80, 20), bedState: 'full' },
    { ...fac('OPEN NEXT', 60, 20), bedState: 'open' },
    { ...fac('OUTPATIENT', 50, 20), bedState: 'not_applicable' },
    { ...fac('NO CENSUS', 40, 20), bedState: 'unknown' },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['FULL TOP', 'OPEN NEXT', 'OUTPATIENT', 'NO CENSUS'], 'still rating order');
  assert.deepEqual(rows.map((r) => r.bedState), ['full', 'open', 'not_applicable', 'unknown']);
});

test('the strip states its own basis, and says so louder when its leader cannot admit anyone', () => {
  const open = qualifyRanksHeading(deriveTopRanks([{ ...fac('A', 80, 20), bedState: 'open' }, { ...fac('B', 60, 20), bedState: 'open' }]), 'this policy');
  assert.match(open, /Top 2 facilities/);
  assert.match(open, /this policy/);
  // The basis is stated unconditionally — a reader must never have to infer why this order differs
  // from the grid's, and "it matches today" is not a reason to leave it unsaid tomorrow.
  assert.match(open, /by rating, not bed availability/);
  // And when a row in the strip is full, the heading does not wait for the reader to spot the chip.
  const withFull = qualifyRanksHeading(deriveTopRanks([{ ...fac('A', 80, 20), bedState: 'full' }, { ...fac('B', 60, 20), bedState: 'open' }]), 'this policy');
  assert.match(withFull, /full/i);
});

test('S3 — the hero can NAME the population it averaged, and says so when nothing clears the floor', () => {
  /* "patient-weighted across 2 rated facilities" is true of the member's own footprint AND of the
   * payer's whole book, so once the book can LEAD the answer that basis line identifies neither.
   * The scope is passed in rather than derived here: this module has no idea which list it was
   * handed, and inventing one from the rows would be the second derivation that drifts. */
  const scope = "AETNA US HEALTHCARE's whole book";
  assert.equal(
    derivePolicyRating([fac('ALPHA', 70, 30), fac('BETA', 40, 10)], scope).basis,
    "patient-weighted across 2 rated facilities in AETNA US HEALTHCARE's whole book",
  );
  // ⚠ THE NOT-RATED ARM CARRIES IT TOO. "no facility clears the sample floor" over a hidden list is
  // the same unattributed claim as the rated basis — and it is the arm a thin book actually hits.
  assert.equal(
    derivePolicyRating([], scope).basis,
    "no facility in AETNA US HEALTHCARE's whole book clears the sample floor",
  );
  // Omitted ⇒ BYTE-IDENTICAL to what shipped. v2's tab and every non-flip v3 render pass nothing.
  assert.equal(derivePolicyRating([fac('A', 70, 20)]).basis, 'patient-weighted across 1 rated facility');
  assert.equal(derivePolicyRating([]).basis, 'no facility clears the sample floor');
});

test('S3 fix — the RANKS STRIP re-bases its scope label when the book leads, because the caption cannot', () => {
  /* THE MITIGATION S3 CITED NEVER RENDERS. The panel's idle caption (`active === null`) and this
   * strip (`active === 'ranks'`) are MUTUALLY EXCLUSIVE — so the moment a reader asks the ranks
   * question over a book-led screen, the caption naming the model's list disappears and the strip's
   * only label is "Top N facilities · {payer} · by rating, not bed availability": a member-scoped
   * table identified by nothing, directly beneath a grid showing that payer's whole book.
   *
   * The strip's POPULATION does not change (it describes what the model read, which is right); its
   * LABEL says which population that is. */
  const rows = deriveTopRanks([fac('ALPHA', 70, 30), fac('BETA', 40, 10)]);
  const led = qualifyRanksHeading(rows, 'aetna us healthcare', 'leading');
  assert.match(led, /this member's own history under aetna us healthcare/);
  assert.match(led, /^Top 2 facilities · /, 'the count and the basis note are untouched');
  assert.match(led, /by rating, not bed availability$/);
  // ⚠ 'secondary' AND 'none' ARE BYTE-IDENTICAL TO WHAT SHIPPED, and 'secondary' is not an oversight:
  // there the member ranking IS the primary grid and the book is the clearly-labelled second thing,
  // so the bare payer label already describes the list the strip is about. Only the flip inverts it.
  const plain = qualifyRanksHeading(rows, 'aetna us healthcare');
  assert.equal(qualifyRanksHeading(rows, 'aetna us healthcare', 'none'), plain);
  assert.equal(qualifyRanksHeading(rows, 'aetna us healthcare', 'secondary'), plain);
  assert.equal(plain, 'Top 2 facilities · aetna us healthcare · by rating, not bed availability');
  // The full-house disclosure survives the re-base — it is a claim about the ROWS, not the scope.
  const full = qualifyRanksHeading(
    deriveTopRanks([{ ...fac('A', 80, 20), bedState: 'full' }, fac('B', 60, 20)]),
    'aetna',
    'leading',
  );
  assert.match(full, /this member's own history under aetna/);
  assert.match(full, /one or more are full/);
});
