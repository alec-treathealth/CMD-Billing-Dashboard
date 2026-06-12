import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distribution, distributionSql } from '../src/queries/distribution.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

/**
 * Fake executor: records every (sql, params), returns the canned data rows for
 * the aggregation query and a synthetic id for the claims.log_query call. Lets
 * the fixture assert summary_stats, the exact SQL, the log_query write, and the
 * audit line — all with no live database.
 */
function makeFake(dataRows: Array<{ value: string | null; metric_value: string | null }>) {
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

test('distribution: payer_name/count — buckets, pct_of_total, exact SQL, query_id', async () => {
  const { executor, calls } = makeFake([
    { value: 'Aetna', metric_value: '150' },
    { value: 'Cigna', metric_value: '50' },
  ]);
  const audit: string[] = [];
  const res = await distribution(
    { field: 'payer_name', metric: 'count' },
    ctxWith(executor, audit),
  );

  // summary_stats shape + computed percentages.
  assert.deepEqual(res.summary_stats, {
    field: 'payer_name',
    metric: 'count',
    buckets: [
      { value: 'Aetna', metric_value: 150, pct_of_total: 75 },
      { value: 'Cigna', metric_value: 50, pct_of_total: 25 },
    ],
  });
  assert.equal(res.query_id, 'fixed-uuid-0000');

  // The exact parameterized data SQL (no filter -> no WHERE), with no params.
  assert.equal(calls.length, 2); // data query + log_query
  assert.equal(
    calls[0]!.sql,
    'select payer_name::text as value, count(*) as metric_value ' +
      'from claims.claims group by payer_name order by metric_value desc nulls last',
  );
  assert.deepEqual(calls[0]!.params, []);

  // The query_log write: function_name, non-PHI args, null identity_hash.
  const log = calls[1]!;
  assert.match(log.sql, /select claims\.log_query\(\$1, \$2, \$3, \$4::jsonb, \$5::jsonb, \$6\)/);
  assert.equal(log.params[0], 'fixed-uuid-0000');
  assert.equal(log.params[1], 'sess-1');
  assert.equal(log.params[2], 'distribution');
  assert.deepEqual(JSON.parse(log.params[3] as string), {
    field: 'payer_name',
    metric: 'count',
    filter: {},
  });
  assert.equal(log.params[5], null); // no identity_hash for distribution

  // Exactly one audit line, non-PHI, with the documented shape.
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-10T00:00:00.000Z',
    function_name: 'distribution',
    args_shape: { field: 'payer_name', metric: 'count', filter_keys: [] },
    query_id: 'fixed-uuid-0000',
    result_row_count: 2,
  });
});

test('distribution: filter + null group/metric — WHERE params, null pct, avg metric', async () => {
  const { executor, calls } = makeFake([
    { value: 'H0015', metric_value: '0.82' },
    { value: null, metric_value: null }, // NULL hcpcs group with undefined avg
  ]);
  const audit: string[] = [];
  const res = await distribution(
    {
      field: 'hcpcs_code',
      metric: 'avg_collection_rate',
      filter: { payer: 'Aetna', date_from: '2024-01-01' },
    },
    ctxWith(executor, audit),
  );

  assert.deepEqual(res.summary_stats.buckets, [
    { value: 'H0015', metric_value: 0.82, pct_of_total: 100 },
    { value: null, metric_value: null, pct_of_total: null },
  ]);

  // Filter -> parameterized WHERE; values bound as $1/$2, columns fixed.
  assert.equal(
    calls[0]!.sql,
    'select hcpcs_code::text as value, avg(collection_rate) as metric_value ' +
      'from claims.claims where lower(payer_name) = lower($1) and date_of_service >= $2 ' +
      'group by hcpcs_code order by metric_value desc nulls last',
  );
  assert.deepEqual(calls[0]!.params, ['Aetna', '2024-01-01']);

  // Stored args retain the (non-PHI) filter for re-execution.
  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), {
    field: 'hcpcs_code',
    metric: 'avg_collection_rate',
    filter: { payer: 'Aetna', date_from: '2024-01-01' },
  });
  assert.deepEqual(JSON.parse(audit[0]!).args_shape, {
    field: 'hcpcs_code',
    metric: 'avg_collection_rate',
    filter_keys: ['payer', 'date_from'],
  });
});

test('distribution: empty result set -> no buckets, row_count 0', async () => {
  const { executor } = makeFake([]);
  const audit: string[] = [];
  const res = await distribution({ field: 'source_year', metric: 'total_charge' }, ctxWith(executor, audit));
  assert.deepEqual(res.summary_stats.buckets, []);
  assert.equal(JSON.parse(audit[0]!).result_row_count, 0);
});

test('distribution: rejects a non-allowlisted field or metric (no SQL built)', async () => {
  const { executor, calls } = makeFake([]);
  const audit: string[] = [];
  await assert.rejects(
    // @ts-expect-error — 'patient_last' is not a DistributionField; runtime guard also rejects it.
    () => distribution({ field: 'patient_last', metric: 'count' }, ctxWith(executor, audit)),
    /invalid field/,
  );
  await assert.rejects(
    // @ts-expect-error — 'drop' is not a DistributionMetric.
    () => distribution({ field: 'payer_name', metric: 'drop' }, ctxWith(executor, audit)),
    /invalid metric/,
  );
  assert.equal(calls.length, 0); // nothing executed, nothing logged
});
