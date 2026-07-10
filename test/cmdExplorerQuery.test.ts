import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  likeContains,
  buildCmdExplorerQuery,
  buildCmdSearchSummaryQueries,
  buildCmdFacilityOptionsQuery,
  sanitizeGridColumns,
  resolveCmdExplorerSort,
  resolveCmdExplorerCursor,
  CMD_EXPLORER_DEFAULT_SORT,
  CMD_EXPLORER_SORTABLE_COLUMNS,
  CMD_EXPLORER_COLUMN_KEYS,
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

test('facility multi-select + exact cpt/payer refinements are each bound', () => {
  const filter: CmdExplorerFilter = {
    facility: ['DALLAS MENTAL HEALTH LLC'],
    cpt_code: '90837',
    primary_payer: 'Aetna',
  };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  // facility is now set-membership (multi-select), bound as ONE array param
  assert.match(sql, /facility = any\(\$2::text\[\]\)/);
  assert.match(sql, /cpt_code = \$3/);
  assert.match(sql, /primary_payer = \$4/);
  assert.deepEqual(params[1], ['DALLAS MENTAL HEALTH LLC']);
  assert.deepEqual(params.slice(2, 4), ['90837', 'Aetna']);
  assertAllBound(sql, params);
});

test('facility multi-select: multiple values bind as a single text[] param', () => {
  const filter: CmdExplorerFilter = { facility: ['DALLAS MENTAL HEALTH LLC', 'FIRST RESPONDERS OF CALIFORNIA LLC'] };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(sql, /facility = any\(\$2::text\[\]\)/);
  assert.deepEqual(params[1], ['DALLAS MENTAL HEALTH LLC', 'FIRST RESPONDERS OF CALIFORNIA LLC']);
  assertAllBound(sql, params);
});

test('facility multi-select: EMPTY array is NO restriction (all facilities), not zero rows', () => {
  // The trap this guards: emitting `facility = any(ARRAY[]::text[])` would match NOTHING. An empty
  // (or null) selection must OMIT the facility condition entirely — same result set as no filter.
  for (const facility of [[], null, undefined] as (string[] | null | undefined)[]) {
    const { sql, params } = buildCmdExplorerQuery(null, { facility }, SORT, 51, ENTITY);
    assert.doesNotMatch(sql, /facility = any/, `facility=${JSON.stringify(facility)} must emit no facility clause`);
    // tenant scope is still the only WHERE predicate → identical to the no-filter query
    assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\) order by/);
    assertAllBound(sql, params);
  }
});

test('search summary honors the facility multi-select the same way (empty = no restriction)', () => {
  const nonEmpty = buildCmdSearchSummaryQueries({ facility: ['DALLAS MENTAL HEALTH LLC'] }, ENTITY);
  assert.match(nonEmpty.totals.sql, /facility = any\(\$2::text\[\]\)/);
  assert.deepEqual(nonEmpty.totals.params[1], ['DALLAS MENTAL HEALTH LLC']);
  assertAllBound(nonEmpty.totals.sql, nonEmpty.totals.params);

  const empty = buildCmdSearchSummaryQueries({ facility: [] }, ENTITY);
  assert.doesNotMatch(empty.totals.sql, /facility = any/);
  assertAllBound(empty.totals.sql, empty.totals.params);
});

test('pct_allowed / pct_paid are sortable and selected (payer-gap columns)', () => {
  // both generated columns are in the sort allowlist
  assert.ok((CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes('pct_allowed'));
  assert.ok((CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes('pct_paid'));
  // a sort by pct_allowed drives ORDER BY the raw generated column (keyset-compatible)
  const { sql } = buildCmdExplorerQuery(null, {}, { column: 'pct_allowed', direction: 'desc' }, 51, ENTITY);
  assert.match(sql, /order by pct_allowed desc nulls last, id desc/);
  // both columns are projected by the grid SELECT
  assert.match(sql, /pct_allowed/);
  assert.match(sql, /pct_paid/);
});

test('facility options query is tenant-scoped and its only bound value is entityIds', () => {
  const { sql, params } = buildCmdFacilityOptionsQuery(ENTITY);
  // tenant scope on cmd_explorer_rows is the sole bound param ($1 = entityIds)
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(params, [ENTITY]);
  assert.equal(params.length, 1);
  // distinct facilities from the ROWS (tenant-scoped), enriched by resolving to the dimension
  assert.match(sql, /select distinct facility from collections\.cmd_explorer_rows/);
  // two-path resolution: exact name match OR the explicit alias crosswalk, then dimension by code
  assert.match(sql, /left join collections\.facilities fe on upper\(fe\.facility_name\) = upper\(r\.facility\)/);
  assert.match(sql, /left join collections\.cmd_facility_aliases a on upper\(a\.facility_text\) = upper\(r\.facility\)/);
  assert.match(sql, /f\.facility_code = coalesce\(fe\.facility_code, a\.facility_code\)/);
  // blank facilities excluded; no interpolation
  assert.match(sql, /btrim\(facility\) <> ''/);
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

test('PHI blind-index tokens add ANDed equality predicates, all bound (raw PHI never here)', () => {
  const filter: CmdExplorerFilter = {
    phiIndex: { memberIdBidx: 'aa11', memberIdPrefixBidx: 'bb22', groupNumberBidx: 'cc33' },
  };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(sql, /member_id_bidx = \$2/);
  assert.match(sql, /member_id_prefix_bidx = \$3/);
  assert.match(sql, /group_number_bidx = \$4/);
  assert.deepEqual(params.slice(1, 4), ['aa11', 'bb22', 'cc33']);
  assertAllBound(sql, params);
});

test('search summary carries the same PHI predicate, tenant-scoped', () => {
  const { totals, groups } = buildCmdSearchSummaryQueries({ phiIndex: { memberIdBidx: 'aa11' } }, ENTITY);
  assert.match(totals.sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(totals.sql, /member_id_bidx = \$2/);
  assertAllBound(totals.sql, totals.params);
  assert.match(groups.facility.sql, /member_id_bidx = \$2/);
  assertAllBound(groups.facility.sql, groups.facility.params);
});

test('sanitizeGridColumns: keeps allowlisted keys in order, drops unknown/non-string, dedups', () => {
  // unknown key, a non-string, and a duplicate are all dropped; valid keys keep their given order
  const input = ['facility', 'charge_date', 'facility', 'ssn', 42, 'pct_allowed', null];
  assert.deepEqual(sanitizeGridColumns(input), ['facility', 'charge_date', 'pct_allowed']);
});

test('sanitizeGridColumns: injection-y / garbage input never yields a bogus key', () => {
  assert.deepEqual(sanitizeGridColumns(['charge_date; drop table x']), []);
  assert.deepEqual(sanitizeGridColumns('not-an-array' as unknown), []);
  assert.deepEqual(sanitizeGridColumns(null), []);
  assert.deepEqual(sanitizeGridColumns(undefined), []);
  assert.deepEqual(sanitizeGridColumns([]), []);
});

test('sanitizeGridColumns: the full allowlist round-trips and result never exceeds it', () => {
  const all = [...CMD_EXPLORER_COLUMN_KEYS];
  assert.deepEqual(sanitizeGridColumns(all), all);
  // duplicating every key still can't exceed the allowlist size (dedup)
  assert.equal(sanitizeGridColumns([...all, ...all]).length, all.length);
  // the 3 PHI display keys ARE valid layout keys (the KEY is non-PHI; the value renders masked)
  for (const k of ['patient_name', 'member_id_raw', 'group_number']) {
    assert.ok((CMD_EXPLORER_COLUMN_KEYS as readonly string[]).includes(k));
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

// --- Session C: (CPT × Revenue-code) combination grouping -------------------

/**
 * The distinction the combo grouping MUST get right: pct_allowed/pct_paid are DOLLAR-WEIGHTED
 * (ratio of the bucket's summed dollars), NOT the average of each row's individual ratio. On a
 * bucket of a few large low-recovery claims + many small high-recovery claims the two DISAGREE
 * sharply, and the dollar-weighted number is the one admissions must trust. This fixture makes
 * them disagree, proving the trap is real; the SQL-shape assertions below then prove the query
 * implements the dollar-weighted formula (ratio of sums), never avg-of-ratios.
 */
test('combo grouping: dollar-weighted (ratio of sums) is what the fixture demands, and it differs from avg-of-ratios', () => {
  // 2 large claims recovering 50%, 10 small claims recovering 90%.
  const claims = [
    ...Array.from({ length: 2 }, () => ({ charge: 10000, allowed: 5000 })),
    ...Array.from({ length: 10 }, () => ({ charge: 100, allowed: 90 })),
  ];
  const sum = (f: (c: { charge: number; allowed: number }) => number) => claims.reduce((a, c) => a + f(c), 0);
  const dollarWeighted = (sum((c) => c.allowed) / sum((c) => c.charge)) * 100; // 10900/21000 → 51.90%
  const avgOfRatios = (claims.reduce((a, c) => a + c.allowed / c.charge, 0) / claims.length) * 100; // → 83.33%
  // They must genuinely disagree (else the fixture wouldn't prove anything).
  assert.ok(Math.abs(dollarWeighted - avgOfRatios) > 30, 'fixture must make the two approaches disagree');
  assert.ok(Math.abs(dollarWeighted - 51.9) < 0.01, 'dollar-weighted %allowed is 51.90%, dominated by the large claims');
  assert.ok(Math.abs(avgOfRatios - 83.33) < 0.01, 'avg-of-ratios is 83.33%, wrongly over-weighting the small claims');
});

test('combo grouping: SQL is dollar-weighted ratio-of-SUMS, never avg-of-ratios or per-row division', () => {
  const { combo } = buildCmdSearchSummaryQueries({}, ENTITY);
  // pct_allowed = sum(allowed)/sum(charge); pct_paid = sum(insurance)/sum(allowed) — ratio of SUMS
  // (each wrapped in a guarded CASE … END and aliased to the pct_* output column).
  assert.match(combo.sql, /round\(sum\(allowed_amount\) \/ sum\(charge_amount\) \* 100, 2\)::float8 end as pct_allowed/);
  assert.match(combo.sql, /round\(sum\(insurance_payments\) \/ sum\(allowed_amount\) \* 100, 2\)::float8 end as pct_paid/);
  // The trap it must NOT fall into: no averaging of any kind, and never aggregating the per-row
  // generated ratio columns (which would be avg/sum-of-per-row-ratios, not ratio-of-sums).
  assert.doesNotMatch(combo.sql, /avg\(/);
  assert.doesNotMatch(combo.sql, /(sum|avg)\(\s*pct_(allowed|paid)/);
});

test('combo grouping: tenant-scoped, groups by BOTH keys, denominators guarded, topN bound last', () => {
  const { combo } = buildCmdSearchSummaryQueries({ q: 'BCBS', searchColumns: ['facility'] }, ENTITY);
  // same shared tenant scope as every other summary query (business_entity_id first)
  assert.match(combo.sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  // grouped by the two-key combination, ordered like the other groups, topN as the LAST bound param
  assert.match(combo.sql, /group by cpt_code, revenue_code order by charge desc nulls last, count desc limit \$\d+/);
  assert.equal(combo.params[combo.params.length - 1], CMD_SEARCH_TOP_N);
  // both divisions guarded by `sum(denominator) > 0` → NULL on zero/negative/null denom (never an error)
  assert.match(combo.sql, /case when sum\(charge_amount\) > 0 then/);
  assert.match(combo.sql, /case when sum\(allowed_amount\) > 0 then/);
  // labels carried as cpt + revenue (distinct shape, two labels)
  assert.match(combo.sql, /cpt_code as cpt, revenue_code as revenue/);
  assertAllBound(combo.sql, combo.params);
});

test('combo grouping: honors the facility multi-select the same way (empty = no restriction)', () => {
  const nonEmpty = buildCmdSearchSummaryQueries({ facility: ['DALLAS MENTAL HEALTH LLC'] }, ENTITY);
  assert.match(nonEmpty.combo.sql, /facility = any\(\$2::text\[\]\)/);
  assertAllBound(nonEmpty.combo.sql, nonEmpty.combo.params);
  const empty = buildCmdSearchSummaryQueries({ facility: [] }, ENTITY);
  assert.doesNotMatch(empty.combo.sql, /facility = any/);
  assertAllBound(empty.combo.sql, empty.combo.params);
});

test('revenue_code exact filter binds (page query + all summary queries)', () => {
  const { sql, params } = buildCmdExplorerQuery(null, { revenue_code: '0100' }, SORT, 51, ENTITY);
  assert.match(sql, /revenue_code = \$2/);
  assert.equal(params[1], '0100');
  assertAllBound(sql, params);
  // the exact same predicate flows into the summary queries (so summary + grid agree)
  const { totals, combo } = buildCmdSearchSummaryQueries({ revenue_code: '0100' }, ENTITY);
  assert.match(totals.sql, /revenue_code = \$2/);
  assert.match(combo.sql, /revenue_code = \$2/);
});

test('combo drill-down narrows the grid by BOTH cpt_code AND revenue_code together', () => {
  // A combo chip sets both fields; the page query must emit BOTH bound equality predicates.
  const both = buildCmdExplorerQuery(null, { cpt_code: '90853', revenue_code: '0900' }, SORT, 51, ENTITY);
  assert.match(both.sql, /cpt_code = \$2/);
  assert.match(both.sql, /revenue_code = \$3/);
  assert.deepEqual(both.params.slice(1, 3), ['90853', '0900']);
  assertAllBound(both.sql, both.params);
  // Clearing the combo (neither field) drops BOTH predicates — back to the search-level result set.
  const cleared = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  assert.doesNotMatch(cleared.sql, /cpt_code =/);
  assert.doesNotMatch(cleared.sql, /revenue_code =/);
  assertAllBound(cleared.sql, cleared.params);
});
