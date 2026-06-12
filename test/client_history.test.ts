import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientHistory, clientHistorySql } from '../src/queries/client_history.js';
import { computeIdentityHash, normalizeMemberId } from '../src/queries/identity.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

interface FakeRow {
  source_year: number | string;
  claim_count: string;
  distinct_facilities: string;
  distinct_payers: string;
  total_charge: string;
  total_paid: string;
  avg_collection_rate: string | null;
  date_from: string | null;
  date_to: string | null;
}

function makeFake(dataRows: FakeRow[]) {
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

function ctxWith(executor: QueryExecutor, audit: string[]): QueryContext {
  return {
    executor,
    createdBy: 'sess-1',
    uuid: () => 'fixed-uuid-0000',
    now: () => new Date('2026-06-10T00:00:00.000Z'),
    audit: (line) => audit.push(line),
  };
}

const yr = (over: Partial<FakeRow> & { source_year: number }): FakeRow => ({
  claim_count: '0',
  distinct_facilities: '0',
  distinct_payers: '0',
  total_charge: '0',
  total_paid: '0',
  avg_collection_rate: null,
  date_from: null,
  date_to: null,
  ...over,
});

test('client_history: last-name only — similarity SQL, per-year roll-up, identity_hash, PHI never logged', async () => {
  const { executor, calls } = makeFake([
    yr({
      source_year: 2024,
      claim_count: '12',
      distinct_facilities: '2',
      distinct_payers: '1',
      total_charge: '6000',
      total_paid: '4000',
      avg_collection_rate: '0.6700',
      date_from: '2024-02-01',
      date_to: '2024-11-20',
    }),
    yr({
      source_year: 2025,
      claim_count: '8',
      distinct_facilities: '1',
      distinct_payers: '2',
      total_charge: '3000',
      total_paid: '2500',
      avg_collection_rate: '0.8300',
      date_from: '2025-01-15',
      date_to: '2025-09-09',
    }),
  ]);
  const audit: string[] = [];
  const res = await clientHistory({ patient_last: 'SMITH' }, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    rows_matched: 20, // 12 + 8
    match_threshold: 0.4,
    by_source_year: [
      {
        source_year: 2024,
        claim_count: 12,
        distinct_facilities: 2,
        distinct_payers: 1,
        total_charge: 6000,
        total_paid: 4000,
        avg_collection_rate: 0.67,
        date_from: '2024-02-01',
        date_to: '2024-11-20',
      },
      {
        source_year: 2025,
        claim_count: 8,
        distinct_facilities: 1,
        distinct_payers: 2,
        total_charge: 3000,
        total_paid: 2500,
        avg_collection_rate: 0.83,
        date_from: '2025-01-15',
        date_to: '2025-09-09',
      },
    ],
  });

  // Exact SQL: similarity term + threshold, grouped by year. No member clause.
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.sql,
    'select source_year, count(*) as claim_count, ' +
      'count(distinct facility_name) as distinct_facilities, ' +
      'count(distinct payer_name) as distinct_payers, ' +
      'coalesce(sum(charge_amount), 0) as total_charge, ' +
      'coalesce(sum(paid_amount), 0) as total_paid, ' +
      'avg(collection_rate) as avg_collection_rate, ' +
      'min(date_of_service)::text as date_from, ' +
      'max(date_of_service)::text as date_to ' +
      'from claims.claims where claims.similarity(patient_last, $1) >= $2 ' +
      'group by source_year order by source_year',
  );
  // patient_last is a BOUND parameter (never interpolated, never stored).
  assert.deepEqual(calls[0]!.params, ['SMITH', 0.4]);

  // query_log write: function_name, identity_hash matching the canonical helper.
  const log = calls[1]!;
  assert.equal(log.params[2], 'client_history');
  const expectedHash = computeIdentityHash('SMITH', '', 'fixed-uuid-0000');
  assert.equal(log.params[5], expectedHash);
  assert.match(log.params[5] as string, /^[0-9a-f]{64}$/);

  // CRITICAL PHI BOUNDARY: stored args contain NO patient terms — only non-PHI.
  const storedArgs = JSON.parse(log.params[3] as string);
  assert.deepEqual(storedArgs, { match_threshold: 0.4, filter: {} });
  const storedJson = log.params[3] as string;
  assert.ok(!storedJson.includes('SMITH'), 'patient_last must not appear in stored args');

  // Audit line carries presence flags only — never the search terms.
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-10T00:00:00.000Z',
    function_name: 'client_history',
    args_shape: { has_member_id: false, filter_keys: [] },
    query_id: 'fixed-uuid-0000',
    result_row_count: 20,
  });
  assert.ok(!audit[0]!.includes('SMITH'), 'patient_last must not appear in the audit line');
});

test('client_history: with member id + filter — $3 member clause, filter params follow, hash folds member', async () => {
  const { executor, calls } = makeFake([
    yr({ source_year: 2024, claim_count: '3', total_charge: '900', total_paid: '750' }),
  ]);
  const audit: string[] = [];
  const res = await clientHistory(
    { patient_last: 'GARCIA', member_id_norm: 'PGE081', filter: { payer: 'Aetna' } },
    ctxWith(executor, audit),
  );

  assert.equal(res.summary_stats.rows_matched, 3);

  // member_id_norm bound at $3; the filter value bound at $4.
  assert.equal(
    calls[0]!.sql,
    'select source_year, count(*) as claim_count, ' +
      'count(distinct facility_name) as distinct_facilities, ' +
      'count(distinct payer_name) as distinct_payers, ' +
      'coalesce(sum(charge_amount), 0) as total_charge, ' +
      'coalesce(sum(paid_amount), 0) as total_paid, ' +
      'avg(collection_rate) as avg_collection_rate, ' +
      'min(date_of_service)::text as date_from, ' +
      'max(date_of_service)::text as date_to ' +
      'from claims.claims where claims.similarity(patient_last, $1) >= $2 ' +
      'and member_id_norm = $3 and lower(payer_name) = lower($4) ' +
      'group by source_year order by source_year',
  );
  assert.deepEqual(calls[0]!.params, ['GARCIA', 0.4, 'PGE081', 'Aetna']);

  // Hash folds in the (normalized) member id.
  const log = calls[1]!;
  assert.equal(log.params[5], computeIdentityHash('GARCIA', 'PGE081', 'fixed-uuid-0000'));

  // Stored args: filter retained (non-PHI), member id absent; audit flags presence.
  const storedJson = log.params[3] as string;
  assert.deepEqual(JSON.parse(storedJson), { match_threshold: 0.4, filter: { payer: 'Aetna' } });
  assert.ok(!storedJson.includes('GARCIA') && !storedJson.includes('PGE081'));
  assert.deepEqual(JSON.parse(audit[0]!).args_shape, {
    has_member_id: true,
    filter_keys: ['payer'],
  });
});

test('client_history: member id normalized (negative 2024 id) for both $3 and the hash', async () => {
  const { executor, calls } = makeFake([yr({ source_year: 2024, claim_count: '1' })]);
  const audit: string[] = [];
  // Mixed-case, padded, leading-minus member id -> normalized to '11724767'.
  await clientHistory(
    { patient_last: 'covenant hills client', member_id_norm: '  -11724767 ' },
    ctxWith(executor, audit),
  );

  assert.equal(normalizeMemberId('  -11724767 '), '11724767');
  // $3 carries the normalized id, matching what ingest stored in member_id_norm.
  assert.equal(calls[0]!.params[2], '11724767');
  assert.equal(
    calls[1]!.params[5],
    computeIdentityHash('covenant hills client', '11724767', 'fixed-uuid-0000'),
  );
});

test('client_history: empty match still logs with identity_hash; rows_matched 0', async () => {
  const { executor, calls } = makeFake([]);
  const audit: string[] = [];
  const res = await clientHistory({ patient_last: 'NobodyHere' }, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    rows_matched: 0,
    match_threshold: 0.4,
    by_source_year: [],
  });
  // Even an empty client_history result carries a non-null identity_hash, so the
  // results route's fail-closed guard (function_name<>'client_history' OR
  // identity_hash IS NOT NULL) does not reject the row.
  assert.match(calls[1]!.params[5] as string, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(audit[0]!).result_row_count, 0);
});

test('client_history: rejects empty/blank patient_last before any SQL runs', async () => {
  const { executor, calls } = makeFake([]);
  const audit: string[] = [];
  await assert.rejects(
    () => clientHistory({ patient_last: '   ' }, ctxWith(executor, audit)),
    /patient_last must be non-empty/,
  );
  await assert.rejects(
    // @ts-expect-error — patient_last is required and must be a string.
    () => clientHistory({}, ctxWith(executor, audit)),
    /patient_last must be a string/,
  );
  assert.equal(calls.length, 0); // nothing executed, nothing logged
});

test('clientHistorySql: member clause and filter clause are gated independently', () => {
  assert.ok(!clientHistorySql(false, '').includes('member_id_norm'));
  assert.ok(clientHistorySql(true, '').includes('and member_id_norm = $3'));
  assert.ok(clientHistorySql(false, 'source_year = $3').includes('and source_year = $3'));
});
