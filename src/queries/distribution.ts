/**
 * distribution — group claims by one allowlisted field and report a metric per
 * bucket, with each bucket's share of the summed metric. Pure aggregation: no
 * identity, no PHI. summary_stats is non-PHI by construction (the grouped field
 * is drawn from the allowlist).
 *
 * `field` and `metric` cannot be SQL parameters (you can't bind a column name or
 * an aggregate). They are mapped to FIXED, hardcoded SQL fragments selected by a
 * validated enum key — never interpolated from caller text. Filter VALUES are
 * $n parameters.
 */
import { randomUUID } from 'node:crypto';
import { buildClaimFilter, validateClaimFilter } from './filters.js';
import { finalize } from './runtime.js';
import type {
  DistributionArgs,
  DistributionBucket,
  DistributionField,
  DistributionMetric,
  DistributionSummary,
  NoPhi,
  QueryContext,
  QueryResult,
} from './types.js';

/** Allowlisted group-by columns (fixed identifiers, chosen by validated enum). */
const FIELD_SQL: Record<DistributionField, string> = {
  facility_name: 'facility_name',
  payer_name: 'payer_name',
  hcpcs_code: 'hcpcs_code',
  revenue_code: 'revenue_code',
  source_year: 'source_year',
};

/** Allowlisted aggregate expressions (fixed, chosen by validated enum). */
const METRIC_SQL: Record<DistributionMetric, string> = {
  count: 'count(*)',
  total_charge: 'coalesce(sum(charge_amount), 0)',
  total_paid: 'coalesce(sum(paid_amount), 0)',
  avg_collection_rate: 'avg(collection_rate)',
};

interface DistRow {
  value: string | null;
  metric_value: string | null;
}

/** Build the parameterized data query. Exposed for the fixture to assert the exact SQL. */
export function distributionSql(
  field: DistributionField,
  metric: DistributionMetric,
  filterClause: string,
): string {
  const col = FIELD_SQL[field];
  const agg = METRIC_SQL[metric];
  return (
    `select ${col}::text as value, ${agg} as metric_value ` +
    `from claims.claims` +
    (filterClause ? ` where ${filterClause}` : '') +
    ` group by ${col} ` +
    `order by metric_value desc nulls last`
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function distribution(
  args: DistributionArgs,
  ctx: QueryContext,
): Promise<QueryResult<NoPhi<DistributionSummary>>> {
  // Validate the enums against the closed allowlists (defense against an
  // untyped/agent caller passing an arbitrary string).
  if (!Object.prototype.hasOwnProperty.call(FIELD_SQL, args.field)) {
    throw new Error(`distribution: invalid field ${JSON.stringify(args.field)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(METRIC_SQL, args.metric)) {
    throw new Error(`distribution: invalid metric ${JSON.stringify(args.metric)}`);
  }
  const filter = validateClaimFilter(args.filter);

  const { clause, params } = buildClaimFilter(filter, 1);
  const sql = distributionSql(args.field, args.metric, clause);
  const { rows } = await ctx.executor.query<DistRow>(sql, params);

  const parsed = rows.map((r) => ({
    value: r.value,
    metric_value: r.metric_value === null ? null : Number(r.metric_value),
  }));
  const total = parsed.reduce((acc, b) => acc + (b.metric_value ?? 0), 0);

  const buckets: DistributionBucket[] = parsed.map((b) => ({
    value: b.value,
    metric_value: b.metric_value,
    pct_of_total:
      b.metric_value === null || total === 0 ? null : round2((b.metric_value / total) * 100),
  }));

  const summary_stats: DistributionSummary = {
    field: args.field,
    metric: args.metric,
    buckets,
  };

  const queryId = ctx.uuid?.() ?? randomUUID();
  return finalize<DistributionSummary>(ctx, {
    functionName: 'distribution',
    queryId,
    // All non-PHI: safe to persist verbatim for the results route to re-run.
    args: { field: args.field, metric: args.metric, filter },
    auditShape: { field: args.field, metric: args.metric, filter_keys: Object.keys(filter) },
    summaryStats: summary_stats,
    identityHash: null,
    resultRowCount: buckets.length,
  });
}
