/**
 * Hermetic tests for src/veris/withTenant.ts — the single-client, transaction-
 * local tenant scoping discipline (S2). No DB, no network: a fake pool/client
 * records the exact query sequence.
 *
 * Locked invariants:
 *  - BEGIN → set_config('app.business_entity_id', $1, true) → callback queries
 *    on the SAME client → COMMIT, in that order, all on one client.
 *  - The GUC is TRANSACTION-local (`true` third arg) — the pooler-leak class.
 *  - The GUC name is a fixed literal; the tenant uuid is the only bound param.
 *  - Callback failure → ROLLBACK (never COMMIT) → client released → rethrow.
 *  - COMMIT failure → ROLLBACK attempted → client released → rethrow.
 *  - Malformed (non-uuid) tenant id fails BEFORE a connection is taken.
 *  - pool.query() is never used — every statement goes through the client.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { withTenant, TENANT_GUC } from '../src/veris/withTenant.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

interface Recorded {
  sql: string;
  params: unknown[] | undefined;
}

/** Fake PoolClient recording every query; can be told to fail on a statement. */
function fakeClient(failOn?: (sql: string) => boolean) {
  const calls: Recorded[] = [];
  let released = 0;
  let guc: string | null = null;
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (failOn?.(sql)) throw new Error(`fake failure on: ${sql}`);
      // Simulate the GUC handshake: set_config stores the bound tenant id; the read-back returns
      // it, so withTenant's post-set_config assertion sees the tenant it set (not an empty result).
      if (/set_config/i.test(sql)) {
        guc = params?.[0] === undefined ? null : String(params[0]);
        return { rows: [{ set_config: guc }], rowCount: 1 };
      }
      if (/current_setting/i.test(sql)) return { rows: [{ v: guc }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      released += 1;
    },
  };
  return { client, calls, releasedCount: () => released };
}

/** Fake Pool: hands out the one fake client; pool.query() is FORBIDDEN. */
function fakePool(client: unknown) {
  let connects = 0;
  const pool = {
    async connect() {
      connects += 1;
      return client;
    },
    async query() {
      throw new Error('pool.query() must never be used by withTenant (txn escape)');
    },
  };
  return { pool: pool as unknown as pg.Pool, connectCount: () => connects };
}

test('happy path: BEGIN -> txn-local set_config -> callback on same client -> COMMIT -> release', async () => {
  const { client, calls, releasedCount } = fakeClient();
  const { pool } = fakePool(client);

  const result = await withTenant(pool, BXR_ENTITY_ID, async (c) => {
    // The callback must receive the exact client the pool handed out.
    assert.equal(c, client as unknown as pg.PoolClient);
    await c.query('select 1 from staging.claim_line', []);
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(calls.map((c) => c.sql), [
    'BEGIN',
    `select set_config('${TENANT_GUC}', $1, true)`,
    `select current_setting('${TENANT_GUC}', true) as v`,
    'select 1 from staging.claim_line',
    'COMMIT',
  ]);
  assert.equal(releasedCount(), 1);
});

test('the GUC is set transaction-locally with the uuid as the ONLY bound param', async () => {
  const { client, calls } = fakeClient();
  const { pool } = fakePool(client);

  await withTenant(pool, INDIGO_ENTITY_ID, async () => undefined);

  const setCall = calls[1]!;
  // Fixed literal GUC name + txn-local `true` in the SQL text; value bound as $1.
  assert.equal(setCall.sql, "select set_config('app.business_entity_id', $1, true)");
  assert.deepEqual(setCall.params, [INDIGO_ENTITY_ID]);
});

test('callback failure: ROLLBACK (no COMMIT), client released, error rethrown', async () => {
  const { client, calls, releasedCount } = fakeClient();
  const { pool } = fakePool(client);

  await assert.rejects(
    withTenant(pool, BXR_ENTITY_ID, async () => {
      throw new Error('callback boom');
    }),
    /callback boom/,
  );

  const sqls = calls.map((c) => c.sql);
  assert.ok(sqls.includes('ROLLBACK'), 'must roll back');
  assert.ok(!sqls.includes('COMMIT'), 'must not commit');
  assert.equal(releasedCount(), 1);
});

test('COMMIT failure: ROLLBACK attempted, client released, error rethrown', async () => {
  const { client, calls, releasedCount } = fakeClient((sql) => sql === 'COMMIT');
  const { pool } = fakePool(client);

  await assert.rejects(
    withTenant(pool, BXR_ENTITY_ID, async () => 'never returned'),
    /fake failure on: COMMIT/,
  );

  const sqls = calls.map((c) => c.sql);
  assert.deepEqual(sqls, [
    'BEGIN',
    `select set_config('${TENANT_GUC}', $1, true)`,
    `select current_setting('${TENANT_GUC}', true) as v`,
    'COMMIT',
    'ROLLBACK',
  ]);
  assert.equal(releasedCount(), 1);
});

test('a failing ROLLBACK is swallowed; the ORIGINAL error surfaces and the client is still released', async () => {
  const { client, releasedCount } = fakeClient((sql) => sql === 'ROLLBACK');
  const { pool } = fakePool(client);

  await assert.rejects(
    withTenant(pool, BXR_ENTITY_ID, async () => {
      throw new Error('original error');
    }),
    /original error/,
  );
  assert.equal(releasedCount(), 1);
});

test('malformed tenant id: rejected BEFORE any connection is taken', async () => {
  const { client } = fakeClient();
  const { pool, connectCount } = fakePool(client);

  for (const bad of ['', 'not-a-uuid', "af504ab6'; drop table x; --", `${BXR_ENTITY_ID} `]) {
    await assert.rejects(
      withTenant(pool, bad, async () => 'unreachable'),
      /canonical UUID literal/,
    );
  }
  assert.equal(connectCount(), 0);
});

test('canonical tenant constants pass the uuid gate (BXR + Indigo)', async () => {
  const { client } = fakeClient();
  const { pool } = fakePool(client);
  assert.equal(await withTenant(pool, BXR_ENTITY_ID, async () => 1), 1);
  assert.equal(await withTenant(pool, INDIGO_ENTITY_ID, async () => 2), 2);
});
