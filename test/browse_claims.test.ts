import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  browseClaims,
  browseClaimsSql,
  claimById,
  claimByIdSql,
  BROWSE_SELECT_LIST,
} from '../src/queries/browse_claims.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

// The SELECT list aliases the computed rate columns; everything else is by name.
const PREFIX = `select ${BROWSE_SELECT_LIST} from claims.claims`;

// Computed-rate SQL expressions (must mirror RATE_EXPR in browse_claims.ts).
const COLLECTION_RATE_EXPR = '(coalesce(paid_amount, 0) / nullif(charge_amount, 0))';

/** Fake executor: records every (sql, params) and returns canned rows. */
function makeFake(dataRows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

function ctx(executor: QueryExecutor): QueryContext {
  return { executor, createdBy: 'test' };
}

test('browse_claims: no filter, no cursor — default sort, keyset limit, no OFFSET', async () => {
  const { executor, calls } = makeFake([]);
  const res = await browseClaims({}, ctx(executor));

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.sql,
    `${PREFIX} order by date_of_service desc nulls last, id desc limit $1`,
  );
  assert.deepEqual(calls[0]!.params, [51]); // default pageSize 50 + 1
  assert.ok(!calls[0]!.sql.includes('offset'));
  assert.equal(res.hasNext, false);
  assert.equal(res.nextCursor, null);
  assert.deepEqual(res.sort, { column: 'date_of_service', direction: 'desc' });
});

test('browse_claims: filter + cursor (non-null value, desc) — parameterized keyset boundary', async () => {
  const { executor, calls } = makeFake([]);
  await browseClaims(
    {
      filter: { source_year: 2024 },
      sort: { column: 'date_of_service', direction: 'desc' },
      cursor: { id: 100, value: '2024-03-01' },
      pageSize: 50,
    },
    ctx(executor),
  );

  assert.equal(
    calls[0]!.sql,
    `${PREFIX} where source_year = $1 and ` +
      `(date_of_service < $2 or (date_of_service = $2 and id < $3) or date_of_service is null) ` +
      `order by date_of_service desc nulls last, id desc limit $4`,
  );
  assert.deepEqual(calls[0]!.params, [2024, '2024-03-01', 100, 51]);
});

test('browse_claims: cursor on id sort uses a plain comparison', async () => {
  const { executor, calls } = makeFake([]);
  await browseClaims(
    { sort: { column: 'id', direction: 'asc' }, cursor: { id: 100, value: 100 }, pageSize: 50 },
    ctx(executor),
  );
  assert.equal(calls[0]!.sql, `${PREFIX} where id > $1 order by id asc limit $2`);
  assert.deepEqual(calls[0]!.params, [100, 51]);
});

test('browse_claims: null-value cursor restricts to the trailing NULL block', async () => {
  const { executor, calls } = makeFake([]);
  await browseClaims(
    { sort: { column: 'hcpcs_code', direction: 'asc' }, cursor: { id: 7, value: null }, pageSize: 50 },
    ctx(executor),
  );
  assert.equal(
    calls[0]!.sql,
    `${PREFIX} where (hcpcs_code is null and id > $1) order by hcpcs_code asc nulls last, id asc limit $2`,
  );
  assert.deepEqual(calls[0]!.params, [7, 51]);
});

test('browse_claims: computed rate sort uses the SQL expression in ORDER BY and keyset boundary', async () => {
  const { executor, calls } = makeFake([]);
  await browseClaims(
    {
      sort: { column: 'collection_rate', direction: 'desc' },
      cursor: { id: 42, value: '0.4000' },
      pageSize: 50,
    },
    ctx(executor),
  );
  assert.equal(
    calls[0]!.sql,
    `${PREFIX} where ` +
      `(${COLLECTION_RATE_EXPR} < $1 or (${COLLECTION_RATE_EXPR} = $1 and id < $2) ` +
      `or ${COLLECTION_RATE_EXPR} is null) ` +
      `order by ${COLLECTION_RATE_EXPR} desc nulls last, id desc limit $3`,
  );
  assert.deepEqual(calls[0]!.params, ['0.4000', 42, 51]);
});

test('browse_claims: hasNext slices to pageSize and derives nextCursor from last row', async () => {
  const { executor } = makeFake([
    { id: '10', date_of_service: '2024-05-01' },
    { id: '9', date_of_service: '2024-04-01' },
    { id: '8', date_of_service: '2024-03-01' }, // the +1 sentinel
  ]);
  const res = await browseClaims(
    { sort: { column: 'date_of_service', direction: 'desc' }, pageSize: 2 },
    ctx(executor),
  );
  assert.equal(res.hasNext, true);
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.nextCursor, { id: 9, value: '2024-04-01' });
});

test('browse_claims: pageSize is clamped to the 200 hard cap', async () => {
  const { executor, calls } = makeFake([]);
  await browseClaims({ pageSize: 5000 }, ctx(executor));
  assert.deepEqual(calls[0]!.params, [201]); // 200 + 1
});

test('claimByIdSql / claimById: exact SQL, bounded id, fail-closed on bad id', async () => {
  assert.equal(claimByIdSql(), `${PREFIX} where id = $1`);

  const { executor, calls } = makeFake([{ id: '5', facility_name: 'X' }]);
  const row = await claimById(5, ctx(executor));
  assert.deepEqual(row, { id: '5', facility_name: 'X' });
  assert.deepEqual(calls[0]!.params, [5]);

  // Invalid ids never hit the database.
  const { executor: e2, calls: c2 } = makeFake([]);
  assert.equal(await claimById(0, ctx(e2)), null);
  assert.equal(await claimById(-3, ctx(e2)), null);
  assert.equal(c2.length, 0);
});
