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

/** Fix A (mobile lead-the-deck): reorder facilities so `landingKey` leads, the rest keeping their (rating)
 *  order. No-op when landingKey is null or not present in the list (a below-floor landing never reaches here
 *  because the core nulls it, but the guard keeps this pure function total). Never mutates the input. */
export function leadFacilities(facilities: readonly QualifyFacility[], landingKey: string | null): QualifyFacility[] {
  if (landingKey === null) return facilities.slice();
  const idx = facilities.findIndex((f) => f.facilityKey === landingKey);
  if (idx <= 0) return facilities.slice(); // not present (-1) or already leading (0)
  const lead = facilities[idx]!;
  return [lead, ...facilities.slice(0, idx), ...facilities.slice(idx + 1)];
}
