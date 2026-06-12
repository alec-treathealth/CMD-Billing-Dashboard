/**
 * The PHI-results column registry.
 *
 * Each vetted query function declares, in its own module, the exact set of
 * `claims.claims` columns the Phase 3 results route is permitted to SELECT when
 * it re-runs that function to surface the underlying rows. This module collects
 * those allowlists into one lookup and is the ONLY thing the results route asks
 * "which columns may I project for this function_name?".
 *
 * Why an allowlist at all: the PHI path must NEVER `SELECT *`. The summary path
 * (query layer) is kept PHI-free by the `NoPhi<S>` type chokepoint; the results
 * path is kept honest by construction here — a column that isn't on the list
 * cannot be projected, and a function_name with no registered list is rejected
 * before any SQL runs.
 *
 * readmission_candidates is special: its allowlist columns are projected for BOTH
 * sides of a candidate pair (prefixed `a_` / `b_`), and the route additionally
 * attaches COMPUTED fields that are NOT in any allowlist — `confidence` (the
 * graded tier), `gap_days` (the bound interval), and `a_id` / `b_id` (the `id`
 * column surfaced once per pair side). Do not expect those four as bare columns.
 */
import { COLUMNS as distributionColumns } from './distribution.js';
import { COLUMNS as payerGapColumns } from './payer_gap_analysis.js';
import { COLUMNS as searchClaimsColumns } from './search_claims.js';
import { COLUMNS as clientHistoryColumns } from './client_history.js';
import { COLUMNS as readmissionColumns } from './readmission_candidates.js';
import type { FunctionName } from './types.js';

/** function_name -> the exact claims.claims columns the results route may SELECT. */
export const COLUMNS: Record<FunctionName, readonly string[]> = {
  distribution: distributionColumns,
  payer_gap_analysis: payerGapColumns,
  search_claims: searchClaimsColumns,
  client_history: clientHistoryColumns,
  readmission_candidates: readmissionColumns,
};

/**
 * Look up the results-route column allowlist for a function name. Throws on any
 * name with no registered allowlist — the route rejects such a query_id BEFORE
 * building or running any SQL (defense in depth; query_log's CHECK already
 * constrains function_name to the five known functions).
 */
export function getColumns(functionName: string): readonly string[] {
  const cols = (COLUMNS as Record<string, readonly string[]>)[functionName];
  if (cols === undefined) {
    throw new Error(`results: no column allowlist registered for function_name ${JSON.stringify(functionName)}`);
  }
  return cols;
}
