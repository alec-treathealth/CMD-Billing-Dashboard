/**
 * client_history — given a patient last name (and optionally a member id), find
 * that client's claims by pg_trgm similarity on patient_last (threshold 0.4) and
 * return a per-year, non-PHI roll-up. This is the first function whose INPUT is
 * PHI: the search terms are passed ONLY as bound query parameters and are NEVER
 * stored in query_log or logged. Instead an irreversible identity_hash binds the
 * query_id to the identity (see identity.ts + migrations/0004), which the Phase 3
 * results route verifies before serving the PHI rows.
 *
 * summary_stats is non-PHI by construction: only source_year, counts, money
 * aggregates, distinct facility/payer counts, and date spans — no patient_name,
 * member id, or other identity field.
 */
import { randomUUID } from 'node:crypto';
import { buildClaimFilter, validateClaimFilter } from './filters.js';
import { computeIdentityHash, normalizeMemberId } from './identity.js';
import { finalize } from './runtime.js';
import type {
  ClientHistoryArgs,
  ClientHistorySummary,
  ClientHistoryYearBucket,
  NoPhi,
  QueryContext,
  QueryResult,
} from './types.js';

/** Fixed pg_trgm similarity threshold for a last-name match (not caller-controllable). */
const MATCH_THRESHOLD = 0.4;
const MAX_TEXT = 200;

/**
 * Results-route column allowlist for `client_history`. This is the full claim
 * history of ONE identified patient, so it carries the fullest projection,
 * including all identity fields plus group_number / employer_name. `id` is the
 * stable row key. Registered in columns.ts.
 *
 * NOTE: serving these rows is gated on identity re-verification — the patient
 * search terms are deliberately NOT stored in query_log.arguments, so the results
 * route cannot reconstruct this query from stored args alone; the caller must
 * re-supply the identity terms and the route must verify the stored identity_hash
 * (identity.ts) before executing. See results.ts.
 */
export const COLUMNS: readonly string[] = [
  'id',
  'patient_name',
  'patient_last',
  'patient_first',
  'member_id_raw',
  'member_id_norm',
  'group_number',
  'employer_name',
  'source_year',
  'facility_name',
  'payer_name',
  'date_of_service',
  'hcpcs_code',
  'revenue_code',
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
  'collection_rate',
];

interface ClientHistoryDbRow {
  source_year: number | string;
  claim_count: string;
  distinct_facilities: string;
  distinct_payers: string;
  total_charge: string;
  total_paid: string;
  avg_collection_rate: string | null;
  date_from: string | null;
  date_to: string | null;
}

/**
 * Build the parameterized data query. The similarity term ($1) and threshold
 * ($2) are always the first two params; the member narrowing ($3) is present
 * only when supplied; `filterClause` placeholders are numbered by the caller to
 * follow. Column names are fixed; only values are bound. Exposed for the fixture.
 */
export function clientHistorySql(hasMember: boolean, filterClause: string): string {
  const conds = ['claims.similarity(patient_last, $1) >= $2'];
  if (hasMember) conds.push('member_id_norm = $3');
  if (filterClause) conds.push(filterClause);
  return (
    `select ` +
    `source_year, ` +
    `count(*) as claim_count, ` +
    `count(distinct facility_name) as distinct_facilities, ` +
    `count(distinct payer_name) as distinct_payers, ` +
    `coalesce(sum(charge_amount), 0) as total_charge, ` +
    `coalesce(sum(paid_amount), 0) as total_paid, ` +
    `avg(collection_rate) as avg_collection_rate, ` +
    `min(date_of_service)::text as date_from, ` +
    `max(date_of_service)::text as date_to ` +
    `from claims.claims ` +
    `where ${conds.join(' and ')} ` +
    `group by source_year ` +
    `order by source_year`
  );
}

export async function clientHistory(
  args: ClientHistoryArgs,
  ctx: QueryContext,
): Promise<QueryResult<NoPhi<ClientHistorySummary>>> {
  // Validate the PHI search terms at the boundary (never stored/logged).
  if (typeof args.patient_last !== 'string') {
    throw new Error('client_history: patient_last must be a string');
  }
  const patientLast = args.patient_last.trim();
  if (patientLast.length === 0) {
    throw new Error('client_history: patient_last must be non-empty');
  }
  if (patientLast.length > MAX_TEXT) {
    throw new Error(`client_history: patient_last exceeds ${MAX_TEXT} chars`);
  }
  if (args.member_id_norm !== undefined && typeof args.member_id_norm !== 'string') {
    throw new Error('client_history: member_id_norm must be a string');
  }
  const memberNorm = normalizeMemberId(args.member_id_norm);
  const hasMember = memberNorm.length > 0;

  const filter = validateClaimFilter(args.filter);

  // Param order: $1 last, $2 threshold, ($3 member if present), then filter.
  const params: unknown[] = [patientLast, MATCH_THRESHOLD];
  let nextIndex = 3;
  if (hasMember) {
    params.push(memberNorm);
    nextIndex = 4;
  }
  const { clause, params: filterParams } = buildClaimFilter(filter, nextIndex);
  params.push(...filterParams);

  const sql = clientHistorySql(hasMember, clause);
  const { rows } = await ctx.executor.query<ClientHistoryDbRow>(sql, params);

  const by_source_year: ClientHistoryYearBucket[] = rows.map((r) => ({
    source_year: Number(r.source_year),
    claim_count: Number(r.claim_count),
    distinct_facilities: Number(r.distinct_facilities),
    distinct_payers: Number(r.distinct_payers),
    total_charge: Number(r.total_charge),
    total_paid: Number(r.total_paid),
    avg_collection_rate: r.avg_collection_rate === null ? null : Number(r.avg_collection_rate),
    date_from: r.date_from,
    date_to: r.date_to,
  }));
  const rows_matched = by_source_year.reduce((acc, b) => acc + b.claim_count, 0);

  const summary_stats: ClientHistorySummary = {
    rows_matched,
    match_threshold: MATCH_THRESHOLD,
    by_source_year,
  };

  // query_id is generated BEFORE the hash because the hash folds it in.
  const queryId = ctx.uuid?.() ?? randomUUID();
  const identityHash = computeIdentityHash(patientLast, memberNorm, queryId);

  return finalize<ClientHistorySummary>(ctx, {
    functionName: 'client_history',
    queryId,
    // NON-PHI ONLY: the search terms are deliberately absent. Re-execution
    // re-supplies them and is gated by identity_hash verification (Phase 3).
    args: { match_threshold: MATCH_THRESHOLD, filter },
    // Identity fields appear as a presence flag only — never their values.
    auditShape: { has_member_id: hasMember, filter_keys: Object.keys(filter) },
    summaryStats: summary_stats,
    identityHash,
    resultRowCount: rows_matched,
  });
}
