/**
 * WHEN THE RANKING INDEX WAS LAST REBUILT — the one freshness question this database can answer
 * honestly, and the two it cannot.
 *
 * Qualify ranks off `collections.cmd_explorer_charge_rollup` (0050), a matview that is invisible to
 * every Qualify query until `/api/cron/refresh-charge-rollup` rebuilds it at :45. `collections.
 * rollup_refresh_run` (0054) is that cron's run-log: one row per attempt, a start row on entry,
 * updated on completion. Measured 2026-08-07 over 7 days: 168 runs, 168 ok, 0 unfinished, duration
 * 84–112s (avg 86s — NOT the "~58s" the cron's own headers claim).
 *
 * ── WHAT THIS ANSWERS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────────────
 * It answers "when was the ranking index last rebuilt". It does NOT answer "when did we last ask
 * CMD": there is no run-log for `cmd-explorer` / `indigo-explorer` at all (the only run tables in
 * the cluster are `cmd_census_run`, `qualify_census_run`, `rollup_refresh_run` and
 * `claims.audit_ingest_run`), and the explorer cron's 210s wall-clock budget silently defers
 * un-pulled customers to the next hour with nothing in the database saying so. So copy driven off
 * this must describe the REBUILD, never the pull.
 *
 * Derived from the schedule + the run-log rather than guessed: BXR pulls at :00 and the rebuild runs
 * at :45, so a BXR row is invisible for 46 min at best and **1h45m** at worst; Indigo (:30) is
 * 17 min / **1h16m**. Both before CMD's own posting lag. "Up to about two hours behind CMD" is the
 * defensible sentence; any single number is not.
 *
 * ── THE TWO COLUMNS THIS QUERY MUST NEVER REACH FOR ─────────────────────────────────────────────
 * Both are one word away, both were measured, and both are wrong in the ALARMING direction:
 *
 *   · `rollup_max_payment_date` — sits in this very row, and reads INTO THE FUTURE.
 *     `FUTURE_PAYMENT_HORIZON_DAYS` is 14 (cmdExplorer.ts), so on 2026-08-07 it read **2026-08-12**.
 *   · `max(ingested_at)` on the rollup — FIRST-SEEN, not last-checked (`ON CONFLICT DO NOTHING`).
 *     Measured 3h25m / 3h54m old across three SUCCESSFUL hourly refreshes, with a 42-hour healthy
 *     gap over a weekend, at a cost of a 20,961-buffer parallel seq scan (~114ms warm).
 *
 * ── GATES ───────────────────────────────────────────────────────────────────────────────────────
 * `claims_reader` holds BOTH — the GRANT (0054:68) and, because RLS is on, a SELECT POLICY
 * (0054:89-90). Verified live as the reader's own privileges, not inferred from the migration text
 * (the 0089 lesson: a grant and a policy are separate gates, and only the grant errors). No
 * migration, no new grant.
 */

/** The run-log, as a fixed identifier. Never interpolated from input. */
export const ROLLUP_REFRESH_RUN = 'collections.rollup_refresh_run';

/**
 * The newest run that FINISHED and reported ok, as a full UTC ISO timestamp. Zero params — this is a
 * global operational fact with no tenant, no identifier and no user input in it (0054 is deliberately
 * NOT tenant-scoped: one `REFRESH MATERIALIZED VIEW CONCURRENTLY` rebuilds both tenants at once).
 *
 * ⚠ `ok is true` AND `finished_at is not null`, not `ok is not false`. 0054's own header: a hard
 * platform timeout kills the function before the completion UPDATE, leaving `ok IS NULL` and
 * `finished_at IS NULL` — and that "started but never finished" state IS the failure signal. A read
 * that accepted it would report the START of a run that never completed as the rebuild time, i.e.
 * would present the one condition the table exists to expose as freshness.
 *
 * ⚠ ORDERED BY `started_at desc`, WHICH IS THE INDEXED COLUMN. 0054 creates
 * `rollup_refresh_run_started_idx (started_at desc)` and nothing on `finished_at`, so ordering by
 * the completion time would sort the whole log to return one row. For an hourly job whose runs take
 * 86s the two orderings agree by construction.
 *
 * Full UTC ISO rather than a formatted local time: rendering in a NAMED timezone is the UI's job and
 * belongs where it can be unit-tested, and a day-grain truncation here would smuggle up to 24h of
 * slack into a sentence whose whole purpose is stating an age (the PR #73 lesson, one loader over).
 */
export function buildRollupRefreshFreshnessQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      `select to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as rebuilt_at ` +
      `from ${ROLLUP_REFRESH_RUN} ` +
      `where ok is true and finished_at is not null ` +
      `order by started_at desc limit 1`,
    params: [],
  };
}
