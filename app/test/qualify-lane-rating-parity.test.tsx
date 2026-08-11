/**
 * THE RAIL SHOWS THE LANE'S NUMBER OR NO NUMBER — it never quotes a wider one.
 *
 * The lane rail promises, in `shell/lane-rail.tsx`: "Locked to <prefix> … Answers come only from
 * this lane's matched lines — nothing outside it." When the book leads (`bookLeadsAnswer`, S3) the
 * answer stage's hero re-bases onto the payer's WHOLE BOOK — facilities this member has never
 * touched. So the rail renders NO rating in that mode. Silence is the honest reading; a whole-book
 * number under a lane-locked panel is a scoped surface quoting an unscoped figure.
 *
 * ⚠ THE INVARIANT IS SCOPE HONESTY, NOT EQUALITY, and this file has already been wrong once in the
 * other direction. Until 2026-08-11 the rail passed `snapshot.facilities` while the hero passed the
 * book, so two different numbers sat side by side (measured on this fixture: band 15 over 5
 * patients against band 50 over 14). The first repair made them EQUAL by widening the rail to the
 * book — which did remove the contradiction between the numbers, by relocating it into the lock.
 * Outside book-led mode the two lists are the same list, so rail and hero still agree there; that
 * agreement is a CONSEQUENCE of both reading the lane's own list, never the goal.
 *
 * ⚠ WHY THIS FILE RATHER THAN A LINE IN AN EXISTING ONE. Nothing hermetic reached the seam. The
 * choice lived inside a component (`resolution-flow.tsx`), the two call sites were in a PARENT and
 * a CHILD, and every gate passed with them disagreeing — the same invisibility class
 * `bookPlacement.test.tsx`'s header describes.
 *
 * Both arms carry positive controls, because "the rail is null" is trivially satisfiable by a
 * fixture where nothing rates at all: the book-led test asserts the HERO's number is real, and the
 * every-state test asserts both arms were actually exercised.
 *
 * `laneInputForFlow` is exported for this test exactly as `railStates` is exported for
 * `qualify-lane-steps.test.tsx` — test-seam parity, no signature change, no production caller.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { laneInputForFlow } from '../components/qualify/v3/resolution-flow';
import { LaneReceipt } from '../components/qualify/shell/lane-progress';
import { laneSteps } from '../lib/qualify/laneSteps';
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

test('BOOK-LED: the rail says NOTHING — the hero keeps its whole-book number', () => {
  const snap = bookLedSnap();
  assert.equal(bookLeadsAnswer(snap), true, 'precondition: the fixture is book-led');

  // THE RAIL IS SILENT. Not zero, not the member ranking, not the book — absent.
  assert.equal(
    laneInputForFlow(propsFor(snap), false).policy,
    null,
    "the lane is locked to its matched lines; the book is outside them, so the rail has nothing it may say",
  );

  // THE HERO IS UNTOUCHED — it still rates the book, with the scope named. This is the half that
  // must NOT have moved: silencing the rail is not the same as suppressing the answer.
  const basis = answerRatingBasis(snap)!;
  assert.deepEqual(
    derivePolicyRating(basis.facilities, basis.basisScope),
    derivePolicyRating(snap.bookFacilities!, "AETNA US HEALTHCARE's whole book"),
    'the hero still weights the BOOK and still names it',
  );

  // ⚠ POSITIVE CONTROL. The hero's number must be a REAL one here, or "rail null, hero speaks" is
  // satisfied by a fixture where nobody speaks and the test proves nothing.
  assert.notEqual(derivePolicyRating(basis.facilities, basis.basisScope).rating, null);
});

test('NOT book-led: the rail keeps the member ranking, and there it still equals the hero', () => {
  // Outside book-led mode the two surfaces read the SAME list, so the agreement that always held
  // still holds — and the rail is entitled to speak, because that list IS the lane's matched lines.
  const snap = bookLedSnap({ memberCount: 4 } as Partial<QualifySnapshot>);
  assert.equal(bookLeadsAnswer(snap), false, 'precondition: the fixture is not book-led');

  const basis = answerRatingBasis(snap)!;
  const railPolicy = laneInputForFlow(propsFor(snap), false).policy;
  assert.notEqual(railPolicy, null, 'the rail must NOT go silent outside book-led mode');
  assert.deepEqual(railPolicy, derivePolicyRating(basis.facilities, basis.basisScope), 'rail == hero');
  assert.deepEqual(railPolicy, derivePolicyRating(snap.facilities), 'unchanged from what shipped');
  assert.equal(basis.basisScope, undefined, 'and it carries no widened scope label');
});

test('the rule is the BOOK-LED flip, not the fixture — every state, both directions', () => {
  // Each state paired with whether the book leads. The rail speaks exactly when it does not.
  const states: readonly (readonly [string, QualifySnapshot])[] = [
    ['book leads', bookLedSnap()],
    ['real member population', bookLedSnap({ memberCount: 4 } as Partial<QualifySnapshot>)],
    ['empty book cannot lead', bookLedSnap({ bookFacilities: [] } as Partial<QualifySnapshot>)],
    [
      'unnameable payer cannot lead',
      bookLedSnap({ resolved: { payerName: null, payerScope: 'all' } } as unknown as Partial<QualifySnapshot>),
    ],
  ];
  let silent = 0;
  let spoke = 0;
  for (const [name, snap] of states) {
    const leads = bookLeadsAnswer(snap);
    const basis = answerRatingBasis(snap)!;
    const railPolicy = laneInputForFlow(propsFor(snap), false).policy;
    if (leads) {
      silent += 1;
      assert.equal(railPolicy, null, `${name}: book leads, so the rail must be silent`);
    } else {
      spoke += 1;
      assert.deepEqual(
        railPolicy,
        derivePolicyRating(basis.facilities, basis.basisScope),
        `${name}: the lane's own list, so the rail speaks and matches the hero`,
      );
    }
  }
  // Both arms must actually be exercised, or this loop asserts one behaviour and claims two.
  assert.ok(silent > 0 && spoke > 0, `positive control: silent=${silent} spoke=${spoke}`);
});

test('no snapshot is no rating — the ANSWER step shows nothing rather than a zero', () => {
  // A rating of 0 is a real verdict ("Avoid"); "still loading" must not look like it.
  // `answer` is `… | null`, never undefined — the prop type says so, and an `undefined` here
  // typechecks in the test file long before it would in production.
  const props = { ...propsFor(bookLedSnap()), answer: null } as Parameters<typeof laneInputForFlow>[0];
  assert.equal(laneInputForFlow(props, false).policy, null);
});

/**
 * ── AND IT RENDERS. The derivation going null is only half the fix; the rail has to draw that
 * state without leaving a stray separator, an empty value line, or a crash where the number was.
 * `laneSteps`' "a rating of 0 is a real verdict, so null must not look like it" rule already covers
 * the DERIVATION — this covers the MARKUP, which is where a `${null} · ${undefined}` would surface.
 */
test('book-led: the ANSWER step renders with no number and no artifact', () => {
  const snap = bookLedSnap();
  const steps = laneSteps(laneInputForFlow(propsFor(snap), false));
  const answer = steps.find((s) => s.key === 'answer');

  assert.equal(answer?.meta, null, 'the step carries no value to render');

  const html = renderToStaticMarkup(<LaneReceipt steps={steps} title="Qualifying prefix GGS" />);
  assert.match(html, /do they pay us, where\?/, 'the QUESTION still renders — the step is not hidden');
  // The two shapes a null rating leaks as: the literal, and the separator with nothing around it.
  assert.ok(!html.includes('null'), 'no stringified null reached the markup');
  assert.ok(!html.includes('undefined'), 'no stringified undefined reached the markup');
  assert.doesNotMatch(html, /·\s*<\/span>/, 'no orphaned "·" separator where the verdict would be');
  assert.doesNotMatch(html, /Not rated/, 'and it must not fall back to the unrated VERDICT either');

  // The contrast that proves the assertions above are not vacuous: outside book-led mode the same
  // component, fed the same way, DOES put a number on screen.
  const speaking = laneSteps(laneInputForFlow(propsFor(bookLedSnap({ memberCount: 4 } as Partial<QualifySnapshot>)), false));
  assert.notEqual(speaking.find((s) => s.key === 'answer')?.meta, null, 'positive control');
});
