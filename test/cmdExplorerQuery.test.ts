import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  likeContains,
  buildCmdExplorerQuery,
  buildCmdSearchSummaryQueries,
  buildCmdFacilityOptionsQuery,
  buildQualifyFacilityOptionsQuery,
  buildCmdPayerOptionsQuery,
  buildCmdEmployerOptionsQuery,
  buildCmdCollectionsEmployerOptionsQuery,
  buildCmdCollectionsEmployerVocabularyQuery,
  CMD_FUNDING_MARKETS,
  buildCohortCurveQueries,
  buildCohortDrilldownQueries,
  sanitizeGridColumns,
  resolveCmdExplorerSort,
  resolveCmdExplorerCursor,
  CMD_EXPLORER_DEFAULT_SORT,
  CMD_EXPLORER_SORTABLE_COLUMNS,
  CMD_EXPLORER_COLUMN_KEYS,
  CMD_EXPLORER_SEARCH_COLUMNS,
  CMD_SEARCH_TERM_MIN,
  CMD_SEARCH_TOP_N,
  COHORT_MIN_PATIENTS,
  COHORT_POSITION_CAP,
  COHORT_DRILLDOWN_TABLE_MIN_PATIENTS,
  clearsCohortFloor,
  clearsDrilldownTableFloor,
  deriveYield,
  type CmdExplorerFilter,
  type CmdExplorerSort,
  buildCmdEmployerCoverageQuery,
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
  assert.match(sql, /order by t\.payment_received desc nulls last, t\.id desc/);
  assertAllBound(sql, params);
});

test('substring search: OR across ONLY allowlisted columns, one shared pattern param', () => {
  const filter: CmdExplorerFilter = {
    q: 'BCBS',
    // patient_name is PHI, "bogus" is unknown → both dropped by the allowlist
    searchColumns: ['facility', 'primary_payer', 'patient_name' as never, 'bogus' as never],
  };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  // both allowlisted columns present, PHI / unknown absent. NO ::text cast (0081): the four
  // search columns ARE text, and the bare column is what the trigram GIN indexes match.
  assert.match(sql, /facility ilike \$2/);
  assert.match(sql, /primary_payer ilike \$2/);
  assert.doesNotMatch(sql, /::text ilike/, 'the cast must not creep back (0081 index reachability)');
  assert.doesNotMatch(sql, /patient_name/);
  assert.doesNotMatch(sql, /bogus/);
  // ONE bound pattern reused across the OR
  assert.match(sql, /\(facility ilike \$2 or primary_payer ilike \$2\)/);
  assert.equal(params[1], '%BCBS%');
  assertAllBound(sql, params);
});

test('search allowlist is the 4 TEXT columns only — money/date keys are dropped (Tier B)', () => {
  // The allowlist itself is exactly the 4 text columns.
  assert.deepEqual(Object.keys(CMD_EXPLORER_SEARCH_COLUMNS).sort(), [
    'cpt_code',
    'facility',
    'primary_payer',
    'revenue_code',
  ]);
  // A term asking to search removed numeric/date columns emits ILIKE only for the surviving text col.
  const filter: CmdExplorerFilter = {
    q: 'BCBS',
    searchColumns: [
      'charge_amount' as never,
      'payment_received' as never,
      'charge_date' as never,
      'allowed_amount' as never,
      'cpt_code',
    ],
  };
  const { sql } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(sql, /cpt_code ilike \$2/);
  assert.doesNotMatch(sql, /charge_amount ilike/);
  assert.doesNotMatch(sql, /payment_received ilike/);
  assert.doesNotMatch(sql, /charge_date ilike/);
  assert.doesNotMatch(sql, /allowed_amount ilike/);
});

test('substring search: a sub-minimum term emits NO ILIKE clause (browse), the floor is 3', () => {
  assert.equal(CMD_SEARCH_TERM_MIN, 3);
  // 2 chars → no substring clause even with a valid column (degrades to a plain browse).
  const short = buildCmdExplorerQuery(null, { q: '90', searchColumns: ['cpt_code'] }, SORT, 51, ENTITY);
  assert.doesNotMatch(short.sql, /ilike/);
  // Exactly 3 chars → the substring clause is emitted.
  const ok = buildCmdExplorerQuery(null, { q: '908', searchColumns: ['cpt_code'] }, SORT, 51, ENTITY);
  assert.match(ok.sql, /cpt_code ilike \$2/);
  // The floor also guards the summary aggregates.
  const { totals } = buildCmdSearchSummaryQueries({ q: 'ab', searchColumns: ['facility'] }, ENTITY);
  assert.doesNotMatch(totals.sql, /ilike/);
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

test('allowed_amount / pct_allowed / pct_paid are SORTABLE AGAIN (0059 ③) — allowed_amount maps to allowed_reliable', () => {
  // 0059 materialized allowed_reliable + both pcts, so all nine columns keyset-sort for real.
  for (const c of [
    'payment_received', 'charge_date', 'charge_amount', 'allowed_amount', 'pct_allowed', 'pct_paid',
    'insurance_payments', 'adjustments', 'patient_balance_due',
  ] as const) {
    assert.ok((CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes(c), `${c} must be sortable`);
    assert.deepEqual(
      resolveCmdExplorerSort({ column: c, direction: 'asc' }),
      { column: c, direction: 'asc' },
      `${c} must resolve as itself, not clamp to the default`,
    );
  }
  // THE REMAP: the grid displays allowed_reliable AS allowed_amount, so the allowed_amount sort +
  // keyset must bind the PHYSICAL allowed_reliable column — never the raw netted allowed_amount.
  const byAllowed = buildCmdExplorerQuery(
    { id: 42, value: '250.00' }, {}, { column: 'allowed_amount', direction: 'desc' }, 51, ENTITY,
  );
  assert.match(byAllowed.sql, /order by t\.allowed_reliable desc nulls last, t\.id desc/);
  assert.doesNotMatch(byAllowed.sql, /order by t\.allowed_amount/);
  assert.match(byAllowed.sql, /\(allowed_reliable < \$\d+ or \(allowed_reliable = \$\d+ and id < \$\d+\) or allowed_reliable is null\)/,
    'keyset walks allowed_reliable too');
  // The pct sorts bind their own materialized columns.
  const byPct = buildCmdExplorerQuery(null, {}, { column: 'pct_paid', direction: 'asc' }, 51, ENTITY);
  assert.match(byPct.sql, /order by t\.pct_paid asc nulls last, t\.id asc/);
  // Projection: displayed allowed IS the tiered value; pcts read straight off the matview.
  const { sql } = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  assert.match(sql, /allowed_reliable as allowed_amount/);
  // qualified `t.` since the employer join (0101) made bare column names ambiguous
  assert.match(sql, /t\.pct_allowed, t\.pct_paid/);
  assert.doesNotMatch(sql, /round\(/, 'no per-page pct re-derivation left');
});

test('facility options query is tenant-scoped and its only bound value is entityIds', () => {
  const { sql, params } = buildCmdFacilityOptionsQuery(ENTITY);
  // tenant scope on the 0080 dimension matview is the sole bound param ($1 = entityIds)
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(params, [ENTITY]);
  assert.equal(params.length, 1);
  // distinct facilities from the 0080 filter-options matview (tenant-scoped, kind literal),
  // enriched by resolving to the dimension. The 503MB cmd_explorer_rows DISTINCT scan is gone.
  assert.match(sql, /select distinct value as facility from collections\.cmd_explorer_filter_options/);
  assert.match(sql, /kind = 'facility'/);
  assert.doesNotMatch(sql, /from collections\.cmd_explorer_rows/);
  // two-path resolution: exact name match OR the explicit alias crosswalk, then dimension by code
  assert.match(sql, /left join collections\.facilities fe on upper\(fe\.facility_name\) = upper\(r\.facility\)/);
  assert.match(sql, /left join collections\.cmd_facility_aliases a on upper\(a\.facility_text\) = upper\(r\.facility\)/);
  assert.match(sql, /f\.facility_code = coalesce\(fe\.facility_code, a\.facility_code\)/);
  assertAllBound(sql, params);
});

test('the COLLECTIONS facility options stay raw-text grain — that surface is out of scope', () => {
  // Guard against "fixing" the duplicate-option problem here too. Collections is production; only
  // Qualify's picker was de-duplicated, and it uses its own builder.
  const { sql } = buildCmdFacilityOptionsQuery(ENTITY);
  assert.match(sql, /group by r\.facility/, 'Collections groups by the RAW text, one row per spelling');
  assert.doesNotMatch(sql, /array_agg/);
  assert.doesNotMatch(sql, /display_acronym/);
});

test('QUALIFY facility options collapse to ONE ROW PER FACILITY and carry every raw spelling', () => {
  const { sql, params } = buildQualifyFacilityOptionsQuery(ENTITY);
  // Same vocabulary + same two-path crosswalk as the Collections list, so the option set stays
  // exactly the set of facility texts the grid/summary predicate can match.
  assert.match(sql, /select distinct value as facility from collections\.cmd_explorer_filter_options/);
  assert.match(sql, /kind = 'facility'/);
  assert.match(sql, /left join collections\.facilities fe on upper\(fe\.facility_name\) = upper\(r\.facility\)/);
  assert.match(sql, /left join collections\.cmd_facility_aliases a on upper\(a\.facility_text\) = upper\(r\.facility\)/);
  assert.doesNotMatch(sql, /from collections\.cmd_explorer_rows/);

  // THE DE-DUPLICATION: group by the RESOLVED code, so `LONESTAR MENTAL HEALTH` and
  // `LONESTAR MENTAL HEALTH LLC` (both LSMH) become one option instead of two identical-looking rows.
  assert.match(sql, /group by coalesce\(f\.facility_code, upper\(r\.facility\)\)/);
  // ...and keep EVERY spelling, because the filter must cover all 4,237 charge lines, not 4,156 or 81.
  assert.match(sql, /array_agg\(r\.facility order by r\.facility\) as variants/);
  // An unresolved text (the `No Facility` placeholder) groups by itself and keeps its own row.
  assert.match(sql, /min\(r\.facility\) as value/);

  // Label from display_acronym FIRST: it is the curated short label, populated for all 16 mnemonic
  // facilities and NULL for every 8-digit Indigo one — hence the mandatory facility_name fallback.
  assert.match(sql, /coalesce\(f\.display_acronym, f\.facility_name, min\(r\.facility\)\) as display/);

  assert.deepEqual(params, [ENTITY]);
  assert.equal(params.length, 1);
  assertAllBound(sql, params);
});

// --- guided payer search: multi-select payer filter + payer options -----------

test('payer multi-select binds as a single text[] param (guided payer search)', () => {
  const { sql, params } = buildCmdExplorerQuery(null, { primary_payers: ['AETNA', 'CIGNA'] }, SORT, 51, ENTITY);
  assert.match(sql, /primary_payer = any\(\$2::text\[\]\)/);
  assert.deepEqual(params[1], ['AETNA', 'CIGNA']);
  assertAllBound(sql, params);
});

test('payer multi-select: EMPTY array is NO restriction (all payers), not zero rows', () => {
  // Same trap as the facility set: `primary_payer = any(ARRAY[]::text[])` would match nothing. An
  // empty/null selection must OMIT the payer clause entirely.
  for (const primary_payers of [[], null, undefined] as (string[] | null | undefined)[]) {
    const { sql, params } = buildCmdExplorerQuery(null, { primary_payers }, SORT, 51, ENTITY);
    assert.doesNotMatch(sql, /primary_payer = any/, `primary_payers=${JSON.stringify(primary_payers)} must emit no payer clause`);
    assertAllBound(sql, params);
  }
});

test('search summary honors the payer multi-select the same way (empty = no restriction)', () => {
  const nonEmpty = buildCmdSearchSummaryQueries({ primary_payers: ['AETNA'] }, ENTITY);
  assert.match(nonEmpty.totals.sql, /primary_payer = any\(\$2::text\[\]\)/);
  assert.deepEqual(nonEmpty.totals.params[1], ['AETNA']);
  assertAllBound(nonEmpty.totals.sql, nonEmpty.totals.params);
  const empty = buildCmdSearchSummaryQueries({ primary_payers: [] }, ENTITY);
  assert.doesNotMatch(empty.totals.sql, /primary_payer = any/);
});

test('payer options query is tenant-scoped and its only bound value is entityIds', () => {
  const { sql, params } = buildCmdPayerOptionsQuery(ENTITY);
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(params, [ENTITY]);
  assert.equal(params.length, 1);
  // reads the 0080 filter-options matview (kind literal), NOT the 503MB base-table DISTINCT.
  // DISTINCT survives: a multi-entity (Consolidated) scope can hold one payer under both entities.
  assert.match(sql, /select distinct value as primary_payer from collections\.cmd_explorer_filter_options/);
  assert.match(sql, /kind = 'payer'/);
  assert.doesNotMatch(sql, /from collections\.cmd_explorer_rows/);
  assert.match(sql, /order by primary_payer/);
  assertAllBound(sql, params);
});

test('page query: cursor + limit are bound; sort column drives ORDER BY', () => {
  const sort: CmdExplorerSort = { column: 'charge_amount', direction: 'asc' };
  const { sql, params } = buildCmdExplorerQuery({ id: 42, value: '250.00' }, {}, sort, 51, ENTITY);
  assert.match(sql, /order by t\.charge_amount asc nulls last, t\.id asc/);
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

test('search summary totals expose total_allowed (SELECTION-MODE %s derive from it, no new query)', () => {
  // The tile aggregate MUST sum allowed_reliable — the SAME column the combo ratios + cohort totals
  // use — so %Allowed/%Paid can be derived filter-wide from this one query. Guard against a
  // regression that drops it (which would silently break selection-mode green cards).
  const { totals } = buildCmdSearchSummaryQueries({ q: 'BCBS', searchColumns: ['facility'] }, ENTITY);
  assert.match(totals.sql, /coalesce\(sum\(allowed_reliable\), 0\)::float8 as total_allowed/);
  assert.match(totals.sql, /coalesce\(sum\(charge_amount\), 0\)::float8 as total_charge/);
  assert.match(totals.sql, /coalesce\(sum\(insurance_payments\), 0\)::float8 as total_paid/);
});

test('deriveYield: shared cohort/selection derivation — mapping, 2dp rounding, guarded denominators', () => {
  // Field mapping: %allowed = allowed/billed, %paid = paid/allowed, %collected = paid/billed.
  const y = deriveYield({ billed: 1000, allowed: 600, paid: 450 });
  assert.equal(y.pct_allowed, 60); // 600/1000
  assert.equal(y.pct_paid, 75); // 450/600
  assert.equal(y.pct_collected, 45); // 450/1000

  // 2-dp rounding is byte-identical to the inline ratio it replaced (Math.round(x*10000)/100).
  assert.equal(deriveYield({ billed: 3, allowed: 1, paid: null }).pct_allowed, 33.33);

  // Guarded denominators → null ("—"), never a divide-by-zero / negative / NaN.
  assert.equal(deriveYield({ billed: 0, allowed: 500, paid: 100 }).pct_allowed, null);
  assert.equal(deriveYield({ billed: 1000, allowed: 0, paid: 100 }).pct_paid, null);
  assert.equal(deriveYield({ billed: -10, allowed: 5, paid: 5 }).pct_collected, null);
  assert.equal(deriveYield({ billed: null, allowed: null, paid: null }).pct_allowed, null);
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
  assert.match(combo.sql, /round\(sum\(allowed_reliable\) \/ sum\(charge_amount\) \* 100, 2\)::float8 end as pct_allowed/);
  assert.match(combo.sql, /round\(sum\(insurance_payments\) \/ sum\(allowed_reliable\) \* 100, 2\)::float8 end as pct_paid/);
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
  // %-allowed guarded by `sum(charge) > 0`; %-paid guarded by the DENOMINATOR FLOOR (netted allowed
  // must be ≥ 2% of billed and ≥ $100) → NULL on a meaningless denominator, never a 1900% artifact.
  assert.match(combo.sql, /case when sum\(charge_amount\) > 0 then/);
  assert.match(combo.sql, /case when sum\(allowed_reliable\) >= greatest\(sum\(charge_amount\) \* 0\.02, 100\) then/);
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
  // Clearing the combo (neither field) drops BOTH bound FILTER predicates — back to the search-level
  // result set. (Match on `= $n`, the filter form: the charge-grain collapse's grain-JOIN references
  // `cpt_code = p.cpt_code` / `coalesce(revenue_code,'') = …` structurally, which is not a filter.)
  const cleared = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  assert.doesNotMatch(cleared.sql, /cpt_code = \$/);
  assert.doesNotMatch(cleared.sql, /revenue_code = \$/);
  assertAllBound(cleared.sql, cleared.params);
});

// --- 0050 charge-grain rollup: which table each query reads -----------------
// The grain audit (2026-07-13) confirmed cmd_explorer_rows is SNAPSHOT grain (BXR ~2.14 rows per
// logical charge), so every AGGREGATE must read the charge-grain rollup view — summing the raw
// table double-counts charges and produced the >100% ratios. The row-BROWSING surfaces (grid page
// query, facility options, drilldown patient table) stay on the base table by design.

test('grain: every aggregate reads the 0050 charge rollup; row-browsing reads stay on the base table', () => {
  const { totals, groups, combo } = buildCmdSearchSummaryQueries({}, ENTITY);
  for (const q of [totals, groups.facility, groups.primary_payer, groups.cpt_code, combo]) {
    assert.match(q.sql, /from collections\.cmd_explorer_charge_rollup/);
    assert.doesNotMatch(q.sql, /from collections\.cmd_explorer_rows/);
  }
  const curve = buildCohortCurveQueries('deadbeefcafe0011', ENTITY);
  for (const q of [curve.byPosition, curve.byDays]) {
    assert.match(q.sql, /from collections\.cmd_explorer_charge_rollup/);
    assert.doesNotMatch(q.sql, /cmd_explorer_rows/);
  }
  for (const axis of ['position', 'days'] as const) {
    const dd = buildCohortDrilldownQueries('deadbeefcafe0011', ENTITY, axis, 3);
    // Bucket membership + the three aggregate joins: charge grain.
    for (const q of [dd.stats, dd.byPayer, dd.byCptRevenue]) {
      assert.match(q.sql, /cmd_explorer_charge_rollup/);
      assert.doesNotMatch(q.sql, /join collections\.cmd_explorer_rows/);
    }
    // The patient TABLE projects real base-table rows (latest snapshot per charge via the rollup's
    // latest-row ids) — the audited reveal path needs real row ids.
    assert.match(dd.rows.sql, /from collections\.cmd_explorer_rows t/);
  }
  // Grid page query (0059 ③): ONE select over the matview — BUILD X's per-page base-table override
  // (snaps/sel/picked) is DELETED; allowed_reliable/pct_allowed/pct_paid are read materialized.
  const grid = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  assert.match(grid.sql, /from collections\.cmd_explorer_charge_rollup t/);
  assert.doesNotMatch(grid.sql, /snaps|picked|recon_val|latest_pos/, 'the X-era override CTEs are gone');
  // The base table IS referenced now (0101's employer join), so a blanket doesNotMatch on
  // cmd_explorer_rows no longer expresses the invariant. State the invariant DIRECTLY instead —
  // it is strictly stronger than the old proxy, not a relaxation of it:
  //   the ONLY base-table reference is the 1:1 LEFT JOIN for the single non-money employer column,
  //   and no grain-bearing value is sourced from it.
  const baseRefs = [...grid.sql.matchAll(/collections\.cmd_explorer_rows/g)];
  assert.equal(baseRefs.length, 1, 'exactly one base-table reference — the employer join');
  assert.match(grid.sql, /left join collections\.cmd_explorer_rows e on e\.id = p\.id/);
  // e.* supplies employer_name and NOTHING else. Money/ratio columns re-derived per page from
  // snapshot-grain base rows is precisely the >100%-ratio bug the 0050/0059 grain audit fixed.
  const eRefs = [...grid.sql.matchAll(/\be\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(eRefs)].sort(), ['employer_name', 'id']);
  for (const money of ['allowed_amount', 'allowed_reliable', 'charge_amount', 'insurance_payments', 'pct_allowed', 'pct_paid']) {
    assert.doesNotMatch(grid.sql, new RegExp(`e\\.${money}`), `${money} must come from the rollup, never the base table`);
  }
});

test('grain: the %-paid denominator floor is the SHARED select everywhere ratios render', () => {
  // 0059 ④: the floor's denominator is the RELIABLE sum; the guard shape/constants are UNCHANGED
  // (the 2%/$100 re-ruling is deferred until real allowed_reliable numbers — do not touch here).
  const guard = /case when sum\(allowed_reliable\) >= greatest\(sum\(charge_amount\) \* 0\.02, 100\) then/;
  const { combo } = buildCmdSearchSummaryQueries({}, ENTITY);
  assert.match(combo.sql, guard);
  const { byPosition, byDays } = buildCohortCurveQueries('deadbeefcafe0011', ENTITY);
  assert.match(byPosition.sql, guard);
  assert.match(byDays.sql, guard);
  const dd = buildCohortDrilldownQueries('deadbeefcafe0011', ENTITY, 'position', 3);
  assert.match(dd.stats.sql, guard);
  assert.match(dd.byCptRevenue.sql, guard);
  // The UNGUARDED division must not survive anywhere a %-paid is computed.
  for (const q of [combo, byPosition, byDays, dd.stats, dd.byCptRevenue]) {
    assert.doesNotMatch(q.sql, /case when sum\(allowed_(amount|reliable)\) > 0 then/);
    // 0059 ④: the netted posting sum is BANNED from every ratio aggregate — reliable only.
    assert.doesNotMatch(q.sql, /sum\(allowed_amount\)/);
  }
});

// --- Session D: alpha-prefix cohort payer-behavior curve --------------------

const PREFIX_TOKEN = 'deadbeefcafe0011'; // opaque keyed-HMAC blind-index token (never raw PHI)

test('cohort curve: BOTH queries tenant-scoped + prefix-token bound, sequenced, dollar-weighted', () => {
  const { byPosition, byDays } = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY);
  for (const q of [byPosition, byDays]) {
    // Tenant scope + the opaque prefix token are the only cohort selectors, both bound.
    assert.match(q.sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
    assert.match(q.sql, /member_id_prefix_bidx = \$2/);
    assert.deepEqual(q.params[0], ENTITY);
    assert.equal(q.params[1], PREFIX_TOKEN);
    // Dollar-weighted ratio-of-sums (same discipline as the combo grouping) — never avg-of-ratios.
    assert.match(q.sql, /round\(sum\(allowed_reliable\) \/ sum\(charge_amount\) \* 100, 2\)::float8 end as pct_allowed/);
    assert.match(q.sql, /round\(sum\(insurance_payments\) \/ sum\(allowed_reliable\) \* 100, 2\)::float8 end as pct_paid/);
    assert.doesNotMatch(q.sql, /avg\(/);
    assertAllBound(q.sql, q.params);
  }
  // Position query sequences visits with dense_rank over charge_date (same-day lines = one visit).
  assert.match(byPosition.sql, /dense_rank\(\) over \(partition by member_id_bidx order by charge_date\)/);
  // Days query measures each patient's days since their OWN first claim.
  assert.match(byDays.sql, /min\(charge_date\) as first_dt/);
  assert.match(byDays.sql, /charge_date - f\.first_dt/);
});

test('cohort curve: SMALL-COHORT SUPPRESSION is in-query and counts DISTINCT PATIENTS', () => {
  const { byPosition, byDays } = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY);
  for (const q of [byPosition, byDays]) {
    // Suppression is a HAVING on the FINAL grouped result, on distinct PATIENTS (not rows), bound.
    assert.match(q.sql, /having count\(distinct member_id_bidx\) >= \$\d+/);
    // No LIMIT/pagination exists that could return a pre-suppression slice.
    assert.doesNotMatch(q.sql, /\blimit\b/i);
  }
});

test('cohort curve: the min-patient floor is CLAMPED — a caller can never weaken suppression', () => {
  // Adversarial: try to lower the floor below the agreed minimum. It must stay pinned at the floor.
  for (const attempt of [0, 1, 2, 4, -100]) {
    const { byPosition, byDays } = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY, { minPatients: attempt });
    for (const q of [byPosition, byDays]) {
      const minParam = q.params[q.params.length - 1];
      assert.equal(minParam, COHORT_MIN_PATIENTS, `minPatients=${attempt} must clamp UP to ${COHORT_MIN_PATIENTS}`);
    }
  }
  // A caller may only make it STRICTER.
  const strict = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY, { minPatients: 25 });
  assert.equal(strict.byPosition.params[strict.byPosition.params.length - 1], 25);
});

test('cohort curve: position axis is capped and bound; no raw-PHI column is ever projected', () => {
  const { byPosition, byDays } = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY);
  // Position cap is a bound param defaulting to COHORT_POSITION_CAP.
  assert.match(byPosition.sql, /where pos <= \$3/);
  assert.ok(byPosition.params.includes(COHORT_POSITION_CAP));
  // The ONLY identity column touched is the blind-index token (in WHERE / window / distinct-count);
  // the encrypted raw-PHI columns are NEVER referenced, and the OUTPUT is a pure aggregate.
  for (const q of [byPosition, byDays]) {
    assert.doesNotMatch(q.sql, /member_id_raw|patient_name|group_number/);
    // output projection is only the aggregate shape — no bare member_id_bidx column selected out
    assert.match(q.sql, /as bucket, count\(distinct member_id_bidx\)::int as patients, count\(\*\)::int as claims/);
  }
});

// --- Phase 2: dollars + zero-pay per bucket ----------------------------------

test('cohort curve: Phase 2 dollars + zero-pay ride the SAME suppressed select, keyed off payments', () => {
  const { byPosition, byDays } = buildCohortCurveQueries(PREFIX_TOKEN, ENTITY);
  for (const q of [byPosition, byDays]) {
    // Bucket $ paid (powers client-side avg-$/patient + cumulative-$/starting-patient), coalesced.
    assert.match(q.sql, /round\(coalesce\(sum\(insurance_payments\), 0\), 2\)::float8 as paid_total/);
    // Zero-pay share = lines with NO positive insurance payment; NULL payment counts as zero-paid.
    assert.match(
      q.sql,
      /round\(count\(\*\) filter \(where coalesce\(insurance_payments, 0\) <= 0\)::numeric \/ count\(\*\) \* 100, 2\)::float8 as pct_zero_paid/,
    );
    // Patient-shifted subset: zero-paid AND balance moved to the patient (deductible/coinsurance).
    assert.match(
      q.sql,
      /round\(count\(\*\) filter \(where coalesce\(insurance_payments, 0\) <= 0 and patient_balance_due > 0\)::numeric \/ count\(\*\) \* 100, 2\)::float8 as pct_patient_shifted/,
    );
    // The zero-pay signal is PAYMENTS, deliberately never allowed_amount (~85% of allowed<=0/null
    // lines in this dataset carry real payments — allowed<=0 is not a denial signal).
    assert.doesNotMatch(q.sql, /allowed_(amount|reliable) <= /);
    // The metric fields sit in the FINAL suppressed select (immediately before `from seq`, whose
    // rollup carries the HAVING floor) — no second unsuppressed projection exists.
    assert.match(q.sql, /as pct_patient_shifted from seq/);
    assertAllBound(q.sql, q.params);
  }
});

// --- Session G: cohort-point drilldown ---------------------------------------

const ENTITY_B = ['141d459c-f371-4229-9a92-ace198e940bb']; // Indigo — distinct from ENTITY (BXR)

test('drilldown: N-1 suppressed, N shows — exact boundary on the patient-table floor', () => {
  assert.equal(clearsDrilldownTableFloor(COHORT_DRILLDOWN_TABLE_MIN_PATIENTS - 1), false);
  assert.equal(clearsDrilldownTableFloor(COHORT_DRILLDOWN_TABLE_MIN_PATIENTS), true);
  // Locks the signed-off value itself — a silent constant change would fail this test.
  assert.equal(COHORT_DRILLDOWN_TABLE_MIN_PATIENTS, 10);
  // The table floor is STRICTER than (never equal to or below) the curve's own aggregate floor.
  assert.ok(COHORT_DRILLDOWN_TABLE_MIN_PATIENTS > COHORT_MIN_PATIENTS);
});

test('drilldown: the aggregate floor is the SAME boundary the curve itself enforces', () => {
  assert.equal(clearsCohortFloor(COHORT_MIN_PATIENTS - 1), false);
  assert.equal(clearsCohortFloor(COHORT_MIN_PATIENTS), true);
});

test('drilldown queries: all four share the SAME tenant + prefix-token scope, fully bound', () => {
  for (const axis of ['position', 'days'] as const) {
    const { stats, byPayer, byCptRevenue, rows } = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, axis, 3);
    for (const q of [stats, byPayer, byCptRevenue, rows]) {
      assert.match(q.sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
      assert.match(q.sql, /member_id_prefix_bidx = \$2/);
      assert.deepEqual(q.params[0], ENTITY);
      assert.equal(q.params[1], PREFIX_TOKEN);
      assertAllBound(q.sql, q.params);
    }
  }
});

test('drilldown queries: tenant scope is DERIVED from the caller — swapping entityIds swaps the bound param, not the SQL shape', () => {
  // The single hermetic proxy this repo has for "reader isolation" (no live-DB harness exists for
  // ANY reader here — see buildCmdExplorerQuery's identical "tenant scope is always the first bound
  // param" test above): prove the tenant condition is a bound $1 driven by the argument, so no code
  // path can silently hardcode or drop it. Live cross-tenant verification is run separately (see the
  // G3 handoff notes) against the real BXR/Indigo data.
  const bxr = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 3);
  const indigo = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY_B, 'position', 3);
  for (const [a, b] of [
    [bxr.stats, indigo.stats],
    [bxr.byPayer, indigo.byPayer],
    [bxr.byCptRevenue, indigo.byCptRevenue],
    [bxr.rows, indigo.rows],
  ] as const) {
    assert.equal(a.sql, b.sql, 'SQL shape must be identical regardless of tenant');
    assert.deepEqual(a.params[0], ENTITY);
    assert.deepEqual(b.params[0], ENTITY_B);
    assert.notDeepEqual(a.params[0], b.params[0]);
  }
});

test('drilldown queries: position axis sequences by dense_rank and filters to the exact bucket', () => {
  const { stats } = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 7);
  assert.match(stats.sql, /dense_rank\(\) over \(partition by member_id_bidx order by charge_date\) as pos/);
  assert.match(stats.sql, /bucket_rows as \(select id, member_id_bidx from seq where pos = \$3\)/);
  assert.equal(stats.params[2], 7);
});

test('drilldown queries: days axis measures from each patient\'s OWN first claim and filters to the exact bucket', () => {
  const { stats } = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'days', 60);
  assert.match(stats.sql, /min\(charge_date\) as first_dt/);
  assert.match(stats.sql, /charge_date - f\.first_dt/);
  assert.match(
    stats.sql,
    /bucket_rows as \(select id, member_id_bidx from seq where \(floor\(days_since::numeric \/ \$3\) \* \$3\)::int = \$4\)/,
  );
  // dayBucketDays defaults to COHORT_DAY_BUCKET_DAYS (30), bound just before the target bucket.
  assert.equal(stats.params[2], 30);
  assert.equal(stats.params[3], 60);
});

test('drilldown queries: stats re-derives patients from DISTINCT member_id_bidx, never trusts a count', () => {
  const { stats } = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 3);
  assert.match(stats.sql, /count\(distinct bucket_rows\.member_id_bidx\)::int as patients/);
  // Dollar-weighted metrics ride the SAME suppressed-style select as the curve — never avg().
  assert.doesNotMatch(stats.sql, /avg\(/);
});

test('drilldown queries: byPayer / byCptRevenue are top-N, dollar-weighted, and bound (default + override)', () => {
  // Position axis: the shared CTE binds 3 params (entityIds, prefix, bucket) before topN, so topN
  // lands at $4 / params[3] — asserted here rather than assumed, since it depends on the CTE shape.
  const def = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 3);
  assert.match(def.byPayer.sql, /group by primary_payer order by charge desc nulls last, count desc limit \$4/);
  assert.equal(def.byPayer.params[3], CMD_SEARCH_TOP_N);
  assert.match(
    def.byCptRevenue.sql,
    /group by cpt_code, revenue_code order by charge desc nulls last, count desc limit \$4/,
  );
  assert.equal(def.byCptRevenue.params[3], CMD_SEARCH_TOP_N);
  assert.match(def.byCptRevenue.sql, /round\(sum\(allowed_reliable\) \/ sum\(charge_amount\) \* 100, 2\)::float8 end as pct_allowed/);

  const custom = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 3, { topN: 3 });
  assert.equal(custom.byPayer.params[3], 3);
  assert.equal(custom.byCptRevenue.params[3], 3);
  assertAllBound(custom.byPayer.sql, custom.byPayer.params);
  assertAllBound(custom.byCptRevenue.sql, custom.byCptRevenue.params);
});

test('drilldown queries: the patient-table row projection reuses CMD_EXPLORER_SELECT — same non-PHI shape, NO raw PHI column ever', () => {
  const { rows, stats, byPayer, byCptRevenue } = buildCohortDrilldownQueries(PREFIX_TOKEN, ENTITY, 'position', 3);
  // Same explicit non-PHI column list the main grid returns (id, charge_date, cpt_code, ... pct_paid).
  assert.match(rows.sql, /select id, to_char\(charge_date, 'YYYY-MM-DD'\) as charge_date/);
  // USING (id), not an explicit ON-join — an ON-join would leave CMD_EXPLORER_SELECT's bare `id`
  // column ambiguous (both `t` and `bucket_rows` have their own `id`); USING merges it into one.
  // (This exact ambiguity was caught live against a real Postgres planner, not by a string match —
  // ­see the G3 handoff notes.)
  assert.match(rows.sql, /join bucket_rows using \(id\)/);
  assert.match(rows.sql, /order by t\.charge_date/);
  // No query in this drilldown ever references the encrypted raw-PHI columns, under any axis/query.
  for (const q of [stats, byPayer, byCptRevenue, rows]) {
    assert.doesNotMatch(q.sql, /member_id_raw|patient_name|group_number/);
  }
});

test('VOB market: employer + funding emit ONE member_id_bidx semi-join into member_benefits_latest, values bound', () => {
  const { sql, params } = buildCmdExplorerQuery(
    null,
    { employers: ['BOEING', 'KAISER'], funding: ['Self-Funded'] },
    SORT,
    51,
    ENTITY,
  );
  // both sub-conditions live in the SAME subquery (one latest VOB row per member), semi-join not JOIN
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$\d+::text\[\]\) and employer_norm = any\(\$\d+::text\[\]\)\)/,
  );
  assert.equal((sql.match(/vob\.member_benefits_latest/g) || []).length, 1);
  assert.doesNotMatch(sql, /join vob\.member_benefits_latest/i);
  // funding binds before employers (cond order); tenant is $1, limit is last.
  assert.deepEqual(params, [ENTITY, ['Self-Funded'], ['BOEING', 'KAISER'], 51]);
});

test('VOB market: only funding present emits a semi-join with just the funding condition', () => {
  const { sql, params } = buildCmdExplorerQuery(null, { funding: ['Self-Funded', 'Fully Insured'] }, SORT, 51, ENTITY);
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$2::text\[\]\)\)/,
  );
  assert.doesNotMatch(sql, /employer_norm/);
  assert.deepEqual(params, [ENTITY, ['Self-Funded', 'Fully Insured'], 51]);
});

test('VOB market: EMPTY / null employer+funding arrays are NO restriction (no semi-join, not zero rows)', () => {
  for (const v of [[], null, undefined] as (string[] | null | undefined)[]) {
    const { sql } = buildCmdExplorerQuery(null, { employers: v, funding: v }, SORT, 51, ENTITY);
    assert.doesNotMatch(sql, /vob\.member_benefits_latest/, `employers/funding=${JSON.stringify(v)} must emit no VOB clause`);
  }
});

test('search summary honors the VOB market filters the same way (grid + summary agree)', () => {
  const nonEmpty = buildCmdSearchSummaryQueries({ funding: ['Self-Funded'] }, ENTITY);
  assert.match(
    nonEmpty.totals.sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$2::text\[\]\)\)/,
  );
  const empty = buildCmdSearchSummaryQueries({ employers: [], funding: [] }, ENTITY);
  assert.doesNotMatch(empty.totals.sql, /vob\.member_benefits_latest/);
});

test('funding markets vocabulary is exactly the two stored values', () => {
  assert.deepEqual([...CMD_FUNDING_MARKETS], ['Self-Funded', 'Fully Insured']);
});

test('employer options query: tenant-scoped, ILIKE on employer_norm, term escaped + bound ($1/$2/$3)', () => {
  const { sql, params } = buildCmdEmployerOptionsQuery(ENTITY, 'boe%ing', 25);
  assert.match(sql, /from vob\.member_benefits_latest/);
  assert.match(sql, /employer_norm ilike \$2/);
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from collections\.cmd_explorer_rows where business_entity_id = any\(\$1::uuid\[\]\)\)/,
  );
  // returns the normalized key as BOTH the filter value and the display label (0064 canonical key)
  assert.match(sql, /select employer_norm, employer_norm as employer_name/);
  // LIKE metacharacter in the term is escaped, never interpolated
  assert.deepEqual(params, [ENTITY, '%boe\\%ing%', 25]);
});

// --- collections-native employer (migration 0101) ---------------------------
// These cover the dimension that arrives on the CMD report itself. They must never touch the VOB
// plane — Collections reads collections data only (ruled 2026-08-15). Several assertions below are
// deliberately NEGATIVE for that reason: a regression that "helpfully" routes Collections employer
// through vob.member_benefits_latest would otherwise look like a passing feature.

test('grid: employer comes from a LEFT JOIN on the base table, never from the rollup', () => {
  const { sql, params } = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  // the join is LEFT (an INNER would silently drop grid rows whose base row is missing)
  assert.match(sql, /left join collections\.cmd_explorer_rows e on e\.id = p\.id/);
  assert.match(sql, /select p\.\*, e\.employer_name from \(/);
  // the rollup must NOT be asked for a column it does not have
  assert.doesNotMatch(sql, /t\.employer_name/, 'the rollup has no employer column and never will');
  assertAllBound(sql, params);
});

test('grid: the LIMIT is inside the subquery so the join runs on one page, not the whole table', () => {
  const { sql, params } = buildCmdExplorerQuery(null, {}, SORT, 51, ENTITY);
  // limit is bound INSIDE the parenthesised subquery, before the join
  const inner = sql.slice(sql.indexOf('from ('), sql.indexOf(') p left join'));
  assert.match(inner, /limit \$\d+/, 'LIMIT must be inside the subquery');
  assert.doesNotMatch(sql.slice(sql.indexOf(') p left join')), /limit /, 'no LIMIT after the join');
  assertAllBound(sql, params);
});

test('grid: the outer ORDER BY uses the OUTPUT name, so allowed_amount does not 42703', () => {
  // allowed_amount is the ONE key whose physical rollup column differs (allowed_reliable). The
  // subquery projects it as `t.allowed_reliable AS allowed_amount`, so the OUTER query — which
  // selects from that subquery — can only reference the output name. Referencing the physical
  // name there is an undefined-column error, and because the grid's keyset cursor is built from
  // the LAST ROW of this result, an unordered outer query would also silently skip/repeat pages.
  const sort: CmdExplorerSort = { column: 'allowed_amount', direction: 'desc' };
  const { sql } = buildCmdExplorerQuery(null, {}, sort, 51, ENTITY);
  assert.match(sql, /t\.allowed_reliable as allowed_amount/, 'inner projects the physical column');
  assert.match(sql, /order by t\.allowed_reliable desc/, 'inner sorts on the physical column');
  assert.match(sql, /order by p\.allowed_amount desc nulls last, p\.id desc/, 'outer sorts on the alias');
  assert.doesNotMatch(sql, /p\.allowed_reliable/, 'p exposes the alias only — p.allowed_reliable would 42703');
});

test('grid: every sortable column produces an outer ORDER BY that exists on the subquery', () => {
  // Guards the whole allowlist, not just the one remapped key: if a future column is projected
  // under an alias, this catches the mismatch instead of leaving a runtime 42703 for one sort.
  const projected = new Set([
    'id', 'charge_date', 'payment_received', 'cpt_code', 'revenue_code', 'facility',
    'charge_amount', 'allowed_amount', 'insurance_payments', 'adjustments',
    'patient_balance_due', 'primary_payer', 'pct_allowed', 'pct_paid', 'ingested_at',
  ]);
  for (const column of CMD_EXPLORER_SORTABLE_COLUMNS) {
    assert.ok(projected.has(column), `${column} must be projected by the subquery to be sortable`);
    const { sql } = buildCmdExplorerQuery(null, {}, { column, direction: 'asc' }, 51, ENTITY);
    assert.match(sql, new RegExp(`order by p\\.${column} asc nulls last, p\\.id asc`));
  }
});

test('employer_names: a non-empty array emits an id semi-join over the BASE table', () => {
  const filter: CmdExplorerFilter = { employer_names: ['BOEING', 'STARBUCKS'] };
  const { sql, params } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(
    sql,
    /id in \(select e\.id from collections\.cmd_explorer_rows e where e\.employer_name = any\(\$2::text\[\]\)\)/,
  );
  assert.deepEqual(params[1], ['BOEING', 'STARBUCKS']);
  assertAllBound(sql, params);
});

test('employer_names: an EMPTY array is no restriction, never match-nothing', () => {
  // Same discipline as facility/primary_payers. Emitting `= any(ARRAY[]::text[])` here would
  // silently return zero rows the moment the picker is cleared.
  const { sql, params } = buildCmdExplorerQuery(null, { employer_names: [] }, SORT, 51, ENTITY);
  // The PROJECTION always carries e.employer_name (the display join is unconditional) — what must
  // be absent is the FILTER predicate. Asserting on the bare column name would be vacuous here.
  assert.doesNotMatch(sql, /where e\.employer_name = any/);
  assert.doesNotMatch(sql, /id in \(select e\.id/);
  assert.equal(params.length, 2, 'only entity ids + limit remain bound');
  assertAllBound(sql, params);
});

test('employer_names is the COLLECTIONS dimension — it must never reach the VOB plane', () => {
  const filter: CmdExplorerFilter = { employer_names: ['BOEING'] };
  const { sql } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.doesNotMatch(sql, /vob\./, 'Collections reads collections data only');
  assert.doesNotMatch(sql, /member_benefits_latest/);
  assert.doesNotMatch(sql, /employer_norm/);
  assert.doesNotMatch(sql, /member_id_bidx/, 'the VOB semi-join keys on bidx; this one keys on id');
});

test('the two employer dimensions stay separable: VOB `employers` still uses the bidx semi-join', () => {
  // Both filters set at once must emit BOTH predicates against their own planes — proving the
  // collections dimension was added ALONGSIDE the VOB one and did not quietly replace it (which
  // would break Qualify's market filter).
  const filter: CmdExplorerFilter = { employers: ['BOEING'], employer_names: ['BOEING'] };
  const { sql } = buildCmdExplorerQuery(null, filter, SORT, 51, ENTITY);
  assert.match(sql, /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest/);
  assert.match(sql, /id in \(select e\.id from collections\.cmd_explorer_rows e/);
});

test('employer_name is an allowlisted grid column key (saved views may show it)', () => {
  assert.ok(CMD_EXPLORER_COLUMN_KEYS.includes('employer_name'));
  assert.deepEqual(sanitizeGridColumns(['employer_name', 'facility']), ['employer_name', 'facility']);
});

test('the four rollup TEXT columns are sortable, and the sort binds the physical column', () => {
  // Added 2026-08-17 ("orderable just like Excel"). All four live on the charge rollup, so the
  // keyset subquery can drive off them with no schema change.
  for (const c of ['cpt_code', 'revenue_code', 'primary_payer', 'facility'] as const) {
    assert.ok(
      (CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes(c),
      `${c} must be sortable`,
    );
    const { sql } = buildCmdExplorerQuery(null, {}, { column: c, direction: 'asc' }, 50, ENTITY);
    // INSIDE the keyset subquery, bound to the rollup alias — not the outer post-join order.
    assert.match(sql, new RegExp(`order by t\\.${c} asc nulls last, t\\.id asc`), `${c} inner sort`);
  }
});

test('a text sort still keysets: the cursor compares the same column it orders by', () => {
  // Text columns page by string comparison. If the boundary compared a different column than the
  // ORDER BY, paging would skip or repeat rows silently — no error, just missing charge lines.
  const { sql, params } = buildCmdExplorerQuery(
    { id: 42, value: 'LONESTAR MENTAL HEALTH' }, {}, { column: 'facility', direction: 'desc' }, 50, ENTITY,
  );
  assert.match(sql, /facility < \$\d+ or \(facility = \$\d+ and id < \$\d+\) or facility is null/);
  assert.ok(params.includes('LONESTAR MENTAL HEALTH'), 'cursor value is BOUND, never interpolated');
  assert.ok(params.includes(42));
});

test('the three PHI columns are NOT sortable — the rollup has only blind indexes for them', () => {
  // Independent of the employer reason below: there is no plaintext to order by, and HMAC order is
  // not alphabetical order. Sorting one would look broken AND leak an ordering over PHI.
  for (const c of ['patient_name', 'member_id_raw', 'group_number']) {
    assert.ok(!(CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes(c), `${c} must not sort`);
  }
});

test('employer_name is NOT sortable — it is not on the rollup the keyset pages', () => {
  // Sorting the grid by employer would require the keyset to drive off a column the paged matview
  // does not have. Adding it to the sortable allowlist without moving it onto the rollup would
  // produce an undefined-column error on the inner query.
  assert.ok(!(CMD_EXPLORER_SORTABLE_COLUMNS as readonly string[]).includes('employer_name'));
});

test('collections employer options: reads the base table, escapes the term, binds every value', () => {
  const { sql, params } = buildCmdCollectionsEmployerOptionsQuery(ENTITY, 'boe%ing', 25);
  assert.match(sql, /from collections\.cmd_explorer_rows/);
  assert.match(sql, /employer_name ilike \$2/);
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant-scoped');
  assert.match(sql, /group by employer_name order by employer_name limit \$3/);
  // blank-but-present employers are excluded so the picker never offers an empty option
  assert.match(sql, /employer_name is not null and employer_name <> ''/);
  // NOT the VOB sibling
  assert.doesNotMatch(sql, /vob\./);
  assert.doesNotMatch(sql, /employer_norm/);
  // LIKE metacharacter escaped, never interpolated
  assert.deepEqual(params, [ENTITY, '%boe\\%ing%', 25]);
});

test('collections employer VOCABULARY: whole tenant vocabulary, tenant-scoped, no term, no limit', () => {
  const { sql, params } = buildCmdCollectionsEmployerVocabularyQuery(ENTITY);
  assert.match(sql, /^select distinct employer_name /, 'one projected column, never SELECT *');
  assert.match(sql, /from collections\.cmd_explorer_rows/);
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant-scoped');
  // Blank-but-present employers excluded, matching the employerMode partition exactly. If these
  // disagree, the segment counts and the picker vocabulary describe different row sets.
  assert.match(sql, /employer_name is not null and employer_name <> ''/);
  // ⚠ NO term and NO limit, and that is the correctness requirement rather than an omission:
  // canonical grouping turns these rows into option `variants` that drive the grid predicate, so a
  // term-matched or truncated set would silently under-select. See employerCanonical.ts.
  assert.doesNotMatch(sql, /ilike/);
  assert.doesNotMatch(sql, /limit/);
  assert.deepEqual(params, [ENTITY], 'entity ids are the ONLY bound parameter');
  // NOT the VOB sibling — Collections reads collections data only (ruled 2026-08-15/17).
  assert.doesNotMatch(sql, /vob\./);
  assert.doesNotMatch(sql, /employer_norm/);
});

test('grid: an UNVALIDATED sort column can never reach the SQL text', () => {
  // Defence in depth. resolveCmdExplorerSort gates the live path (app/lib/actions.ts), but
  // buildCmdExplorerQuery is EXPORTED and the outer ORDER BY interpolates the output column name
  // rather than a map lookup — so the builder must re-validate rather than trust its argument.
  const evil = "payment_received desc, id; drop table collections.cmd_explorer_rows --";
  const { sql, params } = buildCmdExplorerQuery(
    null,
    {},
    { column: evil as never, direction: 'desc' },
    51,
    ENTITY,
  );
  assert.doesNotMatch(sql, /drop table/i, 'no unvalidated column text may reach the statement');
  assert.doesNotMatch(sql, /--/, 'no comment sequence either');
  // falls back to the default sort key rather than emitting `p.undefined`
  assert.match(sql, /order by p\.payment_received desc nulls last, p\.id desc/);
  assert.doesNotMatch(sql, /p\.undefined/);
  assertAllBound(sql, params);
});

test('grid: a bogus sort DIRECTION cannot reach the SQL either', () => {
  const { sql } = buildCmdExplorerQuery(
    null,
    {},
    { column: 'payment_received', direction: 'asc; drop table x --' as never },
    51,
    ENTITY,
  );
  // `dir` is a ternary over two literals, so anything not exactly 'asc' becomes 'desc'
  assert.doesNotMatch(sql, /drop table/i);
  assert.match(sql, /order by p\.payment_received desc nulls last, p\.id desc/);
});

// --- patient-name search + row_ids filter (2026-08-17) --------------------------------------

test('row_ids: a NON-EMPTY list narrows by id; absent omits the condition entirely', () => {
  const withIds = buildCmdExplorerQuery(null, { row_ids: ['12', '34'] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.match(withIds.sql, /id = any\(\$\d+::bigint\[\]\)/);
  assert.ok(withIds.params.some((p) => Array.isArray(p) && (p as string[]).includes('12')));

  // Absent must emit NO condition — never a tautology, which would defeat index selection.
  const without = buildCmdExplorerQuery(null, {}, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.doesNotMatch(without.sql, /bigint\[\]/);
});

test('row_ids: an EMPTY list must not silently widen the grid to every row', () => {
  // [] means "the name search ran and matched nothing". The pure builder treats empty as absent
  // (same discipline as facility/payer), so the ACTION layer is what must preserve the distinction
  // — this test pins the builder's half of that contract so the two cannot drift silently.
  const empty = buildCmdExplorerQuery(null, { row_ids: [] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.doesNotMatch(empty.sql, /bigint\[\]/, 'empty array emits no id condition');
});

test('patient_member_bidx emits a direct rollup predicate, bound and cast to text[]', () => {
  // The FULL-BOOK name search (0105) resolves to member tokens, not row ids. member_id_bidx is on
  // the rollup and covered by 0092's indexes, so this needs neither a join nor a subquery.
  const q = buildCmdExplorerQuery(
    null, { patient_member_bidx: ['a'.repeat(64), 'b'.repeat(64)] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY,
  );
  assert.match(q.sql, /member_id_bidx = any\(\$\d+::text\[\]\)/);
  assert.doesNotMatch(q.sql, /select e\.id from collections\.cmd_explorer_rows/, 'no semi-join needed');
  assert.ok(q.params.some((p) => Array.isArray(p) && (p as string[]).length === 2));
  // The token must be a PARAMETER. Interpolating it would be an injection seam for a value that
  // arrives from the client.
  assert.doesNotMatch(q.sql, /a{64}/);
});

test('patient_member_bidx: an EMPTY list means "matched nobody" and must select NOTHING', () => {
  // ⚠ THE OPPOSITE HANDLING TO row_ids, DELIBERATELY. row_ids treats [] as absent and leaves the
  // empty-means-nothing rule to the action layer, which is why payerIntelSearch has to re-implement
  // that half in three places. This one enforces it HERE, so every consumer of the shared builder —
  // grid, summary, cohort, Payer Intel — inherits it and none of them can forget.
  const q = buildCmdExplorerQuery(null, { patient_member_bidx: [] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.match(q.sql, /\bfalse\b/, 'an impossible predicate, not a widened grid');
  assert.doesNotMatch(q.sql, /member_id_bidx = any/);
});

test('patient_member_bidx absent emits no condition at all', () => {
  const q = buildCmdExplorerQuery(null, {}, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.doesNotMatch(q.sql, /member_id_bidx = any/);
  assert.doesNotMatch(q.sql, /\bfalse\b/, 'no search is not the same as a search that found nobody');
});

test('employer coverage returns TWO booleans — "any tenant" gates the filter, "every tenant" gates the label', () => {
  const q = buildCmdEmployerCoverageQuery(['a1b2c3d4-0000-0000-0000-000000000001']);
  // `has` gates VISIBILITY of the segment/type-ahead.
  assert.match(q.sql, /as has_employer_data/);
  // `all` gates the "Individual" LABEL. Conflating them is the 2026-08-17 bug: in Consolidated,
  // BXR's employers made every blank INDIGO cell read "Individual" — false, because Indigo does not
  // enter an employer in CMD at all. Split, Consolidated shows '—' while the filter stays usable.
  assert.match(q.sql, /as all_have_employer_data/);
  assert.match(q.sql, /count\(distinct business_entity_id\)/);
  assert.match(q.sql, /cardinality\(\$1::uuid\[\]\)/, 'compares against the NUMBER of tenants in scope');
  // Both halves must stay tenant-scoped to the SAME bound param — a second literal would let the
  // two answers describe different tenant sets.
  assert.equal(q.params.length, 1, 'exactly one bound param, reused by both halves');
});

// --- row_ids must be RANGE-safe for ::bigint, not merely digit-shaped ------------------------

test('row_ids: accepts bigint MAX and rejects one past it (a 19-digit check is not a range check)', () => {
  const MAX = '9223372036854775807';        // 19 digits, the largest bigint
  const OVER = '9223372036854775808';       // 19 digits, ONE past — the bug this pins
  const WAY_OVER = '9999999999999999999';   // 19 digits, the original regex accepted this

  const ok = buildCmdExplorerQuery(null, { row_ids: [MAX] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
  assert.match(ok.sql, /id = any\(\$\d+::bigint\[\]\)/, 'the max itself is legal and must survive');
  assert.ok(ok.params.some((p) => Array.isArray(p) && (p as string[]).includes(MAX)));

  // Out-of-range ids are dropped rather than bound: casting them raises 22003 at EXECUTION —
  // a 500, not an empty result. Dropping is semantically free (no row can carry such an id).
  for (const bad of [OVER, WAY_OVER]) {
    const q = buildCmdExplorerQuery(null, { row_ids: [bad] }, CMD_EXPLORER_DEFAULT_SORT, 50, ENTITY);
    assert.ok(
      !q.params.some((p) => Array.isArray(p) && (p as string[]).includes(bad)),
      `${bad} must never reach a ::bigint cast`,
    );
  }
});

test('row_ids: an ALL-INVALID list matches NOTHING — it must not widen back to every row', () => {
  // The dangerous shape. Filtering every id away leaves an empty set, and "empty" elsewhere in this
  // builder means "no condition" — which would turn a name search into a full-table browse.
  const q = buildCmdExplorerQuery(
    null,
    { row_ids: ['9999999999999999999', 'abc', ''] },
    CMD_EXPLORER_DEFAULT_SORT,
    50,
    ENTITY,
  );
  assert.match(q.sql, /\bfalse\b/, 'must emit an impossible predicate, not omit the condition');
  assert.doesNotMatch(q.sql, /::bigint\[\]/, 'nothing may be cast to bigint');
});

test('row_ids: a MIXED list keeps the valid ids and still constrains', () => {
  const q = buildCmdExplorerQuery(
    null,
    { row_ids: ['12', '9999999999999999999', '34'] },
    CMD_EXPLORER_DEFAULT_SORT,
    50,
    ENTITY,
  );
  const bound = q.params.find((p) => Array.isArray(p) && (p as string[]).includes('12')) as string[];
  assert.deepEqual(bound, ['12', '34'], 'valid ids survive, the out-of-range one is dropped');
  assert.doesNotMatch(q.sql, /\bfalse\b/, 'still a real id predicate, not match-nothing');
});
