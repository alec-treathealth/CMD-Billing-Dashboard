/**
 * Qualify — async-landing GUARD PREDICATES (Stage 3a). Pure decision functions shared by the mobile
 * shell's two-stream guard topology (and available to desktop). They take ALREADY-COMPUTED values —
 * captured vs. current sequence tokens, cohort-key strings (produced by cohortKey), and resolved-vs-
 * current payer labels — and return a boolean. They do NOT read React state, hold refs, or call the
 * reducer; the component computes the inputs and acts on the boolean. Kept server-free (no 'use server',
 * no server imports) so the root suite can unit-test the dangerous ordering logic deterministically —
 * closing the "trust by design" gap the way Stage 2 did, since the container itself can't be mounted
 * under the test runner.
 *
 * TWO STREAMS, deliberately NOT collapsed into one generation:
 *   - RESOLUTION (search / payer / window → snapshot + deck): recency only — `resolveLandingWins`.
 *   - DRILL (facility tap → facility-scoped cases): recency AND identity — `drillLandingWins`. Recency
 *     (facilitySeq) catches close→reopen + future pagination races; identity (cohortKey) catches a
 *     wrong-cohort landing after payer/facility/window/prefix changed underneath.
 * The streams write disjoint rendered state; `isPayerChange` gates the ONE shared structure (the cohort):
 * a payer change closes the open drill sheet, so a background resolution can never strand an in-flight
 * drill, and a same-payer re-resolve leaves the drill's cohortKey stable so its landing still wins.
 */

/** Resolution-stream recency guard: a landing commits only if its captured seq is still the latest issued. */
export function resolveLandingWins(capturedSeq: number, currentSeq: number): boolean {
  return capturedSeq === currentSeq;
}

/** Drill-stream guard: BOTH recency (facilitySeq) AND identity (cohortKey string) must still hold for the
 *  facility-cases landing to commit. capturedKey/currentKey are cohortKey() outputs computed by the caller. */
export function drillLandingWins(
  capturedSeq: number,
  currentSeq: number,
  capturedKey: string,
  currentKey: string,
): boolean {
  return capturedSeq === currentSeq && capturedKey === currentKey;
}

/** Sheet-close discriminator: does a resolution CHANGE the resolved payer (vs. the current cohort payer)?
 *  true → payer change: close the open drill sheet + reset the drill cohort (cohort-identity == resolution-
 *  identity, no stuck-loading). false → same payer (e.g. a window change): keep the sheet, refresh cases.
 *  null == null is NOT a change (an unresolved→unresolved re-run keeps everything). */
export function isPayerChange(prevPayer: string | null, nextPayer: string | null): boolean {
  return prevPayer !== nextPayer;
}
