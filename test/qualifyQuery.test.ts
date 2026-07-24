import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import {
  buildResolvePayerQuery,
  buildFacilityRankingQuery,
  buildIdentifierLandingFacilityQuery,
  buildFacilityCasesQuery,
  buildMoversQuery,
  buildBookKpisQuery,
  buildFacilityTrendQuery,
  QUALIFY_CASES_MAX,
  QUALIFY_MOVERS_MIN_PATIENTS,
  QUALIFY_MOVERS_MIN_CHARGES,
  QUALIFY_TREND_BUCKETS,
} from '../src/collections/qualifyQuery.js';

const BOTH = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
const TOKEN = 'a'.repeat(64); // opaque HMAC-shaped token

// ── The headline invariant: every builder targets BOTH tenants in ONE query. ─────────────────────
test('cross-tenant: every builder scopes business_entity_id = any($1::uuid[]) with BOTH tenant ids', () => {
  const built = [
    buildResolvePayerQuery(TOKEN, 'member_id', BOTH),
    buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
    buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH),
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
    buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH),
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
  assert.throws(() => buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'X', '2026-01-01', '2026-02-01', []), /entityIds required/);
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

// ── buildFacilityRankingQuery: reliable-evidence ratio (0059 repoint) + crosswalk + rating-order note. ──
test('buildFacilityRankingQuery: rates on allowed_reliable with tier e2 excluded, resolves facility_code, windows payment_received', () => {
  const { sql, params } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  // THE RATING FIX (ruling Q2a): evidence = materialized allowed_reliable, e2 excluded BY TIER.
  assert.match(
    sql,
    /sum\(allowed_reliable\) filter \(where allowed_tier <> 'e2'\)/,
    'reliable-evidence sum with the e2 tier filter',
  );
  assert.ok(!/sum\(allowed_amount\)/.test(sql), 'the netted posting sum no longer feeds the rating');
  assert.ok(
    !/allowed_reliable is not null/.test(sql),
    'exclusion is BY TIER, never a non-null check — e2 IS non-null and would clamp to a false green',
  );
  assert.match(sql, /as pct_allowed/, 'dollar-weighted reliable-allowed / billed');
  assert.ok(!sql.includes('pct_paid'), 'no pct_paid here — PCT_RATIO_SELECT + its floor stay with combo/cohort (re-rule deferred)');
  assert.match(sql, /primary_payer = \$2/);
  assert.match(sql, /payment_received >= \$3::date and payment_received < \$4::date/, 'half-open window');
  assert.ok(sql.includes('collections.facilities'), 'facility_name/care_setting crosswalk');
  assert.ok(sql.includes('cmd_facility_aliases'), 'alias crosswalk');
  assert.match(sql, /as facility_code/, 'returns facility_code for the city/state lookup');
  assert.match(sql, /count\(\*\)::int as line_count/, 'line_count = ALL in-window lines (volume context, not tier-filtered)');
  assert.match(sql, /sum\(charge_amount\)::float8 as billed/, 'billed = ALL in-window lines (e2 stays in the denominator — unknown-like)');
  // Phase 0 (0059 trust signal): the coverage triple + level-of-care ride the SAME query — counts
  // only, no ratio/rating math change (bucket parity with confidence.ts: qualifyConfidence.test.ts).
  assert.match(sql, /as confirmed_claims/, 'coverage: confirmed count projected');
  assert.match(sql, /as estimate_claims/, 'coverage: estimate count projected');
  assert.match(sql, /as unknown_claims/, 'coverage: unknown count projected');
  assert.match(sql, /max\(f\.care_setting\) as care_setting/, 'level-of-care from the existing dimension join');
  assert.deepEqual(params, [BOTH, 'AETNA', '2026-06-17', '2026-07-17']);
});

// ── buildIdentifierLandingFacilityQuery (Fix A): kind→column, payer+window scope, recency limit 1. ───
test('buildIdentifierLandingFacilityQuery: prefix→prefix column, member→exact column, payer+window scoped, limit 1', () => {
  const pfx = buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.match(pfx.sql, /member_id_prefix_bidx = \$5/, 'prefix kind → prefix blind index');
  assert.ok(!pfx.sql.includes('member_id_bidx = '), 'prefix mode does NOT touch the exact-member column');
  assert.match(pfx.sql, /primary_payer = \$2/, 'scoped to the resolved payer (so the single-payer drill is non-empty)');
  assert.match(pfx.sql, /payment_received >= \$3::date and payment_received < \$4::date/, 'in-window (half-open)');
  assert.match(pfx.sql, /limit 1$/, 'returns 0 or 1 facility');
  assert.deepEqual(pfx.params, [BOTH, 'AETNA', '2026-06-17', '2026-07-17', TOKEN]);

  const exact = buildIdentifierLandingFacilityQuery(TOKEN, 'member_id', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.match(exact.sql, /member_id_bidx = \$5/, 'member_id kind → exact blind index');
  assert.ok(!exact.sql.includes('member_id_prefix_bidx'), 'exact mode does NOT touch the prefix column');
});

// ── ORDER-BY PARITY (the land-on-the-wrong-facility guard): the landing lookup's "most recent" ordering
//    MUST match the drill's claim ordering — NOW on the PAYMENT-date axis (payment_received desc nulls last,
//    id desc). payment_received is a DATE (0019), so the drill's to_char('YYYY-MM-DD') alias is lexical ==
//    chronological == the landing's raw-column order → the two select the SAME "most recent" claim. LOCKSTEP. ──
test('buildIdentifierLandingFacilityQuery: ORDER BY matches the drill (payment_received desc nulls last, id desc — the payment-date axis)', () => {
  const landing = buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  const drill = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  // Landing orders on the raw payment_received column; the drill orders its projected alias agg.payment_date
  // (= to_char(payment_received,'YYYY-MM-DD')). Same axis, byte-identical row order (date column, day-grain).
  assert.match(landing.sql, /order by payment_received desc nulls last, id desc/, 'landing: payment_received desc nulls last, id desc');
  assert.match(drill.sql, /order by agg\.payment_date desc nulls last, agg\.id desc/, 'drill: agg.payment_date desc nulls last, agg.id desc');
  assert.match(drill.sql, /to_char\(payment_received, 'YYYY-MM-DD'\) as payment_date/, 'agg.payment_date IS payment_received — the SAME axis as landing');
  // The claim ordering must key on payment_received on BOTH sides now, and NOT on charge_date/dos.
  assert.ok(!/order by charge_date/.test(landing.sql), 'landing no longer orders by charge_date');
  assert.ok(!/order by agg\.dos/.test(drill.sql), 'drill no longer orders by agg.dos (service date)');
  // dos (service date) is STILL projected for display — it just isn't the sort key anymore.
  assert.match(drill.sql, /to_char\(charge_date, 'YYYY-MM-DD'\) as dos/, 'dos (charge_date) still projected as a displayed column');
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
  assert.match(sql, /to_char\(payment_received, 'YYYY-MM-DD'\) as payment_date/, 'per-claim payment_date = payment_received (the sort axis + a displayed column)');
  // Phase 2: member_id_bidx IS projected — to the SERVER CORE only (patientKey aliasing; wire-tested
  // in qualifyCore.test.ts that it never reaches the client). It must never be a bare predicate here
  // beyond the explicit identifier narrows tested below.
  assert.match(sql, /agg\.member_id_bidx/, 'bidx projected for the server-side patient aliasing');
  assert.match(sql, /care_setting\) as program/, 'program := resolved care_setting');
  assert.match(sql, /order by agg\.payment_date desc nulls last/, 'ordered by the per-claim PAYMENT date');
  // 0059 repoint ②: per-claim allowed/pct come from the materialized tiered columns.
  assert.match(sql, /allowed_reliable::float8 as allowed/, 'per-claim allowed = 0059 allowed_reliable, not the netted sum');
  assert.ok(!/allowed_amount/.test(sql), 'the netted allowed_amount no longer appears in the drill');
  assert.match(sql, /pct_allowed::float8 as pct_allowed/, 'pct read from the materialized 0059 column (identical formula, NULL-safe)');
  assert.ok(!/round\(/.test(sql), 'no inline pct derivation left in the drill');
  // Phase 0 PROJECTS allowed_tier (the core collapses it via confidenceOf) — but it must never be
  // a PREDICATE here: the drill is a display surface, e2 claims stay visible (ruling Q2a).
  assert.ok(
    !/allowed_tier\s*(=|<>|in\s*\()/.test(sql),
    'NO tier FILTER on the drill — e2 claims stay visible (projection only, ruling Q2a)',
  );
  assert.match(sql, /agg\.allowed_tier/, 'the raw tier IS projected for the server-side confidence collapse');
  // OVER-FETCH: with no explicit limit the query binds QUALIFY_CASES_MAX + 1 (the safety-cap backstop, so
  // the caller detects truncation from the extra row — NOT a 15/page pager).
  assert.equal(params[5], QUALIFY_CASES_MAX + 1, 'over-fetches by one (cap+1) so the caller detects `capped`');
  assert.deepEqual(params.slice(0, 5), [BOTH, 'AETNA', '405 recovery', '2026-06-17', '2026-07-17']);
  // No filter by default: no identifier predicate. And NO keyset WHERE ever exists now (the pager is gone).
  assert.ok(!/member_id_prefix_bidx = /.test(sql) && !/member_id_bidx = /.test(sql), 'no identifier PREDICATE when none supplied (projection is fine)');
  assert.ok(!/agg\.payment_date </.test(sql) && !/agg\.payment_date is null and agg\.id </.test(sql), 'no keyset WHERE — the whole window returns in one shot');
});

// ── buildFacilityCasesQuery: PREFIX narrow → member_id_prefix_bidx (the STARTS-WITH bleed guard). ─────
test('buildFacilityCasesQuery: a prefix token adds member_id_prefix_bidx to the INNER WHERE', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    prefixToken: TOKEN,
  });
  assert.match(sql, /payment_received < \$5::date and member_id_prefix_bidx = \$6\)? agg/, 'prefix predicate is the last inner condition');
  assert.ok(!sql.includes('member_id_bidx = '), 'prefix mode does NOT touch the exact-member column');
  assert.equal(params[5], TOKEN, 'prefix token bound (opaque; never the raw prefix)');
  assert.equal(params[6], QUALIFY_CASES_MAX + 1, 'cap+1 follows the prefix param');
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

// ── buildFacilityCasesQuery: NO keyset pager — the whole window returns in one shot (cap+1 over-fetch). ────
test('buildFacilityCasesQuery: no cursor param exists — no keyset WHERE, single capped fetch', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(!/agg\.payment_date </.test(sql), 'no keyset comparison anywhere');
  assert.ok(!/where \(agg\./.test(sql), 'no OUTER keyset WHERE on the agg subquery');
  assert.match(sql, /order by agg\.payment_date desc nulls last, agg\.id desc/, 'ORDER BY the payment-date axis, cap keeps the most recent');
  assert.equal(params[params.length - 1], QUALIFY_CASES_MAX + 1, 'the last bind is the cap+1 over-fetch');
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

// ── Phase 2: the EXACT group-number narrow (the employer proxy) — composable, opaque-token-only ──────
test('buildFacilityCasesQuery: a group token adds an EXACT group_number_bidx predicate, composable with the member narrow', () => {
  const only = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    groupToken: TOKEN,
  });
  assert.match(only.sql, /and group_number_bidx = \$6/, 'group narrow is an exact bidx equality');
  assert.equal(only.params[5], TOKEN, 'opaque token bound (never the raw group #)');

  const both = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    prefixToken: 'b'.repeat(64),
    groupToken: TOKEN,
  });
  assert.match(both.sql, /member_id_prefix_bidx = \$6 and group_number_bidx = \$7/, 'ANDs with the member narrow — composable, not competing');

  const none = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(!/group_number_bidx = /.test(none.sql), 'no group predicate when no token');
});

// ── VOB employer/funding MARKET filter mirrored into the qualify builders (shared semi-join) ──────────
test('buildFacilityRankingQuery: a market funding filter adds the shared member_id_bidx semi-join, values bound', () => {
  const { sql, params } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH, {
    funding: ['Self-Funded'],
  });
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$5::text\[\]\)\) group by facility/,
  );
  assert.deepEqual(params[4], ['Self-Funded']);
  assert.doesNotMatch(sql, /join vob\.member_benefits_latest/i, 'semi-join, never a JOIN into the FROM');
});

test('buildFacilityCasesQuery: a market employer filter narrows the inner WHERE via the semi-join', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    market: { employers: ['BOEING'] },
  });
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where employer_norm = any\(\$6::text\[\]\)\)/,
  );
  assert.deepEqual(params[5], ['BOEING']);
});

test('buildMoversQuery: a market funding filter scopes the two-window population before the payer rollup', () => {
  const { sql, params } = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH, {
    market: { funding: ['Fully Insured'] },
  });
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$9::text\[\]\)\) group by primary_payer/,
  );
  assert.deepEqual(params[8], ['Fully Insured']);
});

test('qualify builders: NO market filter emits NO VOB clause (unchanged behavior)', () => {
  const rank = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  const cases = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  const movers = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH);
  for (const q of [rank, cases, movers]) {
    assert.doesNotMatch(q.sql, /vob\.member_benefits_latest/, 'no VOB clause without a market filter');
  }
});

// ── Redesign overview aggregates: buildBookKpisQuery + buildFacilityTrendQuery ────────────────────
test('overview aggregates: cross-tenant + read the rollup + route through assertEntityScope', () => {
  const kpis = buildBookKpisQuery('2026-06-17', '2026-07-17', BOTH);
  const trend = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  for (const { sql, params } of [kpis, trend]) {
    assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant predicate present');
    assert.deepEqual(params[0], BOTH, 'first param is the pinned [BXR, Indigo] array');
    assert.ok(sql.includes('collections.cmd_explorer_charge_rollup'), 'reads the rollup');
    assert.ok(!sql.includes('cmd_explorer_rows'), 'never reads raw posting-grain rows');
  }
  assert.throws(() => buildBookKpisQuery('2026-01-01', '2026-02-01', []), /entityIds required/);
  assert.throws(() => buildFacilityTrendQuery('2026-01-01', '2026-02-01', '2025-12-01', []), /entityIds required/);
});

test('book KPIs: three guarded ratio columns, e2 excluded from the reliable-allowed evidence, NO raw dollars projected', () => {
  const { sql } = buildBookKpisQuery('2026-06-17', '2026-07-17', BOTH);
  assert.ok(sql.includes('as pct_allowed_of_billed'), 'allowed/billed ratio');
  assert.ok(sql.includes('as pct_paid_of_allowed'), 'paid/allowed ratio (collection yield)');
  assert.ok(sql.includes('as pct_paid_of_billed'), 'paid/billed ratio (net realization)');
  assert.ok(sql.includes("allowed_tier <> 'e2'"), 'reliable-allowed excludes tier e2 (ruling Q2a — parity with the rating)');
  assert.ok(sql.includes('case when'), 'every ratio is denominator-guarded (null, never a coerced 0%)');
  // Only the three pct columns are PROJECTED (dollars are summed as denominators, never returned).
  const selectList = sql.slice(sql.indexOf('select ') + 7, sql.indexOf(' from '));
  assert.equal((selectList.match(/ as /g) ?? []).length, 3, 'exactly three output columns');
  assert.ok(!/as .*(billed_amount|charge_total|insurance_payments) /.test(sql), 'no raw dollar column leaves SQL');
});

test('facility trend: rating-delta order, dominant-payer via mode(), e2-excluded ratings, bucket math, book-wide by default', () => {
  const { sql } = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  assert.match(sql, /order by \(agg\.cur_rating - agg\.prior_rating\) desc nulls last/, 'sorts by the rating delta, new (null-prior) last');
  assert.ok(sql.includes('mode() within group (order by primary_payer)'), 'dominant payer = the most-charges payer (mode)');
  assert.ok(sql.includes("allowed_tier <> 'e2'"), 'ratings exclude tier e2 (parity with the value-first rating)');
  assert.ok(sql.includes('least(') && sql.includes('greatest(0'), 'bucket index is clamped to [0, N-1]');
  assert.ok(sql.includes('array_remove(array_agg'), 'sparkline points drop thin buckets (never fabricated)');
  assert.ok(!sql.includes('primary_payer = $'), 'book-wide by default — no single-payer filter');
});

test('facility trend: a payer-scoped variant adds the single-payer filter (per-facility panel sparklines)', () => {
  const { sql, params } = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH, { payer: 'AETNA' });
  assert.ok(sql.includes('and primary_payer = $'), 'payer-scoped adds the filter');
  assert.ok(params.includes('AETNA'), 'the payer value is a bound param');
});

test('facility trend: bucket count is bounded and defaults to QUALIFY_TREND_BUCKETS', () => {
  const def = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  assert.ok(def.params.includes(QUALIFY_TREND_BUCKETS), 'default bucket count is bound');
  const clamped = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH, { buckets: 999 });
  assert.ok(clamped.params.includes(24), 'an absurd bucket count clamps to 24');
});

test('facility ranking now returns entity_ids (the BXR/Indigo/Mixed label source), still grouped by facility', () => {
  const { sql } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(sql.includes('array_agg(distinct business_entity_id::text) as entity_ids'), 'entity_ids aggregated per facility');
  assert.ok(sql.includes('agg.entity_ids'), 'projected + grouped in the outer query');
});

// ── Change C: client-name blind-index resolution (patient_name_bidx, 0066/0067) ──────────────────
test('client-name kind: resolve + landing match patient_name_bidx; the member kinds are untouched', () => {
  const byName = buildResolvePayerQuery(TOKEN, 'client_name', BOTH);
  assert.ok(byName.sql.includes('patient_name_bidx = $2'), 'name resolve equality-matches the name token column');
  assert.ok(byName.params.includes(TOKEN), 'the opaque token is a bound param');
  const landing = buildIdentifierLandingFacilityQuery(TOKEN, 'client_name', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(landing.sql.includes('patient_name_bidx = $'), 'name landing matches the same column');
  // Regression: the member kinds still hit their own columns.
  assert.ok(buildResolvePayerQuery(TOKEN, 'member_id', BOTH).sql.includes('member_id_bidx = $2'));
  assert.ok(buildResolvePayerQuery(TOKEN, 'prefix', BOTH).sql.includes('member_id_prefix_bidx = $2'));
});

test('cases drill: nameToken adds the exact-name narrow; member/prefix take precedence over it', () => {
  const nameOnly = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, { nameToken: TOKEN });
  assert.ok(nameOnly.sql.includes('patient_name_bidx = $'), 'name narrow applied');
  const memberWins = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH, {
    memberToken: 'M'.repeat(64), nameToken: TOKEN,
  });
  assert.ok(memberWins.sql.includes('member_id_bidx = $'), 'member narrow applied');
  assert.ok(!memberWins.sql.includes('patient_name_bidx'), 'name narrow yields to the member narrow');
});
