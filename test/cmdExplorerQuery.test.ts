import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  likeContains,
  buildCmdExplorerQuery,
  buildCmdSearchSummaryQueries,
  resolveCmdExplorerSort,
  resolveCmdExplorerCursor,
  CMD_EXPLORER_DEFAULT_SORT,
  CMD_SEARCH_TOP_N,
  type CmdExplorerFilter,
  type CmdExplorerSort,
} from '../src/collections/cmdExplorerQuery.js';

const ENTITY = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];
const SORT: CmdExplorerSort = { column: 'payment_received', direction: 'desc' };

/**
 * The core injection-safety invariant: every `$n` placeholder in the SQL is contiguous from 1
 * and has exactly one bound param. If any value were string-concatenated instead of bound, this
 * would fail (a placeholder without a param, or a param without a placeholder).
 */
function assertAllBound(sql: string, params: unknown[]): void {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = nums.length === 0 ? 0 : Math.max(...nums);
  assert.equal(max, params.length, `highest $n (${max}) must equal param count (${params.length})`);
  for (let i = 1; i <= max; i++) {
    assert.ok(nums.includes(i), `missing placeholder $${i}`);
  }
}

test('likeContains escapes LIKE metacharacters and wraps in %…%', () => {
  assert.equal(likeContains('BCBS'), '%BCBS%');
  // percent, underscore, and backslash are escaped so they match literally
  assert.equal(likeContains('a%b_c\\d'), '%a\\%b\\_c\\\\d%');
});

test('page query: tenant scope is always the first bound param, no filters', () => {
  const { sql, params } = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(params[0], ENTITY);
  assert.match(sql, /order by payment_received desc nulls last, id desc/);
  assertAllBound(sql, params);
});

test('substring search: OR across ONLY allowlisted columns, one shared pattern param', () => {
  const filter: CmdExplorerFilter = {
    q: 'BCBS',
    // patient_name is PHI, "bogus" is unknown → both dropped by the allowlist
    searchColumns: ['facility', 'primary_payer', 'patient_name' as never, 'bogus' as never],
  };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  // both allowlisted columns present, PHI / unknown absent
  assert.match(sql, /facility::text ilike \$2/);
  assert.match(sql, /primary_payer::text ilike \$2/);
  assert.doesNotMatch(sql, /patient_name/);
  assert.doesNotMatch(sql, /bogus/);
  // ONE bound pattern reused across the OR
  assert.match(sql, /\(facility::text ilike \$2 or primary_payer::text ilike \$2\)/);
  assert.equal(params[1], '%BCBS%');
  assertAllBound(sql, params);
});

test('substring search: injection payload as a column name is dropped, not emitted', () => {
  const filter: CmdExplorerFilter = {
    q: 'x',
    searchColumns: ['facility; drop table collections.cmd_explorer_rows;--' as never],
  };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.doesNotMatch(sql, /drop table/i);
  // no valid search column → no substring clause at all
  assert.doesNotMatch(sql, /ilike/);
  assertAllBound(sql, params);
});

test('substring term with % is bound (escaped), never interpolated', () => {
  const filter: CmdExplorerFilter = { q: '100%', searchColumns: ['facility'] };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  // the raw term is never in the SQL string; it is a bound, escaped pattern
  assert.doesNotMatch(sql, /100%/);
  assert.equal(params[1], '%100\\%%');
  assertAllBound(sql, params);
});

test('exact refinements (facility / cpt / payer) are each bound', () => {
  const filter: CmdExplorerFilter = { facility: 'DALLAS MENTAL HEALTH LLC', cpt_code: '90837', primary_payer: 'Aetna' };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(sql, /facility = \$2/);
  assert.match(sql, /cpt_code = \$3/);
  assert.match(sql, /primary_payer = \$4/);
  assert.deepEqual(params.slice(1, 4), ['DALLAS MENTAL HEALTH LLC', '90837', 'Aetna']);
  assertAllBound(sql, params);
});

test('page query: cursor + limit are bound; sort column drives ORDER BY', () => {
  const sort: CmdExplorerSort = { column: 'charge_amount', direction: 'asc' };
  const { sql, params } = buildCmdExplorerQuery({ id: 42, value: '250.00' }, {}, sort, 51, ENTITY);
  assert.match(sql, /order by charge_amount asc nulls last, id asc/);
  assert.match(sql, /limit \$\d+/);
  // cursor value + id are bound (not concatenated)
  assert.ok(params.includes('250.00'));
  assert.ok(params.includes(42));
  assert.ok(params.includes(51));
  assertAllBound(sql, params);
});

test('search summary: totals + 3 group queries, tenant-scoped, group cols are literals', () => {
  const filter: CmdExplorerFilter = { q: 'BCBS', searchColumns: ['facility'] };
  const { totals, groups } = buildCmdSearchSummaryQueries(filter, ENTITY);

  assert.match(totals.sql, /count\(\*\)::int as total_count/);
  assert.match(totals.sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assertAllBound(totals.sql, totals.params);

  for (const [key, col] of [
    ['facility', 'facility'],
    ['primary_payer', 'primary_payer'],
    ['cpt_code', 'cpt_code'],
  ] as const) {
    const g = groups[key];
    assert.match(g.sql, new RegExp(`group by ${col} order by charge desc nulls last, count desc limit \\$\\d+`));
    assert.match(g.sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
    // topN is the LAST bound param
    assert.equal(g.params[g.params.length - 1], CMD_SEARCH_TOP_N);
    assertAllBound(g.sql, g.params);
  }
});

test('resolveCmdExplorerSort clamps unknown columns to the default', () => {
  assert.deepEqual(resolveCmdExplorerSort({ column: 'ssn' as never, direction: 'asc' }), CMD_EXPLORER_DEFAULT_SORT);
  assert.deepEqual(resolveCmdExplorerSort(undefined), CMD_EXPLORER_DEFAULT_SORT);
  assert.deepEqual(resolveCmdExplorerSort({ column: 'charge_amount', direction: 'asc' }), {
    column: 'charge_amount',
    direction: 'asc',
  });
});

test('resolveCmdExplorerCursor rejects malformed cursors', () => {
  assert.equal(resolveCmdExplorerCursor(null), null);
  assert.equal(resolveCmdExplorerCursor({ id: 0, value: 'x' }), null);
  assert.equal(resolveCmdExplorerCursor({ id: 1.5, value: 'x' }), null);
  assert.deepEqual(resolveCmdExplorerCursor({ id: 5, value: null }), { id: 5, value: null });
  assert.deepEqual(resolveCmdExplorerCursor({ id: 5, value: 'abc' }), { id: 5, value: 'abc' });
});
