import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  distributionCountFromMatview,
  distributionCountMatviewSql,
  payerGapMatviewSql,
} from '../src/queries/dashboard_aggregates.js';
import type { QueryExecutor } from '../src/queries/types.js';

const MIGRATION_SQL = readFileSync(
  new URL('../supabase/migrations/0009_aggregate_matviews.sql', import.meta.url),
  'utf8',
);

/** Fake executor: records calls, returns canned matview rows. */
function makeFake(dataRows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

test('payerGapMatviewSql: reads the matview, ordering mirrors the live query', () => {
  assert.equal(
    payerGapMatviewSql(),
    'select payer_name, claim_count, total_charge, total_allowed, total_paid, ' +
      'avg_collection_rate, total_write_down, total_collection_gap ' +
      'from claims.mv_payer_gap ' +
      'order by total_collection_gap desc nulls last',
  );
});

test('distributionCountMatviewSql: filters by field via a bound param', () => {
  assert.equal(
    distributionCountMatviewSql(),
    'select value, metric_value from claims.mv_distribution_count ' +
      'where field = $1 order by metric_value desc nulls last',
  );
});

test('distributionCountFromMatview: count shape + pct_of_total; field is the bound param', async () => {
  const { executor, calls } = makeFake([
    { value: '2025', metric_value: '150' },
    { value: '2024', metric_value: '50' },
  ]);

  const res = await distributionCountFromMatview(executor, 'source_year');

  assert.equal(res.field, 'source_year');
  assert.equal(res.metric, 'count');
  assert.deepEqual(res.buckets, [
    { value: '2025', metric_value: 150, pct_of_total: 75 },
    { value: '2024', metric_value: 50, pct_of_total: 25 },
  ]);

  // field flows as a $1 param (never interpolated), and only the matview is read.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.params, ['source_year']);
  assert.ok(calls[0]!.sql.includes('claims.mv_distribution_count'));
  assert.ok(!calls[0]!.sql.includes('from claims.claims'));
});

test('distributionCountFromMatview: null bucket + zero total stay null-safe', async () => {
  const { executor } = makeFake([
    { value: null, metric_value: '0' },
    { value: 'H0015', metric_value: '0' },
  ]);
  const res = await distributionCountFromMatview(executor, 'hcpcs_code');
  // total is 0 → pct_of_total null for every bucket; the NULL value is preserved.
  assert.deepEqual(res.buckets, [
    { value: null, metric_value: 0, pct_of_total: null },
    { value: 'H0015', metric_value: 0, pct_of_total: null },
  ]);
});

// --- migration shape tests --------------------------------------------------

test('migration 0009: no OWNER TO claims_admin (role cannot be set by migration role)', () => {
  assert.ok(
    !MIGRATION_SQL.includes('owner to claims_admin'),
    'migration must not attempt ALTER MATERIALIZED VIEW ... OWNER TO claims_admin',
  );
});

test('migration 0009: SECURITY DEFINER refresh function is created and execute granted only to claims_admin', () => {
  assert.ok(
    MIGRATION_SQL.includes('security definer'),
    'migration must create a SECURITY DEFINER refresh function',
  );
  assert.ok(
    MIGRATION_SQL.includes('claims.refresh_aggregate_matviews'),
    'migration must create claims.refresh_aggregate_matviews()',
  );
  assert.ok(
    MIGRATION_SQL.includes('grant  execute on function claims.refresh_aggregate_matviews() to   claims_admin'),
    'execute must be granted to claims_admin',
  );
  assert.ok(
    MIGRATION_SQL.includes('revoke execute on function claims.refresh_aggregate_matviews() from public'),
    'public execute must be revoked',
  );
  assert.ok(
    !MIGRATION_SQL.includes('grant  execute on function claims.refresh_aggregate_matviews() to   claims_reader'),
    'claims_reader must not receive execute on the refresh function',
  );
});

test('refreshAggregateMatviews: calls the SECURITY DEFINER function, not raw REFRESH statements', async () => {
  const calls: string[] = [];
  const fakeDb = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  const { refreshAggregateMatviews } = await import('../src/db.js');
  await refreshAggregateMatviews(fakeDb as never);
  assert.equal(calls.length, 1, 'exactly one query issued');
  assert.equal(calls[0], 'select claims.refresh_aggregate_matviews()');
});
