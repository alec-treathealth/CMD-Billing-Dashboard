import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleCollectionsDailyRequest,
  handleCollectionsKpisRequest,
} from '../src/routes/collectionsQueryHandlers.js';
import type { CollectionsQueryContext } from '../src/collections/daily.js';
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

function deps(exec: QueryExecutor): { ctx: CollectionsQueryContext; secret: string } {
  return { ctx: { executor: exec, createdBy: 'api', audit: () => {} }, secret: SECRET };
}

const DAILY_ROWS = [
  { payment_date: '2026-06-30', facility_code: 'CAMH', facility_name: 'X', checks_amount: '1', eft_amount: '0', gross_amount: '1' },
];
const KPI_ROWS = [
  { as_of: '2026-06-30', facility_code: 'CAMH', facility_name: 'X', mtd_checks: '1', mtd_eft: '0', mtd_gross: '1', ytd_checks: '1', ytd_eft: '0', ytd_gross: '1' },
];

// --- daily handler -----------------------------------------------------------

test('daily: POST → 405', async () => {
  const r = await handleCollectionsDailyRequest({ method: 'POST', authorization: `Bearer ${SECRET}` }, deps(executor(DAILY_ROWS)));
  assert.equal(r.status, 405);
});

test('daily: missing/wrong bearer → 401, executor not called', async () => {
  let called = false;
  const exec = executor(DAILY_ROWS, () => { called = true; });
  assert.equal((await handleCollectionsDailyRequest({ method: 'GET' }, deps(exec))).status, 401);
  assert.equal((await handleCollectionsDailyRequest({ method: 'GET', authorization: 'Bearer no' }, deps(exec))).status, 401);
  assert.equal(called, false);
});

test('daily: GET + bearer → 200 with non-PHI rows', async () => {
  const r = await handleCollectionsDailyRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, query: { facility: 'CAMH' } },
    deps(executor(DAILY_ROWS)),
  );
  assert.equal(r.status, 200);
  const body = r.body as { row_count: number };
  assert.equal(body.row_count, 1);
  assert.ok(!JSON.stringify(body).includes('source_group_code'));
});

test('daily: malformed from → 400, executor not called', async () => {
  let called = false;
  const exec = executor(DAILY_ROWS, () => { called = true; });
  const r = await handleCollectionsDailyRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, query: { from: '6/1/2026' } },
    deps(exec),
  );
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('daily: unexpected failure → generic 500', async () => {
  const exploding: QueryExecutor = { async query() { throw new Error('relation collections.daily_collections missing'); } };
  const r = await handleCollectionsDailyRequest({ method: 'GET', authorization: `Bearer ${SECRET}` }, deps(exploding));
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'daily_failed' });
});

// --- kpis handler ------------------------------------------------------------

test('kpis: POST → 405; missing bearer → 401', async () => {
  assert.equal((await handleCollectionsKpisRequest({ method: 'POST', authorization: `Bearer ${SECRET}` }, deps(executor(KPI_ROWS)))).status, 405);
  assert.equal((await handleCollectionsKpisRequest({ method: 'GET' }, deps(executor(KPI_ROWS)))).status, 401);
});

test('kpis: GET + bearer → 200 with MTD/YTD body', async () => {
  const r = await handleCollectionsKpisRequest({ method: 'GET', authorization: `Bearer ${SECRET}` }, deps(executor(KPI_ROWS)));
  assert.equal(r.status, 200);
  const body = r.body as { as_of: string; mtd: { gross: number }; ytd: { gross: number } };
  assert.equal(body.as_of, '2026-06-30');
  assert.equal(body.mtd.gross, 1);
  assert.equal(body.ytd.gross, 1);
});

test('kpis: malformed as_of → 400, executor not called', async () => {
  let called = false;
  const exec = executor(KPI_ROWS, () => { called = true; });
  const r = await handleCollectionsKpisRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, query: { as_of: '2026/06/30' } },
    deps(exec),
  );
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('kpis: unexpected failure → generic 500', async () => {
  const exploding: QueryExecutor = { async query() { throw new Error('boom'); } };
  const r = await handleCollectionsKpisRequest({ method: 'GET', authorization: `Bearer ${SECRET}` }, deps(exploding));
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'kpis_failed' });
});
