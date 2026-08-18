/**
 * collections.etl_run — the shared stage-grain run log (migration 0099).
 *
 * WHY IT EXISTS: cmd-explorer and indigo-explorer have NO run log at all. They are the two stages a
 * completion-chained pipeline most wants to speed up and the only two whose duration nobody has ever
 * measured — so the scheduler change is gated behind instrumenting them first. cmd_census_run and
 * rollup_refresh_run keep being written unchanged; this is a third, uniform grain, not a migration
 * of either (0099's header has the full reasoning).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FAIL-SOFT IS THE LOAD-BEARING DECISION HERE. Every write in this module swallows its own errors.
 *
 * Two reasons, and the first is not hypothetical:
 *
 *   1. Merging a migration in a PR does NOT apply it to production (CLAUDE.md). Between this code
 *      deploying and 0099 being applied by hand, every INSERT here raises 42P01 undefined_table. If
 *      that propagated, this PR would take down all five production CMD crons — including the
 *      hourly collections ingest — the moment it merged. An observability table must never be able
 *      to do that.
 *   2. Even fully applied, a run-log failure is not an ingest failure. The stage's real work either
 *      happened or it didn't; losing the timing row is a measurement gap, not a data defect.
 *
 * THIS IS THE OPPOSITE POSTURE TO handleQualifyRatingHistory, on purpose, and the difference is
 * worth stating because the rule there reads like a general one. That path deliberately does NOT
 * blanket-catch, because a swallowed outage would bake context-free ratings into PERMANENT history
 * — the catch would corrupt the DATA. Nothing here feeds data: etl_run rows are pure observation,
 * read by humans and by the tick's scheduling. Failing loud would trade a real outage for a missing
 * measurement. Do not "harden" this by rethrowing.
 *
 * The one thing fail-soft must not do is fail SILENTLY, so every swallow logs, and an unapplied
 * migration logs a distinct line so it is never mistaken for a live outage.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * DURABILITY MODEL, copied from refreshChargeRollup.ts because it has already proven itself: the
 * start row is INSERTed FIRST as its own autocommit statement (Supavisor transaction pooler, 6543 —
 * one statement per transaction, so a returned INSERT is already committed). Only then does the work
 * run. A hard platform kill (maxDuration) leaves the row at status='running' with finished_at NULL —
 * the "started but never finished" signal, which is the one thing a write-once-at-the-end log can
 * never show you.
 *
 * PHI DISCIPLINE: nothing here touches PHI. Stage names are literals, counts are non-PHI, and
 * error_label carries HTTP/driver/config MESSAGES — the stages fail on network, INVALID CRITERIA and
 * permissions, none of which echo row data. Do not widen error_label to carry a stage's payload.
 *
 * SECURITY: runs as the least-privilege cmd_rollup_writer, which 0099 grants SELECT/INSERT/UPDATE
 * and deliberately NOT DELETE.
 */
import type { Db } from './db.js';

/** Postgres SQLSTATE for "relation does not exist" — 0099 not applied yet. */
const UNDEFINED_TABLE = '42P01';

export type EtlRunStatus = 'ok' | 'error' | 'skipped';

export interface EtlRunClose {
  status: EtlRunStatus;
  durationMs: number;
  /** Non-PHI count the stage reported (rows fetched from CMD, etc). Null when it reports none. */
  rowsTouched?: number | null;
  /** Short label or error MESSAGE. Never PHI. */
  errorLabel?: string | null;
}

function isUndefinedTable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNDEFINED_TABLE;
}

function swallow(what: string, err: unknown): void {
  if (isUndefinedTable(err)) {
    // Distinct line: this is the expected state between merge and apply_migration, NOT an outage.
    console.warn(`etl_run: ${what} skipped — collections.etl_run does not exist (migration 0099 not applied).`);
    return;
  }
  console.error(`etl_run: ${what} failed (stage work unaffected):`, err instanceof Error ? err.message : String(err));
}

/**
 * Insert the durable start row. Returns its id, or null if the log is unavailable — callers treat
 * null as "carry on without logging", never as an error.
 */
export async function startEtlRun(
  db: Db,
  stage: string,
  triggeredBy: string,
): Promise<number | null> {
  try {
    const res = await db.query<{ id: string }>(
      `insert into collections.etl_run (stage, triggered_by) values ($1, $2) returning id`,
      [stage, triggeredBy],
    );
    // int8 comes back from node-pg as a STRING even though the driver types it loosely; Number() it
    // once here so no caller ever compares a string id.
    const raw = res.rows[0]?.id;
    return raw == null ? null : Number(raw);
  } catch (err) {
    swallow(`start row for stage '${stage}'`, err);
    return null;
  }
}

/** Close out a run row. No-op when runId is null (the log was unavailable at start). */
export async function finishEtlRun(db: Db, runId: number | null, close: EtlRunClose): Promise<void> {
  if (runId === null) return;
  try {
    await db.query(
      `update collections.etl_run
          set finished_at = now(), duration_ms = $1, status = $2, rows_touched = $3, error_label = $4
        where id = $5`,
      [close.durationMs, close.status, close.rowsTouched ?? null, close.errorLabel ?? null, runId],
    );
  } catch (err) {
    swallow(`close-out for run ${runId}`, err);
  }
}

export interface EtlRunOptions<T> {
  db: Db;
  stage: string;
  /** What kicked this off: 'cron' (a standalone Vercel entry), 'tick', or 'manual'. */
  triggeredBy: string;
  /** Monotonic clock (ms); injectable for tests. Default Date.now. */
  now?: () => number;
  /**
   * Classify the stage's OWN return value. Required because the five cron handlers CATCH their own
   * failures and return `{status: 500}` rather than throwing — so a thrown-error check alone would
   * record every failed ingest as a success. Defaults to unconditional 'ok' with no count.
   */
  classify?: (result: T) => Omit<EtlRunClose, 'durationMs'>;
  /**
   * Receives the start row's id (or null when the log is unavailable) as soon as it exists. The
   * pipeline tick uses it to stamp pipeline_state.last_run_id, so state links to the exact run row
   * rather than to whichever row a read-back happened to find.
   */
  onRunId?: (runId: number | null) => void;
}

/**
 * Wrap a stage: start row -> run -> close row. TRANSPARENT — the wrapped value is returned
 * unchanged and a thrown error is RETHROWN after being recorded, so wrapping a route cannot alter
 * what that route does. That transparency is the contract this PR rests on: it moves WHEN stages
 * run, never WHAT they do.
 */
export async function withEtlRun<T>(opts: EtlRunOptions<T>, fn: () => Promise<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const runId = await startEtlRun(opts.db, opts.stage, opts.triggeredBy);
  opts.onRunId?.(runId);

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await finishEtlRun(opts.db, runId, {
      status: 'error',
      durationMs: now() - startedMs,
      errorLabel: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const verdict = opts.classify ? opts.classify(result) : { status: 'ok' as const };
  await finishEtlRun(opts.db, runId, { ...verdict, durationMs: now() - startedMs });
  return result;
}

/**
 * Shared classifier for the four CMD cron handlers, which return `{status, body}` and never throw.
 *
 * PARTIAL RUNS COUNT AS SUCCESS, deliberately. Both cron families isolate a failing customer and
 * continue (`customers_failed`), and both amortize a sweep across runs by design — a run that pulled
 * 20 of 24 customers wrote 20 customers' worth of real rows, and holding the rollup on that would
 * mean the rollup almost never runs. The count is surfaced on the row instead, so a creeping failure
 * rate is visible in `error_label` without being mistaken for an outage.
 *
 * ⚠ THE PIPELINE TICK DOES NOT CONSULT THIS FUNCTION. `pipelineTick.ts` decides whether a stage
 * advanced from `outcome.status === 200` alone, so a run this classifier calls an outage still marks
 * `pipeline_state` ok and releases its dependents. That divergence PREDATES this function's outage
 * checks and is left alone on purpose: `pipeline_state` is scheduling truth and `etl_run` is
 * observation, and changing the first changes WHEN production stages run. Do not assume the two
 * agree; teaching the tick to read this belongs in a session scoped to the scheduler.
 */
export function classifyCronResult(result: { status: number; body: unknown }): Omit<EtlRunClose, 'durationMs'> {
  const body = (result.body ?? {}) as Record<string, unknown>;
  const rowsFetched = typeof body['rows_fetched'] === 'number' ? (body['rows_fetched'] as number) : null;

  if (result.status !== 200) {
    const err = typeof body['error'] === 'string' ? (body['error'] as string) : `http_${result.status}`;
    return { status: 'error', rowsTouched: rowsFetched, errorLabel: err };
  }

  const failed = typeof body['customers_failed'] === 'number' ? (body['customers_failed'] as number) : 0;
  /**
   * NULL WHEN THE BODY DOES NOT REPORT IT — not 0. Both diagnoses below turn on `processed === 0`,
   * and defaulting an ABSENT field to 0 would let a body that never mentions the roster at all be
   * diagnosed as "nothing succeeded". Absent means UNKNOWN here, and an unknown must not produce a
   * verdict. (This is the `undefined !== null` trap in its other direction: the coercion, not the
   * comparison.)
   */
  const processed = typeof body['customers_processed'] === 'number' ? (body['customers_processed'] as number) : null;

  /**
   * ⚠ A WHOLE-ROSTER EMPTY PULL IS AN OUTAGE, NOT A SUCCESS — the 2026-08-17 lesson.
   *
   * BXR's explorer ran hourly for ELEVEN HOURS reporting `status: ok`, `customers 15/15 (failed 0)`,
   * `fetched 0`. Nothing threw, nothing 5xx'd, no customer failed: the configured report/filter
   * pairing simply matched no rows, so every pull came back empty and every run looked healthy.
   * The outage was found by a human noticing the dashboard, not by anything in this table.
   *
   * Every customer pulled CLEANLY and the entire roster returned NOTHING is not a state the live
   * pairing produces. It is the signature of a filter whose criteria stopped matching — a spent
   * date window, a LASTMONTH variable on an hourly window, an id repointed to a filter that was
   * never exercised.
   *
   * `processed > 0` is what keeps this honest, and it is doing real work: the census cron
   * legitimately reports `customers_processed: 0` with `rows_fetched: 0` on every run where its
   * 24-hour freshness cursor skipped the whole roster. Those runs are correct and must stay `ok`.
   * `failed === 0` is the second half: a run where customers threw is already described by
   * `partial_customers_failed`, and that diagnosis is more specific than this one.
   *
   * KNOWN BENIGN CASE, and it is deliberately NOT special-cased: both explorer rosters use a
   * ROLLING CURRENT-MONTH window, so the first hours of each month genuinely return zero rows for
   * every customer and will flag here. That is a handful of self-clearing rows in a run log once a
   * month — the correct trade against eleven hours of silence, and "the whole roster returned
   * nothing" is a true statement in that case too. Do not add a date exemption without also adding
   * a way to tell it apart from a dead filter, because on the 1st the two are indistinguishable
   * from inside this function.
   */
  if (rowsFetched === 0 && processed !== null && processed > 0 && failed === 0) {
    return { status: 'error', rowsTouched: 0, errorLabel: 'all_customers_empty' };
  }

  /**
   * ⚠ A RUN IN WHICH NO CUSTOMER COMPLETED IS AN OUTAGE, NOT A PARTIAL SUCCESS.
   *
   * The 2026-08-17 incident had a second half that the check above does not reach. Once BXR's
   * report layout changed, the header contract threw for EVERY customer — `customers 0/15
   * (failed 15), fetched 0` — and this function still returned `status: 'ok'` with the label
   * `partial_customers_failed=15`. The word "partial" was doing the damage: a total failure was
   * being described by the vocabulary of a survivable one, in the very column an operator scans
   * to decide whether anything is wrong.
   *
   * The partial-runs-are-successes rule above is still right and is NOT being narrowed: 14 of 15
   * customers writing real rows is a good run. What it never meant is that ZERO of 15 is. The line
   * between them is `processed === 0` — nothing was written, so there is no partial success to
   * protect, and the next stage will run against data that did not move.
   *
   * `failed > 0` is required, so this cannot fire on the benign roster-skip cases: the census
   * cron's freshness cursor reports `processed: 0, failed: 0` on every run where the whole roster
   * was still fresh, and those runs are correct.
   *
   * NOT COVERED, deliberately: a run where the wall-clock budget skipped the entire roster
   * (`processed: 0, failed: 0, skipped_budget: N`). It is the same shape as the census cursor case
   * from inside here, it is self-healing on the next run by design, and diagnosing it needs a
   * field not every cron body carries. If that becomes worth alarming on, it deserves its own
   * label rather than being folded into this one.
   */
  if (processed === 0 && failed > 0) {
    return { status: 'error', rowsTouched: rowsFetched, errorLabel: `all_customers_failed=${failed}` };
  }

  return {
    status: 'ok',
    rowsTouched: rowsFetched,
    errorLabel: failed > 0 ? `partial_customers_failed=${failed}` : null,
  };
}
