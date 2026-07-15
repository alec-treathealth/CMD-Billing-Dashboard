/**
 * Hermetic tests for the billing-audit reader query builder (src/billingAudit/auditQuery.ts).
 * Assert the security-critical invariants: mandatory tenant + scope scoping, a PHI-free
 * projection, allowlisted sort, bounded/validated filters, and correct keyset boundaries.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_SELECT,
  buildAuditRowsQuery,
  buildAuditFacilityOptionsQuery,
  buildAuditPayerOptionsQuery,
  buildAuditPivotQueries,
  buildAuditPatientDetailQuery,
  resolveAuditCursor,
  resolveAuditFilter,
  resolveAuditSort,
  auditSortValue,
  type AuditFilter,
} from '../src/billingAudit/auditQuery.js';

const BXR = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];

test('AUDIT_SELECT is PHI-free: no encrypted or blind-index columns are ever selected', () => {
  for (const banned of ['_enc', '_bidx', 'patient_name', 'patient_dob', 'member_id']) {
    assert.ok(!AUDIT_SELECT.includes(banned), `AUDIT_SELECT must not reference ${banned}`);
  }
});

test('every page query pins tenant + scope in the WHERE (first page, no filters)', () => {
  const { sql, params } = buildAuditRowsQuery(null, {}, resolveAuditSort(undefined), 51, 'IP', BXR);
  assert.match(sql, /t\.business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(sql, /t\.audit_scope = \$2/);
  assert.equal(params[0], BXR);
  assert.equal(params[1], 'IP');
  // default sort = charge_from_date DESC, NULLS LAST, id DESC
  assert.match(sql, /order by t\.charge_from_date desc nulls last, t\.id desc/);
  // limit is parameterized (over-fetch 51), never interpolated
  assert.match(sql, /limit \$\d+/);
  assert.equal(params[params.length - 1], 51);
  // no cursor boundary on the first page
  assert.ok(!/or t\.charge_from_date is null\)/.test(sql));
});

test('keyset cursor (non-null value) emits the strict > / tie / NULL-block boundary', () => {
  const { sql } = buildAuditRowsQuery(
    { id: 900, value: '2026-03-01' }, {}, { column: 'charge_from_date', direction: 'desc' }, 51, 'IP', BXR,
  );
  assert.match(
    sql,
    /\(t\.charge_from_date < \$\d+ or \(t\.charge_from_date = \$\d+ and t\.id < \$\d+\) or t\.charge_from_date is null\)/,
  );
});

test('keyset cursor (null value) walks only the trailing NULL block', () => {
  const { sql } = buildAuditRowsQuery(
    { id: 900, value: null }, {}, { column: 'charge_from_date', direction: 'desc' }, 51, 'OP', BXR,
  );
  assert.match(sql, /\(t\.charge_from_date is null and t\.id < \$\d+\)/);
});

test('asc direction flips the comparator and NULLS-LAST ordering', () => {
  const { sql } = buildAuditRowsQuery(
    { id: 5, value: 'CAMH' }, {}, { column: 'facility_code', direction: 'asc' }, 51, 'IP', BXR,
  );
  assert.match(sql, /t\.facility_code > \$/);
  assert.match(sql, /order by t\.facility_code asc nulls last, t\.id asc/);
});

test('filters are parameterized array/scalar predicates (no interpolation)', () => {
  const filter: AuditFilter = resolveAuditFilter({
    facilityCodes: ['CAMH', 'NASH'],
    payerNames: ['Cigna'],
    cptCodes: ['H0018'],
    revCodes: ['0124'],
    statusCategories: ['AT_PAYER'],
    statusPayer: 'BCBS',
    dateFrom: '2026-01-01',
    dateTo: '2026-03-31',
  });
  const { sql, params } = buildAuditRowsQuery(null, filter, resolveAuditSort(undefined), 51, 'IP', BXR);
  assert.match(sql, /t\.facility_code = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.payer_name = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.cpt_code = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.rev_code = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.status_category = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.status_payer = \$\d+/);
  assert.match(sql, /t\.charge_from_date >= \$\d+::date/);
  assert.match(sql, /t\.charge_from_date <= \$\d+::date/);
  assert.ok(params.includes('BCBS'));
  assert.ok(params.includes('2026-01-01'));
});

test('resolveAuditFilter allowlists status + validates dates + drops junk', () => {
  const f = resolveAuditFilter({
    statusCategories: ['AT_PAYER', 'NOT_A_STATUS', 'PAID'],
    dateFrom: 'not-a-date',
    dateTo: '2026-03-31',
    facilityCodes: ['', '   ', 'CAMH'],
    // @ts-expect-error — exercise runtime coercion of a wrong-typed field
    payerNames: 'oops-not-an-array',
  });
  assert.deepEqual(f.statusCategories, ['AT_PAYER', 'PAID']); // NOT_A_STATUS dropped
  assert.equal(f.dateFrom, null); // invalid date dropped
  assert.equal(f.dateTo, '2026-03-31');
  assert.deepEqual(f.facilityCodes, ['CAMH']); // blanks dropped
  assert.equal(f.payerNames, undefined); // non-array dropped
});

test('resolveAuditFilter caps list length (no unbounded IN)', () => {
  const huge = Array.from({ length: 500 }, (_, i) => `C${i}`);
  const f = resolveAuditFilter({ cptCodes: huge });
  assert.ok((f.cptCodes?.length ?? 0) <= 60);
});

test('resolveAuditSort clamps to the allowlist, else the DOS-desc default', () => {
  assert.deepEqual(resolveAuditSort({ column: 'charge_amount_cents', direction: 'asc' }), { column: 'charge_amount_cents', direction: 'asc' });
  // @ts-expect-error — non-allowlisted column falls back to default
  assert.deepEqual(resolveAuditSort({ column: 'patient_name_enc', direction: 'desc' }), { column: 'charge_from_date', direction: 'desc' });
  assert.deepEqual(resolveAuditSort(undefined), { column: 'charge_from_date', direction: 'desc' });
});

test('resolveAuditCursor rejects malformed cursors (treat as first page)', () => {
  assert.equal(resolveAuditCursor(null), null);
  assert.equal(resolveAuditCursor({ id: 0, value: 'x' }), null);
  assert.equal(resolveAuditCursor({ id: 1.5, value: 'x' }), null);
  // @ts-expect-error — object value is not a JSON scalar
  assert.equal(resolveAuditCursor({ id: 5, value: {} }), null);
  assert.deepEqual(resolveAuditCursor({ id: 5, value: '2026-03-01' }), { id: 5, value: '2026-03-01' });
  assert.deepEqual(resolveAuditCursor({ id: 5, value: null }), { id: 5, value: null });
});

test('auditSortValue returns the sort column scalar (null-safe)', () => {
  const row = { charge_from_date: '2026-03-05', charge_amount_cents: '675000', facility_code: null } as never;
  assert.equal(auditSortValue(row, 'charge_from_date'), '2026-03-05');
  assert.equal(auditSortValue(row, 'facility_code'), null);
});

test('patient-search blind-index tokens filter on the index columns (opaque, non-PHI)', () => {
  const f = resolveAuditFilter({ patientNameBidx: ['abc123'], patientNamePrefixBidx: ['def456'] });
  const { sql, params } = buildAuditRowsQuery(null, f, resolveAuditSort(undefined), 51, 'IP', BXR);
  assert.match(sql, /t\.patient_name_bidx = any\(\$\d+::text\[\]\)/);
  assert.match(sql, /t\.patient_name_pfx3_bidx = any\(\$\d+::text\[\]\)/);
  // tokens are bound as text[] params (arrays), not bare strings
  assert.ok(params.some((p) => Array.isArray(p) && p.includes('abc123')));
  assert.ok(params.some((p) => Array.isArray(p) && p.includes('def456')));
});

test('buildAuditPatientDetailQuery pins tenant + scope + patient, PHI-free, bounded', () => {
  const { sql, params } = buildAuditPatientDetailQuery('80099', 'OP', BXR);
  assert.match(sql, /t\.business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(sql, /t\.audit_scope = \$2/);
  assert.match(sql, /t\.cmd_patient_id = \$3/);
  assert.match(sql, /limit 500/);
  assert.deepEqual(params, [BXR, 'OP', '80099']);
  for (const banned of ['_enc', '_bidx', 'patient_name', 'member_id']) assert.ok(!sql.includes(banned));
});

test('pivot queries all pin tenant + scope + filter', () => {
  const { byOffice, byPayerCpt, byRev } = buildAuditPivotQueries(
    resolveAuditFilter({ facilityCodes: ['CAMH'] }), 'IP', BXR,
  );
  for (const q of [byOffice, byPayerCpt, byRev]) {
    assert.match(q.sql, /t\.business_entity_id = any\(\$\d+::uuid\[\]\)/);
    assert.match(q.sql, /t\.audit_scope = \$\d+/);
    assert.match(q.sql, /t\.facility_code = any\(\$\d+::text\[\]\)/); // the applied filter
  }
  assert.match(byPayerCpt.sql, /limit 8/);
  assert.match(byRev.sql, /limit 8/);
});

test('option queries pin tenant + scope', () => {
  const fac = buildAuditFacilityOptionsQuery('IP', BXR);
  assert.match(fac.sql, /a\.audit_scope = \$1 and a\.business_entity_id = any\(\$2::uuid\[\]\)/);
  assert.deepEqual(fac.params, ['IP', BXR]);
  const pay = buildAuditPayerOptionsQuery('OP', BXR);
  assert.match(pay.sql, /audit_scope = \$1 and business_entity_id = any\(\$2::uuid\[\]\)/);
  assert.deepEqual(pay.params, ['OP', BXR]);
});
