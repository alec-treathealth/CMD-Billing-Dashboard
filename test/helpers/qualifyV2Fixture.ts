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
  | 'medianDaysToPayment'
  | 'avgAuthDays'
  | 'avgLosDays'
  | 'nextUrDate'
  | 'openBeds'
  | 'ratingV2'
  | 'iqBand'
  | 'factors'
  | 'availableWeight'
> = {
  medianDaysToPayment: null,
  avgAuthDays: null,
  avgLosDays: null,
  nextUrDate: null,
  openBeds: null,
  ratingV2: null,
  iqBand: null,
  factors: [],
  availableWeight: 0,
};
