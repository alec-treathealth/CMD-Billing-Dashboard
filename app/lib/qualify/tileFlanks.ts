/**
 * KPI-TILE FLANKS — the worst/best FACILITY on each of the three headline metrics (the prototype's
 * `spreadFor`). A single averaged percentage tells a rep nothing about whether the book is uniform or
 * bimodal; the flanks name the facilities at each end, which is the fact that actually changes a
 * placement decision.
 *
 * ONE MEASUREMENT PER TILE (2026-08-04). Each flank is computed from that facility's OWN value for
 * that tile's metric — `pctAllowedOfBilled`, `pctPaidOfAllowed`, `pctPaidOfBilled` — and the server
 * derives all three with the same SQL expressions `buildBookKpisQuery` uses for the headline. Earlier
 * this module carried one spread (allowed) and the paid tiles had no flanks at all; reusing the allowed
 * spread on a paid tile would have printed a number that is not that tile's metric, which is worse than
 * showing none.
 *
 * SAMPLE GATE. A facility whose card renders '—' (below the distinct-patient floor) cannot set a flank:
 * the tile would name a facility carrying a percentage that appears nowhere beneath it. 61% of
 * facility×payer rows sit under 3 patients and extremes are exactly where that noise lives, so the
 * Worst flank was the expected victim rather than an edge case.
 *
 * SOURCE IS ALWAYS STATED, never assumed. The tiles are fetched by the KPI query (payer + facility
 * scope) and the flanks come from the facility ranking, which can be a different population — a payer
 * derived from an identifier, a peer cohort, an LOC-lensed subset. Rather than suppress the flanks
 * whenever the two provably differ (which hid them on the flagship identifier-search path, the one
 * place a rep most wants them), the tile CAPTIONS what the flanks are drawn from. A labelled range from
 * a named set is honest; an unlabelled one is the parts-vs-whole defect.
 *
 * PURE + NON-DOLLAR by construction: percentages, counts and names only, so an admissions_seat session
 * derives byte-identical flanks to a super_admin.
 */
import type { QualifyFacility } from './contract';
import { ratingSampleTier } from './sampleGate';

/** The three tiles, in render order. Keys match `BookKpiTiles`' own tile keys. */
export type QualifyTileMetric = 'allowed' | 'paidOfAllowed' | 'paidOfBilled';

export interface QualifySpreadEnd {
  label: string;
  /** Whole percent, already rounded for display. */
  value: number;
  who: string;
}

export interface QualifyFacilitySpread {
  worst: QualifySpreadEnd;
  best: QualifySpreadEnd;
}

/** One spread per tile; a metric with fewer than two usable facilities (or a flat set) is null. */
export type QualifyTileFlanks = Record<QualifyTileMetric, QualifyFacilitySpread | null>;

const METRIC_OF: Record<QualifyTileMetric, (f: QualifyFacility) => number | null> = {
  allowed: (f) => f.pctAllowedOfBilled,
  paidOfAllowed: (f) => f.pctPaidOfAllowed,
  paidOfBilled: (f) => f.pctPaidOfBilled,
};

export const NO_TILE_FLANKS: QualifyTileFlanks = { allowed: null, paidOfAllowed: null, paidOfBilled: null };

/**
 * The worst/best ends of ONE metric over the ranked set. Null when fewer than two facilities carry a
 * value for it (a "range" over one facility is not a range) or when every value is identical (a flat
 * set is not a spread worth two columns).
 */
export function deriveFacilitySpread(
  facilities: readonly QualifyFacility[],
  metric: QualifyTileMetric = 'allowed',
): QualifyFacilitySpread | null {
  const read = METRIC_OF[metric];
  const scored: { value: number; name: string }[] = [];
  for (const f of facilities) {
    const value = read(f);
    // Null is NOT a zero — a collapsed denominator means "we cannot say", and averaging or bracketing
    // it as 0% would invent a claim. Sub-floor facilities are excluded for the reason in the header.
    if (value === null || ratingSampleTier(f.distinctPatients) === 'insufficient') continue;
    scored.push({ value, name: f.name });
  }
  if (scored.length < 2) return null;
  let lo = scored[0]!;
  let hi = scored[0]!;
  for (const s of scored) {
    if (s.value < lo.value) lo = s;
    if (s.value > hi.value) hi = s;
  }
  if (lo.value === hi.value) return null;
  return {
    worst: { label: 'Worst', value: Math.round(lo.value), who: lo.name },
    best: { label: 'Best', value: Math.round(hi.value), who: hi.name },
  };
}

/** All three tiles at once — each independently gated, so a metric with thin coverage simply has no
 *  flanks while the others still show theirs. */
export function deriveTileFlanks(facilities: readonly QualifyFacility[]): QualifyTileFlanks {
  return {
    allowed: deriveFacilitySpread(facilities, 'allowed'),
    paidOfAllowed: deriveFacilitySpread(facilities, 'paidOfAllowed'),
    paidOfBilled: deriveFacilitySpread(facilities, 'paidOfBilled'),
  };
}
