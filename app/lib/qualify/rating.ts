/**
 * Qualify facility RATING — the ONE shared, PURE, CLIENT-SAFE module both surfaces import (the
 * desktop tab, Prompt 3, and the mobile PWA, Prompt 4). Keep it here so the badge math + color
 * thresholds live in exactly one place and can never drift between the two frontends.
 *
 * CLIENT-SAFE: consumes only `pctAllowed` (a percentage) + `lineCount` (a count) + compile-time
 * constants — NEVER dollar amounts. So an admissions_seat session (which the server strips of all
 * dollar fields) computes the identical badge with zero dependency on billed/allowed.
 *
 * WHAT IT IS (ruling R-RATING + the distribution-approved constants, 2026-07-17; reweighted 2026-07-18):
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
 *       K         = QUALIFY_RATING_K  = 25   (credibility crossover: observed and prior weigh 50/50 at n=25)
 *       PRIOR     = QUALIFY_RATING_PRIOR = 30 (fixed conservative allowed/billed baseline, %)
 *
 * REWEIGHT toward the allowed amount (ruling 2026-07-18): K was halved 50→25 so the REAL dollar-weighted
 * allowed/billed ratio dominates the score from ~25 charge lines instead of ~50 — the shrinkage toward
 * PRIOR fades twice as fast, i.e. the score leans harder on what a facility actually collects. PRIOR
 * stays 30 (the anchor is unchanged; K is the ONLY reweight lever). The color cutoffs were recalibrated
 * in the same ruling (below) so "green still means green" on the reweighted distribution.
 *
 * WHY prior = 30 (NOT the 38.66% book dollar-weighted mean): the prior anchors UNPROVEN / tiny-volume
 * facilities, so it must sit in the amber band — an unproven facility must read "typical / limited
 * data", never green. 38.66% is dollar-weighted (inflated by a few high-volume facilities); the typical
 * FACILITY sits far lower (unweighted median ~29%; cross-tenant windowed raw-pct p50 ≈ 25), so 30 is the
 * right anchor. The ordering invariant STILL holds under K=25: rating(60,3)=33.2 (amber) <
 * rating(55,400)=53.5 (green) — a tiny-volume 60% neither outranks nor out-colors a solid 55%. That
 * property is pinned by an EXECUTABLE assertion in test/qualifyRating.test.ts (asserts via ratingBucket,
 * which reads these constants, so it fails the build if K or the cutoffs ever regress it) — NOT by prose.
 *
 * COLOR CUTOFFS (applied to the RATING, never raw pct) — recalibrated 2026-07-18 to the reweighted
 * (K=25) cross-tenant WINDOWED rating distribution: danger < 25 · warn 25–40 · ok ≥ 40. Red floor ≈ p25,
 * green ceiling ≈ p83 of that distribution, and STABLE across BOTH the mobile 30d window and desktop's
 * wider 90d window (this module is shared by both surfaces, so the recolor was signed off on both):
 *
 *     window   scored   🟢 ≥40         🟡 25–40        🔴 <25
 *     30d       393     52  (13.2%)    233 (59.3%)    108 (27.5%)
 *     90d       539     97  (18.0%)    264 (49.0%)    178 (33.0%)
 *
 *   (K=25 pctiles — 30d: p25≈24.5 p50≈28.8 p75≈34.1 p90≈42.6 · 90d: p25≈22.9 p50≈28.7 p75≈36.5 p90≈45.7.)
 * DELIBERATELY STRICT green: this is a lead-qualification surface where rating drives both the sort (Q-G)
 * and the color an admissions rep reads as "lean into this lead." A false GREEN is costlier than a false
 * AMBER — amber just means "verify" (which admissions does anyway), while green says "this payer/facility
 * pays, pursue." The reweight's MAIN effect is that genuinely-weak facilities the old 30-prior used to
 * rescue up into amber now correctly read red (30d red 21%→27%); green stays a strict ~13–18% minority.
 * amber = the prior/unproven middle; red = clearly below typical.
 *
 * v1 does NOT fold any second signal (denial rate, recency, streak, …) into rating — a second term
 * would silently reweight the SORT (rating drives rank under Q-G) and destroy sort explainability.
 * Any future factor is an explicit v2 decision.
 */

/** Fixed conservative allowed/billed prior (%) the rating shrinks toward. Unchanged by the 2026-07-18
 *  reweight — the anchor stays put; K is the only reweight lever. */
export const QUALIFY_RATING_PRIOR = 30;

/** Credibility crossover in charge lines: observed and prior weigh 50/50 at lineCount = K. Halved
 *  50→25 on 2026-07-18 so the real allowed/billed ratio dominates from ~25 lines (reweight toward the
 *  allowed amount). See the module doc. */
export const QUALIFY_RATING_K = 25;

/** Rating >= this is "ok" (green). Recalibrated 38→40 on 2026-07-18 to ≈ p83 of the reweighted (K=25)
 *  distribution — green must mean green on a lead surface (a false green is costlier than a false
 *  amber). See the module doc. */
export const RATING_OK_MIN = 40;
/** Rating in [RATING_WARN_MIN, RATING_OK_MIN) is "warn" (amber); below is "danger" (red). Recalibrated
 *  26→25 on 2026-07-18 to ≈ p25 of the reweighted distribution. */
export const RATING_WARN_MIN = 25;

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

/**
 * A DYNAMIC, per-facility explanation of WHY the rating landed where it did — derived from that
 * facility's own numbers, NOT a fixed string. Same purity/client-safety as qualifyRating (no dollars),
 * so both surfaces can render it and the amounts gate is satisfied by construction. Exposes the three
 * levers the shrinkage actually turns:
 *   - volumeWeight = n/(n+K): how much of the score is real observed data vs the book prior (0..1)
 *   - priorPullPts = rawPct − rating: SIGNED points the prior moved the score (+ = pulled down toward
 *     a below-observed baseline; − = lifted up). 0 when the observed ratio already equals the prior.
 * `sentence` is generated from those so a high-volume facility, a thin-volume-above-prior facility,
 * and a thin-volume-below-prior facility each read differently. Mirrors qualifyRating's null-handling.
 */
export interface RatingExplanation {
  rawPct: number | null; // observed dollar-weighted allowed/billed (null → neutral)
  lineCount: number; // clamped to >= 0 (same as qualifyRating)
  volumeWeight: number; // n/(n+K), 0..1 — the share of the score that is real data
  priorPullPts: number; // rawPct - rating, signed; 0 when rawPct is null
  sentence: string; // plain-language, generated from the values above
}

export function explainRating(pctAllowed: number | null, lineCount: number): RatingExplanation {
  const n = Number.isFinite(lineCount) && lineCount > 0 ? lineCount : 0;
  const volumeWeight = n / (n + QUALIFY_RATING_K);
  const wPct = Math.round(volumeWeight * 100);
  const rating = qualifyRating(pctAllowed, lineCount);
  if (pctAllowed === null || rating === null) {
    return {
      rawPct: null,
      lineCount: n,
      volumeWeight,
      priorPullPts: 0,
      sentence: 'No allowed / billed ratio is available for this facility yet, so it carries a neutral rating.',
    };
  }
  const priorPullPts = pctAllowed - rating; // + ⇒ prior pulled the score DOWN; − ⇒ lifted it UP
  const rawR = Math.round(pctAllowed);
  const pull = Math.abs(Math.round(priorPullPts));
  let sentence: string;
  if (volumeWeight >= 0.8) {
    sentence = `Backed by ${n} claim lines, so the score reflects the observed ${rawR}% allowed almost as-is (${wPct}% of the score is real data).`;
  } else if (pull === 0) {
    sentence = `The observed ${rawR}% already sits at the ${QUALIFY_RATING_PRIOR}% book baseline, so volume doesn't move the score.`;
  } else if (priorPullPts > 0) {
    sentence = `Only ${n} claim lines back this, so the observed ${rawR}% is trimmed ${pull} pts toward the ${QUALIFY_RATING_PRIOR}% book baseline until more volume confirms it (${wPct}% real data).`;
  } else {
    sentence = `Only ${n} claim lines back this, so the observed ${rawR}% is lifted ${pull} pts toward the ${QUALIFY_RATING_PRIOR}% book baseline (${wPct}% real data).`;
  }
  return { rawPct: pctAllowed, lineCount: n, volumeWeight, priorPullPts, sentence };
}
