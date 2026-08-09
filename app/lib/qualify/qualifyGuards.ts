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
import type { QualifyFacility, QualifyResolved } from './contract';

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

// ── Fix A — identifier-landing helpers (pure; shared by desktop + mobile) ─────────────────────────────

/** True when the resolution came from an identifier SEARCH (prefix / member-id), vs the resolve-by-payer
 *  path (matchedOn === 'payer') or no resolution. Distinguishes Fix A's identifier-landing behavior from
 *  the browse path at the moment of facility selection. */
export function isIdentifierResolution(resolved: QualifyResolved | null): boolean {
  return resolved !== null && resolved.matchedOn !== 'payer';
}

/** True when an identifier search resolved but has NO claim at any ranked facility in-window — the honest
 *  "no in-window claims — widen the window" trigger (distinct from resolved===null / VOB). Keyed on the
 *  server-computed landing facility, which the core has already dropped to null for a below-floor-only id. */
export function isIdentifierEmpty(resolved: QualifyResolved | null, landingFacility: string | null): boolean {
  return isIdentifierResolution(resolved) && landingFacility === null;
}

/** The NON-PHI label for the honest-empty copy: the ≤3 alpha-prefix echo for a prefix search; the generic
 *  'this member' for an exact member-id search (NEVER the raw id). '' for non-identifier resolutions. */
export function identifierEmptyTerm(resolved: QualifyResolved | null): string {
  if (!isIdentifierResolution(resolved)) return '';
  return resolved!.matchedOn === 'prefix' && resolved!.matchedValue ? resolved!.matchedValue : 'this member';
}

/** PART A (mobile list SCOPE): decide WHICH facilities the ranked list shows for the current resolution.
 *  Supersedes the former lead-the-deck reorder (leadFacilities) — an identifier search no longer merely
 *  leads with the landing facility, it SCOPES to it:
 *   - IDENTIFIER search (isIdentifierResolution) that LANDED → ONLY the landing facility (the searched
 *     member's most-recent in-window claim facility). The search answered a specific question; the rest of
 *     the payer's ranked set is not that answer. Honest-empty (landingKey === null) → [] — the caller's
 *     isIdentifierEmpty branch renders the widen-window nudge, so a below-floor id never shows a random card.
 *   - BROWSE (resolve-by-payer / matchedOn 'payer', or no resolution) → the FULL ranked list, which the
 *     area/LOC filters + 5-up pager then operate on. That list is ordered AVAILABILITY-FIRST, then by
 *     ratingV2 (assembleFacilities, 2026-08-08) — this said "rating order", which stopped being true
 *     when a confirmed-full facility started sorting below every facility that can admit today. This
 *     function does not re-order and never has; it only decides WHICH rows are in scope.
 *  Pure + total; never mutates the input; returns a fresh array. */
export function scopeFacilitiesForList(
  facilities: readonly QualifyFacility[],
  resolved: QualifyResolved | null,
  landingKey: string | null,
): QualifyFacility[] {
  if (!isIdentifierResolution(resolved)) return facilities.slice(); // browse — the full ranked set
  if (landingKey === null) return []; // identifier honest-empty — caller shows the widen-window nudge
  const landing = facilities.find((f) => f.facilityKey === landingKey);
  return landing ? [landing] : []; // scope to the single landing facility (guaranteed present when non-null)
}
