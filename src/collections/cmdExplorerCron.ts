/**
 * CMD Collections Explorer + Master BXR chart CRON — live CMD batch report →
 * collections.cmd_explorer_rows (charge-line detail) AND collections.daily_collections
 * (per-facility/day Check+EFT deposit totals, source_tag='cmd').
 *
 * WHY: the CMD Web API scopes data by CUSTOMER (one customer == one facility). A single
 * report/filter (10091971 / 10147499, the export incl Check/EFT, window baked to PAYMENT-RECEIVED
 * 1/1/2026→6/30/2027) is run ONCE PER CUSTOMER (src/collections/cmdCustomers.ts) to cover all
 * facilities. Each customer's rows feed BOTH surfaces:
 *   - charge lines  → cmd_explorer_rows  (Explorer; append-only ON CONFLICT, full-history grain)
 *   - Check+EFT sums → daily_collections  (Master BXR chart; per-facility transactional replace)
 * Reuses the SEED's exact mapRow + insertRows so a cron-pulled charge line is byte-identical in
 * shape and fingerprint to the same row loaded from the historical CSV.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the 3 identifiers are encrypted in-process before insert
 * (insertRows → encryptPhi). The daily aggregate carries ONLY a date + summed dollars (non-PHI).
 * The returned/logged summary is COUNTS ONLY — never a cell value, never a raw skip "reason",
 * never the live report body.
 *
 * LAYERING (§10): transport-agnostic — no next/cache, no env reads, no secrets. The composition
 * root (app/lib/server.ts) injects the customer list, the per-customer fetch, the least-privilege
 * writer pool, and the cache-revalidate callbacks.
 *
 * TIME BUDGET: CMD runs one report at a time per partner, so customers are pulled SEQUENTIALLY.
 * A wall-clock guard stops launching new customers near the function's deadline; whatever didn't
 * run this invocation is picked up next run (everything is idempotent — ON CONFLICT for charge
 * lines, per-facility DELETE+INSERT for daily), and each run re-pulls the full filter window, so
 * the data self-heals rather than drifting.
 */
import { aggregateDailyDeposits, mapReportRows } from './cmdExplorer.js';
import { insertRows, mapRow, type PlainRow } from './cmdExplorerSeed.js';
import type { CmdReportRow } from './cmdPayer.js';
import { replaceCmdDailyForFacility, type Db } from './db.js';

/** Marks rows that arrived via the live API (vs a seed CSV filename). */
const CRON_SOURCE = 'cmd_api';

/** Default wall-clock budget before the loop stops launching NEW customers (ms). Leaves
 *  headroom under a 300s Vercel function for the final write + revalidate. */
const DEFAULT_BUDGET_MS = 270_000;

/** Non-fatal freshness/expiry thresholds (logged as warnings; never fail the run). */
const STALE_AFTER_DAYS = 10; // newest payment_date this far behind `now` ⇒ pipeline may be stalled
const WINDOW_WARN_DAYS = 30; // saved filter's window-end this close ⇒ extend it in CMD soon
const DAY_MS = 86_400_000;

/** Parse a 'YYYY-MM-DD' date to epoch ms at UTC midnight; NaN if malformed. */
function isoDateMs(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

/**
 * Build non-fatal operational warnings from the run's newest payment_date and the saved CMD
 * filter's absolute window-end. Two INDEPENDENT signals — either can fire alone:
 *  - STALE (reactive): newest ingested payment_date is > STALE_AFTER_DAYS behind `now`, so the
 *    pipeline may be stalled (CMD outage, broken cron, expired filter) even on a "successful" run.
 *  - WINDOW EXPIRY (proactive): the filter's window-end (filterWindowEnd) is within WINDOW_WARN_DAYS
 *    or already past — payment dates beyond it silently stop ingesting until the filter is extended
 *    in CMD. This is the deferred form of the original 6/24 freshness stall. Because every run
 *    re-pulls the full window, extending the filter later backfills any gap — so this is a heads-up,
 *    not a data-loss event.
 * Pure + exported for tests. Every string is non-PHI (dates + day-counts only) and safe to log.
 */
export function computeFreshnessWarnings(input: {
  maxPaymentDate: string | null;
  nowMs: number;
  filterWindowEnd?: string;
}): string[] {
  const { maxPaymentDate, nowMs, filterWindowEnd } = input;
  const warnings: string[] = [];

  if (maxPaymentDate) {
    const ms = isoDateMs(maxPaymentDate);
    if (!Number.isNaN(ms)) {
      const lagDays = Math.floor((nowMs - ms) / DAY_MS);
      if (lagDays > STALE_AFTER_DAYS) {
        warnings.push(
          `STALE: newest payment_date ${maxPaymentDate} is ${lagDays} days behind now ` +
            `(threshold ${STALE_AFTER_DAYS}d) — the cmd-explorer pipeline may be stalled.`,
        );
      }
    }
  }

  if (filterWindowEnd) {
    const ms = isoDateMs(filterWindowEnd);
    if (!Number.isNaN(ms)) {
      const remainingDays = Math.floor((ms - nowMs) / DAY_MS);
      if (remainingDays < 0) {
        warnings.push(
          `FILTER WINDOW EXPIRED: the saved CMD filter window ended ${filterWindowEnd} ` +
            `(${-remainingDays} days ago) — payment dates past it are NOT being ingested. ` +
            `Extend/replace the filter's window in CMD (then a normal run backfills the gap).`,
        );
      } else if (remainingDays <= WINDOW_WARN_DAYS) {
        warnings.push(
          `FILTER WINDOW EXPIRING: the saved CMD filter window ends ${filterWindowEnd} ` +
            `in ${remainingDays} days — extend it in CMD before then or new months stop appending.`,
        );
      }
    }
  }

  return warnings;
}

/** One CMD customer account to pull (== one facility). */
export interface CmdCustomerTarget {
  customerId: string;
  facilityCode: string;
}

export interface CmdExplorerCronDeps {
  /** The CMD customer accounts to loop (one report/filter run each). */
  customers: ReadonlyArray<CmdCustomerTarget>;
  /** Fetch the live CMD report rows for ONE customer — in prod: cmdReportRows(cmdExplorerConfigFor(id)). */
  fetchRows: (customerId: string) => Promise<CmdReportRow[]>;
  /** Least-privilege writer pool (cmd_rollup_writer), injected by the composition root. */
  writeDb: Db;
  /** Bust the explorer's non-PHI cache after a successful pass. In prod: () => revalidateTag('cmd-explorer'). */
  revalidate?: () => void | Promise<void>;
  /** Bust the dashboard aggregate cache (Master BXR chart). In prod: () => revalidateTag('dashboard-aggregates'). */
  revalidateDashboard?: () => void | Promise<void>;
  /** Monotonic clock for the wall-clock guard (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Wall-clock budget before new customers stop launching. Default 270s. */
  budgetMs?: number;
  /** Saved CMD filter's absolute window-end ('YYYY-MM-DD'). Drives the expiry warning; omit to skip. */
  filterWindowEnd?: string;
}

/** Non-PHI summary of a cron run — safe to log and return to the (authed) caller. */
export interface CmdExplorerCronStats {
  customers_total: number;
  customers_processed: number;
  /** Customers that threw (network / INVALID CRITERIA / DB) — skipped, run continues. */
  customers_failed: number;
  /** Customers not attempted because the wall-clock budget was exhausted. */
  customers_skipped_budget: number;
  /** Charge-line rows pulled from the live CMD reports (all customers). */
  rows_fetched: number;
  /** Charge rows that mapped successfully (passed required-field validation). */
  charge_mapped_valid: number;
  /** Charge rows skipped for a missing/invalid required field (counts only). */
  charge_skipped: number;
  /** New charge-line rows actually inserted (ON CONFLICT skipped the rest). */
  charge_inserted: number;
  /** Daily deposit rows (facility-day) inserted into daily_collections. */
  daily_rows_inserted: number;
  /** Prior source_tag='cmd' daily rows deleted (per-facility replace). */
  daily_rows_deleted: number;
  /** Newest payment_date ingested this run (ISO 'YYYY-MM-DD'), or null if nothing landed. */
  max_payment_date: string | null;
  /** Non-fatal operational warnings (stale data / filter-window expiry). Empty ⇒ healthy. */
  freshness_warnings: string[];
}

/**
 * Loop the CMD customer accounts, pulling report 10091971/filter 10147499 for each and writing
 * both surfaces per customer (so a partial run leaves processed facilities fresh and the rest
 * untouched). Revalidates both caches if anything was processed. Returns non-PHI stats only.
 * Per-customer failures are isolated (logged + skipped); a hard DB/auth failure still throws.
 */
export async function cmdExplorerCron(deps: CmdExplorerCronDeps): Promise<CmdExplorerCronStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = now();

  const stats: CmdExplorerCronStats = {
    customers_total: deps.customers.length,
    customers_processed: 0,
    customers_failed: 0,
    customers_skipped_budget: 0,
    rows_fetched: 0,
    charge_mapped_valid: 0,
    charge_skipped: 0,
    charge_inserted: 0,
    daily_rows_inserted: 0,
    daily_rows_deleted: 0,
    max_payment_date: null,
    freshness_warnings: [],
  };

  for (const { customerId, facilityCode } of deps.customers) {
    if (now() - started > budgetMs) {
      stats.customers_skipped_budget += 1;
      continue;
    }
    try {
      const reportRows = await deps.fetchRows(customerId);
      stats.rows_fetched += reportRows.length;

      // Charge lines → cmd_explorer_rows. De-dup by fingerprint within this customer's pull
      // (first wins); cross-customer fingerprints differ (facility is part of the hash), and
      // ON CONFLICT collapses anything already in the table.
      const byFingerprint = new Map<string, PlainRow>();
      for (const full of mapReportRows(reportRows)) {
        const result = mapRow(full, CRON_SOURCE);
        if (!result.ok) {
          stats.charge_skipped += 1;
          continue;
        }
        stats.charge_mapped_valid += 1;
        if (!byFingerprint.has(result.row.row_fingerprint)) {
          byFingerprint.set(result.row.row_fingerprint, result.row);
        }
      }
      stats.charge_inserted += await insertRows(deps.writeDb, [...byFingerprint.values()]);

      // Check+EFT deposits → daily_collections (source_tag='cmd'), per-facility replace.
      const daily = aggregateDailyDeposits(reportRows, facilityCode);
      const { deleted, inserted } = await replaceCmdDailyForFacility(deps.writeDb, facilityCode, daily);
      stats.daily_rows_deleted += deleted;
      stats.daily_rows_inserted += inserted;

      // Track the newest payment_date across all facilities (daily is sorted ascending by date,
      // and ISO 'YYYY-MM-DD' sorts chronologically) for the freshness warning below.
      const last = daily.at(-1);
      if (last && (stats.max_payment_date === null || last.payment_date > stats.max_payment_date)) {
        stats.max_payment_date = last.payment_date;
      }

      stats.customers_processed += 1;
    } catch (err) {
      // Per-customer isolation: log the facility + message (non-PHI) and continue.
      stats.customers_failed += 1;
      console.error(
        `cmd-explorer cron: customer ${customerId} (${facilityCode}) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Bust caches when anything was processed (charge inserts and/or a daily replace).
  if (stats.customers_processed > 0) {
    if (deps.revalidate) await deps.revalidate();
    if (deps.revalidateDashboard) await deps.revalidateDashboard();
  }

  // Non-fatal freshness/expiry warnings (run unconditionally — the window-expiry signal matters
  // most precisely when processing failed). Logged loudly; also surfaced in the returned stats.
  stats.freshness_warnings = computeFreshnessWarnings({
    maxPaymentDate: stats.max_payment_date,
    nowMs: now(),
    filterWindowEnd: deps.filterWindowEnd,
  });
  for (const w of stats.freshness_warnings) console.warn(`cmd-explorer cron: ${w}`);

  console.log(
    `cmd-explorer cron: customers ${stats.customers_processed}/${stats.customers_total} ` +
      `(failed ${stats.customers_failed}, budget-skipped ${stats.customers_skipped_budget}); ` +
      `fetched ${stats.rows_fetched}, charge valid ${stats.charge_mapped_valid}, ` +
      `charge skipped ${stats.charge_skipped}, charge inserted ${stats.charge_inserted}; ` +
      `daily inserted ${stats.daily_rows_inserted}, daily replaced ${stats.daily_rows_deleted}`,
  );

  return stats;
}
