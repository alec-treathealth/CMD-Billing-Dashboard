/**
 * WHERE THE PAYER'S BOOK IS DRAWN — the two predicates, the placement they derive, and the one
 * sentence the AI panel says about it.
 *
 * ⚠ THIS MODULE EXISTS BECAUSE THE WIRING WAS INVISIBLE TO EVERY GATE (S3 fix round 1, 2026-08-08).
 * The placement ternary lived in `resolution-flow-client.tsx` and the caption in
 * `qualify-ai-panel.tsx` — two `'use client'` modules whose import graphs reach the `'use server'`
 * action chain, so nothing hermetic can import either. Measured by the reviewer: **inverting the
 * ternary's arms so `'leading'` is unreachable ships app 557/0 with both typechecks clean and
 * `next build` green.** That is the same class the S1 review found when a deleted `bedState` mapping
 * left the whole gate green, and it gets the same fix: the DECISION moves into a plain lib module
 * with tests, and the client files keep only JSX.
 *
 * `bookIsOnScreen` / `bookLeadsAnswer` moved here with it. They were always pure snapshot predicates
 * with no React in them, and they are the INPUTS to the derivation — leaving them in the component
 * while the derivation lived here would split one question across two modules, which is precisely
 * how the two copies this leg spent its budget unifying got made. `resolution-flow.tsx` re-exports
 * them so its own render sites and their existing tests read the same functions.
 *
 * PURE and client-safe: no React, no `'use server'` chain, relative imports only.
 */
import type { QualifyFacility, QualifySnapshot } from './contract';
import { EMPTY_FACILITIES, scopedPayerOf } from './contract';
import { memberBucketOf } from './memberPreface';

/**
 * IS THE PAYER'S BOOK SECTION ON SCREEN? — the ONE predicate, read by the stage that renders it, by
 * the shell that captions the AI panel around it, and by `bookLeadsAnswer` below.
 *
 * S2 shipped this as two expressions: the shell asked `snapshot.bookFacilities !== null` while the
 * stage rendered on `bookFacilities !== null && bookPayer !== null`. They agreed on every state
 * reachable then and disagree on one that was not (rows present under a scope that names no single
 * payer, where the section cannot render a heading and so does not render at all).
 *
 * `scopedPayerOf` is the second half rather than a bare null check because the section's heading
 * NAMES whose book it is; a book nobody can name is not a book on screen.
 *
 * An EMPTY book is on screen: the section renders its heading, its count and a sentence saying the
 * floor cleared nothing. That is a state, not an absence.
 *
 * ⚠ `?? null`, NOT A BARE `!== null`, AND THIS BIT A REAL RENDER. `undefined !== null` is TRUE, so a
 * payload where the field is ABSENT rather than null — every pre-S2 fixture, and any cached snapshot
 * minted before this field existed — would answer "yes" and send the section into `bookFacilities!.
 * length` on nothing. The contract declares the field required and the core always sets it, so this
 * is a boundary guard rather than a live case; it is here because the local expression it replaced
 * had it, and dropping a coercion during a unification is exactly how a unification regresses.
 */
export function bookIsOnScreen(snapshot: QualifySnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return (snapshot.bookFacilities ?? null) !== null && scopedPayerOf(snapshot.resolved) !== null;
}

/**
 * ── DOES THE BOOK **LEAD** THE ANSWER? (S3, Alec 2026-08-08) ─────────────────────────────────────
 *
 * The inversion, in one predicate. When this is true the payer's whole book becomes the answer's own
 * ranked grid, the identifier's footprint stops rendering as a second grid and survives as
 * annotations on the book's rows, and the hero, the scope sentences, the trace panel and the AI
 * captions all re-base onto the list that leads.
 *
 * ⚠ IT IS BUILT ON `bookIsOnScreen`, NOT BESIDE IT. "Is there a book" has ONE home — including its
 * `?? null` absent-field coercion, whose loss broke 40 renders once already. This adds the second
 * question ("and does it lead") on top; it never re-answers the first.
 *
 * ONE MEMBER ONLY, and the measurement is the argument: 58.8% of prefixes resolve to exactly one
 * member carrying 1.14 facilities of history. Ranking 1.14 rows is not a thin ranking, it is a
 * MALFORMED one — a ranking is a comparative claim and there is nothing to compare — while the
 * payer's book is the list that answers "does this policy pay, anywhere". At 2-9 and 10+ the
 * identifier has a real population of its own and keeps the lead; at `null` the engine could not
 * classify and must not guess; at 0 there is no history to annotate with.
 *
 * ⚠ AN EMPTY BOOK CANNOT LEAD, and this is the one place the two predicates deliberately differ.
 * `bookIsOnScreen` is TRUE for an empty book, because the secondary section renders a real "nothing
 * cleared the floor" sentence and that is a state rather than an absence. Leading with it would put
 * a void where the answer goes AND hide the member's own facilities behind it — so where the book
 * has nothing, the member's footprint, however thin, is the only evidence on the surface and keeps
 * the grid.
 */
export function bookLeadsAnswer(snapshot: QualifySnapshot | null | undefined): boolean {
  if (!bookIsOnScreen(snapshot)) return false;
  return (
    (snapshot!.bookFacilities ?? EMPTY_FACILITIES).length > 0 &&
    memberBucketOf(snapshot!.memberCount) === 'one'
  );
}

/** What the answer's rating is computed OVER, and what it should call that basis. */
export interface AnswerRatingBasis {
  /** The list that LEADS: the book in book-led mode, the member ranking otherwise. */
  facilities: readonly QualifyFacility[];
  /** The scope label handed to `derivePolicyRating` — undefined for the member ranking. */
  basisScope: string | undefined;
}

/**
 * ── WHICH LIST THE ANSWER'S RATING IS PATIENT-WEIGHTED OVER — ONE DEFINITION (2026-08-11) ────────
 *
 * The answer stage's hero and the lane rail's ANSWER step both show a `derivePolicyRating` number,
 * and they must be the SAME number: they sit on one screen, feet apart, describing one answer.
 *
 * ⚠ THEY WERE NOT. `StageAnswer` re-based onto the book when `bookLeadsAnswer` (S3), while
 * `laneInputForFlow` kept passing `snapshot.facilities` — the member ranking — with no scope label.
 * So in book-led mode the rail patient-weighted a list nobody had drawn, and the two numbers could
 * differ for real rather than theoretically: the member ranking is FLOORLESS while the book applies
 * `QUALIFY_MIN_LINES`, so a facility billed 1-2 lines is in one list and absent from the other. The
 * rail's own docblock asserted the numbers were identical the whole time it was false.
 *
 * ⚠ THE REPAIR IS THIS FUNCTION, NOT A SECOND COPY OF THE CHOICE. Restating
 * `leads ? bookFacilities : facilities` at the second call site would make today's numbers agree and
 * leave two expressions to keep in step — which is precisely how `bookIsOnScreen` above came to
 * exist, after the shell and the stage drifted onto different spellings of "is there a book". One
 * definition, two readers; a relabel cannot move one site without the other.
 *
 * PURE and snapshot-only ON PURPOSE. Every input is a field of the snapshot, so this needs no
 * component state and no hook — which is what lets a parent (`ResolutionStages`, via
 * `laneInputForFlow`) and a child (`StageAnswer`) read one value without threading a prop between
 * them or lifting state to hold it.
 *
 * Null in, null out: no snapshot is "nothing to rate", distinct from a snapshot whose list is empty
 * (a real verdict — see `derivePolicyRating`'s own not-rated branch).
 */
export function answerRatingBasis(
  snapshot: QualifySnapshot | null | undefined,
): AnswerRatingBasis | null {
  if (snapshot == null) return null;
  const leads = bookLeadsAnswer(snapshot);
  const payer = scopedPayerOf(snapshot.resolved);
  return {
    facilities: leads
      ? (snapshot.bookFacilities ?? EMPTY_FACILITIES)
      : (snapshot.facilities ?? EMPTY_FACILITIES),
    // `leads` already implies a non-null payer (`bookIsOnScreen` is its first half), so the
    // `payer !== null` half is unreachable — kept because TS cannot narrow through the predicate,
    // and because dropping a coercion during a unification is how a unification regresses.
    basisScope: leads && payer !== null ? `${payer}'s whole book` : undefined,
  };
}

/**
 * WHERE the book is drawn, relative to the AI panel — three states, because the honest caption
 * differs in each and because two booleans (`onScreen && leads`) is a pair a call site can set to an
 * impossible combination. This caption is exactly the surface where an impossible pair would render
 * as a confident sentence.
 */
export type QualifyBookPlacement = 'none' | 'secondary' | 'leading';

/**
 * ⚠ THE ORDER OF THE TWO QUESTIONS IS THE DECISION, not a style choice. `bookLeadsAnswer` is asked
 * FIRST: when the book leads it is not "also on screen", it IS the grid, and the member ranking the
 * model read is no longer drawn as a list at all. An implementation that asked `bookIsOnScreen`
 * first would answer `'secondary'` for every book-led screen, and the caption would point the reader
 * BELOW them at a list that is above them.
 */
export function bookPlacementFor(snapshot: QualifySnapshot | null | undefined): QualifyBookPlacement {
  if (bookLeadsAnswer(snapshot)) return 'leading';
  return bookIsOnScreen(snapshot) ? 'secondary' : 'none';
}

/**
 * THE AI PANEL'S IDLE CAPTION — what the model actually read, named by its position on screen.
 *
 * The payload is `snapshot.facilities.slice(0, 10)` in EVERY mode: the identifier's own ranking,
 * unchanged schema. The payer's book is never mapped into it (sending it would be a schema +
 * system-prompt + firewall change, and a separate ruling). So this sentence's whole job is to say
 * which of the lists on screen backs the answer — and each arm is false in the other two states:
 *
 *   'none'      — no book drawn. Byte-identical to the pre-S2 string (v2's tab, and any v3 answer
 *                 with no book).
 *   'secondary' — the book sits BELOW the member ranking. The model read the list above.
 *   'leading'   — the book IS the grid; the member's footprint is a MARK on its rows. "The ranking
 *                 above" would now point at the one list the model has never seen.
 *
 * ⚠ COPY IS UNRATIFIED (flagged for Alec).
 */
export function aiGroundingCaption(placement: QualifyBookPlacement): string {
  // ⚠ POSITION-NEUTRAL SINCE 2026-08-12. These arms read "above" and "below" while the panel
  // rendered in the BOARD, directly under the ranking. The panel now mounts in the LANE RAIL and the
  // ranking is in the other column, so both words were false — and below `xl` the rail stacks ABOVE
  // the board, so no positional word is safe here at all (the same reason
  // qualify-shell-render.test.tsx forbids "on the left" in shell components). Name the LIST, never
  // the direction.
  const grounded =
    placement === 'leading'
      ? "in this member's own history, not the whole-book ranking"
      : placement === 'secondary'
        ? 'in the member ranking, not the whole-book list'
        : 'in this search';
  return `Preset questions only — each streams a short read grounded in the exact numbers ${grounded}. Nothing here is a guarantee of payment.`;
}
