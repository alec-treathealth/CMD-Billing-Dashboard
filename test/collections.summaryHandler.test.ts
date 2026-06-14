import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCollectionsSummaryRequest } from '../src/routes/collectionsSummaryHandler.js';
import type { CollectionsSummaryContext } from '../src/collections/summary.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

const SECRET = 'test-secret';

function executor(rows: Record<string, unknown>[], onCall?: () => void): QueryExecutor {
  return {
    async query<T>(): Promise<ExecResult<T>> {
      onCall?.();
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

function deps(exec: QueryExecutor): { ctx: CollectionsSummaryContext; secret: string } {
  return { ctx: { executor: exec, createdBy: 'api', audit: () => {} }, secret: SECRET };
}

const ROWS = [
  { month: '2026-03', facility_code: 'X', facility_name: 'Treat X', day_rows: '2', checks_amount: '10', eft_amount: '0', gross_amount: '10' },
];

test('non-GET verb → 405 (independent of auth)', async () => {
  const res = await handleCollectionsSummaryRequest(
    { method: 'POST', authorization: `Bearer ${SECRET}` },
    deps(executor(ROWS)),
  );
  assert.equal(res.status, 405);
});

test('missing/wrong bearer → 401, executor not called', async () => {
  let called = false;
  const exec = executor(ROWS, () => { called = true; });
  const missing = await handleCollectionsSummaryRequest({ method: 'GET' }, deps(exec));
  assert.equal(missing.status, 401);
  const wrong = await handleCollectionsSummaryRequest(
    { method: 'GET', authorization: 'Bearer nope' },
    deps(exec),
  );
  assert.equal(wrong.status, 401);
  assert.equal(called, false, 'auth must gate before any DB work');
});

test('valid GET + bearer → 200 with non-PHI summary body', async () => {
  const res = await handleCollectionsSummaryRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps(executor(ROWS)),
  );
  assert.equal(res.status, 200);
  const body = res.body as { rows_analyzed: number; by_month_facility: unknown[] };
  assert.equal(body.rows_analyzed, 2);
  assert.equal(body.by_month_facility.length, 1);
  assert.ok(!JSON.stringify(body).includes('source_group_code'));
});

test('malformed date bound → 400, executor not called', async () => {
  let called = false;
  const exec = executor(ROWS, () => { called = true; });
  const res = await handleCollectionsSummaryRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, query: { from: '03/01/2026' } },
    deps(exec),
  );
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('valid date bounds pass through', async () => {
  const res = await handleCollectionsSummaryRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, query: { from: '2026-01-01', to: '2026-04-01' } },
    deps(executor(ROWS)),
  );
  assert.equal(res.status, 200);
});

test('unexpected DB failure → generic 500 (never echoed)', async () => {
  const exploding: QueryExecutor = {
    async query() {
      throw new Error('relation "collections.daily_collections" does not exist');
    },
  };
  const res = await handleCollectionsSummaryRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps(exploding),
  );
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'summary_failed' });
});
