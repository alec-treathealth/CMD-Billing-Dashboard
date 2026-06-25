/**
 * CMD payer rollup reader (read-only, non-PHI) — backs the Master BXR Chart's
 * "By Payer" view for a single calendar month.
 *
 * Reads ONLY collections.cmd_payer_facility_monthly (migration 0012) as
 * claims_reader. That table is non-PHI by construction (payer/facility names,
 * service month, money sums — all in the §8 summary_stats allowlist); it has no
 * patient identifiers. One parameterized query at (payer × facility) grain for the
 * month; the result carries BOTH the payer-total summary (the bars) and the
 * per-facility breakdown (the click-into drill-down) so the UI fetches once.
 *
 * Identifiers are FIXED literals; only year/month are $n parameters. Emits one
 * lightweight non-PHI audit line (no claims.query_log — same posture as daily.ts).
 */
import type { Expect, HasNoPhiKey, PayerGapRow, PayerGapSummary } from '../queries/types.js';
import type { CollectionsQueryContext } from './daily.js';

/** Sentinel stored for a blank payer/facility (migration 0012); shown as null. */
const BLANK = '';

/** One (payer × facility) bucket for the month. Every field is non-PHI. */
export interface CmdPayerFacilityRow {
  /** null = the blank-payer group ('' sentinel in storage). */
  payer_name: string | null;
  /** null = the blank-facility group ('' sentinel in storage). */
  facility_name: string | null;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  /** sum(charge - allowed) — contractual write-down. */
  total_write_down: number;
  /** sum(charge - paid) — real collection shortfall. */
  total_collection_gap: number;
}

export interface CmdPayerMonthResult {
  year: number;
  month: number;
  /** Payer-total rollup (drives the bars), reusing the shared non-PHI shape. */
  summary: PayerGapSummary;
  /** Per-facility breakdown across all payers (drives the per-payer drill-down). */
  by_facility: CmdPayerFacilityRow[];
}

/**
 * SQL: one month, projected explicitly (never SELECT *). The 0012 unique key makes
 * (payer, facility) unique within a month, so this is a straight projection.
 * Exposed so the fixture can assert the exact statement.
 */
export function cmdPayerMonthSql(): string {
  return (
    `select payer_name, facility_name, total_charge, total_allowed, total_paid, charge_line_count ` +
    `from collections.cmd_payer_facility_monthly ` +
    `where service_year = $1 and service_month = $2 ` +
    `order by payer_name, total_charge desc`
  );
}

interface RawRollupRow {
  payer_name: string;
  facility_name: string;
  total_charge: string | number;
  total_allowed: string | number;
  total_paid: string | number;
  charge_line_count: string | number;
}

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

const labelOrNull = (s: string): string | null => (s === BLANK ? null : s);

/**
 * Pure mapper: raw rollup rows → { summary, by_facility }. Per-facility rows keep
 * their grain; the payer summary sums facilities per payer. Money is rounded to
 * cents (JS sums can drift). Exported for hermetic unit tests (no DB).
 */
export function rollupRowsToMonthResult(
  rows: RawRollupRow[],
  year: number,
  month: number,
): CmdPayerMonthResult {
  const by_facility: CmdPayerFacilityRow[] = rows.map((r) => {
    const charge = num(r.total_charge);
    const allowed = num(r.total_allowed);
    const paid = num(r.total_paid);
    return {
      payer_name: labelOrNull(r.payer_name),
      facility_name: labelOrNull(r.facility_name),
      total_charge: round2(charge),
      total_allowed: round2(allowed),
      total_paid: round2(paid),
      total_write_down: round2(charge - allowed),
      total_collection_gap: round2(charge - paid),
    };
  });

  // Sum facilities per payer for the bars. Key on the raw '' sentinel so the blank
  // payer collapses to a single group.
  const byPayer = new Map<string, PayerGapRow>();
  for (const r of rows) {
    const key = r.payer_name;
    const acc =
      byPayer.get(key) ??
      {
        payer_name: labelOrNull(r.payer_name),
        claim_count: 0,
        total_charge: 0,
        total_allowed: 0,
        total_paid: 0,
        avg_collection_rate: null,
        total_write_down: 0,
        total_collection_gap: 0,
      };
    acc.claim_count += num(r.charge_line_count);
    acc.total_charge += num(r.total_charge);
    acc.total_allowed += num(r.total_allowed);
    acc.total_paid += num(r.total_paid);
    byPayer.set(key, acc);
  }

  const by_payer: PayerGapRow[] = [...byPayer.values()]
    .map((r) => ({
      payer_name: r.payer_name,
      claim_count: r.claim_count,
      total_charge: round2(r.total_charge),
      total_allowed: round2(r.total_allowed),
      total_paid: round2(r.total_paid),
      avg_collection_rate: r.total_charge > 0 ? round2(r.total_paid / r.total_charge) : null,
      total_write_down: round2(r.total_charge - r.total_allowed),
      total_collection_gap: round2(r.total_charge - r.total_paid),
    }))
    .sort((a, b) => b.total_charge - a.total_charge);

  const rows_analyzed = by_payer.reduce((n, r) => n + r.claim_count, 0);
  return { year, month, summary: { rows_analyzed, by_payer }, by_facility };
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function emitAudit(ctx: CollectionsQueryContext, shape: Record<string, unknown>): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    event: 'cmd_payer_month',
    created_by: ctx.createdBy,
    args_shape: shape,
  });
  (ctx.audit ?? stdoutAudit)(line);
}

/**
 * Per-payer gap + per-facility breakdown for one calendar month, from the CMD
 * rollup. Validates year/month as bounded integers, runs one parameterized query,
 * and aggregates in-process. No PHI, no rows.
 */
export async function cmdPayerMonth(
  year: number,
  month: number,
  ctx: CollectionsQueryContext,
): Promise<CmdPayerMonthResult> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year must be an integer in [2000, 2100]');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('month must be an integer in [1, 12]');
  }
  const { rows } = await ctx.executor.query<RawRollupRow>(cmdPayerMonthSql(), [year, month]);
  const result = rollupRowsToMonthResult(rows, year, month);
  emitAudit(ctx, { year, month, payers: result.summary.by_payer.length, facility_rows: result.by_facility.length });
  return result;
}

// Compile-time proof the result shapes carry no PHI key (defense in depth; this
// table has no patient identifiers to begin with).
export type _CmdPayerFacilityRowNoPhi = Expect<HasNoPhiKey<CmdPayerFacilityRow>>;
