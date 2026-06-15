import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildToolResultBlock,
  isToolName,
  runAgentTurn,
  TOOL_DEFS,
  TOOL_NAMES,
} from '../src/agent/index.js';
import type { AnthropicMessage, MessageCreateParams } from '../src/agent/index.js';
import {
  validateClientHistory,
  validateDistribution,
  validateReadmissionCandidates,
} from '../src/agent/index.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

/**
 * Fake Anthropic client: records the params it was called with and returns a
 * caller-supplied response (mirrors the query-fixture pattern — a well-formed
 * tool_use block, no live LLM).
 */
function makeFakeClient(response: AnthropicMessage) {
  const calls: MessageCreateParams[] = [];
  const client = {
    messages: {
      async create(params: MessageCreateParams): Promise<AnthropicMessage> {
        calls.push(params);
        return response;
      },
    },
  };
  return { client, calls };
}

function toolUseResponse(name: string, input: unknown): AnthropicMessage {
  return {
    id: 'msg_fake',
    model: 'claude-opus-4-8',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake_1', name, input }],
    usage: { input_tokens: 321, output_tokens: 42, cache_read_input_tokens: 0 },
  };
}

/**
 * Fake executor: returns canned data rows for the function's data query and a
 * synthetic id for claims.log_query. Records calls so we can assert PHI never
 * reached the DB as anything but a bound param.
 */
function makeFakeExecutor(dataRows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('claims.log_query')) {
        return { rows: [{ id: params[0] }] as T[], rowCount: 1 };
      }
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

function queryCtx(executor: QueryExecutor): QueryContext {
  return {
    executor,
    createdBy: 'sess-agent',
    uuid: () => 'qid-fixed-0001',
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    // Swallow the query library's own finalize() audit line in tests.
    audit: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tool definitions mirror the five query functions
// ---------------------------------------------------------------------------

test('TOOL_DEFS: one tool per query function, names match FunctionName', () => {
  assert.equal(TOOL_DEFS.length, 5);
  assert.deepEqual(
    TOOL_DEFS.map((t) => t.name).sort(),
    [...TOOL_NAMES].sort(),
  );
  // distribution schema mirrors DistributionArgs (enums + required).
  const dist = TOOL_DEFS.find((t) => t.name === 'distribution')!;
  assert.deepEqual(dist.input_schema.required, ['field', 'metric']);
  assert.deepEqual((dist.input_schema.properties.field as { enum: string[] }).enum, [
    'facility_name',
    'payer_name',
    'hcpcs_code',
    'revenue_code',
    'source_year',
  ]);
  // client_history requires patient_last (the PHI search term).
  const ch = TOOL_DEFS.find((t) => t.name === 'client_history')!;
  assert.deepEqual(ch.input_schema.required, ['patient_last']);
});

test('isToolName: only the five names pass', () => {
  assert.equal(isToolName('distribution'), true);
  assert.equal(isToolName('client_history'), true);
  assert.equal(isToolName('drop_table'), false);
  assert.equal(isToolName('DISTRIBUTION'), false);
});

// ---------------------------------------------------------------------------
// Happy path: NL question → one tool call → non-PHI result
// ---------------------------------------------------------------------------

test('runAgentTurn: dispatches one tool call and returns summary_stats + query_id', async () => {
  const { client, calls } = makeFakeClient(
    toolUseResponse('distribution', { field: 'payer_name', metric: 'count' }),
  );
  const { executor } = makeFakeExecutor([
    { value: 'Aetna', metric_value: '150' },
    { value: 'Cigna', metric_value: '50' },
  ]);
  const audit: string[] = [];

  const res = await runAgentTurn('break down claims by payer', {
    client,
    queryCtx: queryCtx(executor),
    audit: (l) => audit.push(l),
    now: () => new Date('2026-06-12T00:00:00.000Z'),
  });

  assert.equal(res.status, 'ok');
  if (res.status !== 'ok') throw new Error('expected ok outcome');
  assert.equal(res.tool_name, 'distribution');
  assert.equal(res.query_id, 'qid-fixed-0001');
  assert.equal(res.tool_use_id, 'toolu_fake_1');
  assert.deepEqual(res.summary_stats, {
    field: 'payer_name',
    metric: 'count',
    buckets: [
      { value: 'Aetna', metric_value: 150, pct_of_total: 75 },
      { value: 'Cigna', metric_value: 50, pct_of_total: 25 },
    ],
  });

  // Single tool call per turn: tool_choice any + disable_parallel.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.tool_choice, {
    type: 'any',
    disable_parallel_tool_use: true,
  });
  assert.equal(calls[0]!.tools!.length, 5);
  assert.equal(calls[0]!.messages[0]!.content, 'break down claims by payer');
});

test('runAgentTurn: PHI-safe audit line — tool, query_id, tokens; no args/transcript', async () => {
  const { client } = makeFakeClient(
    toolUseResponse('distribution', { field: 'facility_name', metric: 'total_paid' }),
  );
  const { executor } = makeFakeExecutor([{ value: 'Covenant', metric_value: '100' }]);
  const audit: string[] = [];

  await runAgentTurn('total paid by facility', {
    client,
    queryCtx: queryCtx(executor),
    audit: (l) => audit.push(l),
    now: () => new Date('2026-06-12T00:00:00.000Z'),
  });

  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-12T00:00:00.000Z',
    layer: 'agent',
    tool_name: 'distribution',
    query_id: 'qid-fixed-0001',
    input_tokens: 321,
    output_tokens: 42,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: null,
  });
});

// ---------------------------------------------------------------------------
// client_history: PHI in, non-PHI out
// ---------------------------------------------------------------------------

test('runAgentTurn: client_history returns only non-PHI summary; identity never reflected', async () => {
  const { client } = makeFakeClient(
    toolUseResponse('client_history', { patient_last: 'Mossandfar', member_id_norm: 'PGE081' }),
  );
  const { executor, calls: dbCalls } = makeFakeExecutor([
    {
      source_year: 2025,
      claim_count: '7',
      distinct_facilities: '2',
      distinct_payers: '1',
      total_charge: '5000',
      total_paid: '3000',
      avg_collection_rate: '0.6',
      date_from: '2025-01-01',
      date_to: '2025-09-09',
    },
  ]);
  const audit: string[] = [];

  const res = await runAgentTurn('show the claim history for patient Mossandfar', {
    client,
    queryCtx: queryCtx(executor),
    audit: (l) => audit.push(l),
    now: () => new Date('2026-06-12T00:00:00.000Z'),
  });

  // The result surfaced to the caller/UI carries no identity field.
  assert.equal(res.status, 'ok');
  if (res.status !== 'ok') throw new Error('expected ok outcome');
  assert.equal(res.tool_name, 'client_history');
  const summaryJson = JSON.stringify(res.summary_stats);
  assert.ok(!summaryJson.includes('Mossandfar'));
  assert.ok(!summaryJson.includes('PGE081'));
  assert.equal((res.summary_stats as { rows_matched: number }).rows_matched, 7);

  // The model-facing tool result is summary_stats + query_id ONLY.
  const block = buildToolResultBlock(res);
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'toolu_fake_1');
  const parsed = JSON.parse(block.content);
  assert.deepEqual(Object.keys(parsed).sort(), ['query_id', 'summary_stats']);
  assert.ok(!block.content.includes('Mossandfar'));
  assert.ok(!block.content.includes('PGE081'));

  // The audit line never carries the patient terms.
  assert.ok(!audit[0]!.includes('Mossandfar'));
  assert.ok(!audit[0]!.includes('PGE081'));

  // query_log.arguments (stored args) never carries the patient terms — only the
  // bound DATA query receives them as $1 / $3 params.
  const logCall = dbCalls.find((c) => c.sql.includes('claims.log_query'))!;
  const storedArgs = logCall.params[3] as string;
  assert.ok(!storedArgs.includes('Mossandfar'));
  assert.ok(!storedArgs.includes('PGE081'));
  const dataCall = dbCalls.find((c) => !c.sql.includes('claims.log_query'))!;
  assert.deepEqual(dataCall.params.slice(0, 3), ['Mossandfar', 0.4, 'PGE081']);
});

// ---------------------------------------------------------------------------
// Deterministic needs_input for over-broad search_claims (Phase 7.6)
// ---------------------------------------------------------------------------

/** The patient-identifier fields the field-picker must NEVER request. */
const PHI_FIELDS = [
  'patient_name',
  'patient_first',
  'patient_last',
  'member_id_raw',
  'member_id_norm',
  'group_number',
  'employer_name',
];

test('runAgentTurn: empty-filter search_claims returns needs_input (no DB call, no PHI fields)', async () => {
  const { client } = makeFakeClient(toolUseResponse('search_claims', {}));
  const { executor, calls: dbCalls } = makeFakeExecutor([]);
  const audit: string[] = [];

  const res = await runAgentTurn('show me the claims', {
    client,
    queryCtx: queryCtx(executor),
    audit: (l) => audit.push(l),
  });

  assert.equal(res.status, 'needs_input');
  if (res.status !== 'needs_input') throw new Error('expected needs_input');
  assert.equal(res.tool_name, 'search_claims');
  assert.ok(res.missing.length > 0);
  // The picker only ever offers safe, non-PHI filter fields.
  for (const f of PHI_FIELDS) assert.ok(!res.missing.includes(f), `missing must not include PHI field ${f}`);
  // Nothing ran: no DB call, no query_log, no audit line.
  assert.equal(dbCalls.length, 0);
  assert.equal(audit.length, 0);
});

test('runAgentTurn: narrowed search_claims executes normally (ok + query_id)', async () => {
  const { client } = makeFakeClient(
    toolUseResponse('search_claims', { filter: { source_year: 2025 } }),
  );
  const { executor } = makeFakeExecutor([
    {
      rows_matched: '12',
      total_charge: '4000',
      total_allowed: '2500',
      total_paid: '2200',
      avg_collection_rate: '0.88',
      rate_anomaly_count: '0',
      date_from: '2025-01-01',
      date_to: '2025-12-31',
      distinct_facilities: '2',
      distinct_payers: '1',
    },
  ]);

  const res = await runAgentTurn('claims in 2025', {
    client,
    queryCtx: queryCtx(executor),
    audit: () => {},
  });

  assert.equal(res.status, 'ok');
  if (res.status !== 'ok') throw new Error('expected ok outcome');
  assert.equal(res.tool_name, 'search_claims');
  assert.equal(res.query_id, 'qid-fixed-0001');
  assert.equal((res.summary_stats as { rows_matched: number }).rows_matched, 12);
});

// ---------------------------------------------------------------------------
// Untrusted model output is validated before dispatch
// ---------------------------------------------------------------------------

test('runAgentTurn: rejects a tool name outside the allowlist (no dispatch)', async () => {
  const { client } = makeFakeClient(toolUseResponse('drop_table', { sql: 'DROP TABLE claims' }));
  const { executor, calls: dbCalls } = makeFakeExecutor([]);

  await assert.rejects(
    runAgentTurn('delete everything', { client, queryCtx: queryCtx(executor), audit: () => {} }),
    /unknown tool/,
  );
  assert.equal(dbCalls.length, 0); // nothing reached the DB
});

test('runAgentTurn: rejects malformed tool input before any DB call', async () => {
  const { client } = makeFakeClient(
    // metric is not in the allowlist
    toolUseResponse('distribution', { field: 'payer_name', metric: 'wire_transfer' }),
  );
  const { executor, calls: dbCalls } = makeFakeExecutor([]);

  await assert.rejects(
    runAgentTurn('q', { client, queryCtx: queryCtx(executor), audit: () => {} }),
    /metric must be one of/,
  );
  assert.equal(dbCalls.length, 0);
});

test('runAgentTurn: throws when the model returns no tool call', async () => {
  const { client } = makeFakeClient({
    content: [{ type: 'text', text: 'I cannot help with that.' }],
    stop_reason: 'end_turn',
  });
  const { executor } = makeFakeExecutor([]);

  await assert.rejects(
    runAgentTurn('hello', { client, queryCtx: queryCtx(executor), audit: () => {} }),
    /no tool call/,
  );
});

// ---------------------------------------------------------------------------
// Boundary validators (unit)
// ---------------------------------------------------------------------------

test('validateDistribution: coerces filter, rejects bad enum', () => {
  assert.deepEqual(
    validateDistribution({ field: 'source_year', metric: 'count', filter: { payer: 'Aetna' } }),
    { field: 'source_year', metric: 'count', filter: { payer: 'Aetna' } },
  );
  assert.throws(() => validateDistribution({ field: 'ssn', metric: 'count' }), /field must be one of/);
  assert.throws(() => validateDistribution('nope'), /must be a JSON object/);
});

test('validateClientHistory: requires non-empty patient_last', () => {
  assert.deepEqual(validateClientHistory({ patient_last: 'Doe' }), {
    patient_last: 'Doe',
    member_id_norm: undefined,
    filter: undefined,
  });
  assert.throws(() => validateClientHistory({ patient_last: '   ' }), /non-empty/);
  assert.throws(() => validateClientHistory({ member_id_norm: 'X' }), /patient_last must be a string/);
});

test('validateReadmissionCandidates: gap_days must be numeric when present', () => {
  assert.deepEqual(validateReadmissionCandidates({ facility: 'A', gap_days: 14 }), {
    facility: 'A',
    payer: undefined,
    date_from: undefined,
    date_to: undefined,
    gap_days: 14,
  });
  assert.throws(
    () => validateReadmissionCandidates({ gap_days: 'thirty' }),
    /gap_days must be a number/,
  );
});
