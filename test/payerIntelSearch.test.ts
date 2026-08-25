/**
 * Payer Intel query-builder contracts (src/collections/payerIntelSearch.ts) — the
 * cmdExplorerQuery.test.ts discipline: pure builders, assertAllBound on every query, regex
 * assertions on SQL text, and the row_ids TRI-STATE pinned on every new path:
 *   · absent            → NO row_ids condition at all (never a tautology);
 *   · PRESENT-BUT-EMPTY → a literal `false` predicate (the payer-intel builders harden the half
 *     the shared builder deliberately leaves to the action layer — a name-search that matched
 *     nothing must aggregate NOTHING, never widen to the whole book);
 *   · populated         → `id = any($n::bigint[])` via the shared conds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYER_INTEL_DECLINE_MIN_LINES,
  PAYER_INTEL_DECLINE_THRESHOLD_PTS,
  PAYER_INTEL_RECENT_MAX,
  PAYER_INTEL_STARRED_MAX,
  buildFacilityDeclinersQuery,
  buildPayerIntelCensusQuery,
  buildPayerIntelComboQuery,
  buildPayerIntelDistinctMembersQuery,
  buildPayerIntelFacilityNamesQuery,
  buildPayerIntelGainersQuery,
  buildPayerIntelPlacementQuery,
  buildPayerIntelRatingQuery,
  buildPayerIntelSavedSearchesQuery,
  payerIntelMinClientsFor,
} from '../src/collections/payerIntelSearch.js';
import type { CmdExplorerFilter } from '../src/collections/cmdExplorerQuery.js';

const ENTITY_IDS = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];

/** Every $n placeholder is contiguous and bound — the injection-safety invariant. */
function assertAllBound(sql: string, params: unknown[]): void {
  const seen = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) seen.add(Number(m[1]));
  const max = Math.max(0, ...seen);
  assert.equal(max, params.length, `max placeholder $${max} != ${params.length} params`);
  for (let i = 1; i <= max; i += 1) assert.ok(seen.has(i), `$${i} missing from SQL`);
}

// ── Gainers (the signed fork of the tape query) ──────────────────────────────────────────────────

test('gainers: strictly-gainers filter + SIGNED inner order (the fork the shipped tape must not get)', () => {
  const q = buildPayerIntelGainersQuery();
  assertAllBound(q.sql, q.params);
  assert.match(q.sql, /cur\.rating > prev\.rating/);
  assert.match(q.sql, /order by \(cur\.rating - prev\.rating\) desc/);
  assert.doesNotMatch(q.sql, /abs\(cur\.rating - prev\.rating\)/);
  // Non-dollar by projection — the admissions_seat-safe posture the tape established.
  assert.doesNotMatch(q.sql, /billed_amount|allowed_amount|paid_amount/);
  assert.deepEqual(q.params, [90, 3, 20]);
});

test('gainers: bounds clamp (a hostile limit cannot exceed 100)', () => {
  const q = buildPayerIntelGainersQuery({ limit: 5000, deltaDays: -3, minMembers: -1 });
  assert.deepEqual(q.params, [1, 0, 100]);
});

// ── Decliners ────────────────────────────────────────────────────────────────────────────────────

test('decliners: tenant-scoped, floors on BOTH windows, threshold + placeholder exclusion bound', () => {
  const q = buildFacilityDeclinersQuery(ENTITY_IDS);
  assertAllBound(q.sql, q.params);
  assert.match(q.sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(q.sql, /payment_received >= current_date - \$2::int/);
  assert.match(q.sql, /cur\.lines >= \$4::int and prior\.lines >= \$4::int/);
  assert.match(q.sql, /cur\.members >= \$5::int and prior\.members >= \$5::int/);
  assert.match(q.sql, /\(p\.pct_prior - p\.pct_current\) >= \$6/);
  assert.ok(q.params.includes('No Facility'), 'the No Facility placeholder is excluded as a bound value');
  assert.ok(q.params.includes(PAYER_INTEL_DECLINE_THRESHOLD_PTS));
  assert.ok(q.params.includes(PAYER_INTEL_DECLINE_MIN_LINES));
  // The client floor is WINDOW-SCALED, not a constant (Alec, 2026-08-17): the default 90d window
  // binds 3.
  assert.ok(q.params.includes(payerIntelMinClientsFor(90)));
  // Reads the CHARGE-GRAIN rollup, never the raw snapshot table.
  assert.match(q.sql, /from collections\.cmd_explorer_charge_rollup/);
  assert.doesNotMatch(q.sql, /from collections\.cmd_explorer_rows/);
});

test('decliners: empty tenant scope throws instead of reading every tenant', () => {
  assert.throws(() => buildFacilityDeclinersQuery([]), /entity/i);
});

test('decliners: nested aggregation replaced count(distinct) — the shape that stopped the spill', () => {
  const q = buildFacilityDeclinersQuery(ENTITY_IDS);
  assertAllBound(q.sql, q.params);
  // Each window aggregates twice: to (facility, member) first, then up to facility. count(distinct)
  // has no hash path, so it forced a GroupAggregate whose sort spilled to disk at the shipped
  // work_mem (builder header has the measured before/after).
  assert.match(q.sql, /cur_m as \(select facility, member_id_bidx,[\s\S]*?group by facility, member_id_bidx\)/);
  assert.match(q.sql, /prior_m as \(select facility, member_id_bidx,[\s\S]*?group by facility, member_id_bidx\)/);
  assert.doesNotMatch(q.sql, /count\(distinct/, 'count(distinct) is what forced the spilling sort');
});

test('decliners: a NULL member cannot inflate `members` past the floor — the guard both windows carry', () => {
  const q = buildFacilityDeclinersQuery(ENTITY_IDS);
  // ⚠ THE INVARIANT. `count(distinct x)` SKIPS nulls. A bare `count(*)` over the inner groups does
  // NOT: a null member_id_bidx forms its own (facility, null) group and would be counted as a
  // member — letting a facility clear the members floor one member early. Both windows guard it.
  const guarded = [...q.sql.matchAll(/\(count\(\*\) filter \(where member_id_bidx is not null\)\)::int as members/g)];
  assert.equal(guarded.length, 2, 'both cur and prior must guard the member count');
  // The floor being protected: `members` is compared to $5 on BOTH windows, and $5 binds the
  // window-scaled client minimum (3 at the default 90d window).
  assert.match(q.sql, /cur\.members >= \$5::int and prior\.members >= \$5::int/);
  assert.equal(q.params[4], payerIntelMinClientsFor(90));
});

test('decliners: the NULL guard is on the OUTER count only — an inner WHERE would drop dollars', () => {
  // Filtering null-member ROWS out of cur_m/prior_m would also strip their charge_amount,
  // insurance_payments and line count from the sums, silently changing billed/paid/lines. The
  // guard must never migrate into the inner CTE's WHERE clause.
  const q = buildFacilityDeclinersQuery(ENTITY_IDS);
  const inner = q.sql.slice(q.sql.indexOf('cur_m as ('), q.sql.indexOf('), cur as ('));
  assert.doesNotMatch(inner, /member_id_bidx is not null/, 'null-member rows stay in the sums');
  assert.match(inner, /sum\(charge_amount\) as ca/);
  assert.match(inner, /sum\(insurance_payments\) as ip/);
  assert.match(inner, /count\(\*\) as ln/);
});

// ── row_ids tri-state on every new aggregate path ────────────────────────────────────────────────

const NEW_AGGREGATE_BUILDERS: {
  name: string;
  build: (f: CmdExplorerFilter) => { sql: string; params: unknown[] };
}[] = [
  { name: 'placement', build: (f) => buildPayerIntelPlacementQuery(f, ENTITY_IDS) },
  { name: 'combo', build: (f) => buildPayerIntelComboQuery(f, ENTITY_IDS) },
  { name: 'distinct-members', build: (f) => buildPayerIntelDistinctMembersQuery(f, ENTITY_IDS) },
];

for (const { name, build } of NEW_AGGREGATE_BUILDERS) {
  test(`row_ids tri-state (${name}): absent emits NO condition`, () => {
    const q = build({ primary_payers: ['AETNA'] });
    assertAllBound(q.sql, q.params);
    // ::bigint[] anchors the ROW-ID predicate — `business_entity_id = any($1::uuid[])` (the tenant
    // scope) must never trip this negative.
    assert.doesNotMatch(q.sql, /= any\(\$\d+::bigint\[\]\)/);
    assert.doesNotMatch(q.sql, / false/);
  });

  test(`row_ids tri-state (${name}): PRESENT-BUT-EMPTY emits a literal false predicate`, () => {
    const q = build({ primary_payers: ['AETNA'], row_ids: [] });
    assertAllBound(q.sql, q.params);
    assert.match(q.sql, /(?:where|and) false(?: |$)/, 'a matched-nothing search must aggregate nothing');
  });

  test(`row_ids tri-state (${name}): populated binds id = any`, () => {
    const q = build({ primary_payers: ['AETNA'], row_ids: ['15', '16'] });
    assertAllBound(q.sql, q.params);
    assert.match(q.sql, /id = any\(\$\d+::bigint\[\]\)/);
    assert.doesNotMatch(q.sql, /(?:where|and) false(?: |$)/);
  });
}

test('placement: excludes the No Facility placeholder and reads the rollup at charge grain', () => {
  const q = buildPayerIntelPlacementQuery({ primary_payers: ['AETNA'] }, ENTITY_IDS);
  assert.ok(q.params.includes('No Facility'));
  assert.match(q.sql, /from collections\.cmd_explorer_charge_rollup/);
  assert.match(q.sql, /count\(distinct member_id_bidx\)/);
  // Dollar-weighted ratio of sums, never avg-of-ratios (fixture rule inherited from the summary).
  assert.doesNotMatch(q.sql, /avg\(/);
});

test('combo: carries the shared guarded ratios PLUS the zero-paid share', () => {
  const q = buildPayerIntelComboQuery({ primary_payers: ['AETNA'] }, ENTITY_IDS);
  assert.match(q.sql, /pct_allowed/);
  assert.match(q.sql, /pct_paid/);
  assert.match(q.sql, /pct_zero_paid/);
  // The ruled pct_paid denominator floor rides along untouched.
  assert.match(q.sql, /greatest\(sum\(charge_amount\) \* 0\.02, 100\)/);
  assert.doesNotMatch(q.sql, /avg\(/);
});

// ── Hero rating ──────────────────────────────────────────────────────────────────────────────────

test('rating: pair shape binds token + payer + delta and projects no dollars', () => {
  const q = buildPayerIntelRatingQuery('a'.repeat(64), 'AETNA');
  assertAllBound(q.sql, q.params);
  assert.match(q.sql, /member_id_prefix_bidx = \$1/);
  assert.match(q.sql, /prev\.rating::int as rating_then/);
  assert.doesNotMatch(q.sql, /billed_amount|allowed_amount|paid_amount/);
});

test('rating: payer-wide shape is the LINE-WEIGHTED mean (never a flat average)', () => {
  const q = buildPayerIntelRatingQuery(null, 'AETNA');
  assertAllBound(q.sql, q.params);
  assert.match(q.sql, /sum\(cur\.rating \* cur\.line_count\)/);
  assert.match(q.sql, /nullif\(sum\(cur\.line_count\), 0\)/);
  assert.doesNotMatch(q.sql, /avg\(/);
});

// ── Saved searches (0104) ────────────────────────────────────────────────────────────────────────

test('saved searches: projects the 0104 columns, user-scoped, bounded limit as a param', () => {
  const q = buildPayerIntelSavedSearchesQuery('00000000-0000-0000-0000-00000000000a');
  assertAllBound(q.sql, q.params);
  assert.match(q.sql, /starred/);
  assert.match(q.sql, /entity_type/);
  assert.match(q.sql, /resolved/);
  assert.match(q.sql, /app_user_id = \$1::uuid/);
  assert.ok(q.params.includes(PAYER_INTEL_STARRED_MAX + PAYER_INTEL_RECENT_MAX));
});

test('saved-search caps match the 0104 definer literals (the QUALIFY_WATCHER_MAX drift guard)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, '..', 'supabase', 'migrations', '0104_recent_search_starred.sql'), 'utf8');
  assert.match(sql, new RegExp(`\\) >= ${PAYER_INTEL_STARRED_MAX} then`), 'star cap literal drifted from the constant');
  assert.match(sql, new RegExp(`limit ${PAYER_INTEL_RECENT_MAX}`), 'recent prune literal drifted from the constant');
  // The two 0104 behaviour changes, pinned as SQL facts: the prune targets unstarred rows only,
  // and clear keeps starred rows.
  assert.match(sql, /and not starred\s+and id not in/);
  assert.match(sql, /delete from claims\.qualify_recent_search where app_user_id = p_user and not starred/);
});

// ── Census + names ───────────────────────────────────────────────────────────────────────────────

test('census strip read: projects occupancy inputs + synced_at, never auth/LOS', () => {
  const q = buildPayerIntelCensusQuery();
  assert.match(q.sql, /admitted_count/);
  assert.match(q.sql, /synced_at/);
  assert.doesNotMatch(q.sql, /avg_los_days|avg_auth_days/);
  assert.equal(q.params.length, 0);
});

test('facility names: fixed literals only', () => {
  const q = buildPayerIntelFacilityNamesQuery();
  assert.match(q.sql, /from collections\.facilities/);
  assert.equal(q.params.length, 0);
});

test('client floor scales with the window: 1 at 7d, 2 at 14d, 3 at 30d and beyond', () => {
  // Alec, 2026-08-17: "only 1 client in the time window if it's 7d, 2 if it's 14, then 3 if it's
  // 30d or beyond." A flat floor asks a week to produce as many distinct clients as a quarter,
  // which silences the short windows entirely at this book's scale.
  assert.equal(payerIntelMinClientsFor(7), 1);
  assert.equal(payerIntelMinClientsFor(14), 2);
  assert.equal(payerIntelMinClientsFor(30), 3);
  assert.equal(payerIntelMinClientsFor(90), 3);
  assert.equal(payerIntelMinClientsFor(365), 3);
  // Degenerate inputs floor at the most permissive value rather than throwing — the caller has
  // already clamped the window, and a NaN must not silently become an unreachable bar.
  assert.equal(payerIntelMinClientsFor(0), 1);
  assert.equal(payerIntelMinClientsFor(Number.NaN), 1);
});

test('BOTH rails take the scaled floor — the two halves of the board agree on "enough to score"', () => {
  for (const [days, expected] of [
    [7, 1],
    [14, 2],
    [30, 3],
    [90, 3],
  ] as const) {
    assert.equal(
      buildPayerIntelGainersQuery({ deltaDays: days }).params[1],
      expected,
      `gainers rail at ${days}d must bind ${expected}`,
    );
    assert.ok(
      buildFacilityDeclinersQuery(['af504ab6-3dcd-4aa4-a93c-27bc58de4088'], { windowDays: days }).params.includes(
        expected,
      ),
      `decliners rail at ${days}d must bind ${expected}`,
    );
  }
});
