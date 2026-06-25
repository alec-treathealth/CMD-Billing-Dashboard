/**
 * Daily CMD payer rollup refresh — live CMD API → collections.cmd_payer_facility_monthly.
 *
 * WHY: the manual CSV ingest (cmdPayerIngest.ts) keeps the rollup fresh for closed
 * months, but the in-progress month (and recently-closed months that still get late
 * adjustments) go stale until someone re-exports the CSV. This module refreshes a
 * trailing window of months automatically from the SAME CMD "Derek History Report"
 * — pulled via the batch API (cmdReportRows) instead of a manual UI export — so the
 * Master BXR Chart "By Payer" view reflects recent activity without a human in the
 * loop. It is invoked daily by the Vercel Cron route (app/app/api/cron/refresh-cmd-payer).
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the live report rows are per-charge-line and
 * PHI-bearing, identical to the CSV. They are aggregated to PAYER × FACILITY × MONTH
 * totals IN-PROCESS (aggregateRollup) and ONLY the non-PHI rollup is written. No
 * patient-level row ever lands in the database, and the returned stats carry counts
 * and non-PHI aggregates only — never a patient cell.
 *
 * SCOPE: only the trailing window (current month + the prior `windowSize-1` months)
 * is refreshed. writeRollup is refresh-by-month, so it replaces ONLY those buckets —
 * older months stay frozen as ingested, and a manually-corrected closed month outside
 * the window is never overwritten. A late adjustment to a month INSIDE the window IS
 * picked up daily (the intended behavior).
 *
 * SECURITY: writes as the least-privilege cmd_rollup_writer role
 * (CMD_ROLLUP_WRITER_DATABASE_URL, migration 0013) — NOT claims_admin. The live API
 * credentials and the writer DB URL come from env only and are never logged.
 */
import { aggregateRollup, writeRollup, type RollupTuple } from './cmdPayerIngest.js';
import type { CmdReportRow } from './cmdPayer.js';
import type { Db } from './db.js';

/** Default trailing window: current month + 2 prior. */
export const DEFAULT_WINDOW_SIZE = 3;

/** One (service_year, service_month) bucket to refresh. */
export interface RefreshMonth {
  year: number;
  month: number; // 1-12
}

/**
 * The trailing window of months to refresh: the current month plus the prior
 * `windowSize - 1` months, newest first. Uses UTC so the daily cron is deterministic
 * regardless of server locale; the window includes prior months, so month-boundary
 * timing is immaterial. `windowSize` is clamped to at least 1.
 */
export function windowMonths(now: Date, windowSize: number = DEFAULT_WINDOW_SIZE): RefreshMonth[] {
  const size = Math.max(1, Math.floor(windowSize));
  const out: RefreshMonth[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1; // getUTCMonth() is 0-11
  for (let i = 0; i < size; i += 1) {
    out.push({ year, month });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

/** Keep only the tuples whose (year, month) falls in the refresh window. */
export function filterTuplesToWindow(tuples: RollupTuple[], months: RefreshMonth[]): RollupTuple[] {
  const inWindow = new Set(months.map((m) => `${m.year}-${m.month}`));
  return tuples.filter((t) => inWindow.has(`${t.service_year}-${t.service_month}`));
}

const monthKey = (t: RollupTuple): string =>
  `${t.service_year}-${String(t.service_month).padStart(2, '0')}`;

export interface RefreshDeps {
  /** Fetch the live CMD report rows (injected: cmdReportRows(cmdApiConfig()) in prod). */
  fetchRows: () => Promise<CmdReportRow[]>;
  /** Least-privilege writer pool (cmd_rollup_writer). */
  writeDb: Db;
  /** Defaults to `new Date()`. Injected for deterministic tests. */
  now?: Date;
  /** Defaults to DEFAULT_WINDOW_SIZE. */
  windowSize?: number;
}

/** Non-PHI summary of a refresh run — safe to log and return to the (authed) caller. */
export interface RefreshStats {
  /** Months refreshed, 'YYYY-MM' ascending (only those with rows in the live report). */
  months: string[];
  /** Total report rows fetched from the live CMD API. */
  rows_fetched: number;
  /** Rollup rows written (payer × facility × month) within the window. */
  rollup_rows_written: number;
  distinct_payers: number;
  distinct_facilities: number;
}

/**
 * Pull the live CMD report, aggregate to non-PHI rollup tuples, keep only the
 * trailing window, and refresh-by-month upsert. Returns non-PHI stats only.
 */
export async function refreshCmdPayerRollup(deps: RefreshDeps): Promise<RefreshStats> {
  const months = windowMonths(deps.now ?? new Date(), deps.windowSize ?? DEFAULT_WINDOW_SIZE);
  const rows = await deps.fetchRows();
  const { tuples } = aggregateRollup(rows);
  const scoped = filterTuplesToWindow(tuples, months);
  const written = await writeRollup(deps.writeDb, scoped);
  return {
    months: [...new Set(scoped.map(monthKey))].sort(),
    rows_fetched: rows.length,
    rollup_rows_written: written,
    distinct_payers: new Set(scoped.map((t) => t.payer_name)).size,
    distinct_facilities: new Set(scoped.map((t) => t.facility_name)).size,
  };
}
