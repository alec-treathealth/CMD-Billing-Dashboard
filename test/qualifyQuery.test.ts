import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import {
  buildResolvePayerQuery,
  buildFacilityRankingQuery,
  buildCasesQuery,
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
    buildCasesQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
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
    buildCasesQuery('AETNA', '2026-06-17', '2026-07-17', BOTH),
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
  assert.throws(() => buildCasesQuery('X', '2026-01-01', '2026-02-01', []), /entityIds required/);
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

// ── buildCasesQuery: distinct patients, opaque token never projected, program := care_setting. ───
test('buildCasesQuery: 15 distinct patients, reveal id, program from care_setting, token stays server-side', () => {
  const { sql, params } = buildCasesQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  assert.match(sql, /group by member_id_bidx/, 'distinct patients keyed on the blind index');
  assert.match(sql, /array_agg\(id order by payment_received desc/, 'latest-charge id for the audited reveal');
  assert.match(sql, /care_setting\) as program/, 'program := resolved care_setting (Q-D)');
  assert.ok(!/agg\.member_id_bidx/.test(sql), 'opaque token is NOT projected to the caller');
  assert.match(sql, /order by agg\.last_payment desc nulls last/, 'recency = max(payment_received)');
  assert.equal(params[4], QUALIFY_CASES_LIMIT, 'defaults to 15 cases');
  assert.deepEqual(params.slice(0, 4), [BOTH, 'AETNA', '2026-06-17', '2026-07-17']);
});

// ── buildFacilityCasesQuery: buildCasesQuery + one raw-facility-text predicate, same grain/limit. ─
test('buildFacilityCasesQuery: adds a bound raw-facility predicate, keeps distinct-patient grain + 15 cap', () => {
  const { sql, params } = buildFacilityCasesQuery('AETNA', '405 recovery', '2026-06-17', '2026-07-17', BOTH);
  // The ONLY new axis vs buildCasesQuery: an equality on the RAW facility text, as a bound param.
  assert.match(sql, /primary_payer = \$2 and facility = \$3/, 'raw facility text is a bound predicate');
  assert.equal(params[2], '405 recovery', 'facility bound as $3 (raw text, never interpolated)');
  // Same discipline as buildCasesQuery: distinct patients, reveal id, opaque token never projected.
  assert.match(sql, /group by member_id_bidx/, 'distinct patients keyed on the blind index');
  assert.match(sql, /array_agg\(id order by payment_received desc/, 'latest-charge id for the audited reveal');
  assert.ok(!/agg\.member_id_bidx/.test(sql), 'opaque token is NOT projected to the caller');
  assert.match(sql, /care_setting\) as program/, 'program := resolved care_setting');
  assert.match(sql, /order by agg\.last_payment desc nulls last/, 'recency = max(payment_received)');
  assert.equal(params[5], QUALIFY_CASES_LIMIT, 'defaults to 15 cases');
  assert.deepEqual(params.slice(0, 5), [BOTH, 'AETNA', '405 recovery', '2026-06-17', '2026-07-17']);
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
