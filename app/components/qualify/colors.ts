/**
 * Qualify color mapping — PURE, client-safe, no React. The 50/30 RATING cutoffs (on the allowed%) live
 * in app/lib/qualify/rating.ts (ratingBucket) — the ONE shared source both the desktop tab (Prompt 3)
 * and the mobile PWA (Prompt 4) import; this module only maps a bucket → the CSS class the surface
 * paints with, and builds the facility-name → bucket map the cases panel tints from.
 *
 * Imports are RELATIVE (not the `@/` alias) so this and its consumers load under `tsx` in the
 * hermetic render test without depending on tsconfig path-alias resolution.
 *
 * CASE-COLOR RULE — HISTORY, current rule last (this comment has been retired twice):
 *   1. (2026-07-17) tinted by the PARENT FACILITY's rating bucket — retired;
 *   2. then by the row's OWN pct through ratingBucket — retired;
 *   3. (CURRENT, 0059 trust signal) CONFIDENCE-FIRST: a `confirmed` claim colors by its own pct's
 *      ratingBucket; an `estimate` (tier e2 — reversals we couldn't verify) is ALWAYS amber (q-warn)
 *      no matter how high its number reads — X's reversal tell, never painted green; an `unknown`
 *      (no allowed on file) is neutral. confidenceClass below is the one mapping.
 * buildFacilityBucketMap/caseBucket remain for the legacy tint consumers (mobile) until their own phase.
 */
import { ratingBucket, type RatingBucket } from '../../lib/qualify/rating';
import type { QualifyConfidence } from '../../lib/qualify/confidence';
import type { QualifyFacility } from '../../lib/qualify/contract';

export type { RatingBucket };

/** Bucket → the namespaced status class. `.q-<bucket>` sets --q-c / --q-wash in globals.css. */
export function bucketClass(bucket: RatingBucket): `q-${RatingBucket}` {
  return `q-${bucket}`;
}

/**
 * Confidence → the q-class its UI wears (coverage-bar segments, legend dots, the estimate %-cell):
 * confirmed → q-ok · estimate → q-warn (amber — NEVER green, regardless of the number) ·
 * unknown → q-neutral. The pct INSIDE a confirmed cell still grades by ratingBucket; this class
 * only governs the confidence vocabulary itself.
 */
export function confidenceClass(c: QualifyConfidence): 'q-ok' | 'q-warn' | 'q-neutral' {
  return c === 'confirmed' ? 'q-ok' : c === 'estimate' ? 'q-warn' : 'q-neutral';
}

/**
 * facility display name → its rating bucket, for tinting case rows by their parent facility.
 * Both panels resolve the SAME display name (`facility_name ?? facility`) from the same rollup
 * column + crosswalk, so the name is a sound client-side join key (no server threading needed).
 * Collision-safe: if two facility rows share a resolved name but DISAGREE on bucket, that name maps
 * to 'neutral' — an ambiguous name can never let a case wear the greener of the two.
 */
export function buildFacilityBucketMap(facilities: readonly QualifyFacility[]): Map<string, RatingBucket> {
  const map = new Map<string, RatingBucket>();
  const conflicted = new Set<string>();
  for (const f of facilities) {
    const b = ratingBucket(f.rating);
    const prev = map.get(f.name);
    if (prev === undefined) map.set(f.name, b);
    else if (prev !== b) conflicted.add(f.name);
  }
  for (const name of conflicted) map.set(name, 'neutral');
  return map;
}

/**
 * The bucket a case row is tinted with: its parent facility's bucket, else 'neutral'. A case whose
 * facility isn't in the (non-null) facilities list — e.g. its facility text was null/empty — is
 * neutral, never a fabricated color derived from the case's own pct.
 */
export function caseBucket(map: Map<string, RatingBucket>, facilityName: string | null): RatingBucket {
  if (facilityName === null) return 'neutral';
  return map.get(facilityName) ?? 'neutral';
}
