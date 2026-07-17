/**
 * Qualify facility RATING — the ONE shared, PURE, CLIENT-SAFE module both surfaces import (the
 * desktop tab, Prompt 3, and the mobile PWA, Prompt 4). Keep it here so the badge math + color
 * thresholds live in exactly one place and can never drift between the two frontends.
 *
 * CLIENT-SAFE: consumes only `pctAllowed` (a percentage) + `lineCount` (a count) + compile-time
 * constants — NEVER dollar amounts. So an admissions_seat session (which the server strips of all
 * dollar fields) computes the identical badge with zero dependency on billed/allowed.
 *
 * WHAT IT IS (ruling R-RATING + the distribution-approved constants, 2026-07-17):
 *   `rating` is a confidence-DAMPENED version of `pctAllowedOfBilled`, DISTINCT from it. Under ruling
 *   Q-G it is BOTH the list SORT key AND the badge-color source; the raw `pctAllowedOfBilled` is a
 *   displayed value only. rating shrinks the observed dollar-weighted allowed/billed ratio toward a
 *   fixed conservative prior in proportion to how little volume backs it, so a high ratio on tiny
 *   volume cannot outrank (or wear the same green as) a solid ratio on real volume.
 *
 * FORMULA (empirical-Bayes / credibility shrinkage), output clamped to [0, 100]:
 *
 *     rating = (n / (n + K)) * pctAllowed  +  (K / (n + K)) * PRIOR
 *
 *       n         = lineCount (logical charge lines for this facility×payer, in-window)
 *       pctAllowed= pctAllowedOfBilled, 0-100, dollar-weighted allowed/billed
 *       K         = QUALIFY_RATING_K  = 50   (credibility crossover: observed and prior weigh 50/50 at n=50)
 *       PRIOR     = QUALIFY_RATING_PRIOR = 30 (fixed conservative allowed/billed baseline, %)
 *
 * WHY prior = 30 (NOT the 38.66% book dollar-weighted mean): the prior anchors UNPROVEN / tiny-volume
 * facilities, so it must sit in the amber band — an unproven facility must read "typical / limited
 * data", never green. 38.66% is dollar-weighted (inflated by a few high-volume facilities); the
 * typical FACILITY (unweighted median) is ~29%, so 30 is the right anchor. It is also safely below
 * the ordering-invariant bound (~54.7 at K=50): rating(60,3)=31.7 < rating(55,400)=52.2, so a
 * tiny-volume 60% neither outranks nor out-colors a solid 55%.
 *
 * COLOR CUTOFFS (applied to the RATING, never raw pct) — calibrated to the real cross-tenant WINDOWED
 * rating distribution (90d: p25≈25, p50≈29, p75≈34.5, p90≈41): danger < 26 · warn 26–38 · ok ≥ 38.
 * DELIBERATELY STRICT green (ruling 2026-07-17): this is a lead-qualification surface where rating
 * drives both the sort (Q-G) and the color an admissions rep reads as "lean into this lead." A false
 * GREEN is costlier than a false AMBER — amber just means "verify" (which admissions does anyway),
 * while green says "this payer/facility pays, pursue." So green must be trustworthy WITHOUT
 * re-checking; the ≥38 cutoff (≈ the 38.66% book dollar-weighted mean) means "at or above what this
 * book actually collects, earned on real volume." Green lands at ~11–15% of facilities per window —
 * NOT a bug: on a 38% book most facilities are legitimately "typical", only a minority genuinely
 * strong. amber = the prior/unproven middle; red = clearly below typical.
 *
 * v1 does NOT fold any second signal (denial rate, recency, streak, …) into rating — a second term
 * would silently reweight the SORT (rating drives rank under Q-G) and destroy sort explainability.
 * Any future factor is an explicit v2 decision.
 */

/** Fixed conservative allowed/billed prior (%) the rating shrinks toward. */
export const QUALIFY_RATING_PRIOR = 30;

/** Credibility crossover in charge lines: observed and prior weigh 50/50 at lineCount = K. */
export const QUALIFY_RATING_K = 50;

/** Rating >= this is "ok" (green). Deliberately strict (≈ book mean) — green must mean green on a
 *  lead-qualification surface (a false green is costlier than a false amber). See the module doc. */
export const RATING_OK_MIN = 38;
/** Rating in [RATING_WARN_MIN, RATING_OK_MIN) is "warn" (amber); below is "danger" (red). */
export const RATING_WARN_MIN = 26;

export type RatingBucket = 'ok' | 'warn' | 'danger' | 'neutral';

/** Shared legend copy (both surfaces render this) — describes the RATING, not raw pct. */
export const RATING_LEGEND: { description: string; labels: Record<Exclude<RatingBucket, 'neutral'>, string> } = {
  description: 'Reimbursement rating — allowed ÷ billed, adjusted for how much volume backs it.',
  labels: { ok: 'Strong', warn: 'Typical / limited data', danger: 'Weak' },
};

function clamp0to100(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * Compute a facility's rating from its dollar-weighted %-allowed and charge-line volume. Returns null
 * when pctAllowed is null (a guarded/undefined ratio → NEUTRAL badge; never a fabricated prior-colored
 * one). lineCount <= 0 yields the pure prior (a facility with no lines never actually appears — this is
 * defensive). Pure + deterministic + client-safe (no dollars).
 */
export function qualifyRating(pctAllowed: number | null, lineCount: number): number | null {
  if (pctAllowed === null || Number.isNaN(pctAllowed)) return null;
  const n = Number.isFinite(lineCount) && lineCount > 0 ? lineCount : 0;
  const k = QUALIFY_RATING_K;
  const rating = (n / (n + k)) * pctAllowed + (k / (n + k)) * QUALIFY_RATING_PRIOR;
  return clamp0to100(rating);
}

/** Map a rating (or null) to its badge bucket. null → 'neutral' (no data). */
export function ratingBucket(rating: number | null): RatingBucket {
  if (rating === null || Number.isNaN(rating)) return 'neutral';
  if (rating >= RATING_OK_MIN) return 'ok';
  if (rating >= RATING_WARN_MIN) return 'warn';
  return 'danger';
}
