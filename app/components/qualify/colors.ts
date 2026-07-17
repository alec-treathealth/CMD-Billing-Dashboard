/**
 * Qualify color mapping — PURE, client-safe, no React. The 38/26 RATING cutoffs live in
 * app/lib/qualify/rating.ts (ratingBucket) — the ONE shared source both the desktop tab (Prompt 3)
 * and the mobile PWA (Prompt 4) import; this module only maps a bucket → the CSS class the surface
 * paints with, and builds the facility-name → bucket map the cases panel tints from.
 *
 * Imports are RELATIVE (not the `@/` alias) so this and its consumers load under `tsx` in the
 * hermetic render test without depending on tsconfig path-alias resolution.
 *
 * CASE-COLOR RULE (ruling 2026-07-17): a case row is tinted by its PARENT FACILITY's dampened rating
 * bucket — NEVER by the case's own n=1 raw pct (raw pct on the thinnest possible volume is exactly
 * what the dampening exists to correct). Same "green means green" everywhere; no case can fake green.
 */
import { ratingBucket, type RatingBucket } from '../../lib/qualify/rating';
import type { QualifyFacility } from '../../lib/qualify/contract';

export type { RatingBucket };

/** Bucket → the namespaced status class. `.q-<bucket>` sets --q-c / --q-wash in globals.css. */
export function bucketClass(bucket: RatingBucket): `q-${RatingBucket}` {
  return `q-${bucket}`;
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
