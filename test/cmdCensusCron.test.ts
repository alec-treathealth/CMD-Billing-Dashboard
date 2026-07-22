/**
 * Hermetic tests for the CMD charge-census CATCH-UP CRON (Qualify v2 ②b, Step 2). No live DB/LLM: a
 * fake pool/client records the full withTenant + run-log + upsert query sequence, tagging each query
 * with the connection it ran on so we can PROVE every cmd_census_run write is inside a withTenant
 * envelope (BEGIN → set_config → … → COMMIT) on that same connection.
 *
 * Locked cron invariants proved here:
 *  - fresh-skip: a customer a prior run completed OK inside the window is skipped — no fetch, no run row.
 *  - stale-repull: a not-fresh customer is pulled → START(running) → upsert → FINISH(ok), all scoped.
 *  - budget-exit-resume: once the wall-clock budget is exhausted, remaining customers are skipped
 *    WITHOUT a fetch or a run row (so they are simply not-fresh, hence re-pulled, next invocation).
 *  - error-row lifecycle: a throwing pull closes its run row status='error' with a PHI-safe STAGE
 *    LABEL only (never a message / PHI), and the loop continues.
 *  - never-finished re-attempt: the freshness predicate REQUIRES finished_at IS NOT NULL AND
 *    status='ok', so a killed (finished_at NULL) or errored row can never read as fresh.
 *  - run-log lifecycle is 100% tenant-scoped: every cmd_census_run INSERT/UPDATE ran inside a
 *    withTenant transaction on its own connection.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { cmdCensusCron, type CmdCensusTarget } from '../src/collections/cmdCensusCron.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

/** One recorded query, tagged with the connection instance it ran on. */
interface RecordedCall {
  connId: number;
  sql: string;
  params: unknown[] | undefined;
}

interface FakeDbOpts {
  /** customerIds a prior run already completed OK inside the window (freshness read returns true). */
  fresh?: Set<string>;
  /** Force the run-start INSERT to throw for these customerIds (params[1] = customerId). */
  failStartFor?: Set<string>;
}

/** A fake tenant pool: each connect() is a new connection (its own GUC), so run-log writes that
 *  escape withTenant would show a missing BEGIN/set_config on their connId. */
function fakeCensusCronDb(opts: FakeDbOpts = {}) {
  const calls: RecordedCall[] = [];
  let connCounter = 0;
  let runIdCounter = 0;

  function makeClient(connId: number) {
    let guc: string | null = null;
    return {
      async query(sql: string, params?: unknown[]) {
        calls.push({ connId, sql, params });
        if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/set_config/i.test(sql)) {
          guc = params?.[0] === undefined ? null : String(params[0]);
          return { rows: [{ set_config: guc }], rowCount: 1 };
        }
        if (/current_setting/i.test(sql)) return { rows: [{ v: guc }], rowCount: 1 };
        if (/from collections\.cmd_census_run/i.test(sql) && /as fresh/i.test(sql)) {
          return { rows: [{ fresh: opts.fresh?.has(String(params?.[0])) ?? false }], rowCount: 1 };
        }
        if (/insert into collections\.cmd_census_run/i.test(sql)) {
          if (opts.failStartFor?.has(String(params?.[1]))) throw new Error('start insert boom');
          runIdCounter += 1;
          return { rows: [{ id: String(runIdCounter) }], rowCount: 1 };
        }
        if (/update collections\.cmd_census_run/i.test(sql)) return { rows: [], rowCount: 1 };
        if (/insert into collections\.cmd_charge_census/i.test(sql)) {
          const n = (params?.length ?? 0) / 19; // INSERT_COL_COUNT
          return { rows: Array(n).fill({ inserted: true }), rowCount: n };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }

  const pool = {
    async connect() {
      connCounter += 1;
      return makeClient(connCounter);
    },
    async query() {
      throw new Error('pool.query() must never be used (txn escape)');
    },
  };
  return { db: pool as unknown as pg.Pool, calls };
}

const LIB_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const HMAC_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
process.env.LIBSODIUM_KEY = LIB_KEY;
process.env.INDEX_HMAC_KEY = HMAC_KEY;

function target(customerId: string): CmdCensusTarget {
  return { customerId, facilityCode: `F_${customerId}`, businessEntityId: BXR_ENTITY_ID };
}

/** A minimal valid census report row (charge_id + patient_name present). */
function reportRow(chargeId: string): CmdReportRow {
  return {
    'Charge ID': chargeId,
    'Patient Full Name': 'DOE, JANE',
    'Claim Primary Member ID': 'M123',
    'Charge From Date': '5/4/2026',
    'Charge CPT Code': 'H0019',
    'Charge/Debit Amount': '$100.00',
    'Facility Name': 'DALLAS MENTAL HEALTH LLC',
    'Claim Status': 'PAID',
  };
}

/** True if `connId` ran a full withTenant envelope (BEGIN + set_config, then COMMIT). */
function isTenantScoped(calls: RecordedCall[], connId: number): boolean {
  const own = calls.filter((c) => c.connId === connId);
  const hasBegin = own.some((c) => /^BEGIN/i.test(c.sql));
  const hasSetConfig = own.some((c) => /set_config/i.test(c.sql));
  const hasCommit = own.some((c) => /^COMMIT/i.test(c.sql));
  return hasBegin && hasSetConfig && hasCommit;
}

// --- fresh-skip -------------------------------------------------------------

test('fresh-skip: a recently-completed customer is skipped — no fetch, no run row', async () => {
  const { db, calls } = fakeCensusCronDb({ fresh: new Set(['C_FRESH']) });
  const fetched: string[] = [];
  const stats = await cmdCensusCron({
    customers: [target('C_FRESH'), target('C_STALE')],
    writeDb: db,
    fetchRows: async (id) => {
      fetched.push(id);
      return [reportRow('X1')];
    },
  });
  assert.equal(stats.customers_skipped_fresh, 1);
  assert.equal(stats.customers_processed, 1);
  assert.deepEqual(fetched, ['C_STALE'], 'the fresh customer is never fetched');
  // No cmd_census_run INSERT carried the fresh customer's id.
  const startInserts = calls.filter((c) => /insert into collections\.cmd_census_run/i.test(c.sql));
  assert.ok(!startInserts.some((c) => c.params?.[1] === 'C_FRESH'), 'no start row for the fresh customer');
  assert.ok(startInserts.some((c) => c.params?.[1] === 'C_STALE'), 'a start row for the stale customer');
});

// --- stale-repull + tenant-scoped lifecycle ---------------------------------

test('stale-repull: a not-fresh customer is pulled, upserted, and closed OK — all run-log writes tenant-scoped', async () => {
  const { db, calls } = fakeCensusCronDb();
  const stats = await cmdCensusCron({
    customers: [target('C1')],
    writeDb: db,
    fetchRows: async () => [reportRow('A'), reportRow('B')],
  });
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.rows_new, 2);
  assert.equal(stats.census_upserted, 2);

  const startInsert = calls.find((c) => /insert into collections\.cmd_census_run/i.test(c.sql))!;
  const finishUpdate = calls.find((c) => /update collections\.cmd_census_run/i.test(c.sql))!;
  const censusUpsert = calls.find((c) => /insert into collections\.cmd_charge_census/i.test(c.sql))!;
  // status='ok' with the counts, and never touching a fresh predicate.
  assert.match(finishUpdate.sql, /status = 'ok'/);
  // EVERY run-log + census write ran inside a withTenant envelope on its own connection.
  for (const c of [startInsert, finishUpdate, censusUpsert]) {
    assert.ok(isTenantScoped(calls, c.connId), `write on conn ${c.connId} must be inside withTenant`);
  }
  // START precedes the census upsert precedes FINISH (durability ordering).
  assert.ok(calls.indexOf(startInsert) < calls.indexOf(censusUpsert), 'start row before the upsert');
  assert.ok(calls.indexOf(censusUpsert) < calls.indexOf(finishUpdate), 'upsert before the finish');
});

// --- budget-exit-resume -----------------------------------------------------

test('budget-exit-resume: once the budget is exhausted, remaining customers are skipped with no fetch/run row', async () => {
  const { db, calls } = fakeCensusCronDb();
  const fetched: string[] = [];
  // now() sequence: started=0, cust1 check=100 (under 1000), cust2 check=2000 (over), cust3=3000 (over).
  const ticks = [0, 100, 2000, 3000];
  let i = 0;
  const stats = await cmdCensusCron({
    customers: [target('C1'), target('C2'), target('C3')],
    writeDb: db,
    budgetMs: 1000,
    now: () => ticks[Math.min(i++, ticks.length - 1)]!,
    fetchRows: async (id) => {
      fetched.push(id);
      return [reportRow('A')];
    },
  });
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.customers_skipped_budget, 2);
  assert.deepEqual(fetched, ['C1'], 'only the first customer is fetched before the budget trips');
  const startInserts = calls.filter((c) => /insert into collections\.cmd_census_run/i.test(c.sql));
  assert.equal(startInserts.length, 1, 'no run rows for budget-skipped customers');
  assert.equal(startInserts[0]!.params?.[1], 'C1');
});

// --- error-row lifecycle ----------------------------------------------------

test('error-row lifecycle: a failing fetch closes the run row status=error with a PHI-safe stage label; loop continues', async () => {
  const { db, calls } = fakeCensusCronDb();
  const stats = await cmdCensusCron({
    customers: [target('C_BAD'), target('C_OK')],
    writeDb: db,
    fetchRows: async (id) => {
      if (id === 'C_BAD') throw new Error('HTTP 400 https://cmd.example/report?patient=SMITH,JOHN'); // message must NOT leak to the run row
      return [reportRow('A')];
    },
  });
  assert.equal(stats.customers_failed, 1);
  assert.equal(stats.customers_processed, 1, 'the loop continued to the healthy customer');

  const errorUpdate = calls.find(
    (c) => /update collections\.cmd_census_run/i.test(c.sql) && c.params?.some((p) => p === 'fetch_failed'),
  );
  assert.ok(errorUpdate, 'the failed run row was closed with the fetch_failed stage label');
  assert.match(errorUpdate!.sql, /status = 'error'/);
  // The error_label is a bounded stage token — never the message, URL, or PHI.
  const label = String(errorUpdate!.params?.[1]);
  assert.match(label, /^(fetch_failed|write_failed)$/);
  // No cmd_census_run write anywhere carried the leaky message / PHI.
  const runWrites = calls.filter((c) => /collections\.cmd_census_run/i.test(c.sql));
  for (const c of runWrites) {
    for (const p of c.params ?? []) {
      assert.doesNotMatch(String(p), /SMITH|JOHN|cmd\.example|HTTP 400/, 'no message/URL/PHI in a run-log param');
    }
  }
});

test('run-start failure is isolated: counted failed, no crash, loop continues', async () => {
  const { db } = fakeCensusCronDb({ failStartFor: new Set(['C_BAD']) });
  const stats = await cmdCensusCron({
    customers: [target('C_BAD'), target('C_OK')],
    writeDb: db,
    fetchRows: async () => [reportRow('A')],
  });
  assert.equal(stats.customers_failed, 1);
  assert.equal(stats.customers_processed, 1);
});

// --- never-finished re-attempt (the freshness predicate guard) --------------

test('never-finished re-attempt: the freshness predicate requires finished_at IS NOT NULL AND status=ok', async () => {
  const { db, calls } = fakeCensusCronDb();
  await cmdCensusCron({
    customers: [target('C1')],
    writeDb: db,
    fetchRows: async () => [reportRow('A')],
  });
  const freshRead = calls.find((c) => /from collections\.cmd_census_run/i.test(c.sql) && /as fresh/i.test(c.sql))!;
  assert.match(freshRead.sql, /finished_at is not null/i, 'a killed (finished_at NULL) row must not be fresh');
  assert.match(freshRead.sql, /status = 'ok'/i, 'an errored row must not be fresh');
  assert.match(freshRead.sql, /started_at >= now\(\) - make_interval/i, 'bounded by the staleness window');
  // The freshness read itself is tenant-scoped.
  assert.ok(isTenantScoped(calls, freshRead.connId), 'freshness read runs inside withTenant');
});

// --- transformRows (Indigo facility-column alias hook) ----------------------

test('transformRows is applied to fetched rows before mapping', async () => {
  const { db } = fakeCensusCronDb();
  let transformed = false;
  const stats = await cmdCensusCron({
    customers: [target('C1')],
    writeDb: db,
    fetchRows: async () => [reportRow('A')],
    transformRows: (rows) => {
      transformed = true;
      return rows;
    },
  });
  assert.equal(transformed, true);
  assert.equal(stats.customers_processed, 1);
});

// --- revalidate gating ------------------------------------------------------

test('revalidate fires only when a customer was processed', async () => {
  // processed → fires
  {
    const { db } = fakeCensusCronDb();
    let fired = 0;
    await cmdCensusCron({ customers: [target('C1')], writeDb: db, fetchRows: async () => [reportRow('A')], revalidate: () => { fired += 1; } });
    assert.equal(fired, 1);
  }
  // all fresh → nothing processed → does not fire
  {
    const { db } = fakeCensusCronDb({ fresh: new Set(['C1']) });
    let fired = 0;
    await cmdCensusCron({ customers: [target('C1')], writeDb: db, fetchRows: async () => [reportRow('A')], revalidate: () => { fired += 1; } });
    assert.equal(fired, 0);
  }
});
