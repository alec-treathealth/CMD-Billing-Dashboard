/** Public surface of the Phase 2 query-function library. */
export * from './types.js';
export { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from './executor.js';
export { distribution, distributionSql } from './distribution.js';
export { payerGapAnalysis, payerGapSql } from './payer_gap_analysis.js';
export { searchClaims, searchClaimsSql } from './search_claims.js';
export { clientHistory, clientHistorySql } from './client_history.js';
export { computeIdentityHash, normalizeMemberId } from './identity.js';
export {
  readmissionCandidates,
  readmissionCandidatesSql,
  READMISSION_CONFIDENCE_CASE,
  READMISSION_PAIR_JOIN,
  validateGapDays,
} from './readmission_candidates.js';
export { COLUMNS as RESULTS_COLUMNS, getColumns } from './columns.js';
