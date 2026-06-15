/**
 * Dashboard aggregate readers (Phase 7.7, Workstream 1c).
 *
 * The dashboard's arg-free, NON-PHI rollups read from the materialized views in
 * migration 0009 instead of scanning claims.claims live. These readers return the
 * EXACT SAME shapes the UI already consumes (PayerGapSummary, DistributionSummary),
 * so nothing downstream changes — only where the numbers come from.
 *
 * This path is non-PHI by construction: the matviews contain only aggregates over
 * allowlisted dimensions. It is deliberately separate from the agent/reveal path
 * (payer_gap_analysis / distribution / search_claims), which stays live against
 * claims.claims and still writes query_log via finalize(). No finalize() / query_id
 * here — the dashboard never reveals rows.
 */
import type {
  DistributionBucket,
  DistributionField,
  DistributionSummary,
  PayerGapRow,
  PayerGapSummary,
  QueryExecutor,
} from './types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- payer gap --------------------------------------------------------------

interface PayerGapMvRow {
  payer_name: string | null;
  claim_count: string;
  total_charge: string;
  total_allowed: string;
  total_paid: string;
  avg_collection_rate: string | null;
  total_write_down: string;
  total_collection_gap: string;
}

/** Read the pre-aggregated payer gap. Ordering mirrors the live payerGapSql. Exposed for tests. */
export function payerGapMatviewSql(): string {
  return (
    `select ` +
    `payer_name, claim_count, total_charge, total_allowed, total_paid, ` +
    `avg_collection_rate, total_write_down, total_collection_gap ` +
    `from claims.mv_payer_gap ` +
    `order by total_collection_gap desc nulls last`
  );
}

export async function payerGapFromMatview(executor: QueryExecutor): Promise<PayerGapSummary> {
  const { rows } = await executor.query<PayerGapMvRow>(payerGapMatviewSql(), []);
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
  return { rows_analyzed, by_payer };
}

// --- distribution (count) ---------------------------------------------------

interface DistCountMvRow {
  value: string | null;
  metric_value: string | null;
}

/** Read the pre-aggregated count distribution for one allowlisted field. Exposed for tests. */
export function distributionCountMatviewSql(): string {
  return (
    `select value, metric_value ` +
    `from claims.mv_distribution_count ` +
    `where field = $1 ` +
    `order by metric_value desc nulls last`
  );
}

export async function distributionCountFromMatview(
  executor: QueryExecutor,
  field: DistributionField,
): Promise<DistributionSummary> {
  const { rows } = await executor.query<DistCountMvRow>(distributionCountMatviewSql(), [field]);
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
  return { field, metric: 'count', buckets };
}
