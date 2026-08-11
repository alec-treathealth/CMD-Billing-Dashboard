/**
 * THE RAIL'S ANSWER NUMBER IS THE HERO'S ANSWER NUMBER — pinned, because it silently was not.
 *
 * Two `derivePolicyRating` values sit on one screen, feet apart, describing one answer: the answer
 * stage's hero bar, and the ANSWER step of the lane rail beside it. `StageAnswer` re-bases onto the
 * payer's book when `bookLeadsAnswer` (S3); `laneInputForFlow` kept passing `snapshot.facilities`,
 * the member ranking, with no scope label. So in book-led mode the rail patient-weighted a list
 * nobody had drawn — and the rail's own docblock asserted the two numbers were identical the entire
 * time that was false.
 *
 * ⚠ WHY THIS FILE RATHER THAN A LINE IN AN EXISTING ONE. Nothing hermetic reached the seam. The
 * choice lived inside a component (`resolution-flow.tsx`), the two call sites were in a PARENT and
 * a CHILD, and every gate passed with them disagreeing — the same invisibility class
 * `bookPlacement.test.tsx`'s header describes. The repair moved the choice into a lib module
 * (`answerRatingBasis`); this pins that BOTH sites read it.
 *
 * ⚠ AND IT IS DELIBERATELY NOT CIRCULAR. Asserting `laneInputForFlow` agrees with
 * `answerRatingBasis` would be tautological now that both call it — it would pass even if the
 * shared function chose the wrong list. So the expected rating is built INDEPENDENTLY here, from
 * the fixture's book list and the scope label spelled out literally, and the member-ranking rating
 * is asserted to DIFFER. If the hoist ever regresses to the member list, the second assertion is
 * the one that fires.
 *
 * `laneInputForFlow` is exported for this test exactly as `railStates` is exported for
 * `qualify-lane-steps.test.tsx` — test-seam parity, no signature change, no production caller.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { laneInputForFlow } from '../components/qualify/v3/resolution-flow';
import { answerRatingBasis, bookLeadsAnswer } from '../lib/qualify/bookPlacement';
import { derivePolicyRating } from '../lib/qualify/policyRating';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';
import type { QualifyResolution } from '../lib/qualify/resolution';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';

/** Two facilities whose ratings differ, so book-vs-member is a VISIBLE difference, not a tie. */
const fac = (over: Partial<QualifyFacility> = {}): QualifyFacility =>
  ({
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1,
    name: 'SUMMIT RIDGE RECOVERY',
    facilityKey: 'SUMMIT',
    city: null,
    state: null,
    pctAllowedOfBilled: 62,
    rating: 62,
    // ⚠ `ratingV2` IS THE FIELD THE FOLD READS (`PolicyRatable`), not `rating`. A fixture that sets
    // only `rating` leaves every row unrateable, both lists collapse to "Not rated", and the
    // book-vs-member comparison below becomes null === null — vacuously satisfied. The positive
    // control at the end of the first test is what catches that.
    ratingV2: 62,
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount: 210,
    distinctPatients: 14,
    confirmedClaims: 200,
    estimateClaims: 5,
    unknownClaims: 5,
    careSetting: 'IP',
    entity: 'BXR',
    ...over,
  }) as QualifyFacility;

/** BOOK-LED by construction: one member (`memberBucketOf` → 'one'), a named payer, a non-empty book. */
const bookLedSnap = (over: Partial<QualifySnapshot> = {}): QualifySnapshot =>
  ({
    resolved: { payerName: 'AETNA US HEALTHCARE', payerScope: 'payer' },
    // The MEMBER ranking — deliberately a different rating and a different patient weight, so a
    // rail that reads this list produces a different number rather than the same one by luck.
    facilities: [
      fac({
        name: 'NASHVILLE MENTAL HEALTH',
        facilityKey: 'NASH',
        rating: 21,
        ratingV2: 21,
        pctAllowedOfBilled: 21,
        distinctPatients: 5, // clears the >=3 sample floor, so this list is genuinely RATED
      }),
    ],
    memberCount: 1,
    bookFacilities: [fac()],
    ...over,
  }) as unknown as QualifySnapshot;

const resolution = {
  handle: { kind: 'prefix', readAs: 'read as a 3-character member-ID prefix', echo: 'GGS' },
  candidates: { total: 40 },
  group: { payerDisplayName: 'AETNA US HEALTHCARE', employerLabel: 'GOOGLE LLC' },
} as unknown as QualifyResolution;

/** The `ResolutionStagesProps` subset `laneInputForFlow` actually reads. */
const propsFor = (snapshot: QualifySnapshot) =>
  ({
    stage: 'answer',
    resolution,
    payerPick: 'AETNA US HEALTHCARE',
    payerGroups: [{ payer: 'AETNA US HEALTHCARE' }, { payer: 'CIGNA' }],
    answer: { snapshot },
  }) as unknown as Parameters<typeof laneInputForFlow>[0];

test('book-led: the rail ANSWER rating EQUALS the hero rating, weighted over the BOOK', () => {
  const snap = bookLedSnap();
  assert.equal(bookLeadsAnswer(snap), true, 'precondition: the fixture is book-led');

  // Built independently of the production selection — the book list and the label, spelled out.
  const expected = derivePolicyRating(snap.bookFacilities!, "AETNA US HEALTHCARE's whole book");
  const railPolicy = laneInputForFlow(propsFor(snap), false).policy;

  assert.deepEqual(railPolicy, expected, 'the rail must weight the list the hero draws');

  // ⚠ THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. This is what the rail used to return.
  const memberRanking = derivePolicyRating(snap.facilities);
  assert.notDeepEqual(
    railPolicy,
    memberRanking,
    'positive control: book and member ratings differ for this fixture, so the equality above is real',
  );
  assert.notEqual(railPolicy?.rating, memberRanking.rating, 'and they differ in the NUMBER on screen');
});

test('not book-led: the rail keeps the member ranking, unscoped — the flip is the only thing that moved', () => {
  // A real member population (bucket !== 'one') keeps the member ranking leading, so the rail must
  // NOT acquire a book basis. The fix must be conditional, not a blanket re-base.
  const snap = bookLedSnap({ memberCount: 4 } as Partial<QualifySnapshot>);
  assert.equal(bookLeadsAnswer(snap), false, 'precondition: the fixture is not book-led');

  assert.deepEqual(
    laneInputForFlow(propsFor(snap), false).policy,
    derivePolicyRating(snap.facilities),
    'unchanged from the pre-fix behaviour in every non-book-led state',
  );
});

test('both call sites read one derivation — the rail agrees with answerRatingBasis in every state', () => {
  // The structural half. Circular on its own (see the header), which is why it rides BEHIND the two
  // independent assertions above rather than standing in for them: it pins that the rail has no
  // private copy of the choice, while they pin that the shared choice is the right one.
  for (const snap of [
    bookLedSnap(),
    bookLedSnap({ memberCount: 4 } as Partial<QualifySnapshot>),
    bookLedSnap({ bookFacilities: [] } as Partial<QualifySnapshot>),
    bookLedSnap({ resolved: { payerName: null, payerScope: 'all' } } as unknown as Partial<QualifySnapshot>),
  ]) {
    const basis = answerRatingBasis(snap)!;
    assert.deepEqual(
      laneInputForFlow(propsFor(snap), false).policy,
      derivePolicyRating(basis.facilities, basis.basisScope),
      `state with bookLeads=${bookLeadsAnswer(snap)} scope=${String(basis.basisScope)}`,
    );
  }
});

test('no snapshot is no rating — the ANSWER step shows nothing rather than a zero', () => {
  // A rating of 0 is a real verdict ("Avoid"); "still loading" must not look like it.
  // `answer` is `… | null`, never undefined — the prop type says so, and an `undefined` here
  // typechecks in the test file long before it would in production.
  const props = { ...propsFor(bookLedSnap()), answer: null } as Parameters<typeof laneInputForFlow>[0];
  assert.equal(laneInputForFlow(props, false).policy, null);
});
