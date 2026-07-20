import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import {
  buildResolvePayerQuery,
  buildFacilityRankingQuery,
  buildFacilityCasesQuery,
  buildMoversQuery,
  QUALIFY_CASES_LIMIT,
  QUALIFY_MOVERS_MIN_PATIENTS,
  QUALIFY_MOVERS_MIN_CHARGES,
} from '../src/collections/qualifyQuery.js';

const BOTH = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
const TOKEN = 'a'.repeat(64); // opaque HMAC-shaped token

// ── The headline invariant: every builder targets BOTH tenants in ONE query. ─────────────────────
test('cross-tenant: every builder scopes business_entity_id = any($1::uuid[]) with BOTH tenant ids', () => {
  const built = [
    buildResolvePayerQuery(TOKEN, 'member_id', BOTH),
    buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
    buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH),
    buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH),
  ];
  for (const { sql, params } of built) {
    assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant predicate present');
    assert.deepEqual(params[0], BOTH, 'first param is the pinned [BXR, Indigo] array');
    assert.equal((params[0] as string[]).length, 2, 'exactly two tenants');
  }
});

// ── Grain safety: aggregates read the 0050 rollup, NEVER raw cmd_explorer_rows. ──────────────────
test('grain: aggregate builders read the charge rollup, never raw cmd_explorer_rows', () => {
  for (const { sql } of [
    buildResolvePayerQuery(TOKEN, 'prefix', BOTH),
    buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
    buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH),
    buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH),
  ]) {
    assert.ok(sql.includes('collections.cmd_explorer_charge_rollup'), 'reads the rollup');
    assert.ok(!sql.includes('cmd_explorer_rows'), 'never reads raw posting-grain rows');
  }
});

// ── Fail-closed shape validation on every builder. ───────────────────────────────────────────────
test('every builder routes through assertEntityScope (throws on empty scope)', () => {
  assert.throws(() => buildResolvePayerQuery(TOKEN, 'member_id', []), /entityIds required/);
  assert.throws(() => buildFacilityRankingQuery('X', '2026-01-01', '2026-02-01', []), /entityIds required/);
  assert.throws(
    () => buildFacilityCasesQuery('X', 'F', '2026-01-01', '2026-02-01', []),
    /entityIds required/,
  );
  assert.throws(
    () => buildMoversQuery('2026-01-01', '2026-02-01', '2025-12-01', '2026-01-01', []),
    /entityIds required/,
  );
});

// ── buildResolvePayerQuery: server-side sniff column + unwindowed identity. ───────────────────────
test('buildResolvePayerQuery: member_id vs prefix selects the right blind-index column', () => {
  const exact = buildResolvePayerQuery(TOKEN, 'member_id', BOTH);
  assert.match(exact.sql, /member_id_bidx = \$2/);
  assert.ok(!exact.sql.includes('member_id_prefix_bidx'), 'exact match does not touch the prefix column');

  const pfx = buildResolvePayerQuery(TOKEN, 'prefix', BOTH);
  assert.match(pfx.sql, /member_id_prefix_bidx = \$2/);

  // Identity resolution is UNWINDOWED (no payment_received range) → resolved=null means truly unknown.
  assert.ok(!exact.sql.includes('payment_received >='), 'resolution is unwindowed');
  assert.match(exact.sql, /group by primary_payer[\s\S]*limit 1/);
  assert.deepEqual(exact.params, [BOTH, TOKEN]);
});

// ── buildFacilityRankingQuery: dollar-weighted ratio + crosswalk + rating-order note. ────────────
test('buildFacilityRankingQuery: reuses PCT_RATIO_SELECT, resolves facility_code, windows payment_received', () => {
  const { sql, params } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.match(sql, /as pct_allowed/, 'dollar-weighted allowed/billed via shared PCT_RATIO_SELECT');
  assert.match(sql, /primary_payer = \$2/);
  assert.match(sql, /payment_received >= \$3::date and payment_received < \$4::date/, 'half-open window');
  assert.ok(sql.includes('collections.facilities'), 'facility_name/care_setting crosswalk');
  assert.ok(sql.includes('cmd_facility_aliases'), 'alias crosswalk');
  assert.match(sql, /as facility_code/, 'returns facility_code for the city/state lookup');
  assert.match(sql, /count\(\*\)::int as line_count/, 'line_count = rating dampening weight (non-dollar)');
  assert.deepEqual(params, [BOTH, 'AETNA', '2026-06-17', '2026-07-17']);
});

// ── buildFacilityCasesQuery: CLAIM GRAIN (one row per charge), raw-facility predicate, over-fetch. ─────
test('buildFacilityCasesQuery: claim grain (NO member_id_bidx dedup), raw-facility predicate, per-claim dos, over-fetch', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  assert.match(sql, /primary_payer = \$2 and facility = \$3/, 'raw facility text is a bound predicate');
  assert.equal(params[2], '405 recovery', 'facility bound as $3 (raw text, never interpolated)');
  // CLAIM GRAIN: no distinct-patient dedup, no latest-charge array_agg — one row per charge.
  assert.ok(!/group by member_id_bidx/.test(sql), 'NO member_id_bidx dedup — claim grain');
  assert.ok(!/array_agg/.test(sql), 'no per-patient latest-charge collapse — each claim is its own row');
  assert.match(sql, /to_char\(charge_date, 'YYYY-MM-DD'\) as dos/, 'per-claim DOS = the charge_date (not a max)');
  assert.ok(!/agg\.member_id_bidx/.test(sql), 'the blind index is NOT projected to the caller');
  assert.match(sql, /care_setting\) as program/, 'program := resolved care_setting');
  assert.match(sql, /order by agg\.dos desc nulls last/, 'ordered by the per-claim DOS');
  // Pagination OVER-FETCH: with no explicit limit the query binds QUALIFY_CASES_LIMIT + 1 (fetch 16, keep 15).
  assert.equal(params[5], QUALIFY_CASES_LIMIT + 1, 'over-fetches by one (limit+1) so the caller computes hasMore');
  assert.deepEqual(params.slice(0, 5), [BOTH, 'AETNA', '405 recovery', '2026-06-17', '2026-07-17']);
  // No filter / no cursor by default: no identifier predicate, no outer keyset WHERE.
  assert.ok(!sql.includes('member_id_prefix_bidx') && !sql.includes('member_id_bidx'), 'no identifier predicate when none supplied');
  assert.ok(!/agg\.dos </.test(sql) && !/agg\.dos is null and agg\.id </.test(sql), 'no keyset WHERE on page 0');
});

// ── buildFacilityCasesQuery: PREFIX narrow → member_id_prefix_bidx (the STARTS-WITH bleed guard). ─────
test('buildFacilityCasesQuery: a prefix token adds member_id_prefix_bidx to the INNER WHERE', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    prefixToken: TOKEN,
  });
  assert.match(sql, /payment_received < \$5::date and member_id_prefix_bidx = \$6\)? agg/, 'prefix predicate is the last inner condition');
  assert.ok(!sql.includes('member_id_bidx = '), 'prefix mode does NOT touch the exact-member column');
  assert.equal(params[5], TOKEN, 'prefix token bound (opaque; never the raw prefix)');
  assert.equal(params[6], QUALIFY_CASES_LIMIT + 1, 'limit+1 follows the prefix param');
});

// ── buildFacilityCasesQuery: EXACT MEMBER narrow → member_id_bidx (claims for that member only). ──────
test('buildFacilityCasesQuery: a member token adds member_id_bidx to the INNER WHERE (exact, wins over prefix)', () => {
  const exact = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    memberToken: TOKEN,
  });
  assert.match(exact.sql, /payment_received < \$5::date and member_id_bidx = \$6\)? agg/, 'exact member predicate in the inner WHERE');
  assert.ok(!exact.sql.includes('member_id_prefix_bidx'), 'exact mode does NOT touch the prefix column');
  assert.equal(exact.params[5], TOKEN, 'member token bound (opaque; never the raw member id)');
  // Precedence: when BOTH tokens are somehow supplied, EXACT member wins (mutually exclusive in practice).
  const both = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    memberToken: TOKEN,
    prefixToken: 'b'.repeat(64),
  });
  assert.match(both.sql, /member_id_bidx = \$6/, 'member token wins');
  assert.ok(!both.sql.includes('member_id_prefix_bidx'), 'the prefix token is not applied when the member token is present');
});

// ── buildFacilityCasesQuery: keyset lives in the OUTER WHERE (agg.dos/id). ─────────────────────────────
test('buildFacilityCasesQuery: a non-null cursor adds the NULLS-LAST keyset to the OUTER WHERE, before ORDER BY', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    cursor: { lastDos: '2026-07-01', id: 500 },
  });
  assert.match(
    sql,
    /where \(agg\.dos < \$6 or \(agg\.dos = \$6 and agg\.id < \$7\) or agg\.dos is null\) group by/,
    'DESC keyset: past the cursor, id tiebreak, plus the whole NULL tail — then GROUP BY',
  );
  assert.equal(params[5], '2026-07-01', 'cursor lastDos bound as $6');
  assert.equal(params[6], 500, 'cursor id bound as $7');
  assert.equal(params[7], QUALIFY_CASES_LIMIT + 1, 'limit+1 last');
  assert.match(sql, /order by agg\.dos desc nulls last, agg\.id desc/, 'ORDER BY on the per-claim DOS');
});

test('buildFacilityCasesQuery: a null-lastDos cursor uses the IS NULL AND id branch (null-tail walk)', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    cursor: { lastDos: null, id: 500 },
  });
  assert.match(sql, /where \(agg\.dos is null and agg\.id < \$6\) group by/, 'null-tail branch ties by id only');
  assert.equal(params[5], 500, 'cursor id bound as $6');
});

test('buildFacilityCasesQuery: prefix + cursor COEXIST (inner identifier WHERE + outer keyset WHERE)', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    prefixToken: TOKEN,
    cursor: { lastDos: '2026-07-01', id: 500 },
  });
  assert.match(sql, /and member_id_prefix_bidx = \$6\)? agg/, 'prefix in the inner WHERE');
  assert.match(sql, /where \(agg\.dos < \$7 or \(agg\.dos = \$7 and agg\.id < \$8\) or agg\.dos is null\) group by/, 'keyset in the outer WHERE');
  assert.equal(params[5], TOKEN);
  assert.equal(params[6], '2026-07-01');
  assert.equal(params[7], 500);
  assert.equal(params[8], QUALIFY_CASES_LIMIT + 1);
});

// ── buildMoversQuery: distinct-patient delta + both suppression floors + clamp. ──────────────────
test('buildMoversQuery: distinct-patient delta across adjacent windows, floors clamped, signed-desc', () => {
  const { sql, params } = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH);
  assert.match(sql, /count\(distinct member_id_bidx\) filter \(where payment_received >= \$2::date and payment_received < \$3::date\)/, 'this-window distinct patients');
  assert.match(sql, /count\(distinct member_id_bidx\) filter \(where payment_received >= \$4::date and payment_received < \$5::date\)/, 'prior-window distinct patients');
  assert.match(sql, /\(this_patients - prior_patients\) as delta_patients/, 'signed delta');
  assert.match(sql, /where this_patients >= \$6 and this_charges >= \$7/, 'patient suppression + charge floor');
  assert.match(sql, /order by delta_patients desc, this_patients desc, primary_payer/, 'gainers first, deterministic');
  assert.match(sql, /primary_payer/, 'labeled by plaintext payer (non-PHI)');
  assert.equal(params[5], QUALIFY_MOVERS_MIN_PATIENTS);
  assert.equal(params[6], QUALIFY_MOVERS_MIN_CHARGES);
});

test('buildMoversQuery: suppression floor is clamped — a caller can only make it STRICTER', () => {
  const weak = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH, {
    minPatients: 1,
    minCharges: 1,
  });
  assert.equal(weak.params[5], QUALIFY_MOVERS_MIN_PATIENTS, 'minPatients cannot go below 5');
  assert.equal(weak.params[6], QUALIFY_MOVERS_MIN_CHARGES, 'minCharges cannot go below 10');

  const strict = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH, {
    minPatients: 20,
  });
  assert.equal(strict.params[5], 20, 'a stricter floor is honored');
});
