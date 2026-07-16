import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshChargeRollup } from '../src/collections/refreshChargeRollup.js';
import type { Db } from '../src/collections/db.js';

/** Classify a query by SQL so we can assert the ORDER of statements the module issues. */
function classify(sql: string): string {
  if (/insert into collections\.rollup_refresh_run/i.test(sql)) return 'insert_start';
  if (/refresh_cmd_explorer_charge_rollup/i.test(sql)) return 'refresh';
  if (/max\(payment_received\)/i.test(sql)) return 'read_max';
  if (/update collections\.rollup_refresh_run/i.test(sql)) return 'update_finish';
  return 'other';
}

interface Call {
  sql: string;
  params?: unknown[];
}

/**
 * Fake pool exposing .query directly (the module runs autocommit statements on the pool, NOT via
 * withTenant/connect — it is not tenant-scoped). Records every call in order and routes by SQL.
 * The refresh statement can be made to throw, simulating a refresh failure / statement timeout.
 */
function fakeDb(opts: { failRefresh?: boolean; refreshMessage?: string; maxPay?: string | null } = {}): {
  db: Db;
  calls: Call[];
} {
  const calls: Call[] = [];
  let nextId = 41;
  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/insert into collections\.rollup_refresh_run/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: String(nextId++) }] };
      }
      if (/refresh_cmd_explorer_charge_rollup/i.test(sql)) {
        if (opts.failRefresh) {
          throw new Error(opts.refreshMessage ?? 'canceling statement due to statement timeout');
        }
        return { rowCount: 1, rows: [{}] };
      }
      if (/max\(payment_received\)/i.test(sql)) {
        // Honor an EXPLICIT null (empty rollup); only default when maxPay was omitted. Using ?? here
        // would coalesce a deliberate null to the default and the null-freshness case would never run.
        return { rowCount: 1, rows: [{ max_pay: 'maxPay' in opts ? opts.maxPay : '2026-07-16' }] };
      }
      if (/update collections\.rollup_refresh_run/i.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Db;
  return { db, calls };
}

/** Deterministic clock: returns the given times in sequence (clamps to the last). */
function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

// --- THE REQUIRED PROOF: start row commits before a simulated refresh failure -------------------

test('start row is written BEFORE the refresh, and a refresh failure is recorded then rethrown', async () => {
  const fake = fakeDb({ failRefresh: true, refreshMessage: 'canceling statement due to statement timeout' });

  // The failure must PROPAGATE (not be swallowed) so the route returns 500.
  await assert.rejects(
    () => refreshChargeRollup({ db: fake.db, now: fakeClock([1000, 59000]) }),
    /statement timeout/,
  );

  // Ordering proof: the start-row INSERT ran (and returned an id) as its OWN statement BEFORE the
  // refresh was even attempted. On the Supavisor transaction pooler each statement is its own
  // committed transaction, so that returned INSERT is durable independent of the refresh outcome —
  // exactly what survives a mid-refresh platform kill. On the caught failure we skip the freshness
  // read and go straight to the failure UPDATE.
  assert.deepEqual(
    fake.calls.map((c) => classify(c.sql)),
    ['insert_start', 'refresh', 'update_finish'],
  );

  // The start row was inserted with the trigger label only (no ok/finished — a bare "started" row).
  const insert = fake.calls[0]!;
  assert.match(insert.sql, /insert into collections\.rollup_refresh_run/i);
  assert.deepEqual(insert.params, ['cron']);

  // The failure was recorded on the SAME row: ok=false + the error message + the id from the insert.
  const update = fake.calls[2]!;
  assert.match(update.sql, /ok = false/i);
  assert.match(update.sql, /error = \$2/i);
  assert.equal(update.params?.[0], 58000); // duration_ms = 59000 - 1000
  assert.equal(update.params?.[1], 'canceling statement due to statement timeout');
  assert.equal(update.params?.[2], 41); // same run id the INSERT returned
});

// --- happy path ---------------------------------------------------------------------------------

test('happy path: refresh runs, freshness read, row closed ok=true with duration + max date', async () => {
  const fake = fakeDb({ maxPay: '2026-07-16' });

  const stats = await refreshChargeRollup({ db: fake.db, now: fakeClock([2000, 60000]) });

  assert.deepEqual(stats, {
    run_id: 41,
    ok: true,
    duration_ms: 58000,
    rollup_max_payment_date: '2026-07-16',
  });
  assert.deepEqual(
    fake.calls.map((c) => classify(c.sql)),
    ['insert_start', 'refresh', 'read_max', 'update_finish'],
  );
  const update = fake.calls[3]!;
  assert.match(update.sql, /ok = true/i);
  assert.equal(update.params?.[0], 58000);
  assert.equal(update.params?.[1], '2026-07-16');
  assert.equal(update.params?.[2], 41);
});

// --- best-effort failure recording must not mask the original error -----------------------------

test('if the failure-record UPDATE also throws, the ORIGINAL refresh error still surfaces', async () => {
  const db = {
    async query(sql: string) {
      if (/insert into collections\.rollup_refresh_run/i.test(sql)) return { rowCount: 1, rows: [{ id: '7' }] };
      if (/refresh_cmd_explorer_charge_rollup/i.test(sql)) throw new Error('ORIGINAL refresh error');
      if (/update collections\.rollup_refresh_run/i.test(sql)) throw new Error('SECONDARY update error');
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Db;

  await assert.rejects(() => refreshChargeRollup({ db, now: () => 0 }), /ORIGINAL refresh error/);
});

// --- null freshness (empty rollup) is tolerated -------------------------------------------------

test('null max(payment_received) is stored as null, not an error', async () => {
  const fake = fakeDb({ maxPay: null });
  const stats = await refreshChargeRollup({ db: fake.db, now: fakeClock([0, 1000]) });
  assert.equal(stats.ok, true);
  assert.equal(stats.rollup_max_payment_date, null);
});

// --- OVERLAP VISIBILITY: overlapping runs are recorded, never suppressed -------------------------

test('overlap: with a prior run still ok IS NULL, a new run writes its OWN start-row (never blocks or dedupes)', async () => {
  // An hourly schedule + a ~58s CONCURRENTLY refresh can overlap; Postgres serializes them on the
  // matview's SHARE UPDATE EXCLUSIVE lock (they queue, they don't corrupt). We deliberately do NOT
  // prevent or dedupe overlap — we RECORD it. Model the run-log as a table pre-seeded with an
  // unfinished prior run (id 41, ok IS NULL — an in-flight or platform-killed refresh) and assert a
  // fresh run issues its own unconditional start-row and leaves the prior row untouched, exactly as
  // the morning health check would show it: a stale ok IS NULL row preceding a newer row.
  const table = new Map<number, { ok: boolean | null; finished: boolean }>([[41, { ok: null, finished: false }]]);
  let nextId = 42;
  const calls: string[] = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push(sql);
      if (/insert into collections\.rollup_refresh_run/i.test(sql)) {
        const id = nextId++;
        table.set(id, { ok: null, finished: false });
        return { rowCount: 1, rows: [{ id: String(id) }] };
      }
      if (/refresh_cmd_explorer_charge_rollup/i.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/max\(payment_received\)/i.test(sql)) return { rowCount: 1, rows: [{ max_pay: '2026-07-16' }] };
      if (/update collections\.rollup_refresh_run/i.test(sql)) {
        const row = table.get(Number(params?.[params.length - 1]));
        if (row) { row.ok = true; row.finished = true; }
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Db;

  const stats = await refreshChargeRollup({ db, now: fakeClock([0, 1000]) });

  // The new run took its OWN id (42), NOT the prior unfinished row (41) — no reuse, no dedupe.
  assert.equal(stats.run_id, 42);
  // Statement sequence is the plain 4-step path — there is NO guard/dedupe SELECT against the
  // run-log before the insert; the start-row write is unconditional.
  assert.deepEqual(calls.map(classify), ['insert_start', 'refresh', 'read_max', 'update_finish']);
  // The prior overlapping run is left untouched — still ok IS NULL / unfinished — so it stays
  // visible in the morning health check as the earlier unfinished row preceding this newer one.
  assert.deepEqual(table.get(41), { ok: null, finished: false });
  // The new run closed out ONLY its own row.
  assert.deepEqual(table.get(42), { ok: true, finished: true });
});
