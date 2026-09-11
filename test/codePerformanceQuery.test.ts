/**
 * Code Performance query builders — hermetic (node:test, no DB). What these lock:
 *   1) every builder normalises cpt_code / revenue_code the same way and keeps loc_suffix,
 *   2) the metric block is sum-over-sum: no avg(), no pct_allowed / pct_paid, tier-gated,
 *   3) the window is business-day (America/Los_Angeles) anchored and computed in SQL,
 *   4) the maturity guard filters on the `e` column (the spec's max(e)-in-FILTER is a 42803),
 *   5) user values reach SQL only as bound params; identifiers are fixed literals,
 *   6) the per-tenant suppression is a STATE with a reason and never leaks a number,
 *   7) "no code reported" has one presentation for the em dash and for NULL,
 *   8) ref.code_description precedence: tenant row wins, global falls back (ORDER BY locked).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CODE_PERF_WINDOWS,
  CODE_PERF_WINDOW_KEYS,
  CODE_PERF_DEFAULT_WINDOW,
  CODE_PERF_MATURITY_DAYS,
  CODE_PERF_MATURED_SHARE_FLOOR,
  CODE_PERF_FACILITY_MIN_CHARGES,
  CODE_PERF_FRESHNESS_LOOKBACK_DAYS,
  CODE_PERF_MAX_FACILITIES,
  CODE_PERF_RELIABLE_TIERS,
  CODE_PERF_FLAG_THRESHOLDS,
  CODE_PERF_SUPPRESSION_REASONS,
  HCPCS_NORM_SQL,
  LOC_SUFFIX_SQL,
  REVCODE_NORM_SQL,
  NO_PROCEDURE_CODE_LABEL,
  NO_REVENUE_CODE_LABEL,
  NO_PROCEDURE_CODE_MARKER,
  resolveCodePerfWindow,
  sanitizeCodePerfFacilities,
  sanitizeCodePerfPairKey,
  buildCodePerfPairingQuery,
  buildCodePerfWindowSummaryQuery,
  buildCodePerfPayerQuery,
  buildCodePerfFacilityQuery,
  buildCodePerfMonthlyQuery,
  buildCodePerfFacilityOptionsQuery,
  buildCodePerfFreshnessQuery,
  buildCodeDescriptionQuery,
  shapeTenantGatedMetrics,
  describeCodeSlot,
  deriveCodePerfFlags,
  isImmatureWindow,
  shapeCodePerfPairingRow,
  toNum,
  type CodePerfScope,
} from '../src/collections/codePerformanceQuery.js';

const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const INDIGO = '141d459c-f371-4229-9a92-ace198e940bb';
const SCOPE: CodePerfScope = { entityId: BXR, windowDays: 180, facilities: null };
const PAIR = { hcpcs: 'H2013', locSuffix: 'IOP', revcode: '0913' };

const BUSINESS_TODAY = "(now() at time zone 'America/Los_Angeles')::date";
const TIER_GATE = "allowed_tier in ('a', 'cd', 'e1')";

function allBuilderSql(): Array<[string, string]> {
  return [
    ['pairing', buildCodePerfPairingQuery(SCOPE).sql],
    ['summary', buildCodePerfWindowSummaryQuery(SCOPE).sql],
    ['payer', buildCodePerfPayerQuery(SCOPE, PAIR).sql],
    ['facility', buildCodePerfFacilityQuery(SCOPE, PAIR).sql],
    ['monthly', buildCodePerfMonthlyQuery(SCOPE).sql],
    ['monthly-pair', buildCodePerfMonthlyQuery(SCOPE, PAIR).sql],
    ['facility-options', buildCodePerfFacilityOptionsQuery(SCOPE).sql],
    ['freshness', buildCodePerfFreshnessQuery(BXR).sql],
    ['descriptions', buildCodeDescriptionQuery(BXR).sql],
  ];
}

// ---------------------------------------------------------------------------------------------
// Input clamps
// ---------------------------------------------------------------------------------------------

test('window: the five presets resolve to their day counts; anything else falls back to 6mo', () => {
  // Set changed 2026-09-11 (Alec): 30d dropped, 45d and 1yr added. See the maturity-boundary test
  // below for why 45d can never contain a matured charge — and why that is accepted rather than a
  // defect.
  assert.deepEqual(CODE_PERF_WINDOWS, { '45d': 45, '60d': 60, '90d': 90, '6mo': 180, '1yr': 365 });
  assert.equal(CODE_PERF_DEFAULT_WINDOW, '6mo');
  for (const k of ['45d', '60d', '90d', '6mo', '1yr'] as const) assert.equal(resolveCodePerfWindow(k), k);
  // Render order IS the object order — WindowSelector maps CODE_PERF_WINDOW_KEYS — so ascending
  // order is a UI contract, not a formatting preference.
  assert.deepEqual(CODE_PERF_WINDOW_KEYS, ['45d', '60d', '90d', '6mo', '1yr']);
  // A RETIRED key must fall back, not resolve: anything holding a stale '30d' (a bookmark, a
  // persisted preference) lands on the default rather than erroring or silently querying 30 days.
  assert.equal(resolveCodePerfWindow('30d'), '6mo');
  assert.equal(resolveCodePerfWindow('12mo'), '6mo');
  assert.equal(resolveCodePerfWindow(''), '6mo');
  assert.equal(resolveCodePerfWindow(45), '6mo');
  assert.equal(resolveCodePerfWindow(undefined), '6mo');
  // A non-string whose toString() is a VALID key must still be rejected — the guard is a typeof
  // check, not a coercion. (This used to pass '30d', which stopped proving anything once that key
  // was retired: it would now fall back for the wrong reason.)
  assert.equal(resolveCodePerfWindow({ toString: () => '45d' }), '6mo');
});

test('facilities: null means ALL; blanks and non-strings drop; trimmed, de-duped, capped; never []', () => {
  assert.equal(sanitizeCodePerfFacilities(undefined), null);
  assert.equal(sanitizeCodePerfFacilities('NASHVILLE MENTAL HEALTH LLC'), null);
  assert.equal(sanitizeCodePerfFacilities([]), null);
  assert.equal(sanitizeCodePerfFacilities(['', '   ', 42, null]), null);
  assert.deepEqual(sanitizeCodePerfFacilities(['  No Facility ', 'No Facility', 'TELEHEALTH MH LLC']), [
    'No Facility',
    'TELEHEALTH MH LLC',
  ]);
  const many = Array.from({ length: CODE_PERF_MAX_FACILITIES + 50 }, (_, i) => `F${i}`);
  assert.equal(sanitizeCodePerfFacilities(many)?.length, CODE_PERF_MAX_FACILITIES);
  assert.equal(sanitizeCodePerfFacilities(['x'.repeat(201)]), null);
});

test('pair key: trims, upper-cases, blank → null, length-bounded, tolerates garbage', () => {
  assert.deepEqual(sanitizeCodePerfPairKey({ hcpcs: ' h2013 ', locSuffix: 'iop', revcode: '0913' }), {
    hcpcs: 'H2013',
    locSuffix: 'IOP',
    revcode: '0913',
  });
  assert.deepEqual(sanitizeCodePerfPairKey({ hcpcs: '—', locSuffix: '', revcode: null }), {
    hcpcs: '—',
    locSuffix: null,
    revcode: null,
  });
  assert.deepEqual(sanitizeCodePerfPairKey(null), { hcpcs: null, locSuffix: null, revcode: null });
  assert.deepEqual(sanitizeCodePerfPairKey({ hcpcs: 'x'.repeat(13) }), { hcpcs: null, locSuffix: null, revcode: null });
});

// ---------------------------------------------------------------------------------------------
// Invariants over EVERY builder
// ---------------------------------------------------------------------------------------------

test('every builder: no select *, no avg(), never reads pct_allowed / pct_paid, never uses UTC now()', () => {
  for (const [name, sql] of allBuilderSql()) {
    assert.ok(!/select\s+\*/i.test(sql), `${name}: select *`);
    assert.ok(!/\bavg\s*\(/i.test(sql), `${name}: avg()`);
    assert.ok(!/pct_allowed|pct_paid/.test(sql), `${name}: reads a per-charge ratio column`);
    assert.ok(!/current_date|now\(\)::date|\bnow\(\)\s*-/.test(sql), `${name}: UTC-anchored date arithmetic`);
    // An ungrouped aggregate over an EMPTY base divides by zero; every count denominator is guarded
    // (Qodo #346 finding 3). `count(*)::int as charges` is not a division and does not match.
    assert.ok(!/\/\s*count\(\*\)/.test(sql), `${name}: a bare count(*) denominator (22012 on an empty base)`);
  }
});

test('window: a trailing N-day window is N civil dates ENDING today — [today − N + 1, today], the businessWindow.ts trailing contract', () => {
  // src/businessWindow.ts: to = today + 1, from = to − days → exactly `days` dates including today.
  // The first draft's `today − N` start was N + 1 dates: "30d" covered 31 days (Qodo #346 finding 4).
  const windowed = allBuilderSql().filter(([n]) => !['freshness', 'descriptions'].includes(n));
  assert.equal(windowed.length, 7, 'six base-CTE builders plus the facility vocabulary');
  for (const [name, sql] of windowed) {
    assert.ok(sql.includes(`${BUSINESS_TODAY} - $2::int + 1`), `${name}: start is today − N + 1`);
    assert.ok(!/- \$2::int(?! \+ 1)/.test(sql), `${name}: no today − N start anywhere`);
  }
});

test('every windowed builder: normalisation on read, tenant param, business-day window, facility param', () => {
  const windowed = allBuilderSql().filter(([n]) => !['facility-options', 'freshness', 'descriptions'].includes(n));
  assert.equal(windowed.length, 6);
  for (const [name, sql] of windowed) {
    assert.ok(sql.includes(HCPCS_NORM_SQL), `${name}: hcpcs normalisation`);
    assert.ok(sql.includes(LOC_SUFFIX_SQL), `${name}: loc_suffix kept`);
    assert.ok(sql.includes(REVCODE_NORM_SQL), `${name}: revcode lpad`);
    assert.ok(sql.includes('r.business_entity_id = $1::uuid'), `${name}: tenant param`);
    assert.ok(sql.includes(`${BUSINESS_TODAY} - $2::int + 1 as s`), `${name}: window start (N dates ending today)`);
    assert.ok(sql.includes('r.charge_date >= w.s and r.charge_date < w.e + 1'), `${name}: half-open window`);
    assert.ok(sql.includes('($3::text[] is null or r.facility = any($3::text[]))'), `${name}: facility param`);
  }
});

test('normalisation literals are exactly the spec\'s expressions', () => {
  assert.equal(HCPCS_NORM_SQL, "regexp_replace(nullif(btrim(r.cpt_code), ''), '(IOP|PHP|RTC|UHC)$', '')");
  assert.equal(LOC_SUFFIX_SQL, "substring(nullif(btrim(r.cpt_code), '') from '(IOP|PHP|RTC|UHC)$')");
  assert.equal(REVCODE_NORM_SQL, "lpad(nullif(btrim(r.revenue_code), ''), 4, '0')");
});

// ---------------------------------------------------------------------------------------------
// The metric block
// ---------------------------------------------------------------------------------------------

test('metrics: sum-over-sum with the reliable-tier gate, unclamped paid_of_allowed, maturity on the e column', () => {
  const { sql } = buildCodePerfPairingQuery(SCOPE);
  assert.deepEqual([...CODE_PERF_RELIABLE_TIERS], ['a', 'cd', 'e1']);
  assert.ok(sql.includes(`sum(allowed_reliable) filter (where ${TIER_GATE})`), 'allowed_rate numerator gated');
  assert.ok(sql.includes(`nullif(sum(charge_amount) filter (where ${TIER_GATE}), 0)`), 'allowed_rate denominator gated');
  assert.ok(sql.includes(`count(*) filter (where ${TIER_GATE}) / nullif(count(*), 0)`), 'allowed_coverage, guarded denominator');
  assert.ok(
    sql.includes(`sum(insurance_payments) filter (where ${TIER_GATE} and allowed_reliable > 0)`),
    'paid_of_allowed numerator gated + allowed > 0',
  );
  assert.ok(!/least\s*\(\s*100/i.test(sql) && !/greatest\s*\(\s*100/i.test(sql), 'paid_of_allowed is NOT clamped');
  assert.ok(
    sql.includes(`sum(greatest(allowed_reliable - coalesce(insurance_payments, 0), 0))\n        filter (where ${TIER_GATE} and payment_received is not null)`),
    'underpaid_dollars over posted gated charges; a NULL payment total is $0 paid, not an excluded row',
  );
  assert.ok(!sql.includes('allowed_reliable - insurance_payments,'), 'no un-coalesced payment inside the underpaid arithmetic');
  assert.ok(sql.includes('percentile_cont(0.5) within group'), 'days_p50');
  assert.ok(sql.includes('percentile_cont(0.9) within group'), 'days_p90');
  assert.ok(sql.includes('case when payment_received >= charge_date then payment_received - charge_date end'));
  assert.ok(sql.includes('count(*) filter (where coalesce(insurance_payments, 0) = 0) / nullif(count(*), 0)'), 'pct_zero_paid');
  assert.ok(sql.includes('sum(adjustments) / nullif(sum(charge_amount), 0)'), 'write_off_rate');
  assert.ok(sql.includes('sum(patient_balance_due) / nullif(sum(charge_amount), 0)'), 'patient_balance_rate');
  assert.equal(CODE_PERF_MATURITY_DAYS, 45);
  assert.ok(sql.includes(`count(*) filter (where charge_date <= e - ${CODE_PERF_MATURITY_DAYS}) / nullif(count(*), 0)`), 'matured_share');
  assert.ok(!sql.includes('max(e) - 45'), 'the spec\'s aggregate-inside-FILTER shape is NOT emitted');
});

test('pairing: grain, payer concentration, facility spread with the 30-charge floor, NULL-safe joins, fixed order', () => {
  const q = buildCodePerfPairingQuery(SCOPE);
  assert.deepEqual(q.params, [BXR, 180, null]);
  assert.ok(q.sql.includes('group by hcpcs, loc_suffix, revcode'));
  assert.ok(q.sql.includes('count(distinct payer_raw)::int'));
  assert.ok(q.sql.includes('count(distinct facility)::int'));
  // The top payer is an IDENTIFIED payer: the NULL bucket stays in the denominator (real dollars) but
  // can never be the numerator, so missing attribution reads as LOW concentration (Qodo #346 f10).
  assert.match(
    q.sql,
    /max\(billed\) filter \(where payer_raw is not null\)\s*\/ nullif\(sum\(billed\), 0\), 1\)\s+as payer_concentration/,
    'payer_concentration numerator excludes the unknown-payer bucket',
  );
  assert.equal(CODE_PERF_FACILITY_MIN_CHARGES, 30);
  assert.ok(q.sql.includes(`having count(*) >= ${CODE_PERF_FACILITY_MIN_CHARGES}`), 'facility floor');
  // One rated facility is not a variation: the spread is NULL (unavailable), never 0 (Qodo #346 f8).
  assert.match(
    q.sql,
    /case when count\(\*\) >= 2 then round\(max\(allowed_rate\) - min\(allowed_rate\), 2\) end\s+as facility_spread/,
    'facility_spread needs two rated facilities',
  );
  assert.ok(q.sql.includes('count(*)::int                                                    as facilities_rated'), 'facilities_rated rides along so the UI can say why');
  assert.equal((q.sql.match(/is not distinct from/g) ?? []).length, 6, 'both joins NULL-safe on all three keys');
  assert.ok(q.sql.includes('(max(e) - max(charge_date))::int                                 as days_idle'));
  assert.ok(q.sql.trimEnd().endsWith('order by p.billed desc, p.hcpcs nulls last, p.loc_suffix nulls last, p.revcode nulls last'));
  assert.ok(!/\$[4-9]/.test(q.sql), 'exactly three params');
});

test('window summary: one row with window bounds, no-code counts on both slots, and the window-level maturity', () => {
  const q = buildCodePerfWindowSummaryQuery(SCOPE);
  assert.deepEqual(q.params, [BXR, 180, null]);
  assert.ok(q.sql.includes('max(s)                                                             as window_start'));
  assert.ok(q.sql.includes('max(e)                                                             as window_end'));
  assert.ok(q.sql.includes("count(*) filter (where hcpcs is null or hcpcs = '—')::int          as no_procedure_code_charges"));
  assert.ok(q.sql.includes('count(*) filter (where revcode is null)::int                       as no_revenue_code_charges'));
  assert.ok(q.sql.includes('count(distinct (hcpcs, loc_suffix, revcode))::int'));
  assert.ok(q.sql.includes('as matured_share'));
  assert.ok(!/group by/.test(q.sql), 'window summary is ungrouped');
});

// ---------------------------------------------------------------------------------------------
// Drill-downs
// ---------------------------------------------------------------------------------------------

test('payer + facility drill-downs: pair key rides as three NULL-safe text params after the scope', () => {
  for (const q of [buildCodePerfPayerQuery(SCOPE, PAIR), buildCodePerfFacilityQuery(SCOPE, PAIR)]) {
    assert.deepEqual(q.params, [BXR, 180, null, 'H2013', 'IOP', '0913']);
    assert.ok(q.sql.includes('hcpcs is not distinct from $4::text'));
    assert.ok(q.sql.includes('loc_suffix is not distinct from $5::text'));
    assert.ok(q.sql.includes('revcode is not distinct from $6::text'));
    assert.ok(!/\$[7-9]/.test(q.sql));
  }
  const nulls = buildCodePerfPayerQuery(SCOPE, { hcpcs: null, locSuffix: null, revcode: null });
  assert.deepEqual(nulls.params.slice(3), [null, null, null], 'a NULL-keyed pairing is addressable');
});

test('payer level: grouped by the RAW payer string, share of the pairing\'s billed, billed desc', () => {
  const { sql } = buildCodePerfPayerQuery(SCOPE, PAIR);
  assert.ok(sql.includes('group by s.payer_raw'));
  assert.ok(sql.includes('round(100.0 * sum(s.charge_amount) / nullif(max(t.billed), 0), 1)  as share_of_billed'));
  assert.ok(sql.trimEnd().endsWith('order by billed desc, s.payer_raw nulls last'));
  assert.ok(!/payer_alias|payer_identity/.test(sql), 'no alias resolution — out of scope, raw strings only');
});

test('facility level: EVERY facility returned with a rated flag — the core splits and counts — rated first, then by allowed_rate', () => {
  // The excluded count used to ride on the rated rows as a scalar subquery, so it vanished with them
  // when no facility reached the floor (Qodo #346 f7). The rows carry `rated`; the count is derived
  // from the same rows in core.ts (see app/test/codePerformanceCore.test.tsx).
  const { sql } = buildCodePerfFacilityQuery(SCOPE, PAIR);
  assert.ok(sql.includes(`(charges >= ${CODE_PERF_FACILITY_MIN_CHARGES})                     as rated`), 'rated flag on every row');
  assert.ok(!/where charges >= /.test(sql), 'no SQL-side floor: the excluded count must survive an empty rated set');
  assert.ok(!/below_floor/.test(sql), 'no scalar-subquery count riding on rows that may not exist');
  assert.ok(sql.trimEnd().endsWith('order by rated desc, allowed_rate desc nulls last, billed desc, facility nulls last'));
});

test('monthly: date_trunc month series with allowed_rate + matured_share; pair filter is optional', () => {
  const whole = buildCodePerfMonthlyQuery(SCOPE);
  assert.deepEqual(whole.params, [BXR, 180, null]);
  assert.ok(whole.sql.includes("date_trunc('month', charge_date)::date"));
  assert.ok(whole.sql.includes('as matured_share'));
  assert.ok(whole.sql.includes('as allowed_rate'));
  assert.ok(!whole.sql.includes('$4'), 'no pair predicate without a pair');
  assert.ok(/group by 1\norder by 1$/.test(whole.sql.trimEnd()));
  const one = buildCodePerfMonthlyQuery(SCOPE, PAIR);
  assert.deepEqual(one.params, [BXR, 180, null, 'H2013', 'IOP', '0913']);
  assert.ok(one.sql.includes('where hcpcs is not distinct from $4::text'));
});

test('facility options: tenant + window only, ignores the facility filter, keeps "No Facility" as a value', () => {
  const q = buildCodePerfFacilityOptionsQuery({ ...SCOPE, facilities: ['TELEHEALTH MH LLC'] });
  assert.deepEqual(q.params, [BXR, 180], 'the facility filter never reaches the vocabulary query');
  assert.ok(q.sql.includes('group by r.facility'));
  assert.ok(!q.sql.includes('$3'));
  assert.ok(!/No Facility|where .*facility\s*<>/.test(q.sql), 'nothing is hardcoded or excluded');
});

test('freshness: ONE tenant by interface — a single uuid param, no any(uuid[]) — maxima + future-payment count, bounded lookback', () => {
  // The first draft accepted uuid[] and read `= any($1::uuid[])`: a cross-tenant read shape with no
  // reviewed-exception comment, and no caller ever passed more than one id (Qodo #346 rule f1). The
  // interface now cannot express a multi-tenant read at all.
  const q = buildCodePerfFreshnessQuery(BXR);
  assert.deepEqual(q.params, [BXR]);
  assert.ok(q.sql.includes('where r.business_entity_id = $1::uuid'), 'single-tenant predicate');
  assert.ok(!/any\(\$1::uuid\[\]\)|uuid\[\]/.test(q.sql), 'no array predicate anywhere');
  assert.ok(q.sql.includes('max(r.ingested_at)'));
  assert.ok(q.sql.includes('max(r.charge_date)'));
  assert.ok(q.sql.includes(`count(*) filter (where r.payment_received > ${BUSINESS_TODAY})::int`));
  assert.ok(q.sql.includes(`r.charge_date >= ${BUSINESS_TODAY} - ${CODE_PERF_FRESHNESS_LOOKBACK_DAYS}`));
  assert.ok(q.sql.includes('group by r.business_entity_id'));
  assert.throws(() => buildCodePerfFreshnessQuery(''), /canonical business_entity_id/);
  assert.throws(() => buildCodePerfFreshnessQuery('not-a-uuid'), /canonical business_entity_id/);
});

test('descriptions: distinct-on precedence — tenant row wins, global falls back, no other tenant admitted', () => {
  const q = buildCodeDescriptionQuery(INDIGO);
  assert.deepEqual(q.params, [INDIGO]);
  assert.ok(q.sql.startsWith('select distinct on (code_type, code)'));
  assert.ok(q.sql.includes('where business_entity_id is null or business_entity_id = $1::uuid'));
  // THE contract from 038's PRECEDENCE block — locked verbatim.
  assert.ok(q.sql.trimEnd().endsWith('order by code_type, code, business_entity_id nulls last'));
  assert.ok(q.sql.includes('(business_entity_id is not null)                                   as tenant_override'));
  for (const col of ['short_label', 'long_description', 'prior_description', 'source_citation', 'provenance', 'needs_review', 'description_conflict']) {
    assert.ok(q.sql.includes(col), `projects ${col}`);
  }
  assert.throws(() => buildCodeDescriptionQuery('bogus'), /canonical business_entity_id/);
});

// ---------------------------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------------------------

test('scope: a malformed or missing tenant throws before any SQL is built; a bad day count falls back to 180', () => {
  assert.throws(() => buildCodePerfPairingQuery({ ...SCOPE, entityId: '' }), /canonical business_entity_id/);
  assert.throws(() => buildCodePerfPairingQuery({ ...SCOPE, entityId: 'x' }), /canonical business_entity_id/);
  assert.deepEqual(buildCodePerfPairingQuery({ ...SCOPE, windowDays: 0 }).params, [BXR, 180, null]);
  assert.deepEqual(buildCodePerfPairingQuery({ ...SCOPE, windowDays: 400 }).params, [BXR, 180, null]);
  assert.deepEqual(buildCodePerfPairingQuery({ ...SCOPE, windowDays: 30.5 }).params, [BXR, 180, null]);
  assert.deepEqual(buildCodePerfPairingQuery({ ...SCOPE, windowDays: 30, facilities: ['A', 'B'] }).params, [BXR, 30, ['A', 'B']]);
});

// ---------------------------------------------------------------------------------------------
// Shaping — suppression, no-code presentation, flags, pg coercion
// ---------------------------------------------------------------------------------------------

test('suppression is a STATE with a reason: BXR drops write_off_rate, Indigo suppresses patient_balance_rate', () => {
  const raw = { write_off_rate: '31.20', patient_balance_rate: '4.10' };
  const bxr = shapeTenantGatedMetrics(BXR, raw);
  assert.deepEqual(bxr.write_off_rate, { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff });
  assert.deepEqual(bxr.patient_balance_rate, { state: 'available', value: 4.1 });
  assert.ok(!('value' in bxr.write_off_rate), 'a suppressed metric carries NO number');
  const indigo = shapeTenantGatedMetrics(INDIGO, raw);
  assert.deepEqual(indigo.write_off_rate, { state: 'available', value: 31.2 });
  assert.deepEqual(indigo.patient_balance_rate, { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance });
  const other = shapeTenantGatedMetrics('00000000-0000-4000-8000-000000000000', raw);
  assert.equal(other.write_off_rate.state, 'suppressed');
  assert.equal(other.patient_balance_rate.state, 'suppressed');
  for (const reason of Object.values(CODE_PERF_SUPPRESSION_REASONS)) assert.ok(reason.length > 40, 'a reason is a sentence, not a token');
});

test('no-code presentation: the em dash and a NULL share one label family, one flag, one helper', () => {
  assert.equal(NO_PROCEDURE_CODE_MARKER, '—');
  const dash = describeCodeSlot('procedure', '—');
  const nul = describeCodeSlot('procedure', null);
  assert.equal(dash.label, NO_PROCEDURE_CODE_LABEL);
  assert.equal(nul.label, NO_PROCEDURE_CODE_LABEL);
  assert.equal(dash.noCode, true);
  assert.equal(nul.noCode, true);
  assert.equal(dash.lookupCode, '—', 'the em dash HAS a 038 row to look up');
  assert.equal(nul.lookupCode, null);
  assert.deepEqual(describeCodeSlot('procedure', 'H0018'), { label: 'H0018', noCode: false, lookupCode: 'H0018' });
  assert.deepEqual(describeCodeSlot('revenue', null), { label: NO_REVENUE_CODE_LABEL, noCode: true, lookupCode: null });
  assert.deepEqual(describeCodeSlot('revenue', '0913'), { label: '0913', noCode: false, lookupCode: '0913' });
  assert.notEqual(NO_PROCEDURE_CODE_LABEL, NO_REVENUE_CODE_LABEL);
  assert.ok(NO_PROCEDURE_CODE_LABEL.startsWith('No ') && NO_REVENUE_CODE_LABEL.startsWith('No '), 'one wording family');
});

test('038 seed cross-check: the em dash row\'s short_label IS the helper\'s label (they cannot drift)', () => {
  const sql = readFileSync(join(process.cwd(), 'SQL Schemas', '038_ref_code_description.sql'), 'utf8');
  assert.ok(sql.includes(`('OTHER', '${NO_PROCEDURE_CODE_MARKER}', '${NO_PROCEDURE_CODE_LABEL}'`));
  assert.ok(sql.includes('order by code_type, code, business_entity_id nulls last'), '038 documents the same ORDER BY the builder emits');
});

test('flags: thresholds fire at their documented boundaries and nowhere else', () => {
  const base = {
    hcpcs: 'H0018', revcode: '1001', allowed_coverage: 80, matured_share: 90,
    days_idle: 3, paid_of_allowed: 95, pct_zero_paid: 5, facility_spread: 10,
  };
  assert.deepEqual(deriveCodePerfFlags(base), []);
  assert.deepEqual(deriveCodePerfFlags({ ...base, hcpcs: '—' }), ['no_procedure_code']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, hcpcs: null }), ['no_procedure_code']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, revcode: null }), ['no_revenue_code']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, hcpcs: 'INT' }), ['not_clinical']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, hcpcs: 'INTRST' }), ['not_clinical']);
  const t = CODE_PERF_FLAG_THRESHOLDS;
  assert.deepEqual(deriveCodePerfFlags({ ...base, allowed_coverage: t.allowedCoverageUnreliableBelowPct - 0.1 }), ['allowed_unreliable']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, allowed_coverage: t.allowedCoverageUnreliableBelowPct }), []);
  assert.deepEqual(deriveCodePerfFlags({ ...base, matured_share: CODE_PERF_MATURED_SHARE_FLOOR * 100 - 0.1 }), ['immature_window']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, matured_share: CODE_PERF_MATURED_SHARE_FLOOR * 100 }), []);
  assert.deepEqual(deriveCodePerfFlags({ ...base, days_idle: t.dormantIdleDays }), ['dormant']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, days_idle: t.dormantIdleDays - 1 }), []);
  assert.deepEqual(deriveCodePerfFlags({ ...base, paid_of_allowed: t.paidOverAllowedPct + 0.01 }), ['paid_over_allowed']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, paid_of_allowed: t.paidOverAllowedPct }), [], '100% exactly is not overpayment');
  assert.deepEqual(deriveCodePerfFlags({ ...base, pct_zero_paid: t.highZeroPaidPct }), ['high_zero_paid']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, pct_zero_paid: t.highZeroPaidPct - 0.1 }), []);
  assert.deepEqual(deriveCodePerfFlags({ ...base, facility_spread: t.wideFacilitySpreadPts }), ['wide_facility_spread']);
  assert.deepEqual(deriveCodePerfFlags({ ...base, facility_spread: t.wideFacilitySpreadPts - 0.01 }), []);
  assert.deepEqual(
    deriveCodePerfFlags({ hcpcs: null, revcode: null, allowed_coverage: null, matured_share: null, days_idle: null, paid_of_allowed: null, pct_zero_paid: null, facility_spread: null }),
    ['no_procedure_code', 'no_revenue_code'],
    'NULL metrics never fire a threshold flag',
  );
});

test('maturity guard: 60% is the floor on the 0–100 scale SQL returns; unknown is immature', () => {
  assert.equal(CODE_PERF_MATURED_SHARE_FLOOR, 0.6);
  assert.equal(isImmatureWindow(null), true);
  assert.equal(isImmatureWindow(59.9), true);
  assert.equal(isImmatureWindow(60), false);
  assert.equal(isImmatureWindow(100), false);
});

test('toNum: pg strings become numbers; null, blank, garbage and non-finite become null', () => {
  assert.equal(toNum('15'), 15);
  assert.equal(toNum('8346082.00'), 8346082);
  assert.equal(toNum(12.5), 12.5);
  assert.equal(toNum(null), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum(''), null);
  assert.equal(toNum('abc'), null);
  assert.equal(toNum(Number.NaN), null);
  assert.equal(toNum(Number.POSITIVE_INFINITY), null);
  assert.equal(toNum({}), null);
});

test('shapeCodePerfPairingRow: pg-shaped row → typed row with coerced numbers, ISO dates, ruling applied, flags derived', () => {
  const raw = {
    hcpcs: 'H2013', loc_suffix: 'IOP', revcode: '0913', payers: '4', facilities: '3',
    charges: '1185', billed: '4987615.00', collected: '2101000.50', allowed_coverage: '93.9',
    allowed_rate: '44.10', paid_of_allowed: '101.20', underpaid_dollars: '12000.00',
    days_p50: 31, days_p90: 88.5, pct_zero_paid: '21.0', write_off_rate: '30.00',
    patient_balance_rate: null, matured_share: '58.0', first_seen: new Date('2026-03-12T00:00:00Z'),
    last_seen: '2026-09-01', days_idle: '7', payer_concentration: '61.0', facilities_rated: '3',
    facility_spread: '26.50', unexpected_column: 'ignored',
  };
  const row = shapeCodePerfPairingRow(raw, INDIGO);
  assert.equal(row.charges, 1185);
  assert.equal(row.billed, 4987615);
  assert.equal(row.collected, 2101000.5);
  assert.equal(row.paid_of_allowed, 101.2, 'unclamped');
  assert.equal(row.first_seen, '2026-03-12');
  assert.equal(row.last_seen, '2026-09-01');
  assert.deepEqual(row.write_off_rate, { state: 'available', value: 30 });
  assert.equal(row.patient_balance_rate.state, 'suppressed');
  assert.deepEqual(row.flags, ['immature_window', 'paid_over_allowed', 'high_zero_paid', 'wide_facility_spread']);
  assert.ok(!('unexpected_column' in row));
  const bxr = shapeCodePerfPairingRow({ ...raw, hcpcs: '—', revcode: null, write_off_rate: '99.9' }, BXR);
  assert.equal(bxr.write_off_rate.state, 'suppressed');
  assert.ok(!('value' in bxr.write_off_rate), 'BXR write_off value is DISCARDED, not hidden');
  assert.ok(bxr.flags.includes('no_procedure_code') && bxr.flags.includes('no_revenue_code'));
});


test('maturity boundary: 45d is immature-ONLY, and 46 is the first preset that is not', () => {
  // ⚠ THIS ENCODES AN OFF-BY-ONE THAT WAS ASSERTED BACKWARDS FIRST. The original comment on
  // CODE_PERF_WINDOWS claimed 45d was "the first window whose charges can have matured". It is the
  // LAST window whose charges can never have matured, because the two ranges are computed from
  // opposite ends:
  //
  //   window   [today - N + 1, today]                    → earliest = today - N + 1
  //   matured  charge_date <= today - CODE_PERF_MATURITY_DAYS
  //
  // so a preset contains matured dates only when N >= CODE_PERF_MATURITY_DAYS + 1.
  const firstMatureCapable = CODE_PERF_MATURITY_DAYS + 1;
  assert.equal(firstMatureCapable, 46, 'maturity is 45 days, so 46 is the smallest capable preset');

  const canContainMatured = (n: number) => -n + 1 <= -CODE_PERF_MATURITY_DAYS;

  // 45d is immature-only — ACCEPTED, ruled by Alec 2026-09-11 after measurement. It is the same
  // property the 30d preset it replaced had, so nothing regressed; the KPI grid treats an immature
  // window as a first-class state. Asserted so a later edit cannot quietly reintroduce the claim
  // that 45d reports yield.
  assert.equal(canContainMatured(45), false, '45d must be immature-only');
  assert.equal(canContainMatured(30), false, 'the 30d it replaced had the same property');

  // Every OTHER preset must be yield-capable — that is the line 45d sits just below.
  for (const key of CODE_PERF_WINDOW_KEYS) {
    const days = CODE_PERF_WINDOWS[key];
    if (days === 45) continue;
    assert.equal(canContainMatured(days), true, `${key} (${days}d) must be able to report yield`);
  }
});
