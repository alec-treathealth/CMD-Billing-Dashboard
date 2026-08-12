/**
 * The pipeline tick: read state, run the next DUE stage, advance state, return.
 *
 * WHY A TICK AND NOT AN ORCHESTRATOR ROUTE. A single route running all five stages sequentially
 * would be strictly worse than today's schedule. Vercel's function ceiling is 300s; cmd-census alone
 * has been measured at 213.8s and both explorers are UNMEASURED against that same ceiling. One
 * function driving the chain gets platform-killed mid-chain on a heavy hour, and the stages it never
 * reached leave no trace — a silent partial run, which is exactly the failure the current staggered
 * crons do not have. So the tick runs a BOUNDED slice of the pipeline and returns; the next tick
 * continues from durable state. The chain lives in the database, not in a call stack.
 *
 * WHAT ONE TICK DOES:
 *   1. Take the lease (collections.pipeline_lock) — or return immediately if another tick holds it.
 *   2. Read collections.pipeline_state.
 *   3. Loop: plan (pure, see etlStages.planTick) -> run the next due stage -> advance state.
 *      Keep going while the wall-clock budget allows; the FIRST stage always runs.
 *   4. Release the lease and report every stage's verdict, including why each held stage held.
 *
 * IDEMPOTENT AND HAND-SAFE. A tick that runs nothing is a 200 with an empty `ran` list, not an
 * error, so it can be curled repeatedly against a preview deployment without consequence — which
 * matters because Vercel crons fire only on production, and that is the reason none of this is
 * currently testable off main. Every stage it invokes is already idempotent by construction (the
 * explorers upsert ON CONFLICT (row_fingerprint), the census UPSERTs per charge, the rollup refresh
 * is unconditional), so a double-invocation costs time, never correctness.
 *
 * STATE WRITES ARE FATAL, UNLIKE etl_run's. pipeline_state is not observability — it is the
 * scheduling truth, and a tick that cannot record "this stage ran" would re-run stages against the
 * one-report-at-a-time CMD partner slot. If a state write fails, the tick fails loudly and the lease
 * lapses on its own. (etlRun.ts takes the opposite posture, for the reasons in its header.)
 *
 * A STAGE LEFT AT status='running' means the tick was platform-killed while it was in flight. Its
 * dependents correctly see no new last_ok_at and hold; the stage itself is picked up again by the
 * heartbeat once intervalMs has elapsed since last_run_at. That self-heals without a reaper, and the
 * stranded row stays visible in both pipeline_state and etl_run (status='running', finished_at NULL).
 *
 * PHI DISCIPLINE: nothing here touches PHI — stage names are literals, and the report carries
 * counts, timestamps and skip reasons only.
 */
import type { Db } from './db.js';
import { CMD_PIPELINE, CMD_STAGES, planTick, type EtlStage, type StagePlan, type StageState } from './etlStages.js';

/** Default wall-clock the tick may spend starting new stages. Under the 300s function ceiling. */
export const DEFAULT_TICK_BUDGET_MS = 200_000;
/** Default lease length. Longer than the budget so a slow final stage cannot lose its own lock. */
export const DEFAULT_LEASE_MS = 290_000;

export interface StageOutcome {
  stage: string;
  status: number;
  ok: boolean;
  durationMs: number;
  runId: number | null;
}

export interface TickReport {
  ok: boolean;
  pipeline: string;
  /** 'ran' (did work or legitimately had nothing to do) or 'locked' (another tick holds the lease). */
  disposition: 'ran' | 'locked';
  ran: StageOutcome[];
  /** Every stage's verdict from the FINAL plan — so a held stage is always reported, never silent. */
  held: StagePlan[];
  elapsedMs: number;
  budgetMs: number;
}

export interface PipelineTickDeps {
  /** Least-privilege writer pool (cmd_rollup_writer) — owns lock, state and etl_run writes. */
  db: Db;
  /**
   * Invoke one stage. Wired in the composition root to the SAME handler the standalone cron route
   * calls, so the tick cannot drift from what the cron does. Returns the handler's HTTP result plus
   * the etl_run row id its instrumentation wrote.
   */
  runStage: (stage: string) => Promise<{ status: number; body: unknown; runId: number | null }>;
  stages?: readonly EtlStage[];
  pipeline?: string;
  budgetMs?: number;
  leaseMs?: number;
  /** Who is driving: 'cron' (the scheduled tick) or 'manual' (a hand-curled one). Non-PHI. */
  holder?: string;
  /** Wall-clock now; injectable for tests. Default () => new Date(). */
  now?: () => Date;
}

export async function runPipelineTick(deps: PipelineTickDeps): Promise<TickReport> {
  const db = deps.db;
  const stages = deps.stages ?? CMD_STAGES;
  const pipeline = deps.pipeline ?? CMD_PIPELINE;
  const budgetMs = deps.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const holder = deps.holder ?? 'cron';
  const now = deps.now ?? (() => new Date());

  const startedMs = now().getTime();
  const elapsed = () => now().getTime() - startedMs;

  // 1. Lease. A conditional upsert: the DO UPDATE fires only when the existing lease is free or
  //    lapsed, so two concurrent ticks cannot both win. Zero rows back == somebody else holds it.
  const lease = await db.query<{ holder: string | null }>(
    `insert into collections.pipeline_lock (pipeline, locked_until, holder, acquired_at)
     values ($1, now() + ($2::bigint * interval '1 millisecond'), $3, now())
     on conflict (pipeline) do update
        set locked_until = excluded.locked_until, holder = excluded.holder, acquired_at = now()
      where collections.pipeline_lock.locked_until is null
         or collections.pipeline_lock.locked_until <= now()
     returning holder`,
    [pipeline, leaseMs, holder],
  );
  if (lease.rows.length === 0) {
    return {
      ok: true,
      pipeline,
      disposition: 'locked',
      ran: [],
      held: [],
      elapsedMs: elapsed(),
      budgetMs,
    };
  }

  const ran: StageOutcome[] = [];
  let held: StagePlan[] = [];
  /**
   * EACH STAGE RUNS AT MOST ONCE PER TICK. Without this the loop can re-select a stage it just
   * finished and spin until the platform kills the function: planTick's heartbeat clause compares
   * `now` against last_run_at, so any condition that leaves last_run_at stale — a state write that
   * matched no row, a clock skew between the app and the database — makes the stage due again
   * immediately. Bounding it here means such a bug shows up as one stage that did not advance,
   * rather than as a tick that burns its whole budget re-running one stage and starves every other.
   * Re-running is also never USEFUL inside a tick: nothing new can have arrived upstream in the
   * milliseconds since the stage closed.
   */
  const alreadyRan = new Set<string>();

  try {
    for (;;) {
      const state = await readState(db, pipeline);
      const plan = planTick({
        stages: stages.filter((s) => !alreadyRan.has(s.stage)),
        state,
        now: now(),
        elapsedMs: elapsed(),
        budgetMs,
        ranAny: ran.length > 0,
      });
      held = plan.plans;
      if (plan.next === null) break;

      const stageName = plan.next;
      alreadyRan.add(stageName);
      const stageStartedMs = now().getTime();

      // Mark running BEFORE the work, so a platform kill leaves a visible in-flight row rather than
      // a stage that looks like it never started.
      await markRunning(db, pipeline, stageName, null);

      let outcome: { status: number; body: unknown; runId: number | null };
      try {
        outcome = await deps.runStage(stageName);
      } catch (err) {
        // A stage that THROWS (rather than returning 500) still must not advance its dependents.
        const label = err instanceof Error ? err.message : String(err);
        await markFinished(db, pipeline, stageName, false, label);
        ran.push({
          stage: stageName,
          status: 500,
          ok: false,
          durationMs: now().getTime() - stageStartedMs,
          runId: null,
        });
        continue;
      }

      const ok = outcome.status === 200;
      if (outcome.runId !== null) await stampRunId(db, pipeline, stageName, outcome.runId);
      await markFinished(
        db,
        pipeline,
        stageName,
        ok,
        ok ? null : errorLabelOf(outcome.body, outcome.status),
      );
      ran.push({
        stage: stageName,
        status: outcome.status,
        ok,
        durationMs: now().getTime() - stageStartedMs,
        runId: outcome.runId,
      });
    }
  } finally {
    // Always release, even on a thrown state write — a lease that outlives its tick would stall the
    // pipeline for its full duration for no reason. `holder` scoping means a tick that already lost
    // its lease to an expiry cannot clear somebody else's.
    await releaseLease(db, pipeline, holder);
  }

  return {
    ok: ran.every((r) => r.ok),
    pipeline,
    disposition: 'ran',
    ran,
    held,
    elapsedMs: elapsed(),
    budgetMs,
  };
}

async function readState(db: Db, pipeline: string): Promise<Map<string, StageState>> {
  const res = await db.query<{
    stage: string;
    status: string;
    last_run_at: Date | null;
    last_ok_at: Date | null;
    last_error_label: string | null;
  }>(
    `select stage, status, last_run_at, last_ok_at, last_error_label
       from collections.pipeline_state where pipeline = $1`,
    [pipeline],
  );
  return new Map(res.rows.map((r) => [r.stage, r]));
}

async function markRunning(db: Db, pipeline: string, stage: string, runId: number | null): Promise<void> {
  await db.query(
    `insert into collections.pipeline_state (pipeline, stage, status, last_run_at, last_run_id, updated_at)
     values ($1, $2, 'running', now(), $3, now())
     on conflict (pipeline, stage) do update
        set status = 'running', last_run_at = now(), last_run_id = excluded.last_run_id, updated_at = now()`,
    [pipeline, stage, runId],
  );
}

async function stampRunId(db: Db, pipeline: string, stage: string, runId: number): Promise<void> {
  await db.query(
    `update collections.pipeline_state set last_run_id = $3, updated_at = now()
      where pipeline = $1 and stage = $2`,
    [pipeline, stage, runId],
  );
}

/**
 * Close a stage out. On success last_ok_at moves — and THAT is the edge the completion chain reads,
 * so this single UPDATE is what makes a dependent due. On failure last_ok_at deliberately does NOT
 * move: dependents keep comparing against the older value and stay held.
 */
async function markFinished(
  db: Db,
  pipeline: string,
  stage: string,
  ok: boolean,
  errorLabel: string | null,
): Promise<void> {
  if (ok) {
    await db.query(
      `update collections.pipeline_state
          set status = 'ok', last_ok_at = now(), last_error_label = null, updated_at = now()
        where pipeline = $1 and stage = $2`,
      [pipeline, stage],
    );
    return;
  }
  await db.query(
    `update collections.pipeline_state
        set status = 'error', last_error_label = $3, updated_at = now()
      where pipeline = $1 and stage = $2`,
    [pipeline, stage, errorLabel],
  );
}

async function releaseLease(db: Db, pipeline: string, holder: string): Promise<void> {
  try {
    await db.query(
      `update collections.pipeline_lock set locked_until = null
        where pipeline = $1 and holder = $2`,
      [pipeline, holder],
    );
  } catch (err) {
    // Best-effort: the lease expires on its own, so a failed release costs at most one lease
    // length of delay. Never mask the original error that sent us through `finally`.
    console.error(
      'pipeline-tick: lease release failed (it will expire on its own):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Non-PHI label from a handler's error body. The cron handlers return `{error: 'cron_failed'}`. */
function errorLabelOf(body: unknown, status: number): string {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b['error'] === 'string' ? (b['error'] as string) : `http_${status}`;
}
