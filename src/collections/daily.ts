/**
 * Phase 7.1 — daily collections queries (read-only, non-PHI).
 *
 * Two functions, both reading ONLY collections.daily_collections_resolved (the
 * source-tag dedup view over daily_collections — migration 0014; deposit_sheet wins
 * per facility-day, workbook fills the rest) joined to collections.facilities as
 * claims_reader:
 *   - collectionsDaily : granular daily rows (date/facility/checks/eft/gross),
 *     defaulting to the latest calendar month present when unbounded.
 *   - collectionsKpis  : per-facility + overall MTD/YTD (checks/eft/gross),
 *     anchored to `as_of` (defaults to max(payment_date) — the latest loaded day).
 *
 * Never reads collections_raw / payment_lines. Never selects source_group_code.
 * Identifiers are FIXED literals; only date/facility VALUES are $n parameters.
 * Each call emits one lightweight, non-PHI audit line (no claims.query_log).
 */
import type { QueryExecutor } from '../queries/types.js';
import { validateDateBound } from './summary.js';
import type {
  CollectionsAmounts,
  CollectionsDailyArgs,
  CollectionsDailyResult,
  CollectionsDailyRow,
  CollectionsFacilityKpi,
  CollectionsKpis,
  CollectionsKpisArgs,
} from './dailyTypes.js';

export interface CollectionsQueryContext {
  executor: QueryExecutor;
  createdBy: string;
  now?: () => Date;
  audit?: (line: string) => void;
}

// --- collectionsDaily -------------------------------------------------------

/**
 * Daily rows. $1 = from (incl), $2 = to (excl), $3 = facility_code. When BOTH
 * $1 and $2 are null the window defaults to the latest calendar month present
 * (via the anchor CTE) so the dashboard/API "this month" view needs no client
 * date math. Exposed for the fixture to assert the exact SQL.
 */
export function collectionsDailySql(): string {
  return (
    `with anchor as (select max(payment_date) as max_d from collections.daily_collections_resolved) ` +
    `select ` +
    `to_char(dc.payment_date, 'YYYY-MM-DD') as payment_date, ` +
    `dc.facility_code as facility_code, ` +
    `f.facility_name as facility_name, ` +
    `dc.checks_amount as checks_amount, ` +
    `dc.eft_amount as eft_amount, ` +
    `dc.gross_amount as gross_amount ` +
    `from collections.daily_collections_resolved dc ` +
    `cross join anchor a ` +
    `left join collections.facilities f on f.facility_code = dc.facility_code ` +
    `where (case when $1::date is null and $2::date is null ` +
    `then dc.payment_date >= date_trunc('month', a.max_d)::date ` +
    `and dc.payment_date < (date_trunc('month', a.max_d) + interval '1 month')::date ` +
    `else (($1::date is null or dc.payment_date >= $1::date) ` +
    `and ($2::date is null or dc.payment_date < $2::date)) end) ` +
    `and ($3::text is null or dc.facility_code = $3::text) ` +
    `order by dc.payment_date desc, f.facility_name nulls last, dc.facility_code`
  );
}

interface RawDailyRow {
  payment_date: string;
  facility_code: string | null;
  facility_name: string | null;
  checks_amount: string | number;
  eft_amount: string | number;
  gross_amount: string | number;
}

export async function collectionsDaily(
  args: CollectionsDailyArgs,
  ctx: CollectionsQueryContext,
): Promise<CollectionsDailyResult> {
  const from = validateDateBound('from', args.from);
  const to = validateDateBound('to', args.to);
  const facility = typeof args.facility_code === 'string' && args.facility_code.trim() !== ''
    ? args.facility_code.trim()
    : undefined;

  const { rows } = await ctx.executor.query<RawDailyRow>(collectionsDailySql(), [
    from ?? null,
    to ?? null,
    facility ?? null,
  ]);

  const out: CollectionsDailyRow[] = rows.map((r) => ({
    payment_date: r.payment_date,
    facility_code: r.facility_code,
    facility_name: r.facility_name,
    checks_amount: money2(r.checks_amount),
    eft_amount: money2(r.eft_amount),
    gross_amount: money2(r.gross_amount),
  }));

  const result: CollectionsDailyResult = {
    from: from ?? null,
    to: to ?? null,
    facility_code: facility ?? null,
    row_count: out.length,
    rows: out,
  };
  emitAudit(ctx, 'collections_daily', { from: from ?? null, to: to ?? null, facility: facility ?? null, rows_returned: out.length });
  return result;
}

// --- collectionsKpis --------------------------------------------------------

/**
 * Per-facility + overall MTD/YTD. $1 = as_of (anchor); when null it defaults to
 * max(payment_date). MTD = [date_trunc('month', anchor), anchor]; YTD =
 * [date_trunc('year', anchor), anchor] (both inclusive of the anchor day).
 * Exposed for the fixture to assert the exact SQL.
 */
export function collectionsKpisSql(): string {
  const mtd = `dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d`;
  const ytd = `dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d`;
  return (
    `with anchor as (select coalesce($1::date, max(payment_date)) as d from collections.daily_collections_resolved) ` +
    `select ` +
    `to_char(a.d, 'YYYY-MM-DD') as as_of, ` +
    `dc.facility_code as facility_code, ` +
    `f.facility_name as facility_name, ` +
    `coalesce(sum(dc.checks_amount) filter (where ${mtd}), 0) as mtd_checks, ` +
    `coalesce(sum(dc.eft_amount) filter (where ${mtd}), 0) as mtd_eft, ` +
    `coalesce(sum(dc.gross_amount) filter (where ${mtd}), 0) as mtd_gross, ` +
    `coalesce(sum(dc.checks_amount) filter (where ${ytd}), 0) as ytd_checks, ` +
    `coalesce(sum(dc.eft_amount) filter (where ${ytd}), 0) as ytd_eft, ` +
    `coalesce(sum(dc.gross_amount) filter (where ${ytd}), 0) as ytd_gross ` +
    `from collections.daily_collections_resolved dc ` +
    `cross join anchor a ` +
    `left join collections.facilities f on f.facility_code = dc.facility_code ` +
    `group by a.d, dc.facility_code, f.facility_name ` +
    `order by ytd_gross desc`
  );
}

interface RawKpiRow {
  as_of: string | null;
  facility_code: string | null;
  facility_name: string | null;
  mtd_checks: string | number;
  mtd_eft: string | number;
  mtd_gross: string | number;
  ytd_checks: string | number;
  ytd_eft: string | number;
  ytd_gross: string | number;
}

export async function collectionsKpis(
  args: CollectionsKpisArgs,
  ctx: CollectionsQueryContext,
): Promise<CollectionsKpis> {
  const asOfArg = validateDateBound('as_of' as 'from', args.as_of);

  const { rows } = await ctx.executor.query<RawKpiRow>(collectionsKpisSql(), [asOfArg ?? null]);

  const by_facility: CollectionsFacilityKpi[] = rows.map((r) => ({
    facility_code: r.facility_code,
    facility_name: r.facility_name,
    mtd_checks: money2(r.mtd_checks),
    mtd_eft: money2(r.mtd_eft),
    mtd_gross: money2(r.mtd_gross),
    ytd_checks: money2(r.ytd_checks),
    ytd_eft: money2(r.ytd_eft),
    ytd_gross: money2(r.ytd_gross),
  }));

  // Overall totals are summed in JS, so round the result to cents (avoids float
  // artifacts like 2623439.3100000005 reaching the API/UI).
  const mtd: CollectionsAmounts = {
    checks: round2(sum(by_facility, 'mtd_checks')),
    eft: round2(sum(by_facility, 'mtd_eft')),
    gross: round2(sum(by_facility, 'mtd_gross')),
  };
  const ytd: CollectionsAmounts = {
    checks: round2(sum(by_facility, 'ytd_checks')),
    eft: round2(sum(by_facility, 'ytd_eft')),
    gross: round2(sum(by_facility, 'ytd_gross')),
  };

  const result: CollectionsKpis = {
    as_of: rows[0]?.as_of ?? asOfArg ?? null,
    mtd,
    ytd,
    by_facility,
  };
  emitAudit(ctx, 'collections_kpis', { as_of: result.as_of, facilities: by_facility.length });
  return result;
}

// --- shared helpers ---------------------------------------------------------

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Round a number to 2 decimals (cents). EPSILON nudge keeps exact halves stable. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a pg numeric/bigint value and round to cents — for money outputs. */
function money2(v: unknown): number {
  return round2(num(v));
}

function sum(rows: CollectionsFacilityKpi[], key: keyof CollectionsFacilityKpi): number {
  return rows.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** One structured, non-PHI audit line. No claims.query_log write (Phase 7 decision). */
function emitAudit(ctx: CollectionsQueryContext, event: string, shape: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    event,
    created_by: ctx.createdBy,
    args_shape: shape,
  });
  (ctx.audit ?? stdoutAudit)(line);
}
