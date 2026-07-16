/**
 * Dedicated charge-rollup refresh with a durable, queryable run-log.
 *
 * WHY: collections.cmd_explorer_charge_rollup (0050 matview) was going stale silently — the inline
 * best-effort refresh in the ingest loop (cmdExplorerCron) only fired when charge rows were inserted
 * AND competed for the ingest function's wall-clock budget, and any failure was swallowed to a
 * console line reachable only via Vercel logs (403-scoped away from this project). This module is the
 * replacement: the dedicated /api/cron/refresh-charge-rollup route calls it hourly, it refreshes
 * UNCONDITIONALLY (idempotent), and it records EVERY attempt to collections.rollup_refresh_run
 * (0054) so freshness is answerable by SELECT the next morning with zero Vercel access.
 *
 * DURABILITY MODEL (the point of the whole fix): the start row is INSERTed FIRST, as its own
 * autocommit statement (Supavisor transaction pooler, port 6543 — one statement per transaction, so
 * a returned INSERT is already committed). Only then does the ~58s REFRESH ... CONCURRENTLY run. If
 * a hard platform timeout (maxDuration) kills the function mid-refresh, neither the success nor the
 * failure UPDATE runs, leaving a row with ok/finished_at NULL — the "started but never finished"
 * signal. A CAUGHT refresh error is recorded on the SAME row (ok=false + the error MESSAGE) and then
 * RETHROWN, so the route still logs it and returns 500 — never swallowed.
 *
 * OVERLAP: the hourly schedule and the ~58s CONCURRENTLY refresh can overlap (a slow run still
 * going when the next hour fires). This is deliberately NOT prevented and NOT deduped — Postgres
 * serializes concurrent REFRESH MATERIALIZED VIEW CONCURRENTLY on the matview's SHARE UPDATE
 * EXCLUSIVE lock, so a second refresh simply queues behind the first (correct, just slower) and
 * never corrupts the matview. There is no in-flight guard: every run writes its OWN start row
 * unconditionally, so an overlap is plainly VISIBLE in the run-log as an earlier row left
 * ok/finished_at NULL (the still-running or platform-killed prior run) immediately preceding a
 * newer row. That is the intended signal — overlap is RECORDED, not suppressed — and it is exactly
 * what the morning health-check SELECT (order by started_at desc) surfaces: a stale ok IS NULL row
 * sitting ahead of a newer one. No lock-detection machinery is warranted for this.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): touches NO PHI. It issues a parameterless refresh, reads a
 * non-PHI max(payment_received) DATE, and stores timestamps/duration/boolean/date + (on failure) a
 * DB/driver error MESSAGE. The matview projects no ciphertext, and a refresh error string carries no
 * row data.
 *
 * SECURITY: runs as the least-privilege cmd_rollup_writer (CMD_ROLLUP_WRITER_DATABASE_URL) — the
 * role that holds EXECUTE on the 0050 SECURITY-DEFINER refresh function and (0054) SELECT on the
 * matview + INSERT/UPDATE on the run-log. NOT tenant-scoped: a single CONCURRENTLY refresh rebuilds
 * the whole matview across both tenants, so there is no business_entity_id and no tenant GUC —
 * rollup_refresh_run's writer RLS policies are permissive by design (0054).
 */
import type { Db } from './db.js';

export interface RefreshChargeRollupDeps {
  /** Least-privilege writer pool (cmd_rollup_writer). Runs the run-log INSERT/UPDATE, the
   *  SECURITY-DEFINER refresh function, and the freshness read — each as its own autocommit query. */
  db: Db;
  /** What kicked off this run; stored on the row. Default 'cron' (the hourly route). */
  triggeredBy?: 'cron' | 'manual';
  /** Monotonic clock (ms) for the duration measurement; injectable for tests. Default Date.now. */
  now?: () => number;
}

/** Non-PHI summary of a refresh run — safe to log and return to the (authed) caller. */
export interface ChargeRollupRefreshStats {
  /** id of the collections.rollup_refresh_run row written for this attempt. */
  run_id: number;
  /** true on a completed refresh (failures rethrow before this is returned). */
  ok: boolean;
  /** Wall-clock ms from the start-row insert through the freshness read. */
  duration_ms: number;
  /** max(payment_received) in the rollup post-refresh (ISO 'YYYY-MM-DD'), or null if empty. */
  rollup_max_payment_date: string | null;
}

/**
 * Refresh the 0050 charge-grain matview and record the attempt to collections.rollup_refresh_run.
 * Returns non-PHI stats on success; on a caught refresh failure it records ok=false + the message
 * on the same row and RETHROWS (the route surfaces the 500). See the durability model above.
 */
export async function refreshChargeRollup(deps: RefreshChargeRollupDeps): Promise<ChargeRollupRefreshStats> {
  const now = deps.now ?? Date.now;
  const triggeredBy = deps.triggeredBy ?? 'cron';
  const startedMs = now();

  // 1. Durable start row FIRST (own autocommit statement; started_at defaults to now()). This row
  //    survives a mid-refresh platform kill as the ok/finished_at=NULL "started but unfinished" signal.
  const startRes = await deps.db.query<{ id: string }>(
    `insert into collections.rollup_refresh_run (triggered_by) values ($1) returning id`,
    [triggeredBy],
  );
  const runId = Number(startRes.rows[0]!.id);

  try {
    // 2. The refresh itself — SECURITY DEFINER (owner-privileged), CONCURRENTLY (~58s, non-blocking).
    await deps.db.query('select collections.refresh_cmd_explorer_charge_rollup()');

    // 3. Freshness proof: newest payment_received now visible in the rollup (non-PHI date).
    const freshRes = await deps.db.query<{ max_pay: string | null }>(
      `select max(payment_received)::text as max_pay from collections.cmd_explorer_charge_rollup`,
    );
    const maxPay = freshRes.rows[0]?.max_pay ?? null;
    const durationMs = now() - startedMs;

    // 4a. Success: close out the row.
    await deps.db.query(
      `update collections.rollup_refresh_run
          set finished_at = now(), duration_ms = $1, ok = true, rollup_max_payment_date = $2
        where id = $3`,
      [durationMs, maxPay, runId],
    );
    return { run_id: runId, ok: true, duration_ms: durationMs, rollup_max_payment_date: maxPay };
  } catch (err) {
    // 4b. Caught failure: record it on the SAME row, then rethrow (not swallowed). The failure-record
    //     write is best-effort — if IT fails too, keep the ORIGINAL error rather than masking it.
    const durationMs = now() - startedMs;
    const message = err instanceof Error ? err.message : String(err);
    try {
      await deps.db.query(
        `update collections.rollup_refresh_run
            set finished_at = now(), duration_ms = $1, ok = false, error = $2
          where id = $3`,
        [durationMs, message, runId],
      );
    } catch (recordErr) {
      console.error(
        'refresh-charge-rollup: failed to record the failure row (original error rethrown):',
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      );
    }
    throw err;
  }
}
