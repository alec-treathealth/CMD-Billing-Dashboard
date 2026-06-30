/**
 * Year-over-year collected totals (read-only, NON-PHI) — backs the overview YTD
 * Gross card's YoY trend and the Year Forecast card's prior-year comparison.
 *
 * The live deposit series (daily_collections_resolved) is 2026-only, so it cannot
 * supply a year-over-year comparison. `collections.payment_lines` is the only
 * multi-year collections-side series (2024→2026), so the YoY% is sourced here from
 * payment_lines (BOTH years from the same table, so the ratio is self-consistent).
 *
 * Reads ONLY collections.payment_lines as claims_reader. Projects ONLY the non-PHI
 * aggregate sum(insurance_paid) windowed on payment_date — NEVER patient_name /
 * patient_last / patient_first / member_id_* / group_number / source_group_code, and
 * never SELECT *. Identifiers are FIXED literals; only date VALUES are $n params.
 * Emits one lightweight non-PHI audit line.
 *
 * NOTE: payment_lines is the FROZEN legacy `workbook` series (CLAUDE.md §7) — fine
 * as a historical YoY reference, but the live MTD/YTD/forecast headline numbers come
 * from daily_collections_resolved, not from here.
 */
import type { Expect, HasNoPhiKey } from '../queries/types.js';
import type { CollectionsQueryContext } from './daily.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CollectionsYoyArgs {
  /** Anchor 'YYYY-MM-DD' — current YTD runs [Jan 1 of its year, as_of]. */
  as_of: string;
}

export interface CollectionsYoy {
  /** Echo of the anchor used. */
  as_of: string;
  current_year: number;
  prior_year: number;
  /** Insurance paid, current year [Jan 1, as_of]. */
  current_ytd_paid: number;
  /** Insurance paid, prior year [Jan 1, same month/day as as_of] — same-period YoY base. */
  prior_ytd_paid: number;
  /** Insurance paid, the ENTIRE prior year [Jan 1, Dec 31] — forecast YoY base. */
  prior_full_year_paid: number;
}

/** Single-scan FILTER aggregate. $1..$5 are date bounds (see windowsFor). */
export function collectionsYoySql(): string {
  return (
    `select ` +
    `round(coalesce(sum(insurance_paid) filter (where payment_date >= $1::date and payment_date <= $2::date), 0)::numeric, 2) as current_ytd_paid, ` +
    `round(coalesce(sum(insurance_paid) filter (where payment_date >= $3::date and payment_date <= $4::date), 0)::numeric, 2) as prior_ytd_paid, ` +
    `round(coalesce(sum(insurance_paid) filter (where payment_date >= $3::date and payment_date <= $5::date), 0)::numeric, 2) as prior_full_year_paid ` +
    `from collections.payment_lines`
  );
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Derive the five date bounds from the anchor. Returns the param array in $1..$5
 * order plus the two years (for the result echo). Exported for the fixture.
 */
export function windowsFor(asOf: string): {
  params: [string, string, string, string, string];
  currentYear: number;
  priorYear: number;
} {
  if (typeof asOf !== 'string' || !ISO_DATE_RE.test(asOf)) {
    throw new Error('collections yoy: invalid as_of date');
  }
  const currentYear = Number(asOf.slice(0, 4));
  const priorYear = currentYear - 1;
  let mmdd = asOf.slice(5); // 'MM-DD'
  // Feb 29 anchor with a non-leap prior year → clamp to Feb 28 (valid date).
  if (mmdd === '02-29' && !isLeap(priorYear)) mmdd = '02-28';

  const curStart = `${currentYear}-01-01`;
  const curEnd = asOf;
  const priorStart = `${priorYear}-01-01`;
  const priorSamePeriodEnd = `${priorYear}-${mmdd}`;
  const priorFullEnd = `${priorYear}-12-31`;
  return {
    params: [curStart, curEnd, priorStart, priorSamePeriodEnd, priorFullEnd],
    currentYear,
    priorYear,
  };
}

interface RawYoyRow {
  current_ytd_paid: string | number;
  prior_ytd_paid: string | number;
  prior_full_year_paid: string | number;
}

export async function collectionsYoy(
  args: CollectionsYoyArgs,
  ctx: CollectionsQueryContext,
): Promise<CollectionsYoy> {
  const { params, currentYear, priorYear } = windowsFor(args.as_of);

  const { rows } = await ctx.executor.query<RawYoyRow>(collectionsYoySql(), params);
  const r = rows[0];

  const result: CollectionsYoy = {
    as_of: args.as_of,
    current_year: currentYear,
    prior_year: priorYear,
    current_ytd_paid: money2(r?.current_ytd_paid),
    prior_ytd_paid: money2(r?.prior_ytd_paid),
    prior_full_year_paid: money2(r?.prior_full_year_paid),
  };
  emitAudit(ctx, { as_of: result.as_of, current_year: currentYear, prior_year: priorYear });
  return result;
}

// --- shared helpers (mirrors src/collections/daily.ts) ----------------------

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money2(v: unknown): number {
  return round2(num(v));
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function emitAudit(ctx: CollectionsQueryContext, shape: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    event: 'collections_yoy',
    created_by: ctx.createdBy,
    args_shape: shape,
  });
  (ctx.audit ?? stdoutAudit)(line);
}

// Compile-time proof the output carries no PHI key (defense in depth).
export type _CollectionsYoyNoPhi = Expect<HasNoPhiKey<CollectionsYoy>>;
