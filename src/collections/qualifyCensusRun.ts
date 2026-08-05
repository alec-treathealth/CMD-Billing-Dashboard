/**
 * Durable run-log wrapper for the monday census sync (migration 0087).
 *
 * WHY THIS EXISTS: /api/cron/qualify-census fails SILENTLY by construction.
 * `runQualifyCensusSync` catches per board and the route returns HTTP 200 with counts, so a dead
 * MONDAY_SECRET_API_KEY yields `200 { boards_total: 2, boards_synced: 0, boards_failed: 2 }` — a
 * success status, an empty-but-present aggregate table, and a Qualify auth-fit factor reading
 * "no data yet" for every facility. That is byte-identical, from the outside, to a facility whose
 * monday board was simply never curated. The only signal was a `console.error`, and Vercel logs
 * are 403-scoped away from this project. This module makes the difference answerable by SELECT.
 *
 * WHY A WRAPPER rather than instrumenting `runQualifyCensusSync` directly: the sync and its route
 * are owned by an in-flight branch (the Qualify v3 work). Wrapping keeps the call-site diff to two
 * lines and leaves the sync's PHI-audited body untouched, so the two changes cannot conflict over
 * the same hunks. It also mirrors the repo's existing shape — `refreshChargeRollup.ts` is likewise
 * a run-logging module wrapping a single operation rather than logic bolted into a route.
 *
 * DURABILITY MODEL (the point, borrowed from refreshChargeRollup.ts): the start row is INSERTed
 * FIRST, as its own autocommit statement, BEFORE any monday I/O. On Supavisor's transaction pooler
 * a returned INSERT is already committed. If a platform timeout kills the function mid-run,
 * neither the success nor the failure UPDATE runs and the row survives with `finished_at IS NULL`
 * — the "started but never finished" signal. A try/catch cannot produce that: a hard kill runs no
 * catch block.
 *
 * FAIL-SOFT, DELIBERATELY: logging is observability, not the job. If 0087 is unapplied or the
 * INSERT is refused, the sync still runs and the route still returns its stats — the failure is
 * reported to the console and `run_id` comes back null. An observability layer that can take the
 * feed down is worse than no observability layer. The inverse (sync throws) still closes the row
 * as 'failed' and rethrows, so a real failure is never swallowed.
 *
 * PHI: none. Counts, timestamps, a status enum, and monday's error MESSAGE truncated to 200 chars
 * — never a response body, never a column value, never an item name. Census GraphQL selections do
 * not request item names at all (see qualifyCensusSync.ts's PHI POSTURE header).
 */
import type pg from 'pg';
import { runQualifyCensusSync } from './qualifyCensusSync.js';
import type { CensusSyncStats } from './qualifyCensusSync.js';
import { conformanceHasGap, type CensusFacilityConfig } from './qualifyCensus.js';

/** Matches the 0087 CHECK constraint. */
export type QualifyCensusRunStatus = 'ok' | 'partial' | 'failed';

/** The 0087 error_label CHECK bound. Messages are truncated here, app-side, to stay inside it. */
export const ERROR_LABEL_MAX = 200;

export interface QualifyCensusRunResult extends CensusSyncStats {
  /** Row id in collections.qualify_census_run, or null if the log write failed (fail-soft). */
  run_id: number | null;
  status: QualifyCensusRunStatus;
  duration_ms: number;
  /** Boards that synced but did not resolve every expected monday column title. */
  conformance_gap_boards: number;
}

/**
 * FACILITIES whose conformance line records something an operator must act on.
 *
 * This is the sync's quietest failure: when `resolveCensusColumns` finds none of the titles, the
 * item fetch is skipped entirely, `aggregateCensusItems([])` returns zeros, and the upsert
 * overwrites a good facility row with those zeros plus a fresh `synced_at` — all while the board
 * counts as synced. Left unrecorded, the run reads a clean 'ok' over silently zeroed data, which is
 * the same indistinguishable-states failure this module exists to end.
 *
 * The predicate now spans four causes, not one (see conformanceHasGap): a missing title, a title
 * that RESOLVED BUT CARRIED NO VALUES, a board whose columns contradict its declared family, and a
 * family <-> care_setting violation. The second is why this needed widening at all: title presence
 * alone reported `conformance_gap_boards: 0` for months against an API-empty LOS formula column.
 */
export function countConformanceGaps(stats: Pick<CensusSyncStats, 'conformance'>): number {
  return stats.conformance.filter(conformanceHasGap).length;
}

export interface QualifyCensusRunDeps {
  /** cmd_rollup_writer connection — the same client the sync upserts through. */
  client: pg.PoolClient;
  /** What kicked this off; stored on the row. Default 'cron'. */
  triggeredBy?: 'cron' | 'manual';
  /** Monotonic clock (ms) for the duration measurement; injectable for tests. Default Date.now. */
  now?: () => number;
  /** The sync itself — injected so tests exercise this module without monday I/O. */
  sync?: (
    client: pg.PoolClient,
    opts?: { facilities?: readonly CensusFacilityConfig[]; today?: string },
  ) => Promise<CensusSyncStats>;
  /** Passed straight through to the sync. */
  opts?: { facilities?: readonly CensusFacilityConfig[]; today?: string };
}

/**
 * Derive the run status from the sync's own counts.
 *
 * 'partial' is the state worth naming: some boards synced and some failed, so the factor keeps
 * working for a few facilities while silently going stale for the rest — the exact failure the
 * console-only posture hid best.
 *
 * A zero-board run (nothing configured) is 'ok', not 'failed': there is nothing to sync and
 * nothing wrong. Calling it 'failed' would page someone over an empty config.
 *
 * A conformance gap also demotes an otherwise-clean run to 'partial'. A board whose column titles
 * stopped resolving still reports itself synced, so without this a renamed monday column reads as
 * a healthy run over zeroed data — see countConformanceGaps.
 */
export function deriveCensusRunStatus(
  stats: Pick<
    CensusSyncStats,
    'boards_total' | 'boards_synced' | 'boards_failed' | 'facilities_failed' | 'conformance'
  >,
): QualifyCensusRunStatus {
  if (stats.boards_total === 0) return 'ok';
  if (stats.boards_synced === 0) return 'failed';
  if (stats.boards_failed > 0) return 'partial';
  // A facility can fail with every board healthy: its upsert threw, or one board of an N:1 set
  // failed so the whole facility was skipped rather than upserted from a partial item set.
  if (stats.facilities_failed > 0) return 'partial';
  if (countConformanceGaps(stats) > 0) return 'partial';
  return 'ok';
}

/** Bound an error message to the 0087 CHECK. Never receives a response body or a column value. */
export function truncateErrorLabel(message: string): string {
  return message.length <= ERROR_LABEL_MAX ? message : `${message.slice(0, ERROR_LABEL_MAX - 1)}…`;
}

/* Exported so the test suite can assert the statements are frozen literals with matching $n arity,
 * rather than regex-sniffing an already-interpolated runtime string (which can never contain '${'
 * and so certifies nothing). Table and column names are fixed literals; only values are bound. */
export const INSERT_START_SQL =
  'insert into collections.qualify_census_run (triggered_by) values ($1) returning id';

export const UPDATE_FINISH_SQL =
  'update collections.qualify_census_run set finished_at = now(), duration_ms = $1, status = $2, ' +
  'boards_total = $3, boards_synced = $4, boards_failed = $5, capacity_mapped = $6, ' +
  'capacity_unmapped_count = $7, conformance_gap_boards = $8, error_label = $9 where id = $10';

/**
 * Run the census sync with a durable run row around it. Returns the sync's stats plus the run id,
 * derived status and duration. Rethrows whatever the sync throws, after recording it.
 */
export async function runQualifyCensusSyncLogged(deps: QualifyCensusRunDeps): Promise<QualifyCensusRunResult> {
  const now = deps.now ?? Date.now;
  const triggeredBy = deps.triggeredBy ?? 'cron';
  const sync = deps.sync ?? runQualifyCensusSync;
  const startedMs = now();

  // 1. Start row FIRST — before any monday I/O — so a platform kill leaves evidence. Fail-soft:
  //    an unapplied 0087 or a refused INSERT must not take the feed down.
  let runId: number | null = null;
  try {
    const res = await deps.client.query<{ id: string }>(INSERT_START_SQL, [triggeredBy]);
    const raw = res.rows[0]?.id;
    runId = raw === undefined ? null : Number(raw);
  } catch (err) {
    console.error(
      `qualify-census: run-log start row failed, continuing unlogged (${err instanceof Error ? err.message : 'error'})`,
    );
  }

  const closeRow = async (
    status: QualifyCensusRunStatus,
    stats: CensusSyncStats,
    errorLabel: string | null,
    durationMs: number,
  ): Promise<void> => {
    if (runId === null) return;
    try {
      await deps.client.query(UPDATE_FINISH_SQL, [
        durationMs,
        status,
        stats.boards_total,
        stats.boards_synced,
        stats.boards_failed,
        stats.capacity_mapped,
        stats.capacity_unmapped.length,
        countConformanceGaps(stats),
        errorLabel,
        runId,
      ]);
    } catch (err) {
      // Best-effort, and NEVER masks the original outcome (the refreshChargeRollup rule).
      console.error(
        `qualify-census: run-log close failed (${err instanceof Error ? err.message : 'error'})`,
      );
    }
  };

  try {
    const stats = await sync(deps.client, deps.opts);
    const durationMs = now() - startedMs;
    const status = deriveCensusRunStatus(stats);
    const gaps = countConformanceGaps(stats);
    // A 'failed' or 'partial' run carries a label even though nothing threw — the per-board catch
    // already swallowed the real messages, so the counts are the honest thing to record. The two
    // causes are named separately: a board that FAILED never wrote, while a board with a
    // conformance gap wrote zeros over good data. Those want different operator responses.
    const errorLabel =
      status === 'ok'
        ? null
        : truncateErrorLabel(
            [
              stats.boards_failed > 0
                ? `${stats.boards_failed} of ${stats.boards_total} board(s) failed; see cron logs for per-board messages`
                : null,
              stats.facilities_failed > 0
                ? `${stats.facilities_failed} of ${stats.facilities_total} facilit(ies) not upserted`
                : null,
              gaps > 0
                ? `${gaps} of ${stats.facilities_total} facilit(ies) synced with a conformance gap (missing or value-empty monday columns, family or care_setting mismatch)`
                : null,
            ]
              .filter((s): s is string => s !== null)
              .join('; '),
          );
    await closeRow(status, stats, errorLabel, durationMs);
    return { ...stats, run_id: runId, status, duration_ms: durationMs, conformance_gap_boards: gaps };
  } catch (err) {
    // The sync threw before/outside the per-board catch — a hard failure (bad client, monday
    // outage on the facility-info path, a bug). Record it, then RETHROW: the route must still 500.
    const durationMs = now() - startedMs;
    const message = err instanceof Error ? err.message : String(err);
    const empty: CensusSyncStats = {
      facilities_total: 0,
      facilities_synced: 0,
      facilities_failed: 0,
      boards_total: 0,
      boards_synced: 0,
      boards_failed: 0,
      conformance: [],
      capacity_mapped: 0,
      capacity_unmapped: [],
      blocked_boards: [],
    };
    await closeRow('failed', empty, truncateErrorLabel(message), durationMs);
    throw err;
  }
}
