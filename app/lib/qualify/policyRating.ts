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
import type { QualifyBedState } from './bedState';
import type { QualifyBookPlacement } from './bookPlacement';
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
 * set and same sample gate as `derivePolicyRating`.
 *
 * SCOPE CAVEAT, because the earlier claim here that "all three (bar, table, cards) move together" was
 * NOT true: the bar and the cards read the LOC-lensed by-payer ranking, whereas this table reads the
 * AI panel's snapshot, which prefers the identifier lead when one resolved. Those can be different
 * populations, so the table is captioned with the population it actually describes rather than being
 * presented as the same list as the cards.
 */
export interface QualifyRankRow {
  rank: number;
  /** Stable identity. Facility NAMES are not unique (contract.ts) — two same-named facilities keyed
   *  by name give React duplicate keys and can swap rows. Review: unaddressed from PR #94. */
  facilityKey: string;
  name: string;
  rating: number;
  band: QualifyIqBand;
  /** Non-dollar evidence caption — the sample behind the row. */
  evidence: string;
  /**
   * Bed availability for THIS row, carried so the strip cannot present a facility that cannot admit
   * anyone as a placement. It is NOT a sort input here — see `qualifyRanksHeading` for why this
   * table deliberately stays in rating order while the grid does not.
   */
  bedState: QualifyBedState;
}

/** The clause that stops the strip from silently contradicting the grid. Exported so the caption and
 *  its test read the same string, and so any future surface reusing the strip inherits the disclosure. */
export const QUALIFY_RANKS_BASIS_NOTE = 'by rating, not bed availability';

/**
 * THE STRIP'S HEADING — its population AND its ordering basis, in one line.
 *
 * WHY THIS EXISTS (S1 review, 2026-08-08). `deriveTopRanks` sorts by ratingV2 alone; since the
 * availability tier landed at the head of the grid's comparator the two orders can DISAGREE ON THE
 * SAME SCREEN. Reproduced: the grid showed an open house at rank 1 above a full house at rank 2
 * while this strip led with the full one, so one facility wore a "2" on its card and a "1" here —
 * and the strip renders precisely for the 'ranks' question, directly under prose the new prompt rule
 * makes say that facility is full and ranked below. The comment above the strip claimed it "can
 * never disagree with the cards or the bar". It could, and did.
 *
 * RESOLVED BY SAYING SO, NOT BY RE-SORTING, and the distinction is the point: this strip answers
 * "which of these PAYS best", which is a rating question. Re-ordering it on beds would delete the
 * only thing on screen that answers that — the grid already carries the availability answer, and two
 * views of one order is not worth losing the second reading. So the strip keeps its order and stops
 * being ambiguous about which question it is answering. When one of its own rows is full, that is
 * named here too, rather than left to a chip further down the row that a reader may never reach.
 *
 * @param placement WHERE the payer's book is drawn relative to this strip (S3 fix round 1).
 *
 * ⚠ THE MITIGATION S3 CLAIMED FOR THIS NEVER RENDERS. The panel's idle caption (`active === null`)
 * and this strip (`active === 'ranks'`) are MUTUALLY EXCLUSIVE — so the moment a reader asks the
 * ranks question over a book-led screen, the caption naming the model's list disappears and this
 * heading's only label is "Top N facilities · {payer} · by rating, not bed availability": a
 * member-scoped table identified by nothing, directly beneath a grid of that payer's whole book.
 *
 * The strip's POPULATION does not move — it describes what the model actually read, and re-deriving
 * it from the book would put a table on screen the payload never saw. Its LABEL says which
 * population that is.
 *
 * `'secondary'` and `'none'` are byte-identical to what shipped, and `'secondary'` is not an
 * oversight: there the member ranking IS the primary grid and the book is the clearly-labelled second
 * thing, so a bare payer label already describes the list this strip is about. Only the flip inverts
 * which list a bare label reads as. Copy unratified.
 */
export function qualifyRanksHeading(
  rows: readonly QualifyRankRow[],
  scopeLabel: string,
  placement: QualifyBookPlacement = 'none',
): string {
  const anyFull = rows.some((r) => r.bedState === 'full');
  return [
    `Top ${rows.length} facilities`,
    placement === 'leading' ? `this member's own history under ${scopeLabel}` : scopeLabel,
    // Stated UNCONDITIONALLY. "It happens to match the grid today" is not a reason to leave the
    // basis unsaid tomorrow — that is exactly how the claim this replaces became false.
    anyFull ? `${QUALIFY_RANKS_BASIS_NOTE} — one or more are full` : QUALIFY_RANKS_BASIS_NOTE,
  ].join(' · ');
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
      facilityKey: f.facilityKey,
      name: f.name,
      rating: f.ratingV2,
      // Every row here is rated, so iqBandOf cannot return null — assert it rather than widen the type.
      band: iqBandOf(f.ratingV2)!,
      // Carried, never sorted on — the heading discloses the basis instead. See qualifyRanksHeading.
      bedState: f.bedState,
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

/**
 * @param basisScope OPTIONAL name for the POPULATION these facilities are (S3, 2026-08-08) — e.g.
 * `"AETNA US HEALTHCARE's whole book"`. Omit and the basis line is byte-identical to what shipped.
 *
 * WHY IT IS PASSED IN AND NOT DERIVED. Since the book-led flip the same function is handed two
 * genuinely different populations — the searched identifier's own footprint, and the payer's whole
 * book — and "patient-weighted across 2 rated facilities" is true of both, so it identifies neither.
 * This module cannot tell them apart (a `QualifyFacility[]` is a `QualifyFacility[]`), and inventing
 * a guess from the rows would be exactly the second derivation the header's reconciled-by-
 * construction argument exists to prevent. The caller knows which list it drew; it says so.
 *
 * It reaches the NOT_RATED arm too. "No facility clears the sample floor" over an unnamed list is
 * the same unattributed claim as the rated basis — and it is the arm a thin book actually hits.
 */
export function derivePolicyRating(
  facilities: readonly QualifyFacility[],
  basisScope?: string,
): QualifyPolicyRating {
  const inScope = basisScope === undefined ? '' : ` in ${basisScope}`;
  const notRated: QualifyPolicyRating =
    basisScope === undefined
      ? NOT_RATED
      : { ...NOT_RATED, basis: `no facility in ${basisScope} clears the sample floor` };
  // Only facilities whose CARD shows a number: rated, and above the sample-gate floor.
  const rated = facilities.filter(
    (f): f is QualifyFacility & { ratingV2: number } =>
      f.ratingV2 !== null && ratingSampleTier(f.distinctPatients) !== 'insufficient',
  );
  if (rated.length === 0) return notRated;

  const patients = rated.reduce((t, f) => t + f.distinctPatients, 0);
  // Every rated facility sits above the floor (>=3 patients), so this denominator cannot be 0 —
  // but guard anyway rather than emit NaN onto the bar if that floor ever changes.
  if (patients <= 0) return notRated;

  const rating = Math.round(rated.reduce((t, f) => t + f.ratingV2 * f.distinctPatients, 0) / patients);
  const band = iqBandOf(rating);
  return {
    rating,
    band,
    verdict: band ? `${IQ_BAND_VERDICTS[band]} · ${IQ_BAND_LABELS[band]}` : 'Not rated',
    ratedCount: rated.length,
    patients,
    basis: `patient-weighted across ${rated.length} rated ${rated.length === 1 ? 'facility' : 'facilities'}${inScope}`,
  };
}
