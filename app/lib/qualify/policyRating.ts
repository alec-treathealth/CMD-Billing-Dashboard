/**
 * THE POLICY RATING — one number for "does this payer pay us", on the readout bar.
 *
 * RECONCILED BY CONSTRUCTION, which is the whole point. A policy-level rating cannot be an
 * independently-sourced figure: if the bar says 22 while the cards below read 68 down to 33, one of
 * them is lying and the rep has no way to tell which. So this is the patient-weighted mean of
 * EXACTLY the ratings the cards display — same set, same numbers, same sample gate — and it moves
 * only when they move. The prototype makes the same argument in reverse (it shifts a base facility
 * table by a policy factor and then averages it); the invariant either way is that the whole is
 * derived from the parts on screen.
 *
 * WEIGHTED BY DISTINCT PATIENTS, not by lines: claims within a patient share one plan, contract and
 * CPT pattern, so they are not independent draws and line counts overstate a facility's contribution
 * roughly 23× (the same reasoning sampleGate.ts is built on).
 *
 * A facility the cards refuse to rate is excluded here too — including the sample-gate 'insufficient'
 * tier, which renders '—' on the card. Averaging a number the card declines to show would put a
 * figure on the bar that has no visible support anywhere beneath it. When nothing clears the floor
 * the rating is NULL, never 0: "we cannot say" and "they pay nothing" are opposite claims.
 *
 * PURE + CLIENT-SAFE and non-dollar (ratingV2 and distinctPatients carry no dollars), so an
 * admissions_seat session derives the identical number and band.
 */
import type { QualifyFacility } from './contract';
import { iqBandOf, IQ_BAND_LABELS, IQ_BAND_VERDICTS, type QualifyIqBand } from './ratingV2';
import { ratingSampleTier } from './sampleGate';

export interface QualifyPolicyRating {
  /** 0-100, patient-weighted over the rated set. Null ⇒ nothing on screen is rateable. */
  rating: number | null;
  band: QualifyIqBand | null;
  /** The billing team's own label for the band ("Strong · 65%+"), or "Not rated". */
  verdict: string;
  /** Facilities that contributed (i.e. the ones showing a number on their card). */
  ratedCount: number;
  /** Distinct patients behind that set — the weight denominator, and the honesty check. */
  patients: number;
  /** One line naming what the number is an average OF, so it can be checked against the cards. */
  basis: string;
}

/**
 * The RANKS TABLE the explainer shows for the "which facility pays best" question.
 *
 * Derived from the snapshot, NOT parsed out of the model's prose — the same reason the policy rating
 * is: a table the model authored could disagree with the cards, and then the rep is adjudicating
 * between two AI-shaped numbers. The model writes the reasoning; the numbers stay ours. Same rated
 * set and same sample gate as `derivePolicyRating`, so all three (bar, table, cards) move together.
 */
export interface QualifyRankRow {
  rank: number;
  name: string;
  rating: number;
  band: QualifyIqBand;
  /** Non-dollar evidence caption — the sample behind the row. */
  evidence: string;
}

export function deriveTopRanks(facilities: readonly QualifyFacility[], limit = 5): QualifyRankRow[] {
  return facilities
    .filter(
      (f): f is QualifyFacility & { ratingV2: number } =>
        f.ratingV2 !== null && ratingSampleTier(f.distinctPatients) !== 'insufficient',
    )
    .slice()
    .sort((a, b) => b.ratingV2 - a.ratingV2)
    .slice(0, Math.max(0, limit))
    .map((f, i) => ({
      rank: i + 1,
      name: f.name,
      rating: f.ratingV2,
      // Every row here is rated, so iqBandOf cannot return null — assert it rather than widen the type.
      band: iqBandOf(f.ratingV2)!,
      evidence: `${f.distinctPatients} patient${f.distinctPatients === 1 ? '' : 's'} · ${f.lineCount.toLocaleString('en-US')} lines`,
    }));
}

const NOT_RATED: QualifyPolicyRating = {
  rating: null,
  band: null,
  verdict: 'Not rated',
  ratedCount: 0,
  patients: 0,
  basis: 'no facility clears the sample floor',
};

export function derivePolicyRating(facilities: readonly QualifyFacility[]): QualifyPolicyRating {
  // Only facilities whose CARD shows a number: rated, and above the sample-gate floor.
  const rated = facilities.filter(
    (f): f is QualifyFacility & { ratingV2: number } =>
      f.ratingV2 !== null && ratingSampleTier(f.distinctPatients) !== 'insufficient',
  );
  if (rated.length === 0) return NOT_RATED;

  const patients = rated.reduce((t, f) => t + f.distinctPatients, 0);
  // Every rated facility sits above the floor (>=3 patients), so this denominator cannot be 0 —
  // but guard anyway rather than emit NaN onto the bar if that floor ever changes.
  if (patients <= 0) return NOT_RATED;

  const rating = Math.round(rated.reduce((t, f) => t + f.ratingV2 * f.distinctPatients, 0) / patients);
  const band = iqBandOf(rating);
  return {
    rating,
    band,
    verdict: band ? `${IQ_BAND_VERDICTS[band]} · ${IQ_BAND_LABELS[band]}` : 'Not rated',
    ratedCount: rated.length,
    patients,
    basis: `patient-weighted across ${rated.length} rated ${rated.length === 1 ? 'facility' : 'facilities'}`,
  };
}
