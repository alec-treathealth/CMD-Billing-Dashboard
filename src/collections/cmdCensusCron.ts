/**
 * CMD Charge-CENSUS CRON — Feed 2 catch-up loop + run-log lifecycle (Qualify v2 feed series, ②b).
 *
 * WHY: the census (collections.cmd_charge_census) is the openCount DENOMINATOR — the source of truth
 * for charge EXISTENCE across ALL payment states. Like the Explorer cron it pulls the CMD batch report
 * ONCE PER CUSTOMER (CMD scopes by customer == facility), but its target is a SEPARATE saved filter
 * (BXR 10148130 / Indigo 10148129 — a trailing charge census, not a payment-received window) and its
 * write is an UPSERT (one row per (business_entity_id, charge_id)) rather than the append-only log.
 *
 * CATCH-UP MODEL (why this converges instead of timing out): 15 (BXR) / 32 (Indigo) heavy sequential
 * pulls cannot always finish inside one 300s function. So this is a CATCH-UP loop, exactly like the
 * Explorer cron's budget guard PLUS a durable freshness cursor:
 *   - FRESHNESS CURSOR: before pulling customer C, ask cmd_census_run whether C already completed
 *     SUCCESSFULLY within `stalenessMs` (default 24h). Fresh ⇒ skip. So across many invocations the
 *     loop naturally advances to the customers that still need a pull; a full sweep amortizes over
 *     however many runs it takes, and each run re-pulls the whole filter window (self-healing).
 *   - BUDGET GUARD: stop LAUNCHING new customers near the wall-clock deadline; whatever wasn't reached
 *     is simply not-fresh next invocation and gets pulled then (budget-exit-resume).
 *   - NEVER-FINISHED RE-ATTEMPT: freshness requires finished_at IS NOT NULL AND status='ok'. A pull
 *     killed mid-flight by a hard platform timeout leaves its start row with finished_at NULL (and an
 *     errored pull leaves status='error'), so NEITHER counts as fresh — the next run re-pulls it. The
 *     orphan start row stays VISIBLE in the run-log as the "started, never finished" signal (0054 ethos).
 *
 * RUN-LOG LIFECYCLE IS 100% TENANT-SCOPED (0058 constraint): cmd_census_run's writer RLS policies are
 * GUC-scoped, so EVERY run-row write — the freshness read, the START insert (status='running'), and
 * BOTH finish updates (ok / error) — goes through withTenant(writeDb, entityId, …). A run-row write
 * with the GUC unset RAISES (fail-closed, 1-arg current_setting), which is also the proof the lifecycle
 * is tenant-correct: there is no code path that touches cmd_census_run outside a tenant transaction.
 * The START row is its OWN withTenant transaction that commits BEFORE the network pull, so a mid-pull
 * kill leaves a durable finished_at=NULL row (the never-finished signal).
 *
 * PER-CUSTOMER ISOLATION: a customer that throws (network / INVALID CRITERIA / DB) is caught, its run
 * row is closed status='error' with a PHI-SAFE STAGE LABEL only (never a message/URL/criteria/PHI —
 * the message goes to console for ops, mirroring cmdExplorerCron), and the loop continues.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): all PHI encryption happens inside cmdCensus.insertCensusRows
 * (encryptPhi + blind indexes); this module handles COUNTS + STAGE LABELS only. error_label is a fixed
 * token, never derived from row data.
 *
 * LAYERING (§10): transport-agnostic — no next/cache, no env reads, no secrets. The composition root
 * (app/lib/server.ts, Step 3) injects the customer roster, the per-customer fetch, the least-privilege
 * writer pool, the optional row transform (Indigo facility-column alias), the cache-revalidate callback,
 * and the (env-overridable) staleness window.
 */
import { mapCensusRows, insertCensusRows } from './cmdCensus.js';
import { reportColumns } from './cmdExplorer.js';
import { headerMismatchLabel } from './cmdExplorerSeed.js';
import type { CmdReportRow } from './cmdPayer.js';
import type { Db } from './db.js';
import { withTenant } from '../veris/withTenant.js';

/** One CMD customer account to pull (== one facility), carrying its owning tenant. Structurally the
 *  CmdCustomer roster entries (cmdCustomers.ts) — kept as a minimal local interface so the core stays
 *  decoupled from the roster module (mirrors cmdExplorerCron.CmdCustomerTarget). */
export interface CmdCensusTarget {
  customerId: string;
  facilityCode: string;
  /** Owning tenant — stamped on every census row + run row and scoped into every withTenant GUC. */
  businessEntityId: string;
}

/** Default freshness window: a customer whose latest run finished OK within this is skipped (24h). */
const DEFAULT_STALENESS_MS = 86_400_000;
/** Default wall-clock budget before the loop stops LAUNCHING new customers (ms). Mirrors the Explorer
 *  cron's headroom under the 300s function; unreached customers catch up next invocation. */
const DEFAULT_BUDGET_MS = 210_000;

export interface CmdCensusCronDeps {
  /** The CMD customer accounts to loop (one census-filter pull each). */
  customers: ReadonlyArray<CmdCensusTarget>;
  /** Fetch the live CMD census-report rows for ONE customer. In prod: cmdReportRows(censusConfigFor(id)). */
  fetchRows: (customerId: string) => Promise<CmdReportRow[]>;
  /** Least-privilege writer pool (cmd_rollup_writer), injected by the composition root. */
  writeDb: Db;
  /** Optional row transform applied to a customer's fetched rows BEFORE mapping. Indigo passes
   *  aliasIndigoFacilityColumn (Customer Name → Facility Name); BXR omits it (identity). */
  transformRows?: (rows: CmdReportRow[]) => CmdReportRow[];
  /** Bust the Qualify cache after a successful pass. In prod: () => revalidateTag('qualify'). */
  revalidate?: () => void | Promise<void>;
  /** Monotonic clock for the wall-clock guard (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Wall-clock budget before new customers stop launching. Default 210s. */
  budgetMs?: number;
  /** Freshness window (ms): a customer whose latest run finished OK within this is skipped. Default 24h.
   *  Env-overridable at the route (Step 3) so a manual re-pull can force staleness to 0. */
  stalenessMs?: number;
  /**
   * HEADER CONTRACT — the exact column-name set the census report must project (order irrelevant).
   * Checked on the RAW fetch, before transformRows / mapCensusRows / insertCensusRows, so a shape
   * change can never reach the upsert's `do update set … = excluded.…` and null out live rows.
   * Omit to disable (Indigo runs unguarded until its own set is pinned).
   */
  expectedColumns?: readonly string[];
}

/** Non-PHI summary of a census cron run — safe to log and return to the (authed) caller. */
export interface CmdCensusCronStats {
  customers_total: number;
  /** Customers pulled + upserted successfully this run. */
  customers_processed: number;
  /** Customers that threw (network / INVALID CRITERIA / DB) — isolated, run continues. */
  customers_failed: number;
  /** Customers not attempted because the wall-clock budget was exhausted. */
  customers_skipped_budget: number;
  /** Customers skipped because a prior run completed OK inside the freshness window. */
  customers_skipped_fresh: number;
  /** Census rows pulled from the live CMD reports (post-transform, all processed customers). */
  rows_fetched: number;
  /** Distinct charges upserted (rows_new + rows_refreshed). */
  census_upserted: number;
  /** Charges freshly INSERTed (first sighting). */
  rows_new: number;
  /** Charges that DO-UPDATEd an existing census row (re-sighting). */
  rows_refreshed: number;
  /** Required-field skips (charge_id / patient_name missing), all customers. Counts only. */
  census_skipped: number;
  /** Skip counts by PHI-safe field label (charge_id: missing / patient_name: missing). */
  skips_by_label: Record<string, number>;
}

/** Stage label stored on a failed run row — LABEL ONLY (0058: never a message / URL / criteria / PHI).
 *  'contract_failed' = the pull succeeded but the report's COLUMN SET did not match the expected
 *  projection, so it was refused before any upsert. Safe to persist: error_label is plain nullable
 *  text with no CHECK constraint (verified against the live schema), and the label carries no PHI. */
type CensusFailStage = 'fetch_failed' | 'contract_failed' | 'write_failed';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Freshness read — TENANT-SCOPED. Has customer C completed SUCCESSFULLY within `stalenessMs`? The
 *  predicate REQUIRES finished_at IS NOT NULL AND status='ok': a running-but-never-finished row (hard
 *  timeout) or an errored row is therefore NOT fresh and gets re-pulled. */
async function isCustomerFresh(
  db: Db,
  entityId: string,
  customerId: string,
  stalenessMs: number,
): Promise<boolean> {
  return withTenant(db, entityId, async (client) => {
    const res = await client.query<{ fresh: boolean }>(
      `select exists (
         select 1 from collections.cmd_census_run
          where customer_id = $1
            and finished_at is not null
            and status = 'ok'
            and started_at >= now() - make_interval(secs => $2)
       ) as fresh`,
      [customerId, stalenessMs / 1000],
    );
    return res.rows[0]?.fresh === true;
  });
}

/** Durable START row — its OWN withTenant transaction, committed BEFORE the network pull, so a mid-pull
 *  kill leaves a finished_at=NULL row (the never-finished signal). Returns the new run id. */
async function startCensusRun(db: Db, entityId: string, customerId: string): Promise<number> {
  return withTenant(db, entityId, async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into collections.cmd_census_run (business_entity_id, customer_id, status)
         values ($1, $2, 'running')
       returning id`,
      [entityId, customerId],
    );
    return Number(res.rows[0]!.id);
  });
}

/** Close a run row OK with the non-PHI counts — TENANT-SCOPED (RLS USING scopes the row to the GUC). */
async function finishCensusRunOk(
  db: Db,
  entityId: string,
  runId: number,
  counts: { rowsSeen: number; rowsNew: number; rowsRefreshed: number },
): Promise<void> {
  await withTenant(db, entityId, (client) =>
    client.query(
      `update collections.cmd_census_run
          set finished_at = now(), status = 'ok',
              rows_seen = $2, rows_new = $3, rows_refreshed = $4
        where id = $1`,
      [runId, counts.rowsSeen, counts.rowsNew, counts.rowsRefreshed],
    ),
  );
}

/** Close a run row ERROR with a PHI-safe STAGE LABEL only — TENANT-SCOPED. */
async function finishCensusRunError(
  db: Db,
  entityId: string,
  runId: number,
  stage: CensusFailStage,
): Promise<void> {
  await withTenant(db, entityId, (client) =>
    client.query(
      `update collections.cmd_census_run
          set finished_at = now(), status = 'error', error_label = $2
        where id = $1`,
      [runId, stage],
    ),
  );
}

/**
 * Loop the CMD customer accounts, pulling the census filter for each not-fresh customer and UPSERTing
 * its charges into cmd_charge_census, recording every attempt in cmd_census_run. Budget-guarded (stops
 * launching new customers near the deadline) and freshness-gated (skips customers a prior run already
 * completed OK). Per-customer failures are isolated + recorded. Revalidates the Qualify cache when
 * anything was processed. Returns non-PHI stats only.
 */
export async function cmdCensusCron(deps: CmdCensusCronDeps): Promise<CmdCensusCronStats> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const stalenessMs = deps.stalenessMs ?? DEFAULT_STALENESS_MS;
  const started = now();

  const stats: CmdCensusCronStats = {
    customers_total: deps.customers.length,
    customers_processed: 0,
    customers_failed: 0,
    customers_skipped_budget: 0,
    customers_skipped_fresh: 0,
    rows_fetched: 0,
    census_upserted: 0,
    rows_new: 0,
    rows_refreshed: 0,
    census_skipped: 0,
    skips_by_label: {},
  };

  for (const target of deps.customers) {
    const { customerId, facilityCode, businessEntityId: entityId } = target;

    // Budget guard: stop LAUNCHING new customers near the deadline (never mid-customer). Skipped
    // customers wrote no run row, so they are simply not-fresh next invocation (budget-exit-resume).
    if (now() - started > budgetMs) {
      stats.customers_skipped_budget += 1;
      continue;
    }

    // Freshness cursor — a DB failure here is a per-customer failure (no run row to close yet).
    try {
      if (await isCustomerFresh(deps.writeDb, entityId, customerId, stalenessMs)) {
        stats.customers_skipped_fresh += 1;
        continue;
      }
    } catch (err) {
      stats.customers_failed += 1;
      console.error(`cmd-census cron: customer ${customerId} (${facilityCode}) freshness check failed: ${errMessage(err)}`);
      continue;
    }

    // Durable start row FIRST (own committed txn). If even this fails, count + move on (no runId to close).
    let runId: number;
    try {
      runId = await startCensusRun(deps.writeDb, entityId, customerId);
    } catch (err) {
      stats.customers_failed += 1;
      console.error(`cmd-census cron: customer ${customerId} (${facilityCode}) run-start failed: ${errMessage(err)}`);
      continue;
    }

    // Pull → transform → map → upsert. Stage tracks which side failed for the PHI-safe error label.
    let stage: CensusFailStage = 'fetch_failed';
    try {
      const fetched = await deps.fetchRows(customerId);

      // ── HEADER CONTRACT — before the transform, the map, and the upsert. ─────────────
      // The census has no DELETE, but insertCensusRows upserts with
      //   on conflict (business_entity_id, charge_id) do update set <REFRESH_COLS> = excluded.<c>
      // so a report whose columns were renamed would OVERWRITE existing good values with NULLs on
      // every matched row. Rows survive; their contents do not. Refusing here leaves the census
      // exactly as it was.
      // fetched.length > 0 is REQUIRED — see the same guard in cmdExplorerCron: an empty pull has
      // no header to inspect and would report every expected column as missing, failing a healthy
      // customer. An empty pull maps to zero census rows and upserts nothing, so there is nothing
      // to protect.
      if (deps.expectedColumns !== undefined && fetched.length > 0) {
        const mismatch = headerMismatchLabel(reportColumns(fetched), deps.expectedColumns);
        if (mismatch !== null) {
          stage = 'contract_failed';
          throw new Error(mismatch);
        }
      }

      stage = 'write_failed'; // fetch succeeded; anything past here (transform/map/upsert) is a write-side failure
      const rows = deps.transformRows ? deps.transformRows(fetched) : fetched;
      stats.rows_fetched += rows.length;

      const { rows: censusRows, skipsByLabel } = mapCensusRows(rows);
      for (const [label, n] of skipsByLabel) {
        stats.skips_by_label[label] = (stats.skips_by_label[label] ?? 0) + n;
        stats.census_skipped += n;
      }

      const upsert = await insertCensusRows(deps.writeDb, censusRows, entityId, runId);
      stats.rows_new += upsert.inserted;
      stats.rows_refreshed += upsert.refreshed;
      stats.census_upserted += upsert.inserted + upsert.refreshed;

      await finishCensusRunOk(deps.writeDb, entityId, runId, {
        rowsSeen: rows.length,
        rowsNew: upsert.inserted,
        rowsRefreshed: upsert.refreshed,
      });
      stats.customers_processed += 1;
    } catch (err) {
      stats.customers_failed += 1;
      console.error(`cmd-census cron: customer ${customerId} (${facilityCode}) ${stage}: ${errMessage(err)}`);
      // Record the failure on the run row (best-effort; own txn; PHI-safe stage label only). If THIS
      // write fails too, log it but keep the original error's console line above — never mask the cause.
      try {
        await finishCensusRunError(deps.writeDb, entityId, runId, stage);
      } catch (recordErr) {
        console.error(`cmd-census cron: failed to record error run row for ${customerId}: ${errMessage(recordErr)}`);
      }
    }
  }

  if (stats.customers_processed > 0 && deps.revalidate) await deps.revalidate();

  console.log(
    `cmd-census cron: customers ${stats.customers_processed}/${stats.customers_total} ` +
      `(failed ${stats.customers_failed}, budget-skipped ${stats.customers_skipped_budget}, ` +
      `fresh-skipped ${stats.customers_skipped_fresh}); fetched ${stats.rows_fetched}, ` +
      `upserted ${stats.census_upserted} (new ${stats.rows_new}, refreshed ${stats.rows_refreshed}), ` +
      `skipped ${stats.census_skipped}`,
  );

  return stats;
}
