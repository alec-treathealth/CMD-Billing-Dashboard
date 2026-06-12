import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payerGapAnalysis, payerGapSql } from '../src/queries/payer_gap_analysis.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

/** DB row as returned by pg: numerics arrive as strings, payer_name nullable. */
interface FakeRow {
  payer_name: string | null;
  claim_count: string;
  total_charge: string;
  total_allowed: string;
  total_paid: string;
  avg_collection_rate: string | null;
  total_write_down: string;
  total_collection_gap: string;
}

/**
 * Fake executor: records every (sql, params), returns the canned data rows for
 * the aggregation query and a synthetic id for the claims.log_query call. Same
 * pattern as distribution.test.ts — no live database.
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

test('payer_gap_analysis: no filter — gaps, sort, exact SQL, query_id, log + audit', async () => {
  // Deliberately out of gap order to prove the JS trusts the SQL ORDER BY:
  // rows arrive already sorted by total_collection_gap desc.
  const { executor, calls } = makeFake([
    {
      payer_name: 'Aetna',
      claim_count: '100',
      total_charge: '50000',
      total_allowed: '30000',
      total_paid: '20000',
      avg_collection_rate: '0.6700',
      total_write_down: '20000', // 50000 - 30000
      total_collection_gap: '30000', // 50000 - 20000
    },
    {
      payer_name: 'Cigna',
      claim_count: '40',
      total_charge: '10000',
      total_allowed: '8000',
      total_paid: '7000',
      avg_collection_rate: '0.8750',
      total_write_down: '2000',
      total_collection_gap: '3000',
    },
  ]);
  const audit: string[] = [];
  const res = await payerGapAnalysis({}, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    rows_analyzed: 140, // 100 + 40
    by_payer: [
      {
        payer_name: 'Aetna',
        claim_count: 100,
        total_charge: 50000,
        total_allowed: 30000,
        total_paid: 20000,
        avg_collection_rate: 0.67,
        total_write_down: 20000,
        total_collection_gap: 30000,
      },
      {
        payer_name: 'Cigna',
        claim_count: 40,
        total_charge: 10000,
        total_allowed: 8000,
        total_paid: 7000,
        avg_collection_rate: 0.875,
        total_write_down: 2000,
        total_collection_gap: 3000,
      },
    ],
  });
  assert.equal(res.query_id, 'fixed-uuid-0000');

  // Exact parameterized data SQL (no filter -> no WHERE), no params.
  assert.equal(calls.length, 2); // data query + log_query
  assert.equal(
    calls[0]!.sql,
    'select payer_name, count(*) as claim_count, ' +
      'coalesce(sum(charge_amount), 0) as total_charge, ' +
      'coalesce(sum(allowed_amount), 0) as total_allowed, ' +
      'coalesce(sum(paid_amount), 0) as total_paid, ' +
      'avg(collection_rate) as avg_collection_rate, ' +
      'coalesce(sum(charge_amount - coalesce(allowed_amount, 0)), 0) as total_write_down, ' +
      'coalesce(sum(charge_amount - coalesce(paid_amount, 0)), 0) as total_collection_gap ' +
      'from claims.claims group by payer_name ' +
      'order by total_collection_gap desc nulls last',
  );
  assert.deepEqual(calls[0]!.params, []);

  // query_log write: function_name, non-PHI args, null identity_hash.
  const log = calls[1]!;
  assert.match(log.sql, /select claims\.log_query\(\$1, \$2, \$3, \$4::jsonb, \$5::jsonb, \$6\)/);
  assert.equal(log.params[0], 'fixed-uuid-0000');
  assert.equal(log.params[1], 'sess-1');
  assert.equal(log.params[2], 'payer_gap_analysis');
  assert.deepEqual(JSON.parse(log.params[3] as string), { filter: {} });
  assert.equal(log.params[5], null);

  // Exactly one audit line, non-PHI, documented shape.
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-10T00:00:00.000Z',
    function_name: 'payer_gap_analysis',
    args_shape: { filter_keys: [] },
    query_id: 'fixed-uuid-0000',
    result_row_count: 2,
  });
});

test('payer_gap_analysis: with filter — parameterized WHERE, filter stored non-PHI', async () => {
  const { executor, calls } = makeFake([
    {
      payer_name: 'Aetna',
      claim_count: '5',
      total_charge: '1000',
      total_allowed: '600',
      total_paid: '500',
      avg_collection_rate: '0.8333',
      total_write_down: '400',
      total_collection_gap: '500',
    },
  ]);
  const audit: string[] = [];
  const res = await payerGapAnalysis(
    { filter: { payer: 'Aetna', date_from: '2024-01-01' } },
    ctxWith(executor, audit),
  );

  assert.equal(res.summary_stats.rows_analyzed, 5);
  assert.equal(
    calls[0]!.sql,
    'select payer_name, count(*) as claim_count, ' +
      'coalesce(sum(charge_amount), 0) as total_charge, ' +
      'coalesce(sum(allowed_amount), 0) as total_allowed, ' +
      'coalesce(sum(paid_amount), 0) as total_paid, ' +
      'avg(collection_rate) as avg_collection_rate, ' +
      'coalesce(sum(charge_amount - coalesce(allowed_amount, 0)), 0) as total_write_down, ' +
      'coalesce(sum(charge_amount - coalesce(paid_amount, 0)), 0) as total_collection_gap ' +
      'from claims.claims where lower(payer_name) = lower($1) and date_of_service >= $2 ' +
      'group by payer_name order by total_collection_gap desc nulls last',
  );
  assert.deepEqual(calls[0]!.params, ['Aetna', '2024-01-01']);

  // Stored args retain the (non-PHI) filter for re-execution.
  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), {
    filter: { payer: 'Aetna', date_from: '2024-01-01' },
  });
  assert.deepEqual(JSON.parse(audit[0]!).args_shape, {
    filter_keys: ['payer', 'date_from'],
  });
});

test('payer_gap_analysis: null allowed/paid — gaps still computed, avg_rate null', async () => {
  // A payer whose rows had null allowed/paid amounts: coalesce(...,0) inside the
  // SQL means the gaps are still real numbers; avg(collection_rate) is null
  // (no representable rate in the group — a meaningful signal, not "missing").
  const { executor } = makeFake([
    {
      payer_name: 'Beacon Carelon',
      claim_count: '3',
      total_charge: '900',
      total_allowed: '0', // all rows null allowed -> coalesce sum = 0
      total_paid: '0', // all rows null paid -> coalesce sum = 0
      avg_collection_rate: null, // no representable rate
      total_write_down: '900', // 900 - 0
      total_collection_gap: '900', // 900 - 0
    },
    {
      payer_name: null, // NULL-payer group is preserved
      claim_count: '1',
      total_charge: '100',
      total_allowed: '50',
      total_paid: '0',
      avg_collection_rate: null,
      total_write_down: '50',
      total_collection_gap: '100',
    },
  ]);
  const audit: string[] = [];
  const res = await payerGapAnalysis({}, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats.by_payer, [
    {
      payer_name: 'Beacon Carelon',
      claim_count: 3,
      total_charge: 900,
      total_allowed: 0,
      total_paid: 0,
      avg_collection_rate: null,
      total_write_down: 900,
      total_collection_gap: 900,
    },
    {
      payer_name: null,
      claim_count: 1,
      total_charge: 100,
      total_allowed: 50,
      total_paid: 0,
      avg_collection_rate: null,
      total_write_down: 50,
      total_collection_gap: 100,
    },
  ]);
  assert.equal(res.summary_stats.rows_analyzed, 4);
});

test('payer_gap_analysis: empty result — rows_analyzed 0, no payers, row_count 0', async () => {
  const { executor } = makeFake([]);
  const audit: string[] = [];
  const res = await payerGapAnalysis(
    { filter: { source_year: 2099 } },
    ctxWith(executor, audit),
  );
  assert.deepEqual(res.summary_stats, { rows_analyzed: 0, by_payer: [] });
  assert.equal(JSON.parse(audit[0]!).result_row_count, 0);
});

test('payerGapSql: builder is deterministic and parameter-free in its column names', () => {
  // No filter clause -> no WHERE; with a clause -> exactly one WHERE, values bound elsewhere.
  assert.ok(!payerGapSql('').includes('where'));
  assert.ok(payerGapSql('source_year = $1').includes('where source_year = $1'));
});
