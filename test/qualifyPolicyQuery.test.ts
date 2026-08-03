/**
 * Phase B/E SQL builders — policy resolution + the auto-window rung query. Hermetic string/param
 * assertions in the qualifyQuery.test.ts idiom: fixed identifiers, bound values, and the PHI
 * discipline (tokens matched, never projected; no readable prefix column exists on the matview).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildQualifyPolicyQuery,
  buildQualifyVobFreshnessQuery,
  buildQualifyWindowRungsQuery,
  VOB_MEMBER_BENEFITS_LATEST,
} from '../src/collections/qualifyPolicyQuery';
import { buildFacilityRankingQuery } from '../src/collections/qualifyQuery';

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
  assert.match(sql, /bool_or\(group_number_bidx is not null\) as group_on_file/);
  // The blind indexes are counted / presence-tested / equality-matched — never projected as values.
  const legitimate = sql
    .replace('count(distinct member_id_bidx)::int as member_count', '')
    .replace('bool_or(group_number_bidx is not null) as group_on_file', '')
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
