import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import {
  buildResolvePayerQuery,
  buildFacilityRankingQuery,
  buildIdentifierLandingFacilityQuery,
  buildFacilityCasesQuery,
  buildQualifyMatchClientCountQuery,
  buildMoversQuery,
  buildBookKpisQuery,
  buildFacilityTrendQuery,
  QUALIFY_CASES_MAX,
  QUALIFY_MOVERS_MIN_PATIENTS,
  QUALIFY_MOVERS_MIN_CHARGES,
  QUALIFY_TREND_BUCKETS,
  QUALIFY_TREND_MIN_PATIENTS,
  QUALIFY_TREND_TOP_N,
} from '../src/collections/qualifyQuery.js';
import {
  buildCmdSearchSummaryQueries,
  cmdExplorerBaseConds,
  type CmdExplorerFilter,
  type ParamAdder,
} from '../src/collections/cmdExplorerQuery.js';

const BOTH = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
const TOKEN = 'a'.repeat(64); // opaque HMAC-shaped token

/** The single-facility/single-payer drill as a one-element compose set — the shape
 *  buildFacilityCasesQuery now takes after adopting cmdExplorerBaseConds. `extra` supplies phiIndex /
 *  employer / funding narrows (the shared-predicate axes); nameToken/allPayers stay as the 3rd-arg opts. */
const casesFilter = (
  payer: string,
  facility: string,
  from: string,
  to: string,
  extra: Partial<CmdExplorerFilter> = {},
): CmdExplorerFilter => ({ primary_payers: [payer], facility: [facility], from, to, ...extra });

/** Param numbers ($1,$2…) differ between two independently-built queries; normalize them away so a
 *  predicate FRAGMENT can be compared structurally across queries. */
const normParams = (sql: string) => sql.replace(/\$\d+/g, '$?');

// ── COLLECTIONS-SHARED FILTER LAYER (compose-bar regression) — the whole point of the rework is that
//    Qualify's composed cases + its live match count filter on the SAME predicate the Collections grid +
//    summary use. Prove it: for one composed filter, cmdExplorerBaseConds' conjunction appears
//    byte-for-byte (param-normalized) in BOTH Qualify's cases query AND Collections' summary totals. If
//    anyone forks the shared builder for one surface, this fails. ────────────────────────────────────
test('shared predicate: Qualify cases + Collections summary derive the SAME WHERE from cmdExplorerBaseConds', () => {
  const filter: CmdExplorerFilter = {
    facility: ['405 recovery', 'harbor light'],
    primary_payers: ['AETNA', 'CIGNA'],
    from: '2026-06-17',
    to: '2026-07-17',
    phiIndex: { memberIdBidx: TOKEN },
  };
  // The canonical conjunction the shared builder emits (its own fresh param sequence).
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const expected = normParams(cmdExplorerBaseConds(filter, BOTH, add).join(' and '));

  const cases = normParams(buildFacilityCasesQuery(filter, BOTH).sql);
  const summary = normParams(buildCmdSearchSummaryQueries(filter, BOTH).totals.sql);
  assert.ok(cases.includes(expected), 'Qualify cases query uses the shared predicate verbatim');
  assert.ok(summary.includes(expected), 'Collections summary totals uses the SAME shared predicate');

  // The evidence-gauge client count (Qualify-owned) ALSO derives the SAME predicate — so the gauge and
  // the "N charge lines match" count describe the identical population. It does NOT touch the Collections
  // summary builder (which is patient-count-blind); it reuses cmdExplorerBaseConds like the cases drill.
  const evidence = normParams(buildQualifyMatchClientCountQuery(filter, BOTH).sql);
  assert.ok(evidence.includes(expected), 'evidence client-count uses the SAME shared predicate as the match count');
});

// ── EVIDENCE GAUGE client-count builder: counts distinct clients, NEVER projects the token. ───────────
test('buildQualifyMatchClientCountQuery: counts distinct member_id_bidx off the rollup, never projects it', () => {
  const { sql, params } = buildQualifyMatchClientCountQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'),
    BOTH,
  );
  assert.match(sql, /count\(distinct member_id_bidx\)::int as distinct_patients/, 'counts distinct clients');
  // member_id_bidx appears ONLY inside the count() — never projected/selected/grouped bare.
  assert.ok(
    !sql.replace(/count\(distinct member_id_bidx\)/g, '').includes('member_id_bidx'),
    'member_id_bidx is COUNTED, never projected (no PHI token on the wire)',
  );
  assert.match(sql, /from collections\.cmd_explorer_charge_rollup/, 'charge-grain rollup, never raw rows');
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'cross-tenant scoped');
  assert.deepEqual(params[0], BOTH, 'pinned [BXR, Indigo]');
  assert.throws(() => buildQualifyMatchClientCountQuery(casesFilter('X', 'F', '2026-01-01', '2026-02-01'), []), /entityIds required/);
});

// ── The headline invariant: every builder targets BOTH tenants in ONE query. ─────────────────────
test('cross-tenant: every builder scopes business_entity_id = any($1::uuid[]) with BOTH tenant ids', () => {
  const built = [
    buildResolvePayerQuery(TOKEN, 'member_id', BOTH),
    buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
    buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH),
    buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH),
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
    buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH),
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
    () => buildFacilityCasesQuery(casesFilter('X', 'F', '2026-01-01', '2026-02-01'), []),
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
  // PAID RATIOS (2026-08-04): the ranking now also carries the other two KPI-tile metrics per facility,
  // because the tiles render worst/best FACILITY flanks on all three. What must NOT leak in is
  // PCT_RATIO_SELECT's 2%/$100 denominator FLOOR — that stays with the combo/cohort consumers (its
  // re-rule is deferred), and a floored ratio here would disagree with the unfloored headline above it.
  assert.match(sql, /as pct_paid_of_allowed/, 'per-facility paid ÷ reliable allowed');
  assert.match(sql, /as pct_paid_of_billed/, 'per-facility paid ÷ billed');
  assert.ok(!/greatest\(sum\(charge_amount\) \* 0\.02, 100\)/.test(sql), 'PCT_RATIO_SELECT floor must not leak in');
  assert.ok(!/ as pct_paid,| as pct_paid$/.test(sql), 'the floored PCT_RATIO_SELECT pct_paid stays out');
  assert.match(sql, /primary_payer = \$2/);
  assert.match(sql, /payment_received >= \$3::date and payment_received < \$4::date/, 'half-open window');
  assert.ok(sql.includes('collections.facilities'), 'facility_name/care_setting crosswalk');
  assert.ok(sql.includes('cmd_facility_aliases'), 'alias crosswalk');
  assert.match(sql, /as facility_code/, 'returns facility_code for the city/state lookup');
  assert.match(sql, /count\(\*\)::int as line_count/, 'line_count = ALL in-window lines (volume context, not tier-filtered)');
  assert.match(sql, /count\(distinct member_id_bidx\)::int as distinct_patients/, 'sample gate: distinct-patient count projected');
  // The opaque token is ONLY ever counted, NEVER selected as a column (no PHI leaves this builder).
  assert.ok(!sql.replace(/count\(distinct member_id_bidx\)/g, '').includes('member_id_bidx'), 'member_id_bidx is counted, never projected');
  assert.match(sql, /sum\(charge_amount\)::float8 as billed/, 'billed = ALL in-window lines (e2 stays in the denominator — unknown-like)');
  // Phase 0 (0059 trust signal): the coverage triple + level-of-care ride the SAME query — counts
  // only, no ratio/rating math change (bucket parity with confidence.ts: qualifyConfidence.test.ts).
  assert.match(sql, /as confirmed_claims/, 'coverage: confirmed count projected');
  assert.match(sql, /as estimate_claims/, 'coverage: estimate count projected');
  assert.match(sql, /as unknown_claims/, 'coverage: unknown count projected');
  assert.match(sql, /max\(f\.care_setting\) as care_setting/, 'level-of-care from the existing dimension join');
  // The 5th bind is the 'No Facility' placeholder (ruling 2026-08-12): this query produces RANKED
  // facility cards — named, sorted, drilled into, and the source of tileFlanks' Best/Worst — and the
  // placeholder is a bucket, not a place. Bound, never interpolated. The book-wide KPI denominator
  // deliberately binds no such param; test/qualifyNoFacility.test.ts pins both halves.
  assert.deepEqual(params, [BOTH, 'AETNA', '2026-06-17', '2026-07-17', 'No Facility']);
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

// ── IDENTIFIER-WIDE landing (2026-08-07): payer null drops ONLY the payer clause. ─────────────────
// This query can never be called without a token, so dropping the payer clause cannot widen it to the
// book — unlike the ranking builder, which needs a chokepoint guard for exactly that reason.
test('buildIdentifierLandingFacilityQuery: payer=null drops the payer clause and NOTHING else', () => {
  const wide = buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', null, '2026-06-17', '2026-07-17', BOTH);
  assert.ok(!/primary_payer = \$/.test(wide.sql), 'no payer equality in identifier-wide mode');
  assert.match(wide.sql, /member_id_prefix_bidx = \$4/, 'the identifier narrow is still there (one param earlier)');
  assert.match(wide.sql, /payment_received >= \$2::date and payment_received < \$3::date/, 'window intact');
  assert.match(wide.sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant scope intact');
  assert.deepEqual(wide.params, [BOTH, '2026-06-17', '2026-07-17', TOKEN], 'the payer param is gone, not blank');
  // ⚠ THE ORDERING IS THE CONTRACT (see the parity test below). Widening the scope must not touch it.
  const scoped = buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  const orderOf = (s: string) => s.slice(s.indexOf('order by'));
  assert.equal(orderOf(wide.sql), orderOf(scoped.sql), 'ORDER BY is byte-identical with and without a payer');
});

// ── ORDER-BY PARITY (the land-on-the-wrong-facility guard): the landing lookup's "most recent" ordering
//    MUST match the drill's claim ordering — NOW on the PAYMENT-date axis (payment_received desc nulls last,
//    id desc). payment_received is a DATE (0019), so the drill's to_char('YYYY-MM-DD') alias is lexical ==
//    chronological == the landing's raw-column order → the two select the SAME "most recent" claim. LOCKSTEP. ──
test('buildIdentifierLandingFacilityQuery: ORDER BY matches the drill (payment_received desc nulls last, id desc — the payment-date axis)', () => {
  const landing = buildIdentifierLandingFacilityQuery(TOKEN, 'prefix', 'AETNA', '2026-06-17', '2026-07-17', BOTH);
  const drill = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH);
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
  const { sql, params } = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH);
  assert.match(sql, /facility = any\(\$2::text\[\]\) and primary_payer = any\(\$3::text\[\]\)/, 'facility + payer set-membership (shared cmdExplorerBaseConds order)');
  assert.deepEqual(params[1], ['405 recovery'], 'facility bound as the $2 array (raw text, never interpolated)');
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
  assert.deepEqual(params.slice(0, 5), [BOTH, ['405 recovery'], ['AETNA'], '2026-06-17', '2026-07-17']);
  // No filter by default: no identifier predicate. And NO keyset WHERE ever exists now (the pager is gone).
  assert.ok(!/member_id_prefix_bidx = /.test(sql) && !/member_id_bidx = /.test(sql), 'no identifier PREDICATE when none supplied (projection is fine)');
  assert.ok(!/agg\.payment_date </.test(sql) && !/agg\.payment_date is null and agg\.id </.test(sql), 'no keyset WHERE — the whole window returns in one shot');
});

// ── buildFacilityCasesQuery: PREFIX narrow → member_id_prefix_bidx (the STARTS-WITH bleed guard). ─────
test('buildFacilityCasesQuery: a prefix token adds member_id_prefix_bidx to the INNER WHERE', () => {
  const { sql, params } = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', { phiIndex: { memberIdPrefixBidx: TOKEN } }),
    BOTH,
  );
  assert.match(sql, /payment_received < \$5::date and member_id_prefix_bidx = \$6\)? agg/, 'prefix predicate is the last inner condition');
  assert.ok(!sql.includes('member_id_bidx = '), 'prefix mode does NOT touch the exact-member column');
  assert.equal(params[5], TOKEN, 'prefix token bound (opaque; never the raw prefix)');
  assert.equal(params[6], QUALIFY_CASES_MAX + 1, 'cap+1 follows the prefix param');
});

// ── buildFacilityCasesQuery: EXACT MEMBER narrow → member_id_bidx (claims for that member only). ──────
test('buildFacilityCasesQuery: a member token adds member_id_bidx to the INNER WHERE (independent AND with prefix)', () => {
  const exact = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', { phiIndex: { memberIdBidx: TOKEN } }),
    BOTH,
  );
  assert.match(exact.sql, /payment_received < \$5::date and member_id_bidx = \$6\)? agg/, 'exact member predicate in the inner WHERE');
  assert.ok(!exact.sql.includes('member_id_prefix_bidx'), 'exact mode does NOT touch the prefix column');
  assert.equal(exact.params[5], TOKEN, 'member token bound (opaque; never the raw member id)');
  // COMPOSE semantics (the shared cmdExplorerBaseConds predicate): the member + prefix PHI fields are
  // INDEPENDENT and AND together — no precedence. In practice only one is set per search, but if both
  // arrive both narrow (member_id_bidx first, then member_id_prefix_bidx, per the builder's order).
  const both = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', {
      phiIndex: { memberIdBidx: TOKEN, memberIdPrefixBidx: 'b'.repeat(64) },
    }),
    BOTH,
  );
  assert.match(both.sql, /member_id_bidx = \$6/, 'exact member narrow applied');
  assert.match(both.sql, /member_id_prefix_bidx = \$7/, 'prefix narrow ALSO applied (independent AND)');
});

// ── buildFacilityCasesQuery: NO keyset pager — the whole window returns in one shot (cap+1 over-fetch). ────
test('buildFacilityCasesQuery: no cursor param exists — no keyset WHERE, single capped fetch', () => {
  const { sql, params } = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH);
  assert.ok(!/agg\.payment_date </.test(sql), 'no keyset comparison anywhere');
  assert.ok(!/where \(agg\./.test(sql), 'no OUTER keyset WHERE on the agg subquery');
  assert.match(sql, /order by agg\.payment_date desc nulls last, agg\.id desc/, 'ORDER BY the payment-date axis, cap keeps the most recent');
  assert.equal(params[params.length - 1], QUALIFY_CASES_MAX + 1, 'the last bind is the cap+1 over-fetch');
});

// ── buildMoversQuery: distinct-patient delta + both suppression floors + clamp. ──────────────────
test('buildMoversQuery: distinct-patient delta across adjacent windows, floors clamped, signed-desc', () => {
  const { sql, params } = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH);
  // Distinct patients per window, each as its own DISTINCT-then-count pass (see the perf guard below).
  assert.match(sql, /select distinct primary_payer, member_id_bidx from collections\.cmd_explorer_charge_rollup .*payment_received >= \$2::date and payment_received < \$3::date/, 'this-window distinct patients');
  assert.match(sql, /select distinct primary_payer, member_id_bidx from collections\.cmd_explorer_charge_rollup .*payment_received >= \$4::date and payment_received < \$5::date/, 'prior-window distinct patients');
  assert.match(sql, /\(t\.patients - coalesce\(p\.patients, 0\)\) as delta_patients/, 'signed delta');
  assert.match(sql, /where t\.patients >= \$6 and c\.this_charges >= \$7/, 'patient suppression + charge floor');
  assert.match(sql, /order by delta_patients desc, this_patients desc, t\.primary_payer/, 'gainers first, deterministic');
  // A payer with NO prior-window rows must read 0, not null — the old count() over an empty FILTER did.
  assert.match(sql, /coalesce\(p\.patients, 0\) as prior_patients/, 'absent prior window is 0, never null');
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
  const only = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', { phiIndex: { groupNumberBidx: TOKEN } }),
    BOTH,
  );
  assert.match(only.sql, /and group_number_bidx = \$6/, 'group narrow is an exact bidx equality');
  assert.equal(only.params[5], TOKEN, 'opaque token bound (never the raw group #)');

  const both = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', {
      phiIndex: { memberIdPrefixBidx: 'b'.repeat(64), groupNumberBidx: TOKEN },
    }),
    BOTH,
  );
  assert.match(both.sql, /member_id_prefix_bidx = \$6 and group_number_bidx = \$7/, 'ANDs with the member narrow — composable, not competing');

  const none = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH);
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

// ── IDENTIFIER-SCOPED ranking: a prefix/member/name search narrows the ranking to that blind index, so the
//    facility SET + line_count/billed/allowed/pct reflect ONLY the searched id's rows (not the payer book). ──
test('buildFacilityRankingQuery: an identifier token narrows the ranking on the right blind index (bound param)', () => {
  const pfx = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH, {}, 'HMAC_PFX', 'prefix');
  assert.ok(pfx.sql.includes('and member_id_prefix_bidx = $'), 'prefix → member_id_prefix_bidx equality');
  assert.ok(pfx.params.includes('HMAC_PFX'), 'the token is a bound param, never inlined');

  const mem = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH, {}, 'HMAC_MEM', 'member_id');
  assert.ok(mem.sql.includes('and member_id_bidx = $'), 'exact member → member_id_bidx equality');

  const nm = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH, {}, 'HMAC_NAME', 'client_name');
  assert.ok(nm.sql.includes('and patient_name_bidx = $'), 'client name → patient_name_bidx equality');
});

test('buildFacilityRankingQuery: no identifier token → payer-wide, no blind-index predicate (byte-for-byte)', () => {
  const wide = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(!/(member_id_prefix_bidx|patient_name_bidx)/.test(wide.sql), 'no identifier predicate when payer-wide');
  assert.ok(!wide.sql.includes('member_id_bidx = $'), 'no exact-member equality when payer-wide');
});

test('buildFacilityCasesQuery: a market employer filter narrows the inner WHERE via the semi-join', () => {
  const { sql, params } = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', { employers: ['BOEING'] }),
    BOTH,
  );
  // cmdExplorerBaseConds emits the VOB semi-join BEFORE the from/to window → employer param is $4 here.
  assert.match(
    sql,
    /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where employer_norm = any\(\$4::text\[\]\)\)/,
  );
  assert.deepEqual(params[3], ['BOEING']);
});

test('buildMoversQuery: a market funding filter scopes the two-window population before the payer rollup', () => {
  const { sql, params } = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH, {
    market: { funding: ['Fully Insured'] },
  });
  // The semi-join scopes the population BEFORE the payer rollup. It now appears in every pass (both
  // patient windows and the charge count) rather than once — the same narrow, applied consistently.
  const mjRe = /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest where funding = any\(\$9::text\[\]\)\)/g;
  assert.equal((sql.match(mjRe) ?? []).length, 3, 'market narrow applied to all three passes');
  assert.deepEqual(params[8], ['Fully Insured']);
});

test('buildMoversQuery: distinct-first per window — the 13s mount regression guard', () => {
  const { sql } = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH);
  /* MEASURED on prod 2026-08-06 over the 12-month window this runs on at mount:
   *   one scan, count(distinct) FILTER per window .. 13045 ms (Sort, external merge, 26576kB to DISK)
   *   distinct-first, grouped (current) ............   681 ms (all HashAggregate, no spill)
   * count(distinct x) under GROUP BY forces a sort by (group key, x) across the whole scan. Folding
   * these back together is a ~19x latency regression on EVERY mount, invisible to every other test. */
  assert.doesNotMatch(sql, /count\(distinct/, 'no count(distinct) — it forces a sort under GROUP BY');
  assert.doesNotMatch(sql, /filter \(where payment_received/, 'windows are separate passes, not FILTERs over a union scan');
  assert.equal((sql.match(/select distinct primary_payer, member_id_bidx/g) ?? []).length, 2, 'one DISTINCT pass per window');
});

test('qualify builders: NO market filter emits NO VOB clause (unchanged behavior)', () => {
  const rank = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  const cases = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH);
  const movers = buildMoversQuery('2026-06-17', '2026-07-17', '2026-05-18', '2026-06-17', BOTH);
  for (const q of [rank, cases, movers]) {
    assert.doesNotMatch(q.sql, /vob\.member_benefits_latest/, 'no VOB clause without a market filter');
  }
});

// ── Redesign overview aggregates: buildBookKpisQuery + buildFacilityTrendQuery ────────────────────
test('overview aggregates: cross-tenant + read the rollup + route through assertEntityScope', () => {
  const kpis = buildBookKpisQuery({ from: '2026-06-17', to: '2026-07-17' }, BOTH);
  const trend = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  for (const { sql, params } of [kpis, trend]) {
    assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant predicate present');
    assert.deepEqual(params[0], BOTH, 'first param is the pinned [BXR, Indigo] array');
    assert.ok(sql.includes('collections.cmd_explorer_charge_rollup'), 'reads the rollup');
    assert.ok(!sql.includes('cmd_explorer_rows'), 'never reads raw posting-grain rows');
  }
  assert.throws(() => buildBookKpisQuery({ from: '2026-01-01', to: '2026-02-01' }, []), /entityIds required/);
  assert.throws(() => buildFacilityTrendQuery('2026-01-01', '2026-02-01', '2025-12-01', []), /entityIds required/);
});

/**
 * THE MOMENTUM STRIP MUST BE ABLE TO SHOW A DECLINE (Alec, 2026-08-09).
 *
 * The strip ORDERs BY `delta desc`, so any limit small enough to bite is structurally a
 * "hide every falling facility" filter — which is exactly what the old top-15 cut was, and why the
 * surface could only ever report good news. This pins the two halves of the fix together: the rank
 * order is UNCHANGED (risers first — "keep the ranking"), and the bound is now far above the live
 * roster (47 facilities, 39 clearing the 90d gates as measured 2026-08-09) so it selects nothing.
 * If someone re-tightens the cap, this fails and says why.
 */
test('facility momentum: ranked by delta desc, and the row cap is a SAFETY BOUND that cannot hide decliners', () => {
  const { sql, params } = buildFacilityTrendQuery('2026-05-11', '2026-08-09', '2026-02-10', BOTH);
  assert.match(
    sql,
    /order by \(agg\.cur_rating - agg\.prior_rating\) desc nulls last/,
    'the ranking is by rating delta, biggest riser first — unchanged by the 2026-08-09 uncapping',
  );
  assert.ok(
    QUALIFY_TREND_TOP_N >= 60,
    `the cap must stay well clear of the ~47-facility roster; at ${QUALIFY_TREND_TOP_N} a delta-ordered ` +
      'limit starts truncating the TAIL, which is where every declining facility lives',
  );
  // The cap is a BOUND PARAM, not an inlined literal (paramList discipline) — so assert the shape
  // and the value it binds, which is what an inlined-literal assertion would have missed entirely.
  assert.match(sql.trimEnd(), /limit \$\d+$/, 'the row cap is a bound param, never string-built');
  assert.equal(params[params.length - 1], QUALIFY_TREND_TOP_N, 'and the constant is what it binds');
});

test('book KPIs: three guarded ratios + distinct-patient count, e2 excluded, NO raw dollars projected', () => {
  const { sql } = buildBookKpisQuery({ from: '2026-06-17', to: '2026-07-17' }, BOTH);
  assert.ok(sql.includes('as pct_allowed_of_billed'), 'allowed/billed ratio');
  assert.ok(sql.includes('as pct_paid_of_allowed'), 'paid/allowed ratio (collection yield)');
  assert.ok(sql.includes('as pct_paid_of_billed'), 'paid/billed ratio (net realization)');
  assert.match(sql, /count\(\*\)::int as distinct_patients/, 'tile sample gate: distinct-patient count');
  assert.ok(sql.includes("allowed_tier <> 'e2'"), 'reliable-allowed excludes tier e2 (ruling Q2a — parity with the rating)');
  assert.ok(sql.includes('case when'), 'every ratio is denominator-guarded (null, never a coerced 0%)');
  // Four output columns on the OUTER select (3 ratios + the count), dollars summed as denominators.
  const selectList = sql.slice(sql.indexOf('select ') + 7, sql.indexOf(' from '));
  assert.equal(selectList.split(',').length, 4, 'exactly four output columns (3 ratios + patient count)');
  assert.ok(!/as .*(billed_amount|charge_total|insurance_payments) /.test(sql), 'no raw dollar column leaves SQL');
  // member_id_bidx is COUNTED/GROUPED inside the subquery, never projected out (no PHI leaves).
  assert.ok(!sql.replace(/select distinct member_id_bidx/g, '').includes('member_id_bidx'), 'bidx grouped, never projected');
});

test('book KPIs: the distinct count is a SEPARATE scan — the 1.8s mount regression guard', () => {
  const { sql, params } = buildBookKpisQuery({ from: '2026-06-17', to: '2026-07-17' }, BOTH);
  /* MEASURED on prod, 2026-08-06, over the 12-month book-wide window this runs on at mount:
   *   both aggregates in ONE select ... 1819 ms (Sort, external merge, 14232kB spilled to DISK)
   *   split as it is now .............   152 ms (index-only scan + HashAggregate, 1041kB, no spill)
   * Postgres cannot combine count(distinct x) with sibling aggregates without sorting the whole
   * scan by x. Folding these back together is a ~12x latency regression on EVERY mount of the tab,
   * and nothing else in the suite would catch it. */
  assert.doesNotMatch(sql, /count\(distinct member_id_bidx\)/, 'must NOT be folded back into one aggregate');
  assert.match(sql, /cross join/, 'the two aggregates stay separate scans');
  assert.equal((sql.match(/from collections\.cmd_explorer_charge_rollup/g) ?? []).length, 2, 'two scans');
  // The predicate is emitted twice but BOUND once — a second cmdExplorerBaseConds call would push
  // duplicate params and silently renumber the placeholders.
  assert.equal(params.length, 3, 'entity array + from + to, bound once');
  assert.equal((sql.match(/\$1::uuid\[\]/g) ?? []).length, 2, 'one placeholder, referenced by both branches');
});

// ── FLANK PARITY (2026-08-04) ────────────────────────────────────────────────────────────────────
//
// The KPI tiles print a headline from buildBookKpisQuery and, beneath it, the worst/best FACILITY on the
// same metric from buildFacilityRankingQuery. If those two builders ever compute a metric differently,
// the tile's parts contradict its whole — a facility could be bracketed outside a range it belongs to,
// or "Best" could exceed a headline it helped produce. SQL cannot share a constant across the two
// builders' shapes (one is a flat aggregate, the other a grouped subselect), so this test is the lock.
test('FLANK PARITY: the ranking computes the paid ratios with the SAME expressions as the book KPIs', () => {
  const kpis = buildBookKpisQuery({ from: '2026-06-17', to: '2026-07-17' }, BOTH).sql;
  const rank = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH).sql;
  const reliable = "sum(allowed_reliable) filter (where allowed_tier <> 'e2')";
  const EXPRESSIONS = [
    // paid ÷ reliable allowed, guarded on a positive denominator
    `case when (${reliable}) > 0 then round(sum(insurance_payments) / (${reliable}) * 100, 2)::float8 end as pct_paid_of_allowed`,
    // paid ÷ billed
    'case when sum(charge_amount) > 0 then round(sum(insurance_payments) / sum(charge_amount) * 100, 2)::float8 end as pct_paid_of_billed',
  ];
  for (const expr of EXPRESSIONS) {
    assert.ok(kpis.includes(expr), `book KPIs no longer emit: ${expr}`);
    assert.ok(rank.includes(expr), `the ranking no longer emits: ${expr}`);
  }
  // And the allowed metric, which both have always shared.
  assert.ok(kpis.includes(reliable) && rank.includes(reliable), 'both read the same reliable-allowed sum');
});

test('FLANK PARITY: the ranking projects the paid PERCENTAGES only — never the payment sum itself', () => {
  // A percentage survives the amounts strip, so an admissions_seat derives identical flanks to a
  // super_admin. Projecting sum(insurance_payments) would put a dollar figure on the wire for a role
  // that must never receive one, and stripSnapshotAmounts does not know about a new field.
  const { sql } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.ok(!/as (paid|payments|insurance_payments)\b/.test(sql), 'no raw payment column is projected');
  // The OUTER select list only (the inner subselect follows it, inside `from (…) agg`): every column
  // that reaches the caller is listed there, so a payment sum could only escape through it.
  const start = sql.indexOf('select agg.facility');
  const outerList = sql.slice(start, sql.indexOf(' from (', start));
  assert.ok(!outerList.includes('insurance_payments'), 'a payment sum reaches the caller');
  assert.match(outerList, /agg\.pct_paid_of_allowed, agg\.pct_paid_of_billed/, 'the two percentages do');
});

// DESIGN B ASYMMETRY (Phase 2): payer + facility scope the tiles; employer/funding NEVER do. This is
// the load-bearing regression — if a future edit lets market into the tiles predicate, it fails LOUDLY.
test('book KPIs (Design B): book-wide by default; payer[]/facility[] scope; employer/funding structurally ABSENT', () => {
  const wide = buildBookKpisQuery({ from: '2026-06-17', to: '2026-07-17' }, BOTH);
  assert.ok(!wide.sql.includes('primary_payer ='), 'book-wide by default — no payer filter');
  assert.ok(!wide.sql.includes('facility ='), 'book-wide by default — no facility filter');

  const scoped = buildBookKpisQuery(
    { from: '2026-06-17', to: '2026-07-17', primary_payers: ['CIGNA', 'AETNA'], facility: ['405 recovery'] },
    BOTH,
  );
  assert.match(scoped.sql, /primary_payer = any\(\$\d+::text\[\]\)/, 'payer[] scope via the shared set-membership predicate');
  assert.match(scoped.sql, /facility = any\(\$\d+::text\[\]\)/, 'facility[] scope via the shared set-membership predicate');
  // Set-membership binds the whole array as ONE param (…= any($n::text[])), so the values live inside
  // array params — assert they're bound, not string-concatenated into the SQL.
  const paramArrays = scoped.params.filter((p): p is string[] => Array.isArray(p));
  assert.ok(paramArrays.some((a) => a.includes('CIGNA')), 'payer values are bound (array param)');
  assert.ok(paramArrays.some((a) => a.includes('405 recovery')), 'facility values are bound (array param)');
  assert.ok(!scoped.sql.includes('CIGNA') && !scoped.sql.includes('405 recovery'), 'no scope value is concatenated into the SQL');
  assert.ok(scoped.sql.includes('as pct_allowed_of_billed'), 'still projects the same ratios');

  // THE GUARD: the tiles predicate can NEVER carry a VOB employer/funding semi-join. QualifyOrientationScope
  // has no employer/funding fields, so even a caller that tries is a type error — and the SQL proves it.
  assert.ok(!scoped.sql.includes('vob.member_benefits_latest'), 'no VOB market semi-join in the tiles predicate');
  assert.ok(!scoped.sql.includes('employer_norm'), 'employer never scopes the tiles (Design B)');
  assert.ok(!scoped.sql.includes('funding ='), 'funding never scopes the tiles (Design B)');
});

test('facility trend: rating-delta order, dominant-payer by allowed $, e2-excluded ratings, bucket math, book-wide by default', () => {
  const { sql } = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  assert.match(sql, /order by \(agg\.cur_rating - agg\.prior_rating\) desc nulls last/, 'sorts by the rating delta, new (null-prior) last');
  assert.ok(sql.includes('distinct on (facility)') && sql.includes('allowed_sum desc nulls last'), 'dominant payer = top payer by reliable allowed $ (ties → line count → name)');
  assert.ok(sql.includes("allowed_tier <> 'e2'"), 'ratings exclude tier e2 (parity with the value-first rating)');
  assert.ok(sql.includes('least(') && sql.includes('greatest(0'), 'bucket index is clamped to [0, N-1]');
  assert.ok(sql.includes('array_remove(array_agg'), 'sparkline points drop thin buckets (never fabricated)');
  assert.ok(!sql.includes('primary_payer = $'), 'book-wide by default — no single-payer filter');
});

test('facility trend: a payer-scoped variant adds the single-payer filter (the payer-scoped ticker)', () => {
  const { sql, params } = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH, { payer: 'AETNA' });
  assert.ok(sql.includes('and primary_payer = $'), 'payer-scoped adds the filter');
  assert.ok(params.includes('AETNA'), 'the payer value is a bound param');
});

// PHASE 2 (Design B): the ticker gets a both-window distinct-patient delta gate, is NEVER
// employer/funding-scoped, and projects ratings only (no dollars, no PHI).
test('facility trend (Design B): both-window >=5-patient delta gate; NO market; patient count NOT projected; no dollars', () => {
  const { sql, params } = buildFacilityTrendQuery('2026-06-17', '2026-07-17', '2026-05-18', BOTH);
  assert.match(sql, /count\(distinct member_id_bidx\) filter \(where is_cur\)::int as cur_patients/, 'current-window distinct patients');
  assert.match(sql, /count\(distinct member_id_bidx\) filter \(where not is_cur\)::int as prior_patients/, 'prior-window distinct patients');
  assert.match(sql, /agg\.cur_patients >= \$\d+ and agg\.prior_patients >= \$\d+/, 'BOTH windows gated at >= min patients (delta not ranked on noise)');
  assert.ok(params.includes(QUALIFY_TREND_MIN_PATIENTS), 'the min-patients floor is a bound param');
  // Design B: no market param exists on the builder, so the ticker can never be employer/funding-scoped.
  assert.ok(!sql.includes('vob.member_benefits_latest'), 'no VOB market semi-join in the ticker');
  assert.ok(!sql.includes('employer_norm') && !sql.includes('funding ='), 'employer/funding never scope the ticker');
  // member_id_bidx rides ONLY inside the internal `span` CTE (so `fac` can COUNT it) — it is never
  // projected to the caller: `fac` selects the counts, not the token, so `agg` carries no bidx.
  assert.ok(!sql.includes('agg.member_id_bidx'), 'the opaque token never reaches the outer projection (no PHI leaves)');
  assert.ok(!/as member_id_bidx/.test(sql), 'bidx is never aliased into an output column');
  // Ratings only — no raw dollar column is projected (admissions_seat safe by construction).
  assert.ok(!/ as (billed|allowed|charge|paid|insurance_payments)\b/.test(sql), 'no raw dollar column projected');
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

test('cases drill: nameToken adds the exact-name narrow as Qualify’s own extra AND (independent of member/prefix)', () => {
  const nameOnly = buildFacilityCasesQuery(casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17'), BOTH, {
    nameToken: TOKEN,
  });
  assert.ok(nameOnly.sql.includes('patient_name_bidx = $'), 'name narrow applied');
  // patient_name_bidx is Qualify's OWN extra AND (not in cmdExplorerBaseConds' phiIndex), so it composes
  // WITH the member narrow rather than yielding to it — no precedence.
  const memberAndName = buildFacilityCasesQuery(
    casesFilter('AETNA', '405 recovery', '2026-06-17', '2026-07-17', { phiIndex: { memberIdBidx: 'M'.repeat(64) } }),
    BOTH,
    { nameToken: TOKEN },
  );
  assert.ok(memberAndName.sql.includes('member_id_bidx = $'), 'member narrow applied');
  assert.ok(memberAndName.sql.includes('patient_name_bidx = $'), 'name narrow ALSO applied (independent AND, not precedence)');
});
