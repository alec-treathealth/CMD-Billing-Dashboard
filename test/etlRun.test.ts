import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyCronResult,
  finishEtlRun,
  startEtlRun,
  withEtlRun,
} from '../src/collections/etlRun.js';
import type { Db } from '../src/collections/db.js';

/**
 * The behaviour these tests pin down is FAIL-SOFT. This module wraps the production-critical CMD
 * crons, and between this code deploying and migration 0099 being applied by hand every insert here
 * raises 42P01. If that propagated it would take down all five crons on merge. So: a broken run log
 * must never change what a stage returns, and must never turn a successful ingest into a failure.
 */

interface Call {
  sql: string;
  params?: unknown[];
}

function fakeDb(opts: { failStart?: unknown; failFinish?: unknown } = {}): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 7;
  const db = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/insert into collections\.etl_run/i.test(sql)) {
        if (opts.failStart) throw opts.failStart;
        // node-pg returns int8 as a STRING; the module must Number() it.
        return { rowCount: 1, rows: [{ id: String(nextId++) }] };
      }
      if (/update collections\.etl_run/i.test(sql)) {
        if (opts.failFinish) throw opts.failFinish;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Db;
  return { db, calls };
}

const undefinedTable = Object.assign(new Error('relation "collections.etl_run" does not exist'), {
  code: '42P01',
});

const classify = (sql: string) =>
  /insert into collections\.etl_run/i.test(sql) ? 'insert' : /update collections\.etl_run/i.test(sql) ? 'update' : 'work';

// ── Durability model: start row BEFORE the work ────────────────────────────────────────────────

test('the start row is inserted before the work runs and closed after', async () => {
  const { db, calls } = fakeDb();
  const order: string[] = [];
  await withEtlRun({ db, stage: 'cmd-explorer', triggeredBy: 'cron' }, async () => {
    order.push('work');
    return { status: 200, body: {} };
  });
  const seq = calls.map((c) => classify(c.sql));
  assert.deepEqual(seq, ['insert', 'update']);
  // The work ran strictly between them: the insert was recorded before 'work' was pushed.
  assert.deepEqual(order, ['work']);
  assert.equal(calls[0]?.params?.[0], 'cmd-explorer');
  assert.equal(calls[0]?.params?.[1], 'cron');
});

test('startEtlRun coerces the int8 id from a string to a number', async () => {
  const { db } = fakeDb();
  const id = await startEtlRun(db, 'cmd-census', 'cron');
  assert.equal(id, 7);
  assert.equal(typeof id, 'number');
});

test('duration is measured with the injected clock', async () => {
  const { db, calls } = fakeDb();
  let t = 1_000;
  await withEtlRun(
    {
      db,
      stage: 'cmd-census',
      triggeredBy: 'cron',
      now: () => t,
    },
    async () => {
      t = 4_500;
      return { status: 200, body: {} };
    },
  );
  const update = calls.find((c) => classify(c.sql) === 'update');
  assert.equal(update?.params?.[0], 3_500);
});

// ── Fail-soft: an unusable run log cannot break a stage ────────────────────────────────────────

test('an unapplied migration (42P01) does NOT fail the stage', async () => {
  const { db } = fakeDb({ failStart: undefinedTable });
  const result = await withEtlRun({ db, stage: 'cmd-explorer', triggeredBy: 'cron' }, async () => ({
    status: 200,
    body: { ok: true, rows_fetched: 12 },
  }));
  assert.deepEqual(result, { status: 200, body: { ok: true, rows_fetched: 12 } });
});

test('a null run id makes the close-out a no-op rather than an error', async () => {
  const { db, calls } = fakeDb();
  await finishEtlRun(db, null, { status: 'ok', durationMs: 5 });
  assert.equal(calls.length, 0);
});

test('any other logging failure is also swallowed', async () => {
  const { db } = fakeDb({ failStart: new Error('connection terminated unexpectedly') });
  const result = await withEtlRun({ db, stage: 'cmd-census', triggeredBy: 'cron' }, async () => 'work-result');
  assert.equal(result, 'work-result');
});

test('a close-out failure does not fail the stage either', async () => {
  const { db } = fakeDb({ failFinish: new Error('deadlock detected') });
  const result = await withEtlRun({ db, stage: 'cmd-census', triggeredBy: 'cron' }, async () => 'ok');
  assert.equal(result, 'ok');
});

// ── Transparency: the wrapper never alters the stage ───────────────────────────────────────────

test('a thrown stage error is recorded then RETHROWN unchanged', async () => {
  const { db, calls } = fakeDb();
  const boom = new Error('CMD returned INVALID CRITERIA');
  await assert.rejects(
    withEtlRun({ db, stage: 'cmd-explorer', triggeredBy: 'cron' }, async () => {
      throw boom;
    }),
    (err) => err === boom,
  );
  const update = calls.find((c) => classify(c.sql) === 'update');
  assert.equal(update?.params?.[1], 'error');
  assert.equal(update?.params?.[3], 'CMD returned INVALID CRITERIA');
});

test('onRunId receives the start row id', async () => {
  const { db } = fakeDb();
  let seen: number | null | undefined;
  await withEtlRun(
    { db, stage: 'cmd-census', triggeredBy: 'tick', onRunId: (id) => (seen = id) },
    async () => 'x',
  );
  assert.equal(seen, 7);
});

test('onRunId receives null when the log is unavailable', async () => {
  const { db } = fakeDb({ failStart: undefinedTable });
  let seen: number | null | undefined = 999;
  await withEtlRun(
    { db, stage: 'cmd-census', triggeredBy: 'tick', onRunId: (id) => (seen = id) },
    async () => 'x',
  );
  assert.equal(seen, null);
});

// ── classifyCronResult — the handlers catch their own errors, so status is the only signal ─────

test('a 500 from a handler that caught its own failure is recorded as an error', () => {
  // This is the case a thrown-error check alone would MISS: the four cron handlers return 500
  // rather than throwing, so without this classifier every failed ingest would log as a success.
  const v = classifyCronResult({ status: 500, body: { error: 'cron_failed' } });
  assert.equal(v.status, 'error');
  assert.equal(v.errorLabel, 'cron_failed');
});

test('a non-200 with no error field still gets a label', () => {
  const v = classifyCronResult({ status: 401, body: { } });
  assert.equal(v.status, 'error');
  assert.equal(v.errorLabel, 'http_401');
});

test('a clean 200 is ok with rows_fetched captured and no error label', () => {
  const v = classifyCronResult({ status: 200, body: { ok: true, rows_fetched: 41_532, customers_failed: 0 } });
  assert.equal(v.status, 'ok');
  assert.equal(v.rowsTouched, 41_532);
  assert.equal(v.errorLabel, null);
});

test('a PARTIAL run stays ok but surfaces the failed-customer count', () => {
  // Both cron families isolate a failing customer and continue by design, and both amortize a sweep
  // across runs. Holding the rollup on a partial explorer run would mean it almost never runs, so
  // the count is surfaced instead of being escalated to a failure.
  const v = classifyCronResult({ status: 200, body: { ok: true, rows_fetched: 900, customers_failed: 3 } });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, 'partial_customers_failed=3');
});

test('a body without rows_fetched records a null count rather than 0', () => {
  // The rollup stage reports no row count. Recording 0 would read as "refreshed nothing".
  const v = classifyCronResult({ status: 200, body: { ok: true, duration_ms: 98_000 } });
  assert.equal(v.rowsTouched, null);
});

// ── The whole-roster empty pull (2026-08-17: eleven hours of `ok` while fetching nothing) ────────

test('all customers pulled cleanly and the roster returned NOTHING => error, not ok', () => {
  // The exact body BXR's explorer returned every hour for eleven hours while the configured
  // report/filter pairing matched no rows. Nothing threw and no customer failed, so it recorded
  // `ok` and the outage was invisible in etl_run.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_total: 15, customers_processed: 15, customers_failed: 0, rows_fetched: 0 },
  });
  assert.equal(v.status, 'error');
  assert.equal(v.errorLabel, 'all_customers_empty');
  assert.equal(v.rowsTouched, 0);
});

test('a fresh-skipped census sweep is NOT an empty-roster outage', () => {
  // The census cursor legitimately skips every customer that completed inside its 24h window:
  // customers_processed 0, rows_fetched 0. Those runs are correct and must stay `ok`, which is why
  // the guard requires processed > 0 rather than keying off rows_fetched alone.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_total: 15, customers_processed: 0, customers_failed: 0,
            customers_skipped_fresh: 15, rows_fetched: 0 },
  });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, null);
});

test('an empty roster WITH failed customers keeps the more specific partial diagnosis', () => {
  // A run where customers threw is already described by partial_customers_failed; that names the
  // cause, whereas all_customers_empty would only name the symptom.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_processed: 2, customers_failed: 13, rows_fetched: 0 },
  });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, 'partial_customers_failed=13');
});

test('a healthy run with rows is untouched by the guard', () => {
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_processed: 15, customers_failed: 0, rows_fetched: 5231 },
  });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, null);
  assert.equal(v.rowsTouched, 5231);
});

// ── The whole-roster FAILURE (the other half of 2026-08-17, and the one that stayed `ok`) ─────────

test('every customer threw and none completed => error, not a "partial" success', () => {
  // The body BXR's explorer returned once the report layout changed under it: the header contract
  // threw for all 15 customers, so `customers 0/15 (failed 15), fetched 0`. This used to record
  // `status: ok` with `partial_customers_failed=15` — a total outage described in the vocabulary of
  // a survivable one, in the exact column an operator scans to decide whether anything is wrong.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_total: 15, customers_processed: 0, customers_failed: 15, rows_fetched: 0 },
  });
  assert.equal(v.status, 'error');
  assert.equal(v.errorLabel, 'all_customers_failed=15');
  assert.equal(v.rowsTouched, 0);
});

test('ONE customer surviving is still a partial success — the rule is not narrowed', () => {
  // The line is processed === 0, not failed > 0. 1 of 15 wrote real rows, so holding the rollup on
  // it would mean the rollup almost never runs; that trade-off is the whole reason partial runs
  // count as successes and this change must not erode it.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_total: 15, customers_processed: 1, customers_failed: 14, rows_fetched: 12 },
  });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, 'partial_customers_failed=14');
});

test('a body that never reports customers_processed is NOT diagnosed as a total failure', () => {
  // ABSENT is unknown, not zero. Reading a missing field as 0 would let any body that omits the
  // roster count entirely be declared an outage on the strength of a field it never claimed.
  const v = classifyCronResult({ status: 200, body: { ok: true, rows_fetched: 900, customers_failed: 3 } });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, 'partial_customers_failed=3');
});

test('a budget-skipped roster stays ok — deliberately not covered by either guard', () => {
  // processed 0 / failed 0 is indistinguishable from the census freshness-cursor case from inside
  // the classifier, and it self-heals on the next run. Pinned so that widening either guard to
  // catch it has to be a decision rather than a side effect.
  const v = classifyCronResult({
    status: 200,
    body: { ok: true, customers_total: 15, customers_processed: 0, customers_failed: 0,
            customers_skipped_budget: 15, rows_fetched: 0 },
  });
  assert.equal(v.status, 'ok');
  assert.equal(v.errorLabel, null);
});
