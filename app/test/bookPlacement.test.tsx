/**
 * WHERE THE PAYER'S BOOK IS DRAWN, AND WHAT THE AI PANEL SAYS ABOUT IT — pinned away from React.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE WIRING WAS INVISIBLE TO EVERY GATE (S3 fix round 1). The
 * placement derivation and the panel's grounding caption lived in `resolution-flow-client.tsx` and
 * `qualify-ai-panel.tsx` — two `'use client'` modules whose import graphs reach the `'use server'`
 * action chain, so NOTHING hermetic imports either one. Reproduced by the reviewer: inverting the
 * derivation's ternary so that `'leading'` is UNREACHABLE ships app 557/0 with both typechecks
 * clean. The same class the S1 review found in the AI payload, and the same fix: move the decision
 * into a plain lib module and leave only JSX behind.
 *
 * `bookIsOnScreen` / `bookLeadsAnswer` moved here with it. They were always pure snapshot
 * predicates with no React in them, and they are the inputs to the derivation — splitting the
 * question across two modules is how the two copies this leg spent its budget unifying got made.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  aiGroundingCaption,
  bookIsOnScreen,
  bookLeadsAnswer,
  bookPlacementFor,
  answerRatingBasis,
} from '../lib/qualify/bookPlacement';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';

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

const snap = (over: Partial<QualifySnapshot> = {}): QualifySnapshot =>
  ({
    resolved: { payerName: 'AETNA US HEALTHCARE', payerScope: 'payer' },
    facilities: [fac({ name: 'NASHVILLE MENTAL HEALTH', facilityKey: 'NASH' })],
    memberCount: 1,
    bookFacilities: [fac()],
    ...over,
  }) as unknown as QualifySnapshot;

test('bookPlacementFor — three states, and the ORDER of the two questions is the decision', () => {
  // LEADING is asked FIRST: when the book leads it is not "also on screen", it IS the grid, and the
  // member ranking the model read is no longer drawn as a list at all. An implementation that asked
  // `bookIsOnScreen` first would answer 'secondary' for every book-led screen and the caption would
  // point the reader at a list that is above them, not below.
  assert.equal(bookPlacementFor(snap()), 'leading');
  assert.equal(bookPlacementFor(snap({ memberCount: 4 } as Partial<QualifySnapshot>)), 'secondary');
  assert.equal(bookPlacementFor(snap({ bookFacilities: null } as Partial<QualifySnapshot>)), 'none');
  assert.equal(bookPlacementFor(null), 'none');
  // An EMPTY book is on screen but cannot lead — the one state where the two predicates differ.
  assert.equal(bookPlacementFor(snap({ bookFacilities: [] } as Partial<QualifySnapshot>)), 'secondary');
  // A book nobody can name is not a book on screen, so it is not a placement either.
  assert.equal(
    bookPlacementFor(snap({ resolved: { payerName: null, payerScope: 'all' } } as unknown as Partial<QualifySnapshot>)),
    'none',
  );
});

test('the two predicates travelled WITH the derivation, and still answer what they always did', () => {
  // Byte-identical behaviour to the versions that lived in resolution-flow.tsx — including the
  // `?? null` coercion whose loss broke 40 renders when `bookIsOnScreen` was first extracted.
  assert.equal(bookIsOnScreen(snap()), true);
  assert.equal(bookIsOnScreen(null), false);
  assert.equal(bookIsOnScreen(snap({ bookFacilities: [] } as Partial<QualifySnapshot>)), true, 'empty IS on screen');
  assert.equal(bookIsOnScreen({ facilities: [] } as unknown as QualifySnapshot), false, 'an ABSENT field is not null');
  assert.equal(bookLeadsAnswer(snap()), true);
  assert.equal(bookLeadsAnswer(snap({ bookFacilities: [] } as Partial<QualifySnapshot>)), false, 'empty cannot lead');
  for (const memberCount of [0, 2, 10, null]) {
    assert.equal(bookLeadsAnswer(snap({ memberCount } as Partial<QualifySnapshot>)), false);
  }
});

test('aiGroundingCaption — all three arms, and the two that are NOT the default are the point', () => {
  /* The payload is `snap.facilities.slice(0, 10)` in every mode — the identifier's own ranking, with
   * an unchanged schema. So the caption's job is to name the list the model READ by its position
   * relative to the one on screen, and each arm is false in the other two states. */
  assert.match(aiGroundingCaption('none'), /grounded in the exact numbers on this screen/);
  assert.match(aiGroundingCaption('secondary'), /in the ranking above, not the whole-book list below/);
  assert.match(aiGroundingCaption('leading'), /in this member's own history, not the whole-book ranking above/);
  // Every arm keeps the two clauses that are true regardless of placement.
  for (const p of ['none', 'secondary', 'leading'] as const) {
    assert.match(aiGroundingCaption(p), /^Preset questions only — /);
    assert.match(aiGroundingCaption(p), /Nothing here is a guarantee of payment\.$/);
  }
  // ⚠ THREE DISTINCT STRINGS. An arm that duplicated another would make the caption a decoration:
  // the inverted-ternary mutation the reviewer ran is invisible unless the arms actually differ.
  assert.equal(new Set(['none', 'secondary', 'leading'].map((p) => aiGroundingCaption(p as 'none'))).size, 3);
});

/**
 * ── WHICH LIST THE ANSWER'S RATING IS WEIGHTED OVER ─────────────────────────────────────────────
 *
 * `answerRatingBasis` is the single definition the answer stage's hero AND the lane rail's ANSWER
 * step both read. It was added because they had drifted: the stage re-based onto the book when
 * `bookLeadsAnswer`, `laneInputForFlow` did not, and the rail showed a number weighted over a list
 * nobody had drawn. The parity of the two call sites is pinned in
 * `qualify-lane-rating-parity.test.tsx`; what is pinned HERE is the choice itself.
 */
test('answerRatingBasis picks the book exactly when the book leads, and says so in the scope', () => {
  // BOOK-LED: the list is the book, and the basis NAMES whose book — the label the hero prints.
  const leading = answerRatingBasis(snap());
  assert.equal(bookLeadsAnswer(snap()), true, 'precondition: this fixture is book-led');
  assert.deepEqual(leading?.facilities.map((f) => f.facilityKey), ['SUMMIT'], 'the BOOK list');
  assert.equal(leading?.basisScope, "AETNA US HEALTHCARE's whole book");

  // NOT BOOK-LED (a real member population): the member ranking leads and there is NO scope label —
  // `derivePolicyRating` prints its unscoped basis, which is what the member ranking has always said.
  const member = snap({ memberCount: 4 } as Partial<QualifySnapshot>);
  assert.equal(bookLeadsAnswer(member), false, 'precondition: this fixture is not book-led');
  assert.deepEqual(answerRatingBasis(member)?.facilities.map((f) => f.facilityKey), ['NASH'], 'the MEMBER list');
  assert.equal(answerRatingBasis(member)?.basisScope, undefined);

  // ⚠ THE TWO LISTS MUST ACTUALLY DIFFER, or every assertion above is satisfiable by either branch
  // and the whole file proves nothing. This is the positive control for the pair.
  assert.notDeepEqual(leading?.facilities, answerRatingBasis(member)?.facilities);
});

test('answerRatingBasis tracks bookLeadsAnswer through every state, including the two that do not lead', () => {
  // An EMPTY book is on screen but cannot lead, so the member ranking keeps the grid AND the rating.
  const emptyBook = snap({ bookFacilities: [] } as Partial<QualifySnapshot>);
  assert.equal(bookLeadsAnswer(emptyBook), false);
  assert.deepEqual(answerRatingBasis(emptyBook)?.facilities.map((f) => f.facilityKey), ['NASH']);
  assert.equal(answerRatingBasis(emptyBook)?.basisScope, undefined, 'an empty book must not name a basis');

  // A book nobody can name is not a book on screen — same outcome, different reason.
  const unnamed = snap({ resolved: { payerName: null, payerScope: 'all' } } as unknown as Partial<QualifySnapshot>);
  assert.equal(answerRatingBasis(unnamed)?.basisScope, undefined);

  // Null in, null out — distinct from a snapshot whose list is empty, which is a real verdict.
  assert.equal(answerRatingBasis(null), null);
  assert.equal(answerRatingBasis(undefined), null);
});
