/**
 * Coding decision registry (Phase A) — payer-family normalization, the factor lookup's preference
 * order, codes-label composition (NO HCPCS is a method, not a missing value), builder param
 * discipline, and lockstep between the src-side lifecycle list and app/lib/qualify/ratingV2's enum.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildCurrentCodingDecisionsQuery,
  buildCodingDecisionHistoryQuery,
  buildInsertCodingDecisionQuery,
  buildSupersedeCodingDecisionQuery,
  buildInsertCodingAuditQuery,
  normalizePayerFamily,
  lookupCodingDecision,
  codingCodesLabel,
  CODING_LIFECYCLE_VALUES,
  type CodingDecisionRow,
} from '../src/collections/codingRegistryQuery';
import { CODING_LIFECYCLES } from '../app/lib/qualify/ratingV2';

test('lifecycle vocabularies stay in lockstep (src literal vs app enum)', () => {
  assert.deepEqual([...CODING_LIFECYCLE_VALUES], [...CODING_LIFECYCLES]);
});

test('normalizePayerFamily: the messy real labels land in the right families', () => {
  assert.equal(normalizePayerFamily('BLUE CROSS BLUE SHIELD OF TEXAS'), 'BCBS');
  assert.equal(normalizePayerFamily('Anthem BCBS (ALL OTHERS)'), 'BCBS');
  assert.equal(normalizePayerFamily('BCBSTX'), 'BCBS');
  assert.equal(normalizePayerFamily('UNITED HEALTHCARE'), 'UHC/UMR/OPTUM');
  assert.equal(normalizePayerFamily('UMR'), 'UHC/UMR/OPTUM');
  assert.equal(normalizePayerFamily('OPTUM BEHAVIORAL HEALTH'), 'UHC/UMR/OPTUM');
  assert.equal(normalizePayerFamily('GEHA'), 'GEHA'); // before the UHC catch-alls
  assert.equal(normalizePayerFamily('MERITAIN HEALTH'), 'MERITAIN'); // before AETNA
  assert.equal(normalizePayerFamily('AETNA'), 'AETNA');
  assert.equal(normalizePayerFamily('CIGNA BEHAVIORAL'), 'CIGNA');
  assert.equal(normalizePayerFamily('HEALTH NET OF CALIFORNIA'), 'HEALTH NET');
  assert.equal(normalizePayerFamily('SOME UNKNOWN PAYER'), null);
  assert.equal(normalizePayerFamily(''), null);
  assert.equal(normalizePayerFamily(null), null);
});

const row = (over: Partial<CodingDecisionRow>): CodingDecisionRow => ({
  id: 1,
  payer_family: 'BCBS',
  payer_variant_label: null,
  plan_alpha: null,
  employer_norm: null,
  level_of_care: null,
  facility_code: null,
  hcpcs_code: 'H0017',
  revenue_code: '0158',
  hcpcs_suppressed: false,
  dos_batch_min: null,
  dos_batch_max: null,
  type_of_bill: null,
  drg_code: null,
  condition_codes: null,
  modifiers_removed: null,
  units_per_dos: null,
  billing_span: null,
  lifecycle: 'CONFIRMED CODES',
  decided_on: '2026-07-01',
  effective_from: '2026-07-01',
  effective_to: null,
  superseded_by: null,
  notes: null,
  ...over,
});

test('lookupCodingDecision: facility+LOC exact beats facility beats payer-wide; family gate first', () => {
  const rows = [
    row({ id: 1, facility_code: null, level_of_care: null }), // payer-wide default
    row({ id: 2, facility_code: 'NMH', level_of_care: 'OP' }),
    row({ id: 3, facility_code: 'NMH', level_of_care: 'RTC', decided_on: '2026-06-01' }),
    row({ id: 4, payer_family: 'CIGNA', facility_code: 'NMH', level_of_care: 'RTC' }),
  ];
  const ip = lookupCodingDecision(rows, 'BCBS OF TEXAS', 'NMH', 'IP');
  assert.equal(ip?.id, 3); // RTC counts as the IP side
  const op = lookupCodingDecision(rows, 'BCBS OF TEXAS', 'NMH', 'OP');
  assert.equal(op?.id, 2);
  const wide = lookupCodingDecision(rows, 'BCBS OF TEXAS', 'KWC', 'IP');
  assert.equal(wide?.id, 1); // no facility row → payer-wide default
  assert.equal(lookupCodingDecision(rows, 'HUMANA GOLD', 'NMH', 'IP'), null); // family has no rows
  assert.equal(lookupCodingDecision(rows, 'TOTALLY UNKNOWN', 'NMH', 'IP'), null); // unmapped label
});

test('lookupCodingDecision EXCLUDES a payer-wide row whose LOC contradicts the facility (finding #2)', () => {
  // An OP facility must never be rated on an RTC-only payer-wide default — exclusion, not score-0 match.
  const rows = [row({ id: 9, facility_code: null, level_of_care: 'RTC' })];
  assert.equal(lookupCodingDecision(rows, 'BCBS', 'NMH', 'OP'), null);
  // …but the SAME row matches the IP side, and a facility-EXACT row wins even on LOC mismatch
  // (the facility-specific decision beats our crosswalk-guessed care setting).
  assert.equal(lookupCodingDecision(rows, 'BCBS', 'NMH', 'IP')?.id, 9);
  const exact = [row({ id: 10, facility_code: 'NMH', level_of_care: 'RTC' })];
  assert.equal(lookupCodingDecision(exact, 'BCBS', 'NMH', 'OP')?.id, 10);
});

test('lookupCodingDecision ignores superseded rows', () => {
  const rows = [row({ id: 5, effective_to: '2026-07-15' })];
  assert.equal(lookupCodingDecision(rows, 'BCBS', null, null), null);
});

test('codingCodesLabel: suppression is a method — NO HCPCS renders as such', () => {
  assert.equal(codingCodesLabel(row({})), 'H0017 / 0158');
  assert.equal(codingCodesLabel(row({ hcpcs_suppressed: true, revenue_code: '1001' })), 'NO HCPCS / 1001');
  assert.equal(codingCodesLabel(row({ hcpcs_code: null })), '0158');
});

test('builders: explicit projections, bound params, no SELECT *', () => {
  const cur = buildCurrentCodingDecisionsQuery();
  assert.match(cur.sql, /from coding\.code_decision/);
  assert.match(cur.sql, /where effective_to is null/);
  assert.doesNotMatch(cur.sql, /select \*/i);

  const hist = buildCodingDecisionHistoryQuery(9999);
  assert.deepEqual(hist.params, [2000]); // clamped

  const ins = buildInsertCodingDecisionQuery({
    payer_family: 'BCBS',
    payer_variant_label: 'Anthem BCBS (ALL OTHERS)',
    plan_alpha: null,
    employer_norm: null,
    level_of_care: 'RTC',
    facility_code: 'NMH',
    hcpcs_code: null,
    revenue_code: '1001',
    hcpcs_suppressed: true,
    dos_batch_min: 2,
    dos_batch_max: 3,
    type_of_bill: '863',
    drg_code: null,
    condition_codes: ['92'],
    modifiers_removed: ['GT'],
    units_per_dos: null,
    billing_span: 'admit_dc',
    lifecycle: 'OPEN TEST',
    decided_on: '2026-07-20',
    effective_from: '2026-07-20',
    notes: 'test for two months',
    created_by: 'alec@treathealth.ai',
  });
  assert.match(ins.sql, /insert into coding\.code_decision/);
  assert.match(ins.sql, /returning id/);
  assert.match(ins.sql, /created_by\) /);
  assert.equal(ins.params.length, 22);
  assert.ok(!ins.sql.includes('NMH'), 'values are bound, never inlined');

  const sup = buildSupersedeCodingDecisionQuery(10, 11, '2026-08-01');
  assert.match(sup.sql, /set effective_to = \$3::date, superseded_by = \$2/);
  assert.match(sup.sql, /where id = \$1 and effective_to is null/);

  const aud = buildInsertCodingAuditQuery({
    decision_id: 11,
    actor_email: 'a@b.c',
    action: 'create',
    before: null,
    after: { lifecycle: 'OPEN TEST' },
  });
  assert.match(aud.sql, /insert into coding\.code_decision_audit/);
  assert.equal(aud.params[3], null);
  assert.equal(typeof aud.params[4], 'string'); // jsonb payload pre-serialized
});
