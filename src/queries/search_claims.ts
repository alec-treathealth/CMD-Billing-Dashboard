/**
 * search_claims — the non-grouped function. Given a multi-field ClaimFilter, it
 * returns one flat aggregate summary of the matched slice (counts, money totals,
 * collection-rate stats, the rate-anomaly count, date span, distinct
 * facilities/payers). It is the primary path whose query_id the results route
 * later uses to fetch the actual PHI rows; summary_stats here is non-PHI by
 * construction. Filter VALUES are $n parameters; all column names are fixed.
 */
import { randomUUID } from 'node:crypto';
import { buildClaimFilter, validateClaimFilter } from './filters.js';
import { finalize } from './runtime.js';
import type {
  NoPhi,
  QueryContext,
  QueryResult,
  SearchClaimsArgs,
  SearchClaimsSummary,
} from './types.js';

interface SearchClaimsDbRow {
  rows_matched: string;
  total_charge: string;
  total_allowed: string;
  total_paid: string;
  avg_collection_rate: string | null;
  rate_anomaly_count: string;
  date_from: string | null;
  date_to: string | null;
  distinct_facilities: string;
  distinct_payers: string;
}

/** Build the parameterized data query. Exposed for the fixture to assert the exact SQL. */
export function searchClaimsSql(filterClause: string): string {
  return (
    `select ` +
    `count(*) as rows_matched, ` +
    `coalesce(sum(charge_amount), 0) as total_charge, ` +
    `coalesce(sum(allowed_amount), 0) as total_allowed, ` +
    `coalesce(sum(paid_amount), 0) as total_paid, ` +
    `avg(collection_rate) as avg_collection_rate, ` +
    `count(*) filter (where paid_amount is not null and allowed_amount is not null ` +
    `and collection_rate is null) as rate_anomaly_count, ` +
    `min(date_of_service)::text as date_from, ` +
    `max(date_of_service)::text as date_to, ` +
    `count(distinct facility_name) as distinct_facilities, ` +
    `count(distinct payer_name) as distinct_payers ` +
    `from claims.claims` +
    (filterClause ? ` where ${filterClause}` : '')
  );
}

export async function searchClaims(
  args: SearchClaimsArgs,
  ctx: QueryContext,
): Promise<QueryResult<NoPhi<SearchClaimsSummary>>> {
  const filter = validateClaimFilter(args.filter);

  const { clause, params } = buildClaimFilter(filter, 1);
  const sql = searchClaimsSql(clause);
  const { rows } = await ctx.executor.query<SearchClaimsDbRow>(sql, params);

  // The aggregate (no GROUP BY) always returns exactly one row, even when empty.
  const r = rows[0]!;
  const summary_stats: SearchClaimsSummary = {
    rows_matched: Number(r.rows_matched),
    total_charge: Number(r.total_charge),
    total_allowed: Number(r.total_allowed),
    total_paid: Number(r.total_paid),
    avg_collection_rate: r.avg_collection_rate === null ? null : Number(r.avg_collection_rate),
    rate_anomaly_count: Number(r.rate_anomaly_count),
    date_from: r.date_from,
    date_to: r.date_to,
    distinct_facilities: Number(r.distinct_facilities),
    distinct_payers: Number(r.distinct_payers),
  };

  const queryId = ctx.uuid?.() ?? randomUUID();
  return finalize<SearchClaimsSummary>(ctx, {
    functionName: 'search_claims',
    queryId,
    // All non-PHI: safe to persist verbatim for the results route to re-run.
    args: { filter },
    auditShape: { filter_keys: Object.keys(filter) },
    summaryStats: summary_stats,
    identityHash: null,
    // The count of underlying PHI rows the results route would return for this query_id.
    resultRowCount: summary_stats.rows_matched,
  });
}
