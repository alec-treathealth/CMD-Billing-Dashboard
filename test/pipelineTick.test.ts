import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPipelineTick } from '../src/collections/pipelineTick.js';
import type { EtlStage, StageState } from '../src/collections/etlStages.js';
import type { Db } from '../src/collections/db.js';

/**
 * The tick's contract: take a lease, run due stages within a budget, advance durable state, always
 * release. These tests use a small in-memory stand-in for pipeline_state / pipeline_lock so the
 * state machine is exercised end to end without a database.
 */

interface Call {
  sql: string;
  params?: unknown[];
}

const TWO_STAGES: readonly EtlStage[] = [
  { stage: 'up', dependsOn: [], usesCmdApi: false, intervalMs: 3_600_000, reserveMs: 10_000 },
  { stage: 'down', dependsOn: ['up'], usesCmdApi: false, intervalMs: 3_600_000, reserveMs: 10_000 },
];

/**
 * Fake pool backed by a real Map of stage rows, so the tick's own UPDATEs feed the next iteration's
 * SELECT the way they would in Postgres. Without that the loop could not be tested at all — it
 * re-reads state every pass, which is exactly how a completed stage stops being due.
 */
function fakeDb(
  opts: { rows?: Map<string, StageState>; locked?: boolean; failStateWrite?: boolean; now?: () => Date } = {},
) {
  const calls: Call[] = [];
  const rows = opts.rows ?? new Map<string, StageState>();
  let locked = opts.locked ?? false;
  // The fake's now() MUST be the same clock the tick uses. When they diverge, a stage's last_run_at
  // reads as ancient to the heartbeat and the stage becomes due again the instant it finishes —
  // which is how the once-per-tick guard in pipelineTick.ts got written.
  const now = opts.now ?? (() => new Date());

  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (/insert into collections\.pipeline_lock/i.test(sql)) {
        if (locked) return { rowCount: 0, rows: [] };
        locked = true;
        return { rowCount: 1, rows: [{ holder: params?.[2] }] };
      }
      if (/update collections\.pipeline_lock/i.test(sql)) {
        locked = false;
        return { rowCount: 1, rows: [] };
      }
      if (/select stage, status/i.test(sql)) {
        return { rowCount: rows.size, rows: [...rows.values()] };
      }
      if (/insert into collections\.pipeline_state/i.test(sql)) {
        if (opts.failStateWrite) throw new Error('permission denied for table pipeline_state');
        const stage = String(params?.[1]);
        const prev = rows.get(stage);
        rows.set(stage, {
          stage,
          status: 'running',
          last_run_at: now(),
          last_ok_at: prev?.last_ok_at ?? null,
          last_error_label: prev?.last_error_label ?? null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (/set status = 'ok'/i.test(sql)) {
        const stage = String(params?.[1]);
        const prev = rows.get(stage);
        rows.set(stage, {
          stage,
          status: 'ok',
          last_run_at: prev?.last_run_at ?? now(),
          last_ok_at: now(),
          last_error_label: null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (/set status = 'error'/i.test(sql)) {
        const stage = String(params?.[1]);
        const prev = rows.get(stage);
        rows.set(stage, {
          stage,
          status: 'error',
          last_run_at: prev?.last_run_at ?? now(),
          last_ok_at: prev?.last_ok_at ?? null,
          last_error_label: String(params?.[2]),
        });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Db;

  return { db, calls, rows, isLocked: () => locked };
}

const ok = { status: 200, body: { ok: true, rows_fetched: 5 }, runId: 1 };
const fail = { status: 500, body: { error: 'cron_failed' }, runId: 2 };

// ── The lease ──────────────────────────────────────────────────────────────────────────────────

test('a tick that cannot take the lease returns immediately without running anything', async () => {
  const { db } = fakeDb({ locked: true });
  const invoked: string[] = [];
  const report = await runPipelineTick({
    db,
    stages: TWO_STAGES,
    runStage: async (s) => {
      invoked.push(s);
      return ok;
    },
  });
  assert.equal(report.disposition, 'locked');
  assert.deepEqual(invoked, []);
  assert.equal(report.ok, true); // a contended tick is not a failure
});

test('each tick takes a UNIQUE lease token, so an expired tick cannot release a later one', async () => {
  // Qodo review #216, and it was a real defect: with a shared holder label ('cron'), tick A whose
  // lease had already EXPIRED would still match `where holder = 'cron'` on release and clear tick
  // B's live lease — letting a third tick in while B was mid-stage against the one-report-at-a-time
  // CMD slot. The original comment claimed holder scoping prevented exactly that; it did not.
  const holders: string[] = [];
  const capture = {
    async query(sql: string, params?: unknown[]) {
      if (/insert into collections\.pipeline_lock/i.test(sql)) {
        holders.push(String(params?.[2]));
        return { rowCount: 1, rows: [{ holder: params?.[2] }] };
      }
      if (/select stage, status/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Db;

  const run = () =>
    runPipelineTick({ db: capture, stages: [], runStage: async () => ok, holder: 'cron' });
  await run();
  await run();

  assert.equal(holders.length, 2);
  assert.notEqual(holders[0], holders[1], 'two ticks must not share a lease token');
  for (const h of holders) assert.match(h, /^cron:\d+:[0-9a-f-]{36}$/);
});

test('a manual tick is distinguishable in its lease token', async () => {
  let holder = '';
  const capture = {
    async query(sql: string, params?: unknown[]) {
      if (/insert into collections\.pipeline_lock/i.test(sql)) {
        holder = String(params?.[2]);
        return { rowCount: 1, rows: [{ holder: params?.[2] }] };
      }
      if (/select stage, status/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Db;
  await runPipelineTick({ db: capture, stages: [], runStage: async () => ok, holder: 'manual' });
  assert.match(holder, /^manual:/);
});

test('an unrecognised holder is clamped to cron rather than stored verbatim', async () => {
  let holder = '';
  const capture = {
    async query(sql: string, params?: unknown[]) {
      if (/insert into collections\.pipeline_lock/i.test(sql)) {
        holder = String(params?.[2]);
        return { rowCount: 1, rows: [{ holder: params?.[2] }] };
      }
      if (/select stage, status/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Db;
  await runPipelineTick({ db: capture, stages: [], runStage: async () => ok, holder: "'; drop--" });
  assert.match(holder, /^cron:/);
});

test('the default lease OUTLIVES the 300s function ceiling', async () => {
  // If the lease could expire while the function was still alive, a second tick would start
  // alongside the first — the precise contention the lease exists to prevent. It must therefore be
  // longer than the platform ceiling, not shorter than the stage budget.
  const { DEFAULT_LEASE_MS, DEFAULT_TICK_BUDGET_MS } = await import('../src/collections/pipelineTick.js');
  assert.ok(DEFAULT_LEASE_MS > 300_000, 'lease must exceed the 300s maxDuration ceiling');
  assert.ok(DEFAULT_LEASE_MS > DEFAULT_TICK_BUDGET_MS);
});

test('the lease is released after a normal tick', async () => {
  const f = fakeDb();
  await runPipelineTick({ db: f.db, stages: TWO_STAGES, runStage: async () => ok });
  assert.equal(f.isLocked(), false);
});

test('the lease is released even when a state write throws', async () => {
  const f = fakeDb({ failStateWrite: true });
  await assert.rejects(runPipelineTick({ db: f.db, stages: TWO_STAGES, runStage: async () => ok }));
  // A lease outliving its tick would stall the pipeline for its full length for no reason.
  assert.equal(f.isLocked(), false);
});

test('a state-write failure fails the tick loudly rather than proceeding', async () => {
  // pipeline_state is the scheduling truth, not observability: a tick that cannot record "this ran"
  // would re-run stages against the one-report-at-a-time CMD slot. Opposite posture to etl_run.
  const f = fakeDb({ failStateWrite: true });
  await assert.rejects(
    runPipelineTick({ db: f.db, stages: TWO_STAGES, runStage: async () => ok }),
    /pipeline_state/,
  );
});

// ── The chain ──────────────────────────────────────────────────────────────────────────────────

test('one tick runs the upstream stage and then its dependent, in order', async () => {
  const f = fakeDb();
  const invoked: string[] = [];
  const report = await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    runStage: async (s) => {
      invoked.push(s);
      return ok;
    },
  });
  // This IS the completion chain: 'down' was not due until 'up' wrote a newer last_ok_at, and it
  // became due within the same tick rather than at a clock slot 45 minutes later.
  assert.deepEqual(invoked, ['up', 'down']);
  assert.equal(report.ok, true);
  assert.deepEqual(report.ran.map((r) => r.stage), ['up', 'down']);
});

test('a failed upstream stage holds its dependent and reports why', async () => {
  const f = fakeDb();
  const invoked: string[] = [];
  const report = await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    runStage: async (s) => {
      invoked.push(s);
      return s === 'up' ? fail : ok;
    },
  });
  assert.deepEqual(invoked, ['up']); // 'down' never ran
  assert.equal(report.ok, false);
  const held = report.held.find((h) => h.stage === 'down');
  assert.equal(held?.reason, 'blocked_upstream_error');
  assert.equal(held?.blockedBy, 'up');
  // And the failure is durable, not just in the response.
  assert.equal(f.rows.get('up')?.status, 'error');
  assert.equal(f.rows.get('up')?.last_error_label, 'cron_failed');
});

test('a failed stage does NOT advance last_ok_at', async () => {
  const f = fakeDb();
  await runPipelineTick({ db: f.db, stages: TWO_STAGES, runStage: async () => fail });
  // last_ok_at is the edge the chain reads; leaving it untouched is what keeps dependents held.
  assert.equal(f.rows.get('up')?.last_ok_at, null);
});

test('a stage that THROWS is recorded as an error rather than escaping the tick', async () => {
  const f = fakeDb();
  const report = await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    runStage: async (s) => {
      if (s === 'up') throw new Error('socket hang up');
      return ok;
    },
  });
  assert.equal(report.ok, false);
  assert.equal(f.rows.get('up')?.status, 'error');
  assert.equal(f.rows.get('up')?.last_error_label, 'socket hang up');
  assert.equal(report.held.find((h) => h.stage === 'down')?.reason, 'blocked_upstream_error');
});

test('a stage is marked running BEFORE it is invoked', async () => {
  const f = fakeDb();
  let statusAtInvocation: string | undefined;
  await runPipelineTick({
    db: f.db,
    stages: [TWO_STAGES[0]!],
    runStage: async (s) => {
      statusAtInvocation = f.rows.get(s)?.status;
      return ok;
    },
  });
  // So a platform kill mid-stage leaves a visible in-flight row instead of a stage that looks like
  // it never started.
  assert.equal(statusAtInvocation, 'running');
});

// ── Idempotency + budget ───────────────────────────────────────────────────────────────────────

test('a second tick with nothing due runs no stage and is still a success', async () => {
  const f = fakeDb();
  await runPipelineTick({ db: f.db, stages: TWO_STAGES, runStage: async () => ok });
  const invoked: string[] = [];
  const second = await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    runStage: async (s) => {
      invoked.push(s);
      return ok;
    },
  });
  // Safe to curl by hand as often as you like.
  assert.deepEqual(invoked, []);
  assert.equal(second.ok, true);
  assert.equal(second.disposition, 'ran');
});

test('the tick stops starting stages once the budget is spent', async () => {
  let t = new Date('2026-08-12T10:00:00Z').getTime();
  const now = () => new Date(t);
  const f = fakeDb({ now });
  const invoked: string[] = [];
  await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    budgetMs: 20_000,
    now,
    runStage: async (s) => {
      invoked.push(s);
      t += 19_000; // 'up' eats almost the whole budget
      return ok;
    },
  });
  // 'down' reserves 10s and only ~1s of budget remains, so it defers to the next tick rather than
  // risking a platform kill mid-stage.
  assert.deepEqual(invoked, ['up']);
});

test('a stage runs at most ONCE per tick even if state says it is due again', async () => {
  // Guards the infinite-loop class directly: this fake never advances last_run_at, so the heartbeat
  // would re-select 'solo' forever without the once-per-tick set. A tick that burns its whole budget
  // re-running one stage is worse than the staggered crons it replaces, and a platform kill would be
  // the only thing stopping it.
  const neverAdvances = {
    async query(sql: string, params?: unknown[]) {
      if (/insert into collections\.pipeline_lock/i.test(sql)) return { rowCount: 1, rows: [{ holder: params?.[2] }] };
      if (/select stage, status/i.test(sql)) return { rowCount: 0, rows: [] }; // always "never run"
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Db;

  const invoked: string[] = [];
  const report = await runPipelineTick({
    db: neverAdvances,
    stages: [{ stage: 'solo', dependsOn: [], usesCmdApi: false, intervalMs: 3_600_000, reserveMs: 1_000 }],
    runStage: async (s) => {
      invoked.push(s);
      return ok;
    },
  });
  assert.deepEqual(invoked, ['solo']);
  assert.equal(report.ran.length, 1);
});

test('an unwired stage records an error instead of advancing as a success', async () => {
  // dispatchStage throws for a stage name with no handler. The tick must treat that like any other
  // stage failure — durable error, dependents held — rather than marking a stage that never ran ok.
  const f = fakeDb();
  const report = await runPipelineTick({
    db: f.db,
    stages: TWO_STAGES,
    runStage: async () => {
      throw new Error("pipeline-tick: no handler wired for stage 'up'");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(f.rows.get('up')?.status, 'error');
  assert.equal(f.rows.get('up')?.last_ok_at, null);
  assert.equal(report.held.find((h) => h.stage === 'down')?.reason, 'blocked_upstream_error');
});
