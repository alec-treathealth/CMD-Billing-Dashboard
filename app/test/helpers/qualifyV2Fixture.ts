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
  | 'authHeadroomDays'
  | 'nextUrDate'
  | 'openBeds'
  | 'bedCapacity'
  // Bed availability (S1, 2026-08-08). 'unknown' = no census row, which is what a fixture that says
  // nothing about census means — and it is the NEUTRAL sort tier, so a fixture cannot accidentally
  // sink or float a facility by omission.
  | 'bedState'
  // The blend disclosure (2026-08-07). 1 = a payer-scoped card, which is what a fixture that says
  // nothing about payer scope means. Only an identifier-wide ranking produces >1.
  | 'payerCount'
  | 'solePayer'
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
  authHeadroomDays: null,
  nextUrDate: null,
  openBeds: null,
  bedCapacity: null,
  bedState: 'unknown',
  payerCount: 1,
  solePayer: null,
  ratingV2: null,
  iqBand: null,
  factors: [],
  availableWeight: 0,
};
