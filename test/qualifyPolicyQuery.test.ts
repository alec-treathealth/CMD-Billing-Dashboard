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


test('ranking with payer=null and NO market narrow throws at the builder chokepoint (finding #5)', () => {
  assert.throws(() => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, {}), /market narrow/);
  assert.throws(() => buildFacilityRankingQuery(null, '2026-05-01', '2026-08-01', ENT, { employers: [] }), /market narrow/);
});

// ── The SPREAD builders (2026-08-06): the widening that stops a single mode() standing in for a
// population. See the builders' headers for the measurements that motivated them.

test('policy spread: both dims, token bound once and reused, capped per branch', () => {
  const { sql, params } = buildQualifyPolicySpreadQuery('tok-abc', 'prefix');
  assert.equal(params.length, 1);
  assert.equal(params[0], 'tok-abc');
  // ONE bound param serving both UNION branches — not two copies of the token.
  assert.equal((sql.match(/\$1/g) || []).length, 2);
  assert.match(sql, /'employer'::text as dim/);
  assert.match(sql, /'carrier'::text as dim/);
  assert.match(sql, /union all/);
  assert.match(sql, /member_id_prefix_bidx = \$1/);
  // Each branch carries its own LIMIT — an uncapped branch is the 300-employer failure mode.
  assert.equal((sql.match(new RegExp(`limit ${QUALIFY_SPREAD_LIMIT}`, 'g')) || []).length, 2);
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

test('policy spread: limit is integer-clamped, so a caller bug cannot unbound or negate the scan', () => {
  assert.match(buildQualifyPolicySpreadQuery('t', 'prefix', 0).sql, /limit 1\)/);
  assert.match(buildQualifyPolicySpreadQuery('t', 'prefix', -5).sql, /limit 1\)/);
  assert.match(buildQualifyPolicySpreadQuery('t', 'prefix', 9999).sql, /limit 200\)/);
  assert.match(buildQualifyPolicySpreadQuery('t', 'prefix', 7.9).sql, /limit 7\)/);
});

test('policy query projects the TRUE distinct counts — the honesty denominators for the modal chips', () => {
  const { sql } = buildQualifyPolicyQuery('tok-abc', 'prefix');
  assert.match(sql, /count\(distinct employer_norm\)::int as employer_count/);
  assert.match(sql, /count\(distinct insurance_co\)::int as carrier_count/);
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
  assert.match(sql, new RegExp(`limit ${QUALIFY_PAYER_SPREAD_LIMIT}$`));
  assert.equal(params[1], 'tok');
});

test('payer spread stays tenant-scoped and refuses an empty scope (fail-closed, not fail-open)', () => {
  const { sql } = buildResolvePayerSpreadQuery('tok', 'prefix', ENT);
  assert.match(sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.throws(() => buildResolvePayerSpreadQuery('tok', 'prefix', []));
});
