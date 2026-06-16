import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchClaims, searchClaimsSql } from '../src/queries/search_claims.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

/** The single aggregate row pg returns (numerics/counts as strings, dates as text). */
interface FakeRow {
  rows_matched: string;
  total_charge: string;
  total_allowed: string;
  total_paid: string;
  avg_collection_rate: string | null;
  rate_anomaly_count: string;
  date_from: string | null;
  date_to: string | null;
  distinct_facilities: string;
  distinct_payers: string;
}

/**
 * Fake executor: records every (sql, params), returns the single canned
 * aggregate row for the data query and a synthetic id for claims.log_query.
 * Same pattern as the other query-function fixtures — no live database.
 */
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

const EXPECTED_SELECT =
  'select count(*) as rows_matched, ' +
  'coalesce(sum(charge_amount), 0) as total_charge, ' +
  'coalesce(sum(allowed_amount), 0) as total_allowed, ' +
  'coalesce(sum(paid_amount), 0) as total_paid, ' +
  'avg(collection_rate) as avg_collection_rate, ' +
  'count(*) filter (where paid_amount is not null and allowed_amount is not null ' +
  'and collection_rate is null) as rate_anomaly_count, ' +
  'min(date_of_service)::text as date_from, ' +
  'max(date_of_service)::text as date_to, ' +
  'count(distinct facility_name) as distinct_facilities, ' +
  'count(distinct payer_name) as distinct_payers ' +
  'from claims.claims';

test('search_claims: no filter — full summary, exact SQL, query_id, log + audit', async () => {
  const { executor, calls } = makeFake([
    {
      rows_matched: '320116',
      total_charge: '5000000',
      total_allowed: '3000000',
      total_paid: '2500000',
      avg_collection_rate: '0.7421',
      rate_anomaly_count: '128',
      date_from: '2024-01-02',
      date_to: '2026-05-30',
      distinct_facilities: '37',
      distinct_payers: '54',
    },
  ]);
  const audit: string[] = [];
  const res = await searchClaims({}, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    rows_matched: 320116,
    total_charge: 5000000,
    total_allowed: 3000000,
    total_paid: 2500000,
    avg_collection_rate: 0.7421,
    rate_anomaly_count: 128,
    date_from: '2024-01-02',
    date_to: '2026-05-30',
    distinct_facilities: 37,
    distinct_payers: 54,
  });
  assert.equal(res.query_id, 'fixed-uuid-0000');

  // Exact parameterized data SQL (no filter -> no WHERE), no params.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.sql, EXPECTED_SELECT);
  assert.deepEqual(calls[0]!.params, []);

  // query_log write: function_name, non-PHI args, null identity_hash.
  const log = calls[1]!;
  assert.match(log.sql, /select claims\.log_query\(\$1, \$2, \$3, \$4::jsonb, \$5::jsonb, \$6\)/);
  assert.equal(log.params[2], 'search_claims');
  assert.deepEqual(JSON.parse(log.params[3] as string), { filter: {} });
  assert.equal(log.params[5], null);

  // Audit line: result_row_count = rows_matched (the underlying PHI-row count).
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-10T00:00:00.000Z',
    function_name: 'search_claims',
    args_shape: { filter_keys: [] },
    query_id: 'fixed-uuid-0000',
    result_row_count: 320116,
  });
});

test('search_claims: filter incl. new code keys — parameterized WHERE, order preserved', async () => {
  const { executor, calls } = makeFake([
    {
      rows_matched: '12',
      total_charge: '4000',
      total_allowed: '2500',
      total_paid: '2200',
      avg_collection_rate: '0.8800',
      rate_anomaly_count: '0',
      date_from: '2024-03-01',
      date_to: '2024-09-15',
      distinct_facilities: '2',
      distinct_payers: '1',
    },
  ]);
  const audit: string[] = [];
  const res = await searchClaims(
    {
      filter: {
        facility: 'My Time Recovery',
        payer: 'Aetna',
        date_from: '2024-01-01',
        date_to: '2024-12-31',
        source_year: 2024,
        hcpcs_code: 'H0015',
        revenue_code: '0906',
      },
    },
    ctxWith(executor, audit),
  );

  assert.equal(res.summary_stats.rows_matched, 12);
  assert.equal(
    calls[0]!.sql,
    EXPECTED_SELECT +
      ' where lower(facility_name) = lower($1) and lower(payer_name) = lower($2) ' +
      'and date_of_service >= $3 and date_of_service <= $4 and source_year = $5 ' +
      'and lower(hcpcs_code) = lower($6) and lower(revenue_code) = lower($7)',
  );
  assert.deepEqual(calls[0]!.params, [
    'My Time Recovery',
    'Aetna',
    '2024-01-01',
    '2024-12-31',
    2024,
    'H0015',
    '0906',
  ]);

  // Stored args retain the (non-PHI) filter verbatim for re-execution.
  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), {
    filter: {
      facility: 'My Time Recovery',
      payer: 'Aetna',
      date_from: '2024-01-01',
      date_to: '2024-12-31',
      source_year: 2024,
      hcpcs_code: 'H0015',
      revenue_code: '0906',
    },
  });
  assert.deepEqual(JSON.parse(audit[0]!).args_shape, {
    filter_keys: ['facility', 'payer', 'date_from', 'date_to', 'source_year', 'hcpcs_code', 'revenue_code'],
  });
});

test('search_claims: id filter (single-claim reveal) — scoped WHERE, non-PHI args/audit', async () => {
  // Phase 8.0: the /claims/[claimId] reveal mints a query_id via search_claims with
  // an `id` equality so the results route later re-runs it scoped to exactly one row.
  const { executor, calls } = makeFake([
    {
      rows_matched: '1',
      total_charge: '1200',
      total_allowed: '800',
      total_paid: '760',
      avg_collection_rate: '0.9500',
      rate_anomaly_count: '0',
      date_from: '2025-04-02',
      date_to: '2025-04-02',
      distinct_facilities: '1',
      distinct_payers: '1',
    },
  ]);
  const audit: string[] = [];
  const res = await searchClaims({ filter: { id: 4242 } }, ctxWith(executor, audit));

  assert.equal(res.summary_stats.rows_matched, 1);

  // Scoped to one synthetic id, parameterized.
  assert.equal(calls[0]!.sql, EXPECTED_SELECT + ' where id = $1');
  assert.deepEqual(calls[0]!.params, [4242]);

  // Stored args are the non-PHI filter (the synthetic id only) — re-run material.
  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), { filter: { id: 4242 } });

  // Audit line carries only the non-PHI key shape, never the id value or any PHI.
  const auditLine = JSON.parse(audit[0]!);
  assert.deepEqual(auditLine.args_shape, { filter_keys: ['id'] });
  assert.equal(auditLine.function_name, 'search_claims');
  assert.ok(!audit[0]!.includes('patient'));
});

test('search_claims: empty match — count 0, money 0, avg/dates null, row_count 0', async () => {
  // The aggregate returns one row even when nothing matched.
  const { executor } = makeFake([
    {
      rows_matched: '0',
      total_charge: '0',
      total_allowed: '0',
      total_paid: '0',
      avg_collection_rate: null,
      rate_anomaly_count: '0',
      date_from: null,
      date_to: null,
      distinct_facilities: '0',
      distinct_payers: '0',
    },
  ]);
  const audit: string[] = [];
  const res = await searchClaims({ filter: { source_year: 2099 } }, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    rows_matched: 0,
    total_charge: 0,
    total_allowed: 0,
    total_paid: 0,
    avg_collection_rate: null,
    rate_anomaly_count: 0,
    date_from: null,
    date_to: null,
    distinct_facilities: 0,
    distinct_payers: 0,
  });
  assert.equal(JSON.parse(audit[0]!).result_row_count, 0);
});

test('search_claims: rate-anomaly count surfaces non-representable rates', async () => {
  const { executor } = makeFake([
    {
      rows_matched: '50',
      total_charge: '20000',
      total_allowed: '10000',
      total_paid: '9000',
      avg_collection_rate: '0.9000',
      rate_anomaly_count: '7', // paid & allowed present, collection_rate NULL
      date_from: '2025-01-01',
      date_to: '2025-12-31',
      distinct_facilities: '1',
      distinct_payers: '3',
    },
  ]);
  const audit: string[] = [];
  const res = await searchClaims({ filter: { facility: 'Covenant Hills' } }, ctxWith(executor, audit));
  assert.equal(res.summary_stats.rate_anomaly_count, 7);
});

test('searchClaimsSql: trailing WHERE present iff a clause is supplied', () => {
  // Note: the FILTER (where ...) aggregate always contains the word "where", so
  // assert on the trailing WHERE clause specifically.
  assert.ok(searchClaimsSql('').endsWith('from claims.claims'));
  assert.ok(searchClaimsSql('source_year = $1').endsWith('where source_year = $1'));
});
