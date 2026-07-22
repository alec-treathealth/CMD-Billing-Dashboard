/**
 * Qualify Phase 2 — PURE client-side patient grouping + LOC filtering helpers. No React, no server
 * imports; root-suite-tested directly (the qualifyGuards.ts pattern). The desktop claims panel
 * renders ONE row per patient with an expand chevron; the SERVER still returns claim grain — this is
 * presentation only, over whatever page of claims the server sent (grouping is per-page by design;
 * patientKey is a per-response ordinal, deliberately unstable across responses — see contract.ts).
 */
import type { QualifyClaim, QualifyFacility } from './contract';
import type { QualifyConfidence } from './confidence';

export interface QualifyClaimGroup {
  /** The per-response patient ordinal shared by every claim in this group (display: "Patient {n}"). */
  patientKey: number;
  /** The group's claims in the order the server returned them (dos desc, id desc). */
  claims: QualifyClaim[];
  claimCount: number;
  /**
   * Roll-up %-allowed: the PLAIN MEAN of the group's non-null per-claim pcts (confirmed + estimate;
   * unknown contributes nothing), rounded to whole %. Deliberately NOT dollar-weighted: an
   * admissions_seat's claims are server-stripped of dollars, and the roll-up must read identically
   * for every role — a mean of the visible per-claim numbers is the only honest cross-role choice.
   * null when no claim in the group has a pct.
   */
  avgPct: number | null;
  /**
   * Group confidence (approved rule): ANY estimate claim marks the whole group 'estimate' (one
   * unverifiable reversal taints the roll-up — never let it read green); else all-unknown →
   * 'unknown'; else 'confirmed'.
   */
  confidence: QualifyConfidence;
}

/** Group a server page of claims by patientKey, first-seen order (the page is dos-desc, so groups
 *  order by each patient's most-recent claim — daily IP charge runs fold under one patient row). */
export function groupClaimsByPatient(claims: readonly QualifyClaim[]): QualifyClaimGroup[] {
  const byKey = new Map<number, QualifyClaim[]>();
  for (const c of claims) {
    const bucket = byKey.get(c.patientKey);
    if (bucket === undefined) byKey.set(c.patientKey, [c]);
    else bucket.push(c);
  }
  const groups: QualifyClaimGroup[] = [];
  for (const [patientKey, groupClaims] of byKey) {
    const pcts = groupClaims.map((c) => c.pctAllowedOfBilled).filter((p): p is number => p !== null);
    const anyEstimate = groupClaims.some((c) => c.confidence === 'estimate');
    const allUnknown = groupClaims.every((c) => c.confidence === 'unknown');
    groups.push({
      patientKey,
      claims: groupClaims,
      claimCount: groupClaims.length,
      avgPct: pcts.length === 0 ? null : Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length),
      confidence: anyEstimate ? 'estimate' : allUnknown ? 'unknown' : 'confirmed',
    });
  }
  return groups;
}

export type QualifyLocFilter = 'IP' | 'OP' | 'BOTH' | null;

/**
 * LOC chip filtering (INCLUSIVE semantics): the IP chip shows facilities that serve IP — careSetting
 * 'IP' or 'BOTH'; likewise OP; the Both chip shows only 'BOTH'. A facility with an unresolved
 * careSetting (null) appears ONLY when no chip is active — a chip is a positive assertion and an
 * unknown LOC can't satisfy it.
 */
export function filterFacilitiesByLoc(
  facilities: readonly QualifyFacility[],
  loc: QualifyLocFilter,
): QualifyFacility[] {
  if (loc === null) return [...facilities];
  if (loc === 'BOTH') return facilities.filter((f) => f.careSetting === 'BOTH');
  return facilities.filter((f) => f.careSetting === loc || f.careSetting === 'BOTH');
}
