/**
 * Shared v2-null block for QualifyFacility TEST fixtures (app-suite twin of
 * test/helpers/qualifyV2Fixture.ts — the app tsconfig does not reach the root test tree). Spread
 * FIRST so a fixture's own fields win. Production values are computed only by core.ts.
 */
import type { QualifyFacility } from '../../lib/qualify/contract';

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
