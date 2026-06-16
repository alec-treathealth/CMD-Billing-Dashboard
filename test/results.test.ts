import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clientHistoryResultsSql,
  fetchResults,
  filterResultsSql,
  readmissionResultsSql,
} from '../src/routes/results.js';
import { getColumns } from '../src/queries/columns.js';
import { computeIdentityHash, normalizeMemberId } from '../src/queries/identity.js';
import type { FunctionName, QueryExecutor } from '../src/queries/types.js';

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
    created_at: '2026-06-11T00:00:00.000Z',
    expires_at: '2026-06-11T01:00:00.000Z',
    created_by: 'sess-1',
    function_name: functionName,
    arguments: args,
    summary_stats: {},
  };
}

/**
 * Fake executor: returns `log` (or nothing) for the get_query_log lookup, and
 * `dataRows` for the subsequent row-level query. Records every call so the test
 * can assert the exact re-execution SQL/params and that nothing ran when it must
 * fail-closed.
 */
function makeFake(
  log: FakeLogRow | null,
  dataRows: Record<string, unknown>[],
  verifyExpectedHash?: string,
) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('claims.get_query_log')) {
        return { rows: (log ? [log] : []) as T[], rowCount: log ? 1 : 0 };
      }
      if (sql.includes('claims.verify_identity')) {
        // Server-side comparison: true only when the route's recomputed hash
        // (params[1]) equals the configured "stored" hash.
        const ok = verifyExpectedHash !== undefined && params[1] === verifyExpectedHash;
        return { rows: [{ ok }] as T[], rowCount: 1 };
      }
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

function ctxWith(executor: QueryExecutor, audit: string[]) {
  return {
    executor,
    now: () => new Date('2026-06-11T00:30:00.000Z'),
    audit: (line: string) => audit.push(line),
  };
}

const INPUT = { query_id: 'q-1', created_by: 'sess-9' };

// --- valid re-execution, exact SQL/params/columns per function -------------

test('distribution: re-executes the filtered slice with only allowlisted columns (no PHI)', async () => {
  const cols = getColumns('distribution');
  const { executor, calls } = makeFake(
    logRow('distribution', { field: 'payer_name', metric: 'count', filter: { payer: 'Aetna' } }),
    [{ id: 1, payer_name: 'Aetna' }, { id: 2, payer_name: 'Aetna' }],
  );
  const audit: string[] = [];
  const res = await fetchResults(INPUT, ctxWith(executor, audit));

  assert.equal(res.function_name, 'distribution');
  assert.equal(res.query_id, 'q-1');
  assert.equal(res.rows.length, 2);

  // get_query_log lookup, then the row-level SELECT.
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.sql.includes('claims.get_query_log($1)'));
  assert.deepEqual(calls[0]!.params, ['q-1']);
  // Bounded reveal: filter at $1, then limit ($2 = pageSize+1 = 51) / offset ($3 = 0).
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'lower(payer_name) = lower($1)', 2, 3));
  assert.deepEqual(calls[1]!.params, ['Aetna', 51, 0]);
  assert.ok(calls[1]!.sql.includes('order by id limit $2 offset $3'));

  // Allowlist content: a non-PHI distribution projects NO patient identifiers.
  assert.ok(!calls[1]!.sql.includes('patient_name'));
  assert.ok(!calls[1]!.sql.includes('member_id'));
  assert.ok(calls[1]!.sql.startsWith('select id, '));

  // Audit: counts only, exact shape, no row content.
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-11T00:30:00.000Z',
    query_id: 'q-1',
    function_name: 'distribution',
    row_count: 2,
    created_by: 'sess-9',
  });
});

test('payer_gap_analysis: re-executes the filter, no patient identifiers projected', async () => {
  const cols = getColumns('payer_gap_analysis');
  const { executor, calls } = makeFake(
    logRow('payer_gap_analysis', { filter: { date_from: '2025-01-01' } }),
    [{ id: 7, payer_name: 'Cigna' }],
  );
  const res = await fetchResults(INPUT, ctxWith(executor, []));

  assert.equal(res.function_name, 'payer_gap_analysis');
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'date_of_service >= $1', 2, 3));
  assert.deepEqual(calls[1]!.params, ['2025-01-01', 51, 0]);
  assert.ok(!calls[1]!.sql.includes('patient_name'));
});

test('search_claims: projects patient identifiers (record-level review path)', async () => {
  const cols = getColumns('search_claims');
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    [{ id: 11, patient_name: 'DOE, JANE' }],
  );
  const res = await fetchResults(INPUT, ctxWith(executor, []));

  assert.equal(res.function_name, 'search_claims');
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'lower(facility_name) = lower($1)', 2, 3));
  assert.deepEqual(calls[1]!.params, ['My Time Recovery', 51, 0]);
  // This is the PHI path for search_claims — identifiers ARE in the projection.
  assert.ok(calls[1]!.sql.includes('patient_name'));
  assert.ok(calls[1]!.sql.includes('member_id_norm'));
});

test('search_claims (single-claim reveal): stored id filter re-runs WHERE id = $1, one row, audit no PHI', async () => {
  // Phase 8.0: a /claims/[claimId] reveal stores { filter: { id } }; the results
  // route re-runs the search_claims projection scoped to that one synthetic id.
  const cols = getColumns('search_claims');
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { id: 4242 } }),
    [{ id: 4242, patient_name: 'DOE, JANE', member_id_norm: 'PGE081' }],
  );
  const audit: string[] = [];
  const res = await fetchResults(INPUT, ctxWith(executor, audit));

  assert.equal(res.function_name, 'search_claims');
  assert.equal(res.rows.length, 1);

  // Scoped re-execution: id at $1, then limit ($2=51) / offset ($3=0).
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'id = $1', 2, 3));
  assert.deepEqual(calls[1]!.params, [4242, 51, 0]);
  // The reveal IS the PHI path for search_claims — identifiers are in the projection.
  assert.ok(calls[1]!.sql.includes('patient_name'));
  assert.ok(calls[1]!.sql.includes('member_id_norm'));

  // Audit line: counts only — never the row content / patient identifiers.
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-11T00:30:00.000Z',
    query_id: 'q-1',
    function_name: 'search_claims',
    row_count: 1,
    created_by: 'sess-9',
  });
  assert.ok(!audit[0]!.includes('DOE'));
  assert.ok(!audit[0]!.includes('PGE081'));
});

test('readmission_candidates: re-runs the self-join, a_/b_ pair projection + computed fields', async () => {
  const cols = getColumns('readmission_candidates');
  const { executor, calls } = makeFake(
    logRow('readmission_candidates', { gap_days: 14, filter: { facility: 'My Time Recovery' } }),
    [{ confidence: 'exact', gap_days: 14, a_id: 1, b_id: 2 }],
  );
  const res = await fetchResults(INPUT, ctxWith(executor, []));

  assert.equal(res.function_name, 'readmission_candidates');
  // gap_days is $1; the filter is numbered from $2; limit ($3=51) / offset ($4=0) follow.
  assert.equal(
    calls[1]!.sql,
    readmissionResultsSql(cols, 'lower(facility_name) = lower($2)', 3, 4),
  );
  assert.deepEqual(calls[1]!.params, [14, 'My Time Recovery', 51, 0]);

  // Pair projection (both sides) + computed confidence / gap_days; id -> a_id/b_id.
  assert.ok(calls[1]!.sql.includes('a.patient_last as a_patient_last'));
  assert.ok(calls[1]!.sql.includes('b.patient_last as b_patient_last'));
  assert.ok(calls[1]!.sql.includes('a.id as a_id, b.id as b_id'));
  assert.ok(calls[1]!.sql.includes('end as confidence'));
  assert.ok(calls[1]!.sql.includes("($1)::int as gap_days"));
  assert.ok(calls[1]!.sql.includes('where confidence is not null'));
});

test('readmission_candidates: no filter — gap_days $1 only, no WHERE in the CTE', async () => {
  const cols = getColumns('readmission_candidates');
  const { executor, calls } = makeFake(
    logRow('readmission_candidates', { gap_days: 30, filter: {} }),
    [],
  );
  await fetchResults(INPUT, ctxWith(executor, []));
  assert.equal(calls[1]!.sql, readmissionResultsSql(cols, '', 2, 3));
  assert.deepEqual(calls[1]!.params, [30, 51, 0]);
  assert.ok(!calls[1]!.sql.includes('where lower'));
});

// --- fail-closed paths -----------------------------------------------------

test('missing/expired query_id: empty result, function_name null, no data SQL run', async () => {
  const { executor, calls } = makeFake(null, []); // get_query_log returns nothing
  const audit: string[] = [];
  const res = await fetchResults(INPUT, ctxWith(executor, audit));

  assert.deepEqual(res, {
    rows: [],
    function_name: null,
    query_id: 'q-1',
    pageSize: 50,
    offset: 0,
    hasNext: false,
  });
  assert.equal(calls.length, 1); // only the lookup; no row-level query
  // Still audited as an access attempt, with a null function and zero rows.
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-11T00:30:00.000Z',
    query_id: 'q-1',
    function_name: null,
    row_count: 0,
    created_by: 'sess-9',
  });
});

test('unknown function_name: throws before any data SQL', async () => {
  const { executor, calls } = makeFake(logRow('totally_unknown', { filter: {} }), []);
  await assert.rejects(
    () => fetchResults(INPUT, ctxWith(executor, [])),
    /no column allowlist registered for function_name "totally_unknown"/,
  );
  assert.equal(calls.length, 1); // lookup only; getColumns threw before re-execution
});

// --- client_history identity verification ----------------------------------

test('client_history: valid identity verifies, then serves the row-level query', async () => {
  const cols = getColumns('client_history');
  const storedHash = computeIdentityHash('Doe', normalizeMemberId(undefined), 'q-1');
  const { executor, calls } = makeFake(
    logRow('client_history', { match_threshold: 0.4, filter: {} }),
    [{ id: 1, patient_name: 'DOE, JANE', patient_last: 'Doe' }],
    storedHash,
  );
  const audit: string[] = [];
  const res = await fetchResults(
    { ...INPUT, identity: { patient_last: 'Doe' } },
    ctxWith(executor, audit),
  );

  assert.equal(res.function_name, 'client_history');
  assert.equal(res.rows.length, 1);

  // get_query_log -> verify_identity -> row-level SELECT.
  assert.equal(calls.length, 3);
  assert.ok(calls[1]!.sql.includes('claims.verify_identity($1, $2)'));
  assert.deepEqual(calls[1]!.params, ['q-1', storedHash]);
  // patient_last $1, threshold $2, then limit ($3=51) / offset ($4=0).
  assert.equal(calls[2]!.sql, clientHistoryResultsSql(cols, false, '', 3, 4));
  assert.deepEqual(calls[2]!.params, ['Doe', 0.4, 51, 0]);
  // Full identified-patient projection includes identity columns.
  assert.ok(calls[2]!.sql.includes('member_id_norm'));
  assert.ok(calls[2]!.sql.includes('employer_name'));

  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-11T00:30:00.000Z',
    query_id: 'q-1',
    function_name: 'client_history',
    row_count: 1,
    created_by: 'sess-9',
  });
});

test('client_history: with member id — $3 narrowing, filter follows from $4', async () => {
  const cols = getColumns('client_history');
  const memberNorm = normalizeMemberId('pge081');
  const storedHash = computeIdentityHash('Doe', memberNorm, 'q-1');
  const { executor, calls } = makeFake(
    logRow('client_history', { match_threshold: 0.4, filter: { payer: 'Aetna' } }),
    [{ id: 1, patient_last: 'Doe' }],
    storedHash,
  );
  const res = await fetchResults(
    { ...INPUT, identity: { patient_last: 'Doe', member_id_norm: 'pge081' } },
    ctxWith(executor, []),
  );

  assert.equal(res.rows.length, 1);
  // member_id_norm $3, filter $4, then limit ($5=51) / offset ($6=0).
  assert.equal(
    calls[2]!.sql,
    clientHistoryResultsSql(cols, true, 'lower(payer_name) = lower($4)', 5, 6),
  );
  assert.deepEqual(calls[2]!.params, ['Doe', 0.4, memberNorm, 'Aetna', 51, 0]);
});

test('client_history: wrong identity fails verification -> empty (fail-closed), no row query', async () => {
  const storedHash = computeIdentityHash('Doe', normalizeMemberId(undefined), 'q-1');
  const { executor, calls } = makeFake(
    logRow('client_history', { match_threshold: 0.4, filter: {} }),
    [{ id: 1, patient_last: 'Doe' }],
    storedHash, // stored identity is "Doe"...
  );
  const res = await fetchResults(
    { ...INPUT, identity: { patient_last: 'Smith' } }, // ...caller supplies "Smith"
    ctxWith(executor, []),
  );

  assert.deepEqual(res, {
    rows: [],
    function_name: 'client_history',
    query_id: 'q-1',
    pageSize: 50,
    offset: 0,
    hasNext: false,
  });
  assert.equal(calls.length, 2); // lookup + verify; verify returned false, no PHI query
});

test('client_history: missing identity -> empty (fail-closed) before any verify call', async () => {
  const { executor, calls } = makeFake(
    logRow('client_history', { match_threshold: 0.4, filter: {} }),
    [{ id: 1, patient_last: 'Doe' }],
    'unused',
  );
  const res = await fetchResults(INPUT, ctxWith(executor, [])); // no identity supplied

  assert.deepEqual(res, {
    rows: [],
    function_name: 'client_history',
    query_id: 'q-1',
    pageSize: 50,
    offset: 0,
    hasNext: false,
  });
  assert.equal(calls.length, 1); // lookup only; verify_identity never called
});

test('identity field on a non-client_history query is silently ignored', async () => {
  const cols = getColumns('search_claims');
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    [{ id: 11, patient_name: 'DOE, JANE' }],
  );
  const res = await fetchResults(
    { ...INPUT, identity: { patient_last: 'Doe' } }, // ignored for search_claims
    ctxWith(executor, []),
  );

  assert.equal(res.function_name, 'search_claims');
  assert.equal(calls.length, 2); // lookup + row query; no verify_identity call
  assert.ok(!calls.some((c) => c.sql.includes('verify_identity')));
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'lower(facility_name) = lower($1)', 2, 3));
});

// --- bounded pagination -----------------------------------------------------

test('reveal is bounded: default page is 50 rows (limit bound 51, offset 0)', async () => {
  const cols = getColumns('search_claims');
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    [{ id: 1, patient_name: 'DOE, JANE' }],
  );
  const res = await fetchResults(INPUT, ctxWith(executor, []));

  assert.equal(res.pageSize, 50);
  assert.equal(res.offset, 0);
  // filter $1, then limit $2 = 50 + 1, offset $3 = 0.
  assert.equal(calls[1]!.sql, filterResultsSql(cols, 'lower(facility_name) = lower($1)', 2, 3));
  assert.deepEqual(calls[1]!.params, ['My Time Recovery', 51, 0]);
});

test('reveal page size is capped at 200 (limit bound 201) and offset passes through', async () => {
  const cols = getColumns('search_claims');
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    [{ id: 1, patient_name: 'DOE, JANE' }],
  );
  const res = await fetchResults(
    { ...INPUT, limit: 5000, offset: 200 },
    ctxWith(executor, []),
  );

  assert.equal(res.pageSize, 200); // clamped down from 5000
  assert.equal(res.offset, 200);
  assert.deepEqual(calls[1]!.params, ['My Time Recovery', 201, 200]);
});

test('reveal: a negative/invalid limit & offset fall back to the defaults', async () => {
  const { executor, calls } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    [{ id: 1 }],
  );
  const res = await fetchResults(
    { ...INPUT, limit: 0, offset: -10 },
    ctxWith(executor, []),
  );

  assert.equal(res.pageSize, 50);
  assert.equal(res.offset, 0);
  assert.deepEqual(calls[1]!.params, ['My Time Recovery', 51, 0]);
});

test('reveal: hasNext is true and the extra (limit+1) row is trimmed off the page', async () => {
  // The fake returns 51 rows for a page size of 50; the route must serve 50 and
  // report hasNext, never shipping the extra probe row.
  const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, patient_name: 'X' }));
  const { executor } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    fiftyOne,
  );
  const audit: string[] = [];
  const res = await fetchResults(INPUT, ctxWith(executor, audit));

  assert.equal(res.rows.length, 50); // trimmed to the page size
  assert.equal(res.hasNext, true);
  // Audit reports rows actually served (50), not the 51-row probe.
  assert.equal(JSON.parse(audit[0]!).row_count, 50);
});

test('reveal: hasNext is false when the slice fits within one page', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
  const { executor } = makeFake(
    logRow('search_claims', { filter: { facility: 'My Time Recovery' } }),
    ten,
  );
  const res = await fetchResults(INPUT, ctxWith(executor, []));
  assert.equal(res.rows.length, 10);
  assert.equal(res.hasNext, false);
});

// --- column allowlist registry --------------------------------------------

test('getColumns: every function has an id-keyed allowlist; unknown names throw', () => {
  const names: FunctionName[] = [
    'distribution',
    'payer_gap_analysis',
    'search_claims',
    'client_history',
    'readmission_candidates',
  ];
  for (const n of names) {
    const cols = getColumns(n);
    assert.ok(cols.length > 0);
    assert.equal(cols[0], 'id', `${n} allowlist must start with the id row key`);
  }
  // Identity-bearing functions carry the mandated identifier columns.
  for (const n of ['search_claims', 'client_history', 'readmission_candidates'] as const) {
    const cols = getColumns(n);
    for (const id of ['patient_name', 'patient_last', 'patient_first', 'member_id_raw', 'member_id_norm']) {
      assert.ok(cols.includes(id), `${n} must include ${id}`);
    }
  }
  // Non-identity functions carry NO patient identifiers.
  for (const n of ['distribution', 'payer_gap_analysis'] as const) {
    const cols = getColumns(n);
    for (const id of ['patient_name', 'patient_last', 'member_id_raw', 'member_id_norm']) {
      assert.ok(!cols.includes(id), `${n} must NOT include ${id}`);
    }
  }
  assert.throws(() => getColumns('nope'), /no column allowlist registered/);
});
