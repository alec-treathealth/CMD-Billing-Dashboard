/**
 * Qualify CONFIDENCE — the plain-language collapse of 0059's six-value `allowed_tier` into THREE
 * states the user never has to decode (approved design intent, 2026-07-22):
 *
 *   confirmed — tiers a / cd / e1: the allowed is a value CMD actually adjudicated (single real
 *               value, the reconciling snapshot, or the reversal-netted sum that reconciles to
 *               paid + balance within $0.01). Trustworthy evidence.
 *   estimate  — tier e2: restated with NOTHING reconciling (the reversal-heavy tail). The displayed
 *               number is the latest positive allowed — honest best-effort, NOT verified. The
 *               value-first rating already EXCLUDES these (ruling Q2a: `allowed_tier <> 'e2'` in
 *               buildFacilityRankingQuery), and the UI must never paint an estimate green even when
 *               its number is high — that is BUILD X's reversal tell, preserved.
 *   unknown   — tiers b / none (and any null/unexpected input, fail-toward-unknown): no allowed on
 *               file (the CMD phantom $0, or no non-null allowed on any snapshot). Renders "—",
 *               never 0%.
 *
 * THE ONE SOURCE: both surfaces (desktop /qualify + mobile /qualify/m) import THIS mapping — no
 * per-surface tier logic anywhere. The SQL FILTER sets in buildFacilityRankingQuery
 * (src/collections/qualifyQuery.ts) mirror these buckets BY NECESSITY (SQL cannot import TS);
 * test/qualifyConfidence.test.ts asserts the two stay in lockstep — change one, the test names the
 * other.
 *
 * CLIENT-SAFE: pure, deterministic, no dollars, no server imports (mirrors rating.ts's shape) — an
 * admissions_seat session renders confidence/coverage from dollar-stripped data unchanged.
 */

export type QualifyConfidence = 'confirmed' | 'estimate' | 'unknown';

/** The tier buckets — exported so the SQL-parity test can assert the builder mirrors them exactly. */
export const CONFIRMED_TIERS: readonly string[] = ['a', 'cd', 'e1'];
export const ESTIMATE_TIERS: readonly string[] = ['e2'];
export const UNKNOWN_TIERS: readonly string[] = ['b', 'none'];

/** Collapse a raw 0059 allowed_tier to its confidence state. Unrecognized/null input fails toward
 *  'unknown' — a tier this module has never heard of must read "no allowed on file", never
 *  "confirmed". Pure + total. */
export function confidenceOf(tier: string | null | undefined): QualifyConfidence {
  if (tier != null && CONFIRMED_TIERS.includes(tier)) return 'confirmed';
  if (tier != null && ESTIMATE_TIERS.includes(tier)) return 'estimate';
  return 'unknown';
}

/** Shared legend copy — both surfaces render this verbatim (same pattern as RATING_LEGEND). */
export const CONFIDENCE_LEGEND: {
  description: string;
  labels: Record<QualifyConfidence, string>;
  captions: Record<QualifyConfidence, string>;
} = {
  description:
    'Confidence — whether each claim’s allowed amount is verified. The rating counts confirmed claims only.',
  labels: { confirmed: 'Confirmed', estimate: 'Estimate', unknown: 'No allowed on file' },
  captions: {
    confirmed: 'Allowed verified against payments on file.',
    estimate: 'Estimate · reversals we couldn’t verify.',
    unknown: 'No allowed on file.',
  },
};
