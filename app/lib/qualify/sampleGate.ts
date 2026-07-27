/**
 * Qualify RATING SAMPLE GATE — distinct-patient confidence tiering for the facility ranking
 * (hotfix 2026-07-27, Alec).
 *
 * WHY THIS EXISTS: the shipped rating (rating.ts) is value-first — the raw dollar-weighted allowed%,
 * with NO volume term. That is intended, and rating.ts is NOT reopened here. But under a payer slice
 * the median facility rests on ~2 DISTINCT PATIENTS (measured on prod 2026-07-27: facility × single
 * payer @90d median 2 patients, p25 1, 61.3% of rows < 3 patients, ~23 charge lines per patient; of
 * the "Strong" ≥50% rows, 74% are backed by 1-2 patients). A confident bucket color on 1-2 patients
 * reads as signal when it is sampling noise. This module tiers a facility by its distinct-patient
 * count — the statistically independent unit, since claims WITHIN a patient share one plan / contract
 * / CPT pattern and are not independent draws. Charge-line counts (rating.ts QUALIFY_LIMITED_DATA_LINES)
 * overstate the sample ~23×, so the gate keys on patients, not lines.
 *
 * The patient-based discipline mirrors the movers query (qualifyQuery.ts QUALIFY_MOVERS_MIN_PATIENTS /
 * MIN_CHARGES) rather than inventing a second idiom; the thresholds below (3 / 10) are the ruled
 * numbers for RATINGS and deliberately differ from movers' 5 / 10.
 *
 * SUPPRESSION IS A DISPLAY DECISION layered on top of the rating — the score itself is untouched.
 * Pure, client-safe, no dollars, no server imports (mirrors rating.ts / confidence.ts): an
 * admissions_seat session tiers from the (non-dollar) patient count unchanged.
 */

/** Fewer than this many DISTINCT PATIENTS → INSUFFICIENT: render no bucket color and no confident
 *  percentage — an explicit "insufficient data in this slice" state (the facility is still listed).
 *  Tunable (product ruling, 2026-07-27). */
export const QUALIFY_RATING_MIN_PATIENTS = 3;

/** At least this many distinct patients → FULL confidence (current presentation, unchanged). Between
 *  QUALIFY_RATING_MIN_PATIENTS and this → THIN: the rating renders but is visibly flagged a thin
 *  sample. Tunable (product ruling, 2026-07-27). */
export const QUALIFY_RATING_CONFIDENT_PATIENTS = 10;

/** insufficient → suppress · thin → flag · full → unchanged. */
export type RatingSampleTier = 'insufficient' | 'thin' | 'full';

/**
 * Tier a facility by its distinct-patient count. Non-finite / negative inputs clamp to 0 →
 * 'insufficient' (fail toward suppression, never toward a false-confident color). Pure + total.
 */
export function ratingSampleTier(distinctPatients: number): RatingSampleTier {
  const n = Number.isFinite(distinctPatients) && distinctPatients > 0 ? Math.trunc(distinctPatients) : 0;
  if (n < QUALIFY_RATING_MIN_PATIENTS) return 'insufficient';
  if (n < QUALIFY_RATING_CONFIDENT_PATIENTS) return 'thin';
  return 'full';
}
