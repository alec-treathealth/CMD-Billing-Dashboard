/**
 * payer_gap_analysis — group claims by payer and report, per payer, the billed
 * vs allowed vs paid totals plus two gap lenses:
 *   - total_write_down     = sum(charge_amount - allowed_amount) — contractual write-down
 *   - total_collection_gap = sum(charge_amount - paid_amount)    — real collection shortfall
 * Pure aggregation: no identity, no PHI. payer_name is allowlisted, so the
 * summary_stats is non-PHI by construction. Filter VALUES are $n parameters;
 * all column names are fixed literals.
 */
import { randomUUID } from 'node:crypto';
import { buildClaimFilter, validateClaimFilter } from './filters.js';
import { finalize } from './runtime.js';
import type {
  NoPhi,
  PayerGapArgs,
  PayerGapRow,
  PayerGapSummary,
  QueryContext,
  QueryResult,
} from './types.js';

/**
 * Results-route column allowlist for `payer_gap_analysis`. Re-running this
 * function's filter surfaces the claims behind a payer's gap; the analysis is by
 * payer, so no patient identifiers are projected. `id` is the stable row key.
 * Registered in columns.ts.
 */
export const COLUMNS: readonly string[] = [
  'id',
  'facility_name',
  'payer_name',
  'source_year',
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

interface PayerGapDbRow {
  payer_name: string | null;
  claim_count: string;
  total_charge: string;
  total_allowed: string;
  total_paid: string;
  avg_collection_rate: string | null;
  total_write_down: string;
  total_collection_gap: string;
}

/** Build the parameterized data query. Exposed for the fixture to assert the exact SQL. */
export function payerGapSql(filterClause: string): string {
  return (
    `select ` +
    `payer_name, ` +
    `count(*) as claim_count, ` +
    `coalesce(sum(charge_amount), 0) as total_charge, ` +
    `coalesce(sum(allowed_amount), 0) as total_allowed, ` +
    `coalesce(sum(paid_amount), 0) as total_paid, ` +
    `avg(collection_rate) as avg_collection_rate, ` +
    `coalesce(sum(charge_amount - coalesce(allowed_amount, 0)), 0) as total_write_down, ` +
    `coalesce(sum(charge_amount - coalesce(paid_amount, 0)), 0) as total_collection_gap ` +
    `from claims.claims` +
    (filterClause ? ` where ${filterClause}` : '') +
    ` group by payer_name ` +
    `order by total_collection_gap desc nulls last`
  );
}

export async function payerGapAnalysis(
  args: PayerGapArgs,
  ctx: QueryContext,
): Promise<QueryResult<NoPhi<PayerGapSummary>>> {
  const filter = validateClaimFilter(args.filter);

  const { clause, params } = buildClaimFilter(filter, 1);
  const sql = payerGapSql(clause);
  const { rows } = await ctx.executor.query<PayerGapDbRow>(sql, params);

  const by_payer: PayerGapRow[] = rows.map((r) => ({
    payer_name: r.payer_name,
    claim_count: Number(r.claim_count),
    total_charge: Number(r.total_charge),
    total_allowed: Number(r.total_allowed),
    total_paid: Number(r.total_paid),
    avg_collection_rate: r.avg_collection_rate === null ? null : Number(r.avg_collection_rate),
    total_write_down: Number(r.total_write_down),
    total_collection_gap: Number(r.total_collection_gap),
  }));

  const rows_analyzed = by_payer.reduce((acc, r) => acc + r.claim_count, 0);

  const summary_stats: PayerGapSummary = { rows_analyzed, by_payer };

  const queryId = ctx.uuid?.() ?? randomUUID();
  return finalize<PayerGapSummary>(ctx, {
    functionName: 'payer_gap_analysis',
    queryId,
    // All non-PHI: safe to persist verbatim for the results route to re-run.
    args: { filter },
    auditShape: { filter_keys: Object.keys(filter) },
    summaryStats: summary_stats,
    identityHash: null,
    resultRowCount: by_payer.length,
  });
}
