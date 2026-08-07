/**
 * Phase B/E SQL builders — policy resolution + the auto-window rung query. Hermetic string/param
 * assertions in the qualifyQuery.test.ts idiom: fixed identifiers, bound values, and the PHI
 * discipline (tokens matched, never projected; no readable prefix column exists on the matview).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildQualifyPolicyQuery,
  buildQualifyPolicySpreadQuery,
  buildQualifyVobFreshnessQuery,
  buildQualifyWindowRungsQuery,
  QUALIFY_SPREAD_LIMIT,
  VOB_MEMBER_BENEFITS_LATEST,
} from '../src/collections/qualifyPolicyQuery';
import {
  buildFacilityRankingQuery,
  buildResolvePayerQuery,
  buildResolvePayerSpreadQuery,
  QUALIFY_PAYER_SPREAD_LIMIT,
} from '../src/collections/qualifyQuery';

const ENT = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088', '141d459c-f371-4229-9a92-ace198e940bb'];

test('policy query: prefix kind matches member_id_prefix_bidx; token bound, never inlined', () => {
  const { sql, params } = buildQualifyPolicyQuery('tok-abc', 'prefix');
  assert.match(sql, /from vob\.member_benefits_latest/);
  assert.match(sql, /where member_id_prefix_bidx = \$1/);
  assert.deepEqual(params, ['tok-abc']);
  assert.ok(!sql.includes('tok-abc'), 'token is a bound param only');
  // No readable prefix column exists — the builder must never name one.
  assert.doesNotMatch(sql, /alpha_prefix/);
});

test('policy query: aggregates only — no member-level projection, group number is presence-only', () => {
  const { sql } = buildQualifyPolicyQuery('t', 'member_id');
  assert.match(sql, /where member_id_bidx = \$1/);
  assert.match(sql, /count\(distinct member_id_bidx\)::int as member_count/);
  assert.match(sql, /coalesce\(bool_or\(group_number_bidx is not null\), false\) as group_on_file/);
  // The blind indexes are counted / presence-tested / equality-matched — never projected as values.
  const legitimate = sql
    .replace('count(distinct member_id_bidx)::int as member_count', '')
    .replace('coalesce(bool_or(group_number_bidx is not null), false) as group_on_file', '')
    .replace('where member_id_bidx = $1', '');
  assert.ok(!legitimate.includes('member_id_bidx'), 'member_id_bidx only in count/where');
  assert.ok(!legitimate.includes('group_number_bidx'), 'group_number_bidx only in the presence test');
  assert.match(sql, /mode\(\) within group \(order by insurance_co\) as carrier/);
  assert.match(sql, /max\(vob_created_at\)/);
});

test('freshness query: one global high-water mark, zero params', () => {
  const { sql, params } = buildQualifyVobFreshnessQuery();
  assert.equal(params.length, 0);
  assert.match(sql, new RegExp(`from ${VOB_MEMBER_BENEFITS_LATEST.replace('.', '\\.')}`));
  assert.match(sql, /max\(vob_created_at\)/);
  // PR #73 review pin: FULL UTC timestamp — a day-grain regression would reintroduce the 24h slack.
  assert.match(sql, /at time zone 'UTC'/);
  assert.match(sql, /HH24:MI:SS/);
});

test('window rungs: ONE scan, five FILTER counts, token+tenant scoped, widest rung bounds the scan', () => {
  const froms = { d30: '2026-07-05', d60: '2026-06-05', d90: '2026-05-06', d180: '2026-02-05', d365: '2025-08-04' };
  const { sql, params } = buildQualifyWindowRungsQuery('tok-p', 'prefix', ENT, froms, '2026-08-04');
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(sql, /member_id_prefix_bidx = \$2/);
  for (const name of ['p30', 'p60', 'p90', 'p180', 'p365']) {
    assert.match(sql, new RegExp(`count\\(distinct member_id_bidx\\) filter \\(where payment_received >= \\$\\d+::date\\)::int as ${name}`));
  }
  // Single scan bounded by the WIDEST rung — no unbounded read, no five round-trips.
  assert.match(sql, /and payment_received >= \$7::date and payment_received < \$8::date/);
  assert.equal(params.length, 8);
  assert.equal(params[1], 'tok-p');
  assert.equal((sql.match(/from collections\.cmd_explorer_charge_rollup/g) || []).length, 1);
});

test('ranking with payer=null (comparable cohort): no payer clause; market semi-join carries the scope', () => {
  const { sql, params } = buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {
    employers: ['ACME_CORP'],
  });
  assert.doesNotMatch(sql, /primary_payer = \$/);
  assert.match(sql, /member_id_bidx in \(select member_id_bidx from vob\.member_benefits_latest/);
  assert.match(sql, /employer_norm = any\(/);
  assert.ok(params.some((p) => Array.isArray(p) && (p as string[]).includes('ACME_CORP')));
});

test('ranking (payer path) still binds payer and now returns the median TTP day count', () => {
  const { sql, params } = buildFacilityRankingQuery('AETNA', '2026-05-01', '2026-08-01', ENT);
  assert.match(sql, /primary_payer = \$2/);
  assert.equal(params[1], 'AETNA');
  assert.match(sql, /percentile_cont\(0\.5\) within group \(order by \(payment_received - charge_date\)::float8\)/);
  assert.match(sql, /as median_days_to_payment/);
  assert.match(sql, /agg\.median_days_to_payment/);
});


test('ranking with payer=null and NO scope at all still throws at the builder chokepoint (finding #5)', () => {
  // The guard's REASON is unchanged — an unscoped null ranks the whole book — but it now recognises
  // TWO scopes. These four calls carry neither, so they must still throw.
  assert.throws(() => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}), /requires a scope/);
  assert.throws(() => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, { employers: [] }), /requires a scope/);
  // A token with NO kind is not a scope: the builder cannot pick a blind-index column without one, so
  // the narrow would silently vanish and the read would go book-wide. Same for a kind with no token.
  assert.throws(
    () => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, 'HMAC', null),
    /requires a scope/,
  );
  assert.throws(
    () => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, null, 'prefix'),
    /requires a scope/,
  );
  // ⚠ AN EMPTY-STRING TOKEN IS NOT A SCOPE, AND THE GUARD ONCE THOUGHT IT WAS. `idNarrow` emits on
  // TRUTHINESS (`token && kind`), so '' produces no identifier clause; a guard written `token !== null`
  // accepted this pair and the builder emitted neither a payer clause nor an identifier one — an
  // unscoped WHOLE-BOOK ranking, the maximum-magnitude version of the exact failure this chokepoint
  // exists to prevent. Unreachable from the cores today, but the builder's header claims enforcement
  // happens HERE, so the claim has to be true independently of its callers.
  assert.throws(
    () => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, '', 'prefix'),
    /requires a scope/,
  );
});

test('the guard and the identifier narrow agree on what counts as a token — one predicate, two sites', () => {
  // The pairing is the invariant: whatever the guard ACCEPTS as an identifier scope, the SQL must
  // actually narrow by. Asserted as a property rather than by re-reading the source, so the two
  // cannot drift apart silently the way they did.
  for (const token of ['HMAC_PFX', '', null] as const) {
    let sql: string | null = null;
    try {
      sql = buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, token, 'prefix').sql;
    } catch {
      sql = null; // the guard refused — which is a valid outcome, just not a silently-unscoped one
    }
    if (sql !== null) {
      assert.match(sql, /member_id_prefix_bidx = \$\d+/, `an accepted token (${JSON.stringify(token)}) must actually narrow`);
    }
  }
});

// ── IDENTIFIER-WIDE MODE (the v3 Skip, 2026-08-07) ───────────────────────────────────────────────
// Reverses "the DIRECT path's rankings are payer-scoped" for this one input. The TOKEN is the scope:
// a blind-index equality bounds the scan at least as tightly as an employer semi-join (measured live
// — 3.2ms/264 buffers at 30d on the busiest prefix, 19.4ms/1,471 at the 365d ladder worst case).
test('ranking with payer=null and a token+kind is ALLOWED — the identifier narrow IS the scope', () => {
  const { sql, params } = buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, 'HMAC_PFX', 'prefix');
  assert.ok(!/primary_payer = \$/.test(sql), 'no payer equality — the ranking spans every label');
  assert.match(sql, /and member_id_prefix_bidx = \$\d+/, 'the identifier narrow IS present');
  assert.ok(params.includes('HMAC_PFX'), 'the token is a bound param, never inlined');
  // Fail-closed shape that must survive the widening.
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant scope intact');
  assert.match(sql, /payment_received >= \$\d+::date and payment_received < \$\d+::date/, 'window intact');
});

test('ranking: payer_count rides the SAME scan so a card can disclose the blend', () => {
  // Present in BOTH modes — degenerate (always 1) under a payer equality, load-bearing without one.
  for (const q of [
    buildFacilityRankingQuery('AETNA', '2026-05-01', '2026-08-01', ENT),
    buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}, 'HMAC_PFX', 'prefix'),
  ]) {
    assert.match(q.sql, /count\(distinct primary_payer\)::int as payer_count/, 'counted in the inner aggregate');
    assert.match(q.sql, /agg\.payer_count/, 'projected through the outer select');
  }
});

// ── The SPREAD builders (2026-08-06): the widening that stops a single mode() standing in for a
// population. See the builders' headers for the measurements that motivated them.

test('policy spread: both dims, token AND limit bound once each, reused across both branches', () => {
  const { sql, params } = buildQualifyPolicySpreadQuery('tok-abc', 'prefix');
  assert.deepEqual(params, ['tok-abc', QUALIFY_SPREAD_LIMIT]);
  // ONE bound param each, referenced twice — not two copies, and not interpolated.
  assert.equal((sql.match(/\$1/g) || []).length, 2);
  assert.equal((sql.match(/\$2/g) || []).length, 2);
  assert.match(sql, /'employer'::text as dim/);
  assert.match(sql, /'carrier'::text as dim/);
  assert.match(sql, /union all/);
  assert.match(sql, /member_id_prefix_bidx = \$1/);
  // Each branch carries its own LIMIT — an uncapped branch is the 300-employer failure mode.
  assert.equal((sql.match(/limit \$2/g) || []).length, 2);
});

test('policy spread: the LIMIT is a BOUND param, never interpolated into the SQL text', () => {
  const { sql, params } = buildQualifyPolicySpreadQuery('tok-abc', 'prefix', 7);
  // The literal must not appear in the text — safety comes from binding, not from the clamp.
  assert.doesNotMatch(sql, /limit 7/);
  assert.match(sql, /limit \$2/);
  assert.equal(params[1], 7);
});

test('policy spread groups employer_norm — NEVER employer_name, which is a PHI column', () => {
  const { sql } = buildQualifyPolicySpreadQuery('tok-abc', 'prefix');
  assert.match(sql, /employer_norm as value/);
  // The whole PHI posture of this builder in one assertion: the display name must not appear at all.
  assert.doesNotMatch(sql, /employer_name/);
});

test('policy spread: member_id kind swaps the match column; token still never projected', () => {
  const { sql } = buildQualifyPolicySpreadQuery('tok-m', 'member_id');
  assert.match(sql, /member_id_bidx = \$1/);
  assert.doesNotMatch(sql, /select[^;]*member_id_prefix_bidx as value/);
});

test('policy spread: limit is integer-clamped in the BOUND VALUE, bounding the scan not the syntax', () => {
  // The clamp is a resource bound and now lands in params[1], not in the SQL text.
  assert.equal(buildQualifyPolicySpreadQuery('t', 'prefix', 0).params[1], 1);
  assert.equal(buildQualifyPolicySpreadQuery('t', 'prefix', -5).params[1], 1);
  assert.equal(buildQualifyPolicySpreadQuery('t', 'prefix', 9999).params[1], 200);
  assert.equal(buildQualifyPolicySpreadQuery('t', 'prefix', 7.9).params[1], 7);
});

test('policy query counts IGNORE blanks, so dirty data cannot manufacture a fake "1 of 2"', () => {
  const { sql } = buildQualifyPolicyQuery('tok-abc', 'prefix');
  // count(distinct col) treats '' as a real value; the spread builder filters it with btrim(…) <> ''
  // and the UI treats blank as missing. All three must agree or the chip overclaims ambiguity.
  assert.match(sql, /count\(distinct nullif\(btrim\(employer_norm\), ''\)\)::int as employer_count/);
  assert.match(sql, /count\(distinct nullif\(btrim\(insurance_co\), ''\)\)::int as carrier_count/);
  assert.doesNotMatch(sql, /count\(distinct employer_norm\)/);
  assert.doesNotMatch(sql, /count\(distinct insurance_co\)/);
});

test('payer spread: same ordering as the narrow resolve, so row [0] agrees by construction', () => {
  const ORDER = 'order by count(*) desc, max(payment_received) desc nulls last, primary_payer';
  assert.ok(buildResolvePayerQuery('tok', 'prefix', ENT).sql.includes(ORDER));
  assert.ok(buildResolvePayerSpreadQuery('tok', 'prefix', ENT).sql.includes(ORDER));
});

test('payer spread returns evidence counts and a date — never an amount (admissions_seat parity)', () => {
  const { sql, params } = buildResolvePayerSpreadQuery('tok', 'prefix', ENT);
  assert.match(sql, /count\(\*\)::int as lines/);
  assert.match(sql, /count\(distinct member_id_bidx\)::int as patients/);
  assert.match(sql, /to_char\(max\(payment_received\), 'YYYY-MM-DD'\) as last_payment/);
  // A dollar column here would silently diverge blind and sighted sessions.
  assert.doesNotMatch(sql, /allowed|charge_amount|insurance_payments|billed/);
  // BOUND limit — the value rides params, never the SQL text.
  assert.match(sql, /limit \$3$/);
  assert.doesNotMatch(sql, new RegExp(`limit ${QUALIFY_PAYER_SPREAD_LIMIT}`));
  assert.equal(params[1], 'tok');
  assert.equal(params[2], QUALIFY_PAYER_SPREAD_LIMIT);
});

test('payer spread stays tenant-scoped and refuses an empty scope (fail-closed, not fail-open)', () => {
  const { sql } = buildResolvePayerSpreadQuery('tok', 'prefix', ENT);
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.throws(() => buildResolvePayerSpreadQuery('tok', 'prefix', []));
});
