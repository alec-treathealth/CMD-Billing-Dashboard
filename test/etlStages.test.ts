import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CMD_STAGES,
  inCmdQuietWindow,
  planTick,
  type EtlStage,
  type StageState,
} from '../src/collections/etlStages.js';

/**
 * planTick is pure, so these tests are the real specification of the scheduler. They cover the two
 * things that make this pipeline different from the cron schedule it replaces: the completion chain
 * (a dependent becomes due the instant its dependencies finish, not at a clock minute) and the
 * strict hold (a failed stage stops its dependents rather than letting them record a success on
 * stale inputs).
 */

const T0 = new Date('2026-08-12T10:00:00Z');
const at = (iso: string) => new Date(iso);

function state(rows: Array<Partial<StageState> & { stage: string }>): Map<string, StageState> {
  return new Map(
    rows.map((r) => [
      r.stage,
      {
        stage: r.stage,
        status: r.status ?? 'ok',
        last_run_at: r.last_run_at ?? null,
        last_ok_at: r.last_ok_at ?? null,
        last_error_label: r.last_error_label ?? null,
      },
    ]),
  );
}

function plan(opts: {
  stages?: readonly EtlStage[];
  state: Map<string, StageState>;
  now?: Date;
  elapsedMs?: number;
  budgetMs?: number;
  ranAny?: boolean;
}) {
  return planTick({
    stages: opts.stages ?? CMD_STAGES,
    state: opts.state,
    now: opts.now ?? T0,
    elapsedMs: opts.elapsedMs ?? 0,
    budgetMs: opts.budgetMs ?? 200_000,
    ranAny: opts.ranAny ?? false,
  });
}

const reasonFor = (p: ReturnType<typeof plan>, stage: string) =>
  p.plans.find((x) => x.stage === stage)?.reason;

// ── The registry encodes the DERIVED dependency graph, not the cron schedule ───────────────────

test('the DAG is the fork the data implies, not the linear chain the schedule implies', () => {
  const by = new Map(CMD_STAGES.map((s) => [s.stage, s]));

  // Verified 2026-08-12: cmd_explorer_charge_rollup is defined over cmd_explorer_rows only.
  assert.deepEqual(by.get('refresh-charge-rollup')?.dependsOn, ['cmd-explorer', 'indigo-explorer']);

  // The census stages write cmd_charge_census, which no stage here reads. Putting them upstream of
  // the rollup — as the :15/:35-before-:45 clock order suggests — would park a run measured at 214s
  // in the rollup's critical path for no data reason.
  assert.deepEqual(by.get('cmd-census')?.dependsOn, []);
  assert.deepEqual(by.get('indigo-census')?.dependsOn, []);
  assert.deepEqual(by.get('cmd-explorer')?.dependsOn, []);
  assert.deepEqual(by.get('indigo-explorer')?.dependsOn, []);
});

test('only the rollup is DB-only; the four CMD stages carry the partner-slot flag', () => {
  const cmdStages = CMD_STAGES.filter((s) => s.usesCmdApi).map((s) => s.stage);
  assert.deepEqual(cmdStages, ['cmd-explorer', 'indigo-explorer', 'cmd-census', 'indigo-census']);
  assert.equal(CMD_STAGES.find((s) => s.stage === 'refresh-charge-rollup')?.usesCmdApi, false);
});

test('declaration order is a valid topological order', () => {
  const seen = new Set<string>();
  for (const s of CMD_STAGES) {
    for (const d of s.dependsOn) {
      assert.ok(seen.has(d), `${s.stage} declared before its dependency ${d}`);
    }
    seen.add(s.stage);
  }
});

// ── The completion chain ───────────────────────────────────────────────────────────────────────

test('the rollup fires as soon as BOTH explorers are newer than its own last success', () => {
  const p = plan({
    state: state([
      { stage: 'cmd-explorer', last_ok_at: at('2026-08-12T09:58:00Z'), last_run_at: at('2026-08-12T09:58:00Z') },
      { stage: 'indigo-explorer', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
      // Rollup succeeded BEFORE both, and only 10 minutes ago — its hourly heartbeat has NOT
      // elapsed, so the only thing that can make it due is the completion chain.
      { stage: 'refresh-charge-rollup', last_ok_at: at('2026-08-12T09:50:00Z'), last_run_at: at('2026-08-12T09:50:00Z') },
      { stage: 'cmd-census', last_ok_at: at('2026-08-12T09:55:00Z'), last_run_at: at('2026-08-12T09:55:00Z') },
      { stage: 'indigo-census', last_ok_at: at('2026-08-12T09:55:00Z'), last_run_at: at('2026-08-12T09:55:00Z') },
    ]),
  });
  assert.equal(p.next, 'refresh-charge-rollup');
});

test('the rollup does NOT fire when only one explorer is newer (fires once, after the last)', () => {
  const p = plan({
    state: state([
      { stage: 'cmd-explorer', last_ok_at: at('2026-08-12T09:58:00Z'), last_run_at: at('2026-08-12T09:58:00Z') },
      // Indigo has not run since the rollup did.
      { stage: 'indigo-explorer', last_ok_at: at('2026-08-12T09:45:00Z'), last_run_at: at('2026-08-12T09:45:00Z') },
      { stage: 'refresh-charge-rollup', last_ok_at: at('2026-08-12T09:50:00Z'), last_run_at: at('2026-08-12T09:50:00Z') },
      { stage: 'cmd-census', last_ok_at: at('2026-08-12T09:55:00Z'), last_run_at: at('2026-08-12T09:55:00Z') },
      { stage: 'indigo-census', last_ok_at: at('2026-08-12T09:55:00Z'), last_run_at: at('2026-08-12T09:55:00Z') },
    ]),
  });
  assert.equal(p.next, null);
  assert.equal(reasonFor(p, 'refresh-charge-rollup'), 'not_due');
});

test('the heartbeat still runs a stage whose interval elapsed with no upstream movement', () => {
  const old = at('2026-08-12T08:30:00Z'); // 90 minutes before T0
  const p = plan({
    state: state([
      { stage: 'cmd-explorer', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-explorer', last_ok_at: old, last_run_at: old },
      { stage: 'refresh-charge-rollup', last_ok_at: old, last_run_at: old },
      { stage: 'cmd-census', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-census', last_ok_at: old, last_run_at: old },
    ]),
  });
  assert.equal(p.next, 'cmd-explorer');
});

test('a never-run pipeline starts at the first declared stage', () => {
  const p = plan({ state: state(CMD_STAGES.map((s) => ({ stage: s.stage, status: 'idle' }))) });
  assert.equal(p.next, 'cmd-explorer');
  // The rollup has no upstream success to consume yet — reported as waiting, not as "not due".
  assert.equal(reasonFor(p, 'refresh-charge-rollup'), 'waiting_on_upstream');
});

test('missing pipeline_state rows are treated as never-run rather than crashing', () => {
  const p = plan({ state: state([]) });
  assert.equal(p.next, 'cmd-explorer');
});

// ── A failed stage HOLDS its dependents ────────────────────────────────────────────────────────

test('a dependency in error blocks the dependent and names the blocker', () => {
  const recent = at('2026-08-12T09:58:00Z');
  const p = plan({
    state: state([
      { stage: 'cmd-explorer', status: 'error', last_run_at: recent, last_ok_at: at('2026-08-12T08:00:00Z'), last_error_label: 'cron_failed' },
      { stage: 'indigo-explorer', status: 'ok', last_ok_at: recent, last_run_at: recent },
      { stage: 'refresh-charge-rollup', status: 'ok', last_ok_at: at('2026-08-12T09:00:00Z'), last_run_at: at('2026-08-12T09:00:00Z') },
      { stage: 'cmd-census', last_ok_at: recent, last_run_at: recent },
      { stage: 'indigo-census', last_ok_at: recent, last_run_at: recent },
    ]),
  });
  const rollup = p.plans.find((x) => x.stage === 'refresh-charge-rollup');
  assert.equal(rollup?.runnable, false);
  assert.equal(rollup?.reason, 'blocked_upstream_error');
  assert.equal(rollup?.blockedBy, 'cmd-explorer');
});

test('the heartbeat cannot override an upstream error — a hold is not a delay', () => {
  // The rollup has not succeeded in 3 hours, so its own interval has long elapsed. It must STILL
  // hold, because running it would refresh a matview over inputs a failed explorer never wrote and
  // then record that as a success.
  const stale = at('2026-08-12T07:00:00Z');
  const p = plan({
    state: state([
      { stage: 'cmd-explorer', status: 'error', last_run_at: at('2026-08-12T09:58:00Z'), last_ok_at: stale },
      { stage: 'indigo-explorer', status: 'ok', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
      { stage: 'refresh-charge-rollup', status: 'ok', last_ok_at: stale, last_run_at: stale },
      { stage: 'cmd-census', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
      { stage: 'indigo-census', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
    ]),
  });
  assert.equal(reasonFor(p, 'refresh-charge-rollup'), 'blocked_upstream_error');
  // Nothing else is due either: the failed explorer attempted 2 minutes ago, and the heartbeat is
  // measured from the last ATTEMPT precisely so a failing stage backs off instead of being retried
  // on every tick against the one-report-at-a-time CMD slot.
  assert.equal(p.next, null);
  assert.equal(reasonFor(p, 'cmd-explorer'), 'not_due');
});

test('a failed stage IS retried once its own interval elapses — a hold blocks dependents, not recovery', () => {
  const stale = at('2026-08-12T07:00:00Z');
  const p = plan({
    state: state([
      // Same failure, but the attempt was 70 minutes ago rather than 2.
      { stage: 'cmd-explorer', status: 'error', last_run_at: at('2026-08-12T08:50:00Z'), last_ok_at: stale },
      { stage: 'indigo-explorer', status: 'ok', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
      { stage: 'refresh-charge-rollup', status: 'ok', last_ok_at: stale, last_run_at: stale },
      { stage: 'cmd-census', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
      { stage: 'indigo-census', last_ok_at: at('2026-08-12T09:59:00Z'), last_run_at: at('2026-08-12T09:59:00Z') },
    ]),
  });
  assert.equal(p.next, 'cmd-explorer');
  // And the dependent is still held until that retry actually succeeds.
  assert.equal(reasonFor(p, 'refresh-charge-rollup'), 'blocked_upstream_error');
});

// ── The reserved CMD quiet window ──────────────────────────────────────────────────────────────

test('inCmdQuietWindow covers :41 through :59 inclusive and nothing else', () => {
  assert.equal(inCmdQuietWindow(at('2026-08-12T10:40:59Z')), false);
  assert.equal(inCmdQuietWindow(at('2026-08-12T10:41:00Z')), true);
  assert.equal(inCmdQuietWindow(at('2026-08-12T10:59:59Z')), true);
  assert.equal(inCmdQuietWindow(at('2026-08-12T11:00:00Z')), false);
});

test('inside :41-:59 the CMD stages stand down but the DB-only rollup still runs', () => {
  const quiet = at('2026-08-12T10:45:00Z');
  const old = at('2026-08-12T08:00:00Z');
  const p = plan({
    now: quiet,
    state: state([
      // Both explorers succeeded recently, so the rollup is due via the completion chain.
      { stage: 'cmd-explorer', last_ok_at: at('2026-08-12T10:35:00Z'), last_run_at: old },
      { stage: 'indigo-explorer', last_ok_at: at('2026-08-12T10:36:00Z'), last_run_at: old },
      { stage: 'refresh-charge-rollup', last_ok_at: at('2026-08-12T10:00:00Z'), last_run_at: at('2026-08-12T10:00:00Z') },
      { stage: 'cmd-census', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-census', last_ok_at: old, last_run_at: old },
    ]),
  });
  assert.equal(p.next, 'refresh-charge-rollup');
  // The census stages were due on their heartbeat and were held purely by the window.
  assert.equal(reasonFor(p, 'cmd-census'), 'cmd_quiet_window');
  assert.equal(reasonFor(p, 'cmd-explorer'), 'cmd_quiet_window');
});

test('a tick entirely inside the quiet window with only CMD work due runs nothing', () => {
  const old = at('2026-08-12T08:00:00Z');
  const p = plan({
    now: at('2026-08-12T10:50:00Z'),
    state: state([
      { stage: 'cmd-explorer', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-explorer', last_ok_at: old, last_run_at: old },
      // Rollup already ran after both explorers, so the chain is satisfied and its heartbeat has not
      // elapsed — nothing at all is runnable.
      { stage: 'refresh-charge-rollup', last_ok_at: at('2026-08-12T10:45:00Z'), last_run_at: at('2026-08-12T10:45:00Z') },
      { stage: 'cmd-census', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-census', last_ok_at: old, last_run_at: old },
    ]),
  });
  assert.equal(p.next, null);
});

// ── The wall-clock budget ──────────────────────────────────────────────────────────────────────

test('the FIRST stage of a tick runs even when its reserve exceeds the whole budget', () => {
  // cmd-explorer reserves 300s (unmeasured) against a 200s budget. A strict check would make it
  // permanently unrunnable, which is why the first stage is exempt.
  const p = plan({
    state: state([]),
    elapsedMs: 0,
    budgetMs: 200_000,
    ranAny: false,
  });
  assert.equal(p.next, 'cmd-explorer');
});

test('a SECOND stage is declined when its reserve no longer fits', () => {
  const old = at('2026-08-12T08:00:00Z');
  const p = plan({
    state: state([
      // cmd-explorer already ran this tick; indigo-explorer is next and reserves 300s.
      { stage: 'cmd-explorer', last_ok_at: T0, last_run_at: T0 },
      { stage: 'indigo-explorer', last_ok_at: old, last_run_at: old },
      { stage: 'refresh-charge-rollup', last_ok_at: old, last_run_at: old },
      { stage: 'cmd-census', last_ok_at: old, last_run_at: old },
      { stage: 'indigo-census', last_ok_at: old, last_run_at: old },
    ]),
    elapsedMs: 120_000,
    budgetMs: 200_000,
    ranAny: true,
  });
  assert.equal(p.next, null);
  assert.equal(reasonFor(p, 'indigo-explorer'), 'budget_exhausted');
});

test('a second stage IS taken when it fits', () => {
  const old = at('2026-08-12T08:00:00Z');
  const cheap: readonly EtlStage[] = [
    { stage: 'a', dependsOn: [], usesCmdApi: false, intervalMs: 3_600_000, reserveMs: 10_000 },
    { stage: 'b', dependsOn: [], usesCmdApi: false, intervalMs: 3_600_000, reserveMs: 10_000 },
  ];
  const p = plan({
    stages: cheap,
    state: state([
      { stage: 'a', last_ok_at: T0, last_run_at: T0 },
      { stage: 'b', last_ok_at: old, last_run_at: old },
    ]),
    elapsedMs: 30_000,
    budgetMs: 200_000,
    ranAny: true,
  });
  assert.equal(p.next, 'b');
});

// ── Every held stage is reported ───────────────────────────────────────────────────────────────

test('every stage gets a verdict, so a hold is never silent', () => {
  const p = plan({ state: state([]) });
  assert.equal(p.plans.length, CMD_STAGES.length);
  for (const sp of p.plans) {
    if (!sp.runnable) assert.ok(sp.reason, `${sp.stage} held with no reason`);
  }
});
