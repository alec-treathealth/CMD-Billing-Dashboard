/**
 * Shared v2-null block for QualifyFacility TEST fixtures — the rating-v2 contract additions with
 * every field at its honest "no data" value. Spread FIRST so a fixture's own fields win:
 *   const fac: QualifyFacility = { ...QUALIFY_FACILITY_V2_NULLS, rank: 1, ... };
 * Lives under test/ (never shipped); production QualifyFacility objects are built ONLY by
 * core.ts assembleFacilities, which computes the real values.
 */
import type { QualifyFacility } from '../../app/lib/qualify/contract';

export const QUALIFY_FACILITY_V2_NULLS: Pick<
  QualifyFacility,
  // The two non-allowed KPI-tile metrics (2026-08-04) — null here so a fixture that cares about the
  // tile flanks must state its own values, and one that doesn't gets the honest "we cannot say".
  | 'pctPaidOfAllowed'
  | 'pctPaidOfBilled'
  | 'medianDaysToPayment'
  | 'avgAuthDays'
  | 'avgLosDays'
  | 'nextUrDate'
  | 'openBeds'
  | 'bedCapacity'
  | 'ratingV2'
  | 'iqBand'
  | 'factors'
  | 'availableWeight'
> = {
  pctPaidOfAllowed: null,
  pctPaidOfBilled: null,
  medianDaysToPayment: null,
  avgAuthDays: null,
  avgLosDays: null,
  nextUrDate: null,
  openBeds: null,
  bedCapacity: null,
  ratingV2: null,
  iqBand: null,
  factors: [],
  availableWeight: 0,
};
