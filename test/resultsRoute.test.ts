import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleResultsRequest } from '../src/routes/resultsHandler.js';
import { computeIdentityHash, normalizeMemberId } from '../src/queries/identity.js';
import type { ResultsContext } from '../src/routes/results.js';
import type { QueryExecutor } from '../src/queries/types.js';

const SECRET = 'results-secret-1234567890';
const AUTH = `Bearer ${SECRET}`;

interface FakeLogRow {
  id: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  function_name: string;
  arguments: Record<string, unknown>;
  summary_stats: Record<string, unknown>;
}

function logRow(functionName: string, args: Record<string, unknown>): FakeLogRow {
  return {
    id: 'q-1',
    created_at: '2026-06-12T00:00:00.000Z',
    expires_at: '2026-06-12T01:00:00.000Z',
    created_by: 'sess-1',
    function_name: functionName,
    arguments: args,
    summary_stats: {},
  };
}

/** Mirrors test/results.test.ts: get_query_log, verify_identity, then data rows. */
function fakeExecutor(
  log: FakeLogRow | null,
  dataRows: Array<Record<string, unknown>>,
  verifyExpectedHash?: string,
) {
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      if (sql.includes('claims.get_query_log')) {
        return { rows: (log ? [log] : []) as T[], rowCount: log ? 1 : 0 };
      }
      if (sql.includes('claims.verify_identity')) {
        const ok = verifyExpectedHash !== undefined && params[1] === verifyExpectedHash;
        return { rows: [{ ok }] as T[], rowCount: 1 };
      }
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return executor;
}

function ctxWith(executor: QueryExecutor): ResultsContext {
  return { executor, now: () => new Date('2026-06-12T00:30:00.000Z'), audit: () => {} };
}

test('results route: GET (any non-POST) returns 405 — PHI must never ride a URL', async () => {
  const ctx = ctxWith(fakeExecutor(logRow('distribution', {}), []));
  // 405 holds regardless of auth — the method is rejected before auth is checked.
  const res = await handleResultsRequest(
    { method: 'GET', authorization: AUTH, body: { query_id: 'q-1' } },
    { ctx, secret: SECRET },
  );
  assert.equal(res.status, 405);
  assert.deepEqual(res.body, { error: 'method_not_allowed' });

  const unauthed = await handleResultsRequest(
    { method: 'GET', authorization: null, body: null },
    { ctx, secret: SECRET },
  );
  assert.equal(unauthed.status, 405);
});

test('results route: 401 without a valid Bearer token', async () => {
  const ctx = ctxWith(fakeExecutor(logRow('distribution', {}), []));
  const res = await handleResultsRequest(
    { authorization: 'Bearer nope', body: { query_id: 'q-1' } },
    { ctx, secret: SECRET },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
});

test('results route: 400 when query_id is missing/blank', async () => {
  const ctx = ctxWith(fakeExecutor(logRow('distribution', {}), []));
  assert.equal(
    (await handleResultsRequest({ authorization: AUTH, body: {} }, { ctx, secret: SECRET })).status,
    400,
  );
  assert.equal(
    (await handleResultsRequest({ authorization: AUTH, body: { query_id: '' } }, { ctx, secret: SECRET }))
      .status,
    400,
  );
});

test('results route: 200 returns PHI rows for a re-executed filter query', async () => {
  const ctx = ctxWith(
    fakeExecutor(logRow('distribution', { field: 'payer_name', metric: 'count', filter: { payer: 'Aetna' } }), [
      { id: 1, payer_name: 'Aetna', patient_name: 'DOE, JANE' },
    ]),
  );
  const res = await handleResultsRequest(
    { authorization: AUTH, body: { query_id: 'q-1' }, createdBy: 'sess-9' },
    { ctx, secret: SECRET },
  );
  assert.equal(res.status, 200);
  const body = res.body as { function_name: string; query_id: string; rows: unknown[] };
  assert.equal(body.function_name, 'distribution');
  assert.equal(body.query_id, 'q-1');
  assert.equal(body.rows.length, 1);
});

test('results route: client_history serves rows only when re-supplied identity verifies', async () => {
  const queryId = 'q-1';
  const patientLast = 'Mossandfar';
  const memberNorm = normalizeMemberId('PGE081');
  const storedHash = computeIdentityHash(patientLast, memberNorm, queryId);

  const ctx = ctxWith(
    fakeExecutor(
      logRow('client_history', { match_threshold: 0.4, filter: {} }),
      [{ id: 1, patient_name: 'MOSSANDFAR, A', member_id_norm: 'PGE081' }],
      storedHash,
    ),
  );

  // Correct identity -> rows served.
  const ok = await handleResultsRequest(
    {
      authorization: AUTH,
      body: { query_id: queryId, identity: { patient_last: patientLast, member_id_norm: 'PGE081' } },
    },
    { ctx, secret: SECRET },
  );
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { rows: unknown[] }).rows.length, 1);

  // Missing identity -> fail-closed empty (still 200, no PHI).
  const missing = await handleResultsRequest(
    { authorization: AUTH, body: { query_id: queryId } },
    { ctx, secret: SECRET },
  );
  assert.equal(missing.status, 200);
  assert.deepEqual((missing.body as { rows: unknown[] }).rows, []);

  // Wrong identity -> fail-closed empty.
  const wrong = await handleResultsRequest(
    { authorization: AUTH, body: { query_id: queryId, identity: { patient_last: 'Wrong' } } },
    { ctx, secret: SECRET },
  );
  assert.equal(wrong.status, 200);
  assert.deepEqual((wrong.body as { rows: unknown[] }).rows, []);
});

test('results route: missing/expired handle fails closed to empty rows', async () => {
  const ctx = ctxWith(fakeExecutor(null, []));
  const res = await handleResultsRequest(
    { authorization: AUTH, body: { query_id: 'gone' } },
    { ctx, secret: SECRET },
  );
  assert.equal(res.status, 200);
  const body = res.body as { function_name: string | null; rows: unknown[] };
  assert.equal(body.function_name, null);
  assert.deepEqual(body.rows, []);
});
