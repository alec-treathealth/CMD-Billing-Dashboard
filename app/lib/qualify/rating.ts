/**
 * Qualify facility RATING — VALUE-FIRST model (ruling 2026-07-19b, Alec; supersedes the 2026-07-17/18
 * shrinkage model and the un-shipped 2026-07-19 min-cap). The rating IS the facility's dollar-weighted
 * allowed ÷ billed — full stop. Volume no longer bends the score: in RCM the allowed% reflects the
 * payer's CONTRACTED rate, which is stable even at low volume, so a small facility genuinely at 90% is a
 * strong lead (a smaller opportunity, not an unreliable one) and MUST rank on its merit. Under ruling Q-G
 * the rating is BOTH the list sort key AND the badge-color source; it now equals the displayed
 * pctAllowedOfBilled.
 *
 * CLIENT-SAFE: consumes only `pctAllowed` (a percentage) — NEVER dollar amounts. So an admissions_seat
 * session (server-stripped of all dollar fields) computes the identical badge from billed/allowed-free data.
 *
 * VOLUME is surfaced as CONTEXT, two ways — never as a score penalty:
 *   - HARD FLOOR (QUALIFY_MIN_LINES): a facility with fewer than this many charge lines is dropped from
 *     the ranked list entirely (applied in core.ts assembleFacilities), so a degenerate "100% on 1 claim"
 *     fluke never surfaces. Set LOW — it kills flukes, NOT genuinely small facilities.
 *   - SOFT FLAG (QUALIFY_LIMITED_DATA_LINES): below this, explainRating marks the facility "limited data"
 *     so the user weighs the sample size themselves (pairs with click-into-facility).
 *
 * COLOR CUTOFFS (applied to the rating = allowed%): ok ≥ RATING_OK_MIN · warn ≥ RATING_WARN_MIN · else
 * danger. TUNABLE — they encode "what allowed% reads as strong / typical / weak reimbursement" and are a
 * product (Alec) call, not a statistical one.
 *
 * v1 folds NO second signal (denial rate, recency, streak, …) into the rating — the rating is exactly the
 * allowed%, which keeps the sort perfectly explainable. Any future factor is an explicit v2 decision.
 */

/** Hard floor: a facility with fewer than this many charge lines is SUPPRESSED from the ranked list —
 *  it kills 1–2-line flukes ("100% on one claim") without burying genuinely small facilities. Tunable. */
export const QUALIFY_MIN_LINES = 3;

/** Soft threshold: below this many charge lines, explainRating flags "limited data" (context for the
 *  user, NOT a score penalty). Tunable. */
export const QUALIFY_LIMITED_DATA_LINES = 10;

/** Rating (= allowed%) ≥ this is "ok" (green) — "strong reimbursement". TUNABLE (product call). */
export const RATING_OK_MIN = 50;
/** Rating in [RATING_WARN_MIN, RATING_OK_MIN) is "warn" (amber); below is "danger" (red). TUNABLE. */
export const RATING_WARN_MIN = 30;

export type RatingBucket = 'ok' | 'warn' | 'danger' | 'neutral';

/** Shared legend copy (both surfaces render this). Labels ruled 2026-07-24: Strong / Watch / Weak.
 *  The description also defines the UI's "n" (Change A): n = claim lines backing the rating. */
export const RATING_LEGEND: { description: string; labels: Record<Exclude<RatingBucket, 'neutral'>, string> } = {
  description: 'Reimbursement rating — the facility’s allowed ÷ billed. Small facilities rank on merit; “thin sample” flags a small claim count. n = claim lines backing the rating.',
  labels: { ok: 'Strong', warn: 'Watch', danger: 'Weak' },
};

function clamp0to100(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * The rating = the dollar-weighted allowed ÷ billed, clamped to [0, 100]. Returns null when pctAllowed is
 * null (a guarded/undefined ratio → NEUTRAL badge). Volume does NOT enter the score — it gates a
 * facility's APPEARANCE (QUALIFY_MIN_LINES, in assembleFacilities) and its "limited data" context only.
 * Pure + deterministic + client-safe (no dollars).
 */
export function qualifyRating(pctAllowed: number | null): number | null {
  if (pctAllowed === null || Number.isNaN(pctAllowed)) return null;
  return clamp0to100(pctAllowed);
}

/** Map a rating (or null) to its badge bucket. null → 'neutral' (no data). */
export function ratingBucket(rating: number | null): RatingBucket {
  if (rating === null || Number.isNaN(rating)) return 'neutral';
  if (rating >= RATING_OK_MIN) return 'ok';
  if (rating >= RATING_WARN_MIN) return 'warn';
  return 'danger';
}

/**
 * A DYNAMIC, per-facility explanation of the rating — derived from that facility's own numbers. Same
 * purity/client-safety as qualifyRating (no dollars). Under the value-first model the rating IS the
 * allowed%, so the explanation's job is to (a) restate that and (b) surface VOLUME as context: how many
 * claim lines back it, and whether that's a thin ("limited data") sample. Mirrors qualifyRating's
 * null-handling.
 */
export interface RatingExplanation {
  rawPct: number | null; // observed dollar-weighted allowed/billed (null → neutral)
  lineCount: number; // clamped to >= 0
  limitedData: boolean; // lineCount < QUALIFY_LIMITED_DATA_LINES — a thin sample, treat as an early signal
  sentence: string; // plain-language, generated from the values above
}

export function explainRating(pctAllowed: number | null, lineCount: number): RatingExplanation {
  const n = Number.isFinite(lineCount) && lineCount > 0 ? lineCount : 0;
  const limitedData = n < QUALIFY_LIMITED_DATA_LINES;
  if (pctAllowed === null || Number.isNaN(pctAllowed)) {
    return {
      rawPct: null,
      lineCount: n,
      limitedData,
      sentence: 'No allowed / billed ratio is available for this facility yet, so it carries a neutral rating.',
    };
  }
  const rawR = Math.round(pctAllowed);
  const sentence = limitedData
    ? `Ranked on its ${rawR}% allowed ÷ billed. Only ${n} claim line${n === 1 ? '' : 's'} back it so far — a thin sample, so treat it as an early signal.`
    : `Ranked on its ${rawR}% allowed ÷ billed, backed by ${n} claim lines.`;
  return { rawPct: pctAllowed, lineCount: n, limitedData, sentence };
}
