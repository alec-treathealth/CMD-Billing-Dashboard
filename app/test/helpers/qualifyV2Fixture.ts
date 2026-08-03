/**
 * Shared v2-null block for QualifyFacility TEST fixtures (app-suite twin of
 * test/helpers/qualifyV2Fixture.ts — the app tsconfig does not reach the root test tree). Spread
 * FIRST so a fixture's own fields win. Production values are computed only by core.ts.
 */
import type { QualifyFacility } from '../../lib/qualify/contract';

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
