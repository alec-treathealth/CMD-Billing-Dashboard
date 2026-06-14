/**
 * Phase 7 — monthly collections summary by facility (read-only, non-PHI).
 *
 * Aggregates `collections.daily_collections` joined to `collections.facilities`
 * as claims_reader. It NEVER touches `collections.collections_raw` (PHI-bearing,
 * admin-only) or `collections.payment_lines`, and it NEVER selects
 * `source_group_code` — TREAT_FRCA / LSMH_DMH are lineage only, never a facility,
 * so a NULL `facility_code` simply falls through the LEFT JOIN with a NULL
 * facility_name (rendered "(unassigned)" upstream).
 *
 * Column/table identifiers are FIXED literals; only the optional date bounds are
 * `$n` parameters. Per the Phase 7 decision this does NOT route through the
 * claims `finalize()` chokepoint / `claims.query_log` (that is claims-domain
 * audit); it emits exactly one lightweight structured, non-PHI audit line.
 */
import type { QueryExecutor } from '../queries/types.js';
import type {
  CollectionsMonthlySummary,
  CollectionsMonthRow,
  CollectionsSummaryArgs,
} from './summaryTypes.js';

/** Accepted shape for the optional date bounds. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Per-call context — the executor is the claims_reader pool; sinks are injectable for tests. */
export interface CollectionsSummaryContext {
  executor: QueryExecutor;
  /** Non-PHI principal for the audit line. */
  createdBy: string;
  now?: () => Date;
  /** Audit sink; defaults to one JSON line on stdout. */
  audit?: (line: string) => void;
}

interface RawRow {
  month: string;
  facility_code: string | null;
  facility_name: string | null;
  day_rows: string | number;
  checks_amount: string | number;
  eft_amount: string | number;
  gross_amount: string | number;
}

/**
 * The parameterized SQL. Exposed so the fixture can assert the exact string.
 * `$1` = inclusive from-date, `$2` = exclusive to-date (either may be NULL).
 */
export function collectionsMonthlySummarySql(): string {
  return (
    `select ` +
    `to_char(date_trunc('month', dc.payment_date), 'YYYY-MM') as month, ` +
    `dc.facility_code as facility_code, ` +
    `f.facility_name as facility_name, ` +
    `count(*)::bigint as day_rows, ` +
    `coalesce(sum(dc.checks_amount), 0) as checks_amount, ` +
    `coalesce(sum(dc.eft_amount), 0) as eft_amount, ` +
    `coalesce(sum(dc.gross_amount), 0) as gross_amount ` +
    `from collections.daily_collections dc ` +
    `left join collections.facilities f on f.facility_code = dc.facility_code ` +
    `where ($1::date is null or dc.payment_date >= $1::date) ` +
    `and ($2::date is null or dc.payment_date < $2::date) ` +
    `group by 1, dc.facility_code, f.facility_name ` +
    `order by month desc, gross_amount desc`
  );
}

/** Validate an optional 'YYYY-MM-DD' bound; throws (fail-closed) on a malformed value. */
export function validateDateBound(label: 'from' | 'to', v: string | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) {
    throw new Error(`collections summary: invalid ${label} date`);
  }
  return v;
}

/** Coerce a pg numeric/bigint (returned as text) to a finite number; null/garbage → 0. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function collectionsMonthlySummary(
  args: CollectionsSummaryArgs,
  ctx: CollectionsSummaryContext,
): Promise<CollectionsMonthlySummary> {
  const from = validateDateBound('from', args.from);
  const to = validateDateBound('to', args.to);

  const { rows } = await ctx.executor.query<RawRow>(collectionsMonthlySummarySql(), [
    from ?? null,
    to ?? null,
  ]);

  const by_month_facility: CollectionsMonthRow[] = rows.map((r) => ({
    month: r.month,
    facility_code: r.facility_code,
    facility_name: r.facility_name,
    day_rows: num(r.day_rows),
    checks_amount: num(r.checks_amount),
    eft_amount: num(r.eft_amount),
    gross_amount: num(r.gross_amount),
  }));

  const rows_analyzed = by_month_facility.reduce((acc, r) => acc + r.day_rows, 0);

  const summary: CollectionsMonthlySummary = {
    from: from ?? null,
    to: to ?? null,
    rows_analyzed,
    by_month_facility,
  };

  emitAudit(ctx, { from: from ?? null, to: to ?? null, rows_returned: by_month_facility.length, rows_analyzed });
  return summary;
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** One structured, non-PHI audit line. No claims.query_log write (Phase 7 decision). */
function emitAudit(
  ctx: CollectionsSummaryContext,
  shape: { from: string | null; to: string | null; rows_returned: number; rows_analyzed: number },
): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    event: 'collections_monthly_summary',
    created_by: ctx.createdBy,
    args_shape: { from: shape.from, to: shape.to },
    rows_returned: shape.rows_returned,
    rows_analyzed: shape.rows_analyzed,
  });
  (ctx.audit ?? stdoutAudit)(line);
}
