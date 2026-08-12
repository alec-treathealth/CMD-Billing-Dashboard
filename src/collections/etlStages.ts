/**
 * The CMD ETL stage registry and the pure scheduling decision that drives the pipeline tick.
 *
 * WHAT THIS REPLACES: five cron entries pinned to clock minutes (:00 / :15 / :30 / :35 / :45) that
 * make freshness a function of the schedule instead of the work. Measured 2026-08-12, the work is
 * roughly 7 minutes spread across a 100-minute window (see 0099's header for the numbers). A stage
 * here becomes due the moment its inputs are newer than its last success — not when the clock
 * reaches its slot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO DIFFERENT CONSTRAINTS, MODELLED SEPARATELY — this is the part worth reading.
 *
 * 1. DATA DEPENDENCY (`dependsOn`). Verified 2026-08-12 by reading what each stage touches, NOT by
 *    reading the cron schedule:
 *
 *      - collections.cmd_explorer_charge_rollup is defined over collections.cmd_explorer_rows and
 *        nothing else (pg_get_viewdef), and refresh_cmd_explorer_charge_rollup() refreshes that
 *        matview plus cmd_explorer_filter_options, which is itself defined over the rollup.
 *      - Both explorer stages write cmd_explorer_rows.
 *      - Both census stages write collections.cmd_charge_census (cmdCensus.ts) and read nothing an
 *        explorer produces. No stage in this pipeline reads cmd_charge_census — its consumers are
 *        arAging.ts and the live Qualify surface.
 *
 *    So the real graph is a fork, not the linear chain the schedule implies:
 *
 *        cmd-explorer  ─┐
 *                       ├──> refresh-charge-rollup
 *        indigo-explorer┘
 *
 *        cmd-census      (independent)
 *        indigo-census   (independent)
 *
 *    Encoding the schedule order as the DAG would have put a stage measured at 214 seconds
 *    (cmd-census) in the rollup's critical path for no data reason whatsoever.
 *
 * 2. RESOURCE MUTEX (`usesCmdApi`). CMD allows ONE report at a time per partner, so the four
 *    CMD-calling stages must not overlap each other. This is NOT a dependency — it constrains
 *    concurrency, not order. The tick satisfies it structurally by running stages sequentially in
 *    one function, and the pipeline lease (0099) extends that across ticks. It is also what the
 *    :41–:59 quiet window protects: that band is reserved for live CMD probe work, so CMD stages
 *    stand down inside it while DB-only stages (the rollup) keep running — which is exactly why
 *    refresh-charge-rollup has legitimately been scheduled at :45 all along.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Namespace for this stage set. `pipeline_state` is keyed (pipeline, stage). */
export const CMD_PIPELINE = 'cmd';

export interface EtlStage {
  /** Stage id — matches the cron route name and `etl_run.stage`. */
  readonly stage: string;
  /**
   * DATA dependencies only: this stage reads what those stages write. Emphatically NOT "runs after
   * on the clock". See the header — the census stages depend on nothing here.
   */
  readonly dependsOn: readonly string[];
  /**
   * Does this stage call the CMD partner API? Drives the :41–:59 quiet-window stand-down and
   * documents the one-report-at-a-time mutex. The rollup is pure DB and is false.
   */
  readonly usesCmdApi: boolean;
  /**
   * Heartbeat cadence. A stage runs on this interval even when no upstream moved, which preserves
   * today's behaviour for the root stages (they poll CMD; nothing "completes" upstream of them) and
   * keeps the rollup refreshing on a quiet hour. Matches the current hourly schedules.
   */
  readonly intervalMs: number;
  /**
   * Conservative wall-clock reservation. The tick will not START this stage unless the reservation
   * still fits in the remaining budget — with one exception (see planTick): the first stage of a
   * tick always runs, otherwise a stage whose reserve exceeds the budget could never run at all.
   *
   * THESE ARE PESSIMISTIC ON PURPOSE AND ARE MEANT TO BE RETUNED FROM etl_run:
   *   - cmd-census      240_000 — measured max 213.8s over 7 days (24 customers / 42,458 rows).
   *   - indigo-census   150_000 — measured max 121.2s.
   *   - rollup          150_000 — measured 81.6–117.5s over 168 runs, avg 98.4s.
   *   - both explorers  300_000 — UNKNOWN. No run log has ever existed for them, so they are
   *                     reserved at the full function ceiling. Guessing lower would be inventing a
   *                     number, and this is the specific gap etl_run was built to close. Once a day
   *                     of rows exists, set these from p95 and the tick will start packing stages.
   */
  readonly reserveMs: number;
}

const HOURLY = 60 * 60 * 1000;

/**
 * Declaration order IS the execution priority, and it is a valid topological order (every stage
 * appears after its dependencies). The two explorers lead so the rollup can chain off them as soon
 * as both land; the census stages sit between them and the rollup because they contend for the same
 * CMD slot, not because the rollup needs them.
 */
export const CMD_STAGES: readonly EtlStage[] = [
  { stage: 'cmd-explorer', dependsOn: [], usesCmdApi: true, intervalMs: HOURLY, reserveMs: 300_000 },
  { stage: 'indigo-explorer', dependsOn: [], usesCmdApi: true, intervalMs: HOURLY, reserveMs: 300_000 },
  { stage: 'cmd-census', dependsOn: [], usesCmdApi: true, intervalMs: HOURLY, reserveMs: 240_000 },
  { stage: 'indigo-census', dependsOn: [], usesCmdApi: true, intervalMs: HOURLY, reserveMs: 150_000 },
  {
    stage: 'refresh-charge-rollup',
    dependsOn: ['cmd-explorer', 'indigo-explorer'],
    usesCmdApi: false,
    intervalMs: HOURLY,
    reserveMs: 150_000,
  },
];

/** A pipeline_state row, as the tick reads it. */
export interface StageState {
  stage: string;
  status: string;
  last_run_at: Date | null;
  last_ok_at: Date | null;
  last_error_label: string | null;
}

export type SkipReason =
  /** Interval has not elapsed and no dependency has produced anything new. */
  | 'not_due'
  /** A dependency's last attempt ENDED IN ERROR. Dependents are held, never silently advanced. */
  | 'blocked_upstream_error'
  /** A dependency has never completed successfully, so there is nothing downstream to consume. */
  | 'waiting_on_upstream'
  /** CMD stage inside the reserved :41–:59 CMD quiet window. */
  | 'cmd_quiet_window'
  /** Would not fit in the tick's remaining wall-clock budget; the next tick picks it up. */
  | 'budget_exhausted';

export interface StagePlan {
  stage: string;
  runnable: boolean;
  reason?: SkipReason;
  /** Which dependency caused a blocked/waiting verdict — for the tick's report. */
  blockedBy?: string;
}

/**
 * The reserved CMD quiet window: minutes 41–59 of any hour, UTC (Vercel Cron runs in UTC).
 *
 * The band is held for live CMD probe work, so it binds stages that CONTEND FOR THE CMD PARTNER
 * SLOT — not every stage that happens to run in those minutes. That is the practised reading, not a
 * softening of the rule: refresh-charge-rollup (:45, pure DB) and upcoming-overrides (:55, Google
 * Sheets) have both sat inside it legitimately all along.
 */
export function inCmdQuietWindow(now: Date): boolean {
  const minute = now.getUTCMinutes();
  return minute >= 41 && minute <= 59;
}

export interface PlanInput {
  stages: readonly EtlStage[];
  /** Current pipeline_state, keyed by stage. A missing entry is treated as never-run. */
  state: ReadonlyMap<string, StageState>;
  now: Date;
  /** Wall-clock already spent in this tick. */
  elapsedMs: number;
  /** Total wall-clock the tick may spend starting new stages. */
  budgetMs: number;
  /** Has this tick already run a stage? The first stage ignores the reserve check. */
  ranAny: boolean;
}

export interface TickPlan {
  /** The one stage to run now, or null if nothing is runnable. */
  next: string | null;
  /** Every stage's verdict — this is what the tick reports, so a hold is never silent. */
  plans: StagePlan[];
}

/**
 * Decide what the tick should do next. Pure — no clock, no DB, no I/O.
 *
 * DUE-NESS, in order of precedence:
 *   1. A dependency's last attempt errored          -> blocked_upstream_error (reported, held)
 *   2. A dependency has never succeeded             -> waiting_on_upstream
 *   3. CMD stage inside :41–:59                     -> cmd_quiet_window
 *   4. Never succeeded, OR every dependency has a last_ok_at NEWER than this stage's own
 *      (the completion chain), OR the heartbeat interval has elapsed since the last ATTEMPT
 *                                                   -> due
 *   5. Otherwise                                    -> not_due
 *   6. Due but the reserve does not fit             -> budget_exhausted
 *
 * Rule 4's middle clause is the whole point: `every` (not `some`) means the rollup fires ONCE after
 * the last explorer completes rather than twice, and it fires immediately rather than at :45.
 *
 * Rule 1 is deliberately strict — a failed stage HOLDS its dependents rather than letting them run
 * on stale inputs and record a success. The heartbeat in rule 4 cannot override it, because rules
 * 1–3 are evaluated first.
 */
export function planTick(input: PlanInput): TickPlan {
  const { stages, state, now, elapsedMs, budgetMs, ranAny } = input;
  const plans: StagePlan[] = [];
  let next: string | null = null;

  for (const stage of stages) {
    const mine = state.get(stage.stage);
    const plan = evaluate(stage, mine, state, now);

    if (plan.runnable && next === null) {
      // Budget gate. The FIRST stage of a tick is exempt: with a 200s budget and a 300s reserve on
      // the unmeasured explorers, a strict check would make them permanently unrunnable. Running one
      // stage per tick is exactly the exposure the standalone cron already has today (each stage
      // carries its own internal wall-clock guard calibrated to its own function), so this is not a
      // regression — it just declines to stack a second stage on top of an unknown one.
      if (!ranAny || elapsedMs + stage.reserveMs <= budgetMs) {
        next = stage.stage;
      } else {
        plans.push({ stage: stage.stage, runnable: false, reason: 'budget_exhausted' });
        continue;
      }
    }
    plans.push(plan);
  }

  return { next, plans };
}

function evaluate(
  stage: EtlStage,
  mine: StageState | undefined,
  state: ReadonlyMap<string, StageState>,
  now: Date,
): StagePlan {
  // 1 + 2: dependency health, before anything else. A held stage is REPORTED, never advanced.
  for (const depName of stage.dependsOn) {
    const dep = state.get(depName);
    if (dep?.status === 'error') {
      return { stage: stage.stage, runnable: false, reason: 'blocked_upstream_error', blockedBy: depName };
    }
    if (!dep?.last_ok_at) {
      return { stage: stage.stage, runnable: false, reason: 'waiting_on_upstream', blockedBy: depName };
    }
  }

  // 3: the CMD partner slot is reserved in this band; DB-only stages are unaffected.
  if (stage.usesCmdApi && inCmdQuietWindow(now)) {
    return { stage: stage.stage, runnable: false, reason: 'cmd_quiet_window' };
  }

  // 4: due?
  const lastOk = mine?.last_ok_at ?? null;
  const lastRun = mine?.last_run_at ?? null;

  if (lastOk === null) return { stage: stage.stage, runnable: true };

  // The completion chain. `every` so a fork (the rollup) fires once, after the LAST dependency.
  const freshUpstream =
    stage.dependsOn.length > 0 &&
    stage.dependsOn.every((d) => {
      const depOk = state.get(d)?.last_ok_at;
      return depOk != null && depOk.getTime() > lastOk.getTime();
    });
  if (freshUpstream) return { stage: stage.stage, runnable: true };

  // Heartbeat, measured from the last ATTEMPT so a failing stage retries on its interval rather
  // than hammering every tick.
  const intervalElapsed = lastRun === null || now.getTime() - lastRun.getTime() >= stage.intervalMs;
  if (intervalElapsed) return { stage: stage.stage, runnable: true };

  return { stage: stage.stage, runnable: false, reason: 'not_due' };
}
