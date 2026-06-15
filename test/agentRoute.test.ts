import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAgentRequest } from '../src/routes/agentHandler.js';
import type { AnthropicMessage, MessageCreateParams } from '../src/agent/index.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

const SECRET = 'test-secret-1234567890';

function fakeClient(name: string, input: unknown) {
  const response: AnthropicMessage = {
    id: 'msg_fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  return {
    messages: {
      async create(_p: MessageCreateParams): Promise<AnthropicMessage> {
        return response;
      },
    },
  };
}

/** No-tool response (model declined). */
function noToolClient() {
  return {
    messages: {
      async create(_p: MessageCreateParams): Promise<AnthropicMessage> {
        return { content: [{ type: 'text', text: 'no' }], stop_reason: 'end_turn' };
      },
    },
  };
}

function fakeExecutor(dataRows: Array<Record<string, unknown>>) {
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      if (sql.includes('claims.log_query')) {
        return { rows: [{ id: params[0] }] as T[], rowCount: 1 };
      }
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return executor;
}

function deps(client: ReturnType<typeof fakeClient>, dataRows: Array<Record<string, unknown>>) {
  const seen: string[] = [];
  const makeQueryCtx = (createdBy: string): QueryContext => {
    seen.push(createdBy);
    return {
      executor: fakeExecutor(dataRows),
      createdBy,
      uuid: () => 'qid-route-1',
      now: () => new Date('2026-06-12T00:00:00.000Z'),
      audit: () => {},
    };
  };
  return { d: { client, makeQueryCtx, secret: SECRET, now: () => new Date('2026-06-12T00:00:00.000Z') }, seen };
}

const AUTH = `Bearer ${SECRET}`;

test('agent route: GET (any non-POST) returns 405', async () => {
  const { d } = deps(fakeClient('distribution', { field: 'payer_name', metric: 'count' }), []);
  const res = await handleAgentRequest({ method: 'GET', authorization: AUTH, body: null }, d);
  assert.equal(res.status, 405);
  assert.deepEqual(res.body, { error: 'method_not_allowed' });
});

test('agent route: 401 without a valid Bearer token (no dispatch)', async () => {
  const { d } = deps(fakeClient('distribution', { field: 'payer_name', metric: 'count' }), []);
  const res = await handleAgentRequest({ authorization: 'Bearer wrong', body: { question: 'x' } }, d);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
});

test('agent route: 400 on a body missing a question', async () => {
  const { d } = deps(fakeClient('distribution', { field: 'payer_name', metric: 'count' }), []);
  assert.equal((await handleAgentRequest({ authorization: AUTH, body: {} }, d)).status, 400);
  assert.equal((await handleAgentRequest({ authorization: AUTH, body: { question: '  ' } }, d)).status, 400);
});

test('agent route: 200 returns tool_name + query_id + non-PHI summary_stats', async () => {
  const { d, seen } = deps(fakeClient('distribution', { field: 'payer_name', metric: 'count' }), [
    { value: 'Aetna', metric_value: '3' },
  ]);
  const res = await handleAgentRequest(
    { authorization: AUTH, body: { question: 'break down by payer' }, createdBy: 'sess-42' },
    d,
  );
  assert.equal(res.status, 200);
  const body = res.body as { tool_name: string; query_id: string; summary_stats: unknown };
  assert.equal(body.tool_name, 'distribution');
  assert.equal(body.query_id, 'qid-route-1');
  assert.ok(body.summary_stats);
  // No PHI keys ever in the response body.
  const json = JSON.stringify(res.body);
  for (const k of ['patient_name', 'patient_last', 'member_id', 'rows', 'employer']) {
    assert.ok(!json.includes(k), `response must not contain ${k}`);
  }
  // The authenticated principal flows to the audit/query_log path.
  assert.deepEqual(seen, ['sess-42']);
});

test('agent route: over-broad search_claims returns 200 needs_input (no query ran)', async () => {
  // Model picks search_claims with no filter — the deterministic guard intervenes.
  const { d } = deps(fakeClient('search_claims', {}), []);
  const res = await handleAgentRequest(
    { authorization: AUTH, body: { question: 'show me all the claims' } },
    d,
  );
  assert.equal(res.status, 200);
  const body = res.body as { status: string; tool_name: string; missing: string[]; query_id?: string };
  assert.equal(body.status, 'needs_input');
  assert.equal(body.tool_name, 'search_claims');
  assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
  // No query ran — there is no query_id on a needs_input response.
  assert.equal(body.query_id, undefined);
  // No PHI fields offered.
  for (const k of ['patient_name', 'patient_last', 'member_id_norm', 'employer_name', 'group_number']) {
    assert.ok(!body.missing.includes(k), `missing must not include ${k}`);
  }
});

test('agent route: narrowed search_claims returns 200 ok with query_id', async () => {
  const { d } = deps(fakeClient('search_claims', { filter: { source_year: 2025 } }), [
    {
      rows_matched: '5',
      total_charge: '100',
      total_allowed: '80',
      total_paid: '70',
      avg_collection_rate: '0.875',
      rate_anomaly_count: '0',
      date_from: '2025-01-01',
      date_to: '2025-12-31',
      distinct_facilities: '1',
      distinct_payers: '1',
    },
  ]);
  const res = await handleAgentRequest(
    { authorization: AUTH, body: { question: 'claims in 2025' } },
    d,
  );
  assert.equal(res.status, 200);
  const body = res.body as { status: string; tool_name: string; query_id: string };
  assert.equal(body.status, 'ok');
  assert.equal(body.tool_name, 'search_claims');
  assert.equal(body.query_id, 'qid-route-1');
});

test('agent route: client_history through the route returns no identity', async () => {
  const { d } = deps(
    fakeClient('client_history', { patient_last: 'Mossandfar', member_id_norm: 'PGE081' }),
    [
      {
        source_year: 2025,
        claim_count: '4',
        distinct_facilities: '1',
        distinct_payers: '1',
        total_charge: '100',
        total_paid: '60',
        avg_collection_rate: '0.6',
        date_from: '2025-01-01',
        date_to: '2025-02-02',
      },
    ],
  );
  const res = await handleAgentRequest(
    { authorization: AUTH, body: { question: 'history for Mossandfar' } },
    d,
  );
  assert.equal(res.status, 200);
  const json = JSON.stringify(res.body);
  assert.ok(!json.includes('Mossandfar'));
  assert.ok(!json.includes('PGE081'));
});

test('agent route: 500 (generic) when the model picks an unknown tool — no leak', async () => {
  const { d } = deps(fakeClient('drop_table', { sql: 'DROP TABLE claims' }), []);
  const res = await handleAgentRequest({ authorization: AUTH, body: { question: 'x' } }, d);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'agent_failed' });
  assert.ok(!JSON.stringify(res.body).includes('drop_table'));
});

test('agent route: 500 (generic) when the model returns no tool call', async () => {
  const { d } = deps(noToolClient() as ReturnType<typeof fakeClient>, []);
  const res = await handleAgentRequest({ authorization: AUTH, body: { question: 'hi' } }, d);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'agent_failed' });
});
