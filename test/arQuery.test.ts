/**
 * Hermetic SQL-shape tests for the AR Management query builders (src/billingAudit/arQuery.ts).
 * No DB. They pin the invariants the PHI rules depend on: every value is a `$n` parameter, the
 * tenant predicate is always present, sorts are allowlisted, cursors validated, band filters
 * compile to DOS date bounds, and no encrypted column ever appears in the queue projection.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AR_PAGE_SIZE,
  arSortValue,
  buildArAssigneeOptionsQuery,
  buildArChargeLinesQuery,
  buildArClaimQuery,
  buildArFacilityOptionsQuery,
  buildArKpiQuery,
  buildArNotesQuery,
  buildArNotificationCountQuery,
  buildArNotificationsQuery,
  buildArPatientRevealQuery,
  buildArQueueQuery,
  buildArSummaryQuery,
  resolveArCursor,
  resolveArFilter,
  resolveArSort,
  type ArQueueRow,
} from '../src/billingAudit/arQuery.js';

const ENT = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];
const AS_OF = '2026-09-09';
const USER = '11111111-2222-4333-8444-555555555555';

/** Every `$n` placeholder in the SQL must map to a param and vice versa (no gaps, no literals smuggled in). */
function assertParamsAligned(sql: string, params: unknown[]): void {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = Math.max(0, ...nums);
  assert.equal(max, params.length, `highest $n (${max}) must equal params.length (${params.length})`);
  for (let i = 1; i <= params.length; i++) assert.ok(nums.includes(i), `$${i} unused`);
}

test('resolveArFilter: allowlists, bounds and drops garbage', () => {
  const f = resolveArFilter({
    bands: ['31_60', 'nope', '2yr_plus', '31_60'],
    facilityCodes: ['CAMH', '', 'x'.repeat(100)],
    statusCategories: ['AT_PAYER', 'BOGUS'],
    workStatuses: ['open', 'appeal', 'wat'],
    assigneeUserIds: [USER, 'not-a-uuid'],
    hasDenial: true,
    includePaid: 'yes',
    minBalance: -5,
    claimId: '12; drop table',
    patientNameBidx: ['ab'.repeat(32)],
  });
  assert.deepEqual(f.bands, ['31_60', '2yr_plus']);
  assert.deepEqual(f.facilityCodes, ['CAMH']);
  assert.deepEqual(f.statusCategories, ['AT_PAYER']);
  assert.deepEqual(f.workStatuses, ['open', 'appeal']);
  assert.deepEqual(f.assigneeUserIds, [USER]);
  assert.equal(f.hasDenial, true);
  assert.equal(f.includePaid, undefined);
  assert.equal(f.minBalance, undefined);
  assert.equal(f.claimId, undefined);
  assert.deepEqual(f.patientNameBidx, ['ab'.repeat(32)]);
  assert.deepEqual(resolveArFilter(null), {});
  assert.equal(resolveArFilter({ claimId: '900000001' }).claimId, '900000001');
});

test('resolveArSort / resolveArCursor: allowlist + defaults', () => {
  assert.deepEqual(resolveArSort(undefined), { column: 'balance', direction: 'desc' });
  assert.deepEqual(resolveArSort({ column: 'age', direction: 'asc' }), { column: 'age', direction: 'asc' });
  assert.deepEqual(resolveArSort({ column: 'patient_name_enc', direction: 'asc' }), { column: 'balance', direction: 'asc' });
  assert.deepEqual(resolveArCursor({ id: 5, value: 12.5 }), { id: 5, value: 12.5 });
  assert.deepEqual(resolveArCursor({ id: 5, value: null }), { id: 5, value: null });
  assert.equal(resolveArCursor({ id: -1, value: 1 }), null);
  assert.equal(resolveArCursor({ id: 1, value: { evil: true } }), null);
});

test('queue query: tenant + in_latest + open-balance predicates, parameterised, no PHI column in the projection', () => {
  const { sql, params } = buildArQueueQuery(null, {}, { column: 'balance', direction: 'desc' }, AR_PAGE_SIZE + 1, ENT, AS_OF);
  assertParamsAligned(sql, params);
  assert.match(sql, /c\.business_entity_id = any\(\$2::uuid\[\]\)/);
  assert.match(sql, /c\.in_latest_snapshot/);
  assert.match(sql, /c\.balance > 0/);
  assert.match(sql, /order by c\.balance DESC nulls last, c\.id DESC limit \$3/);
  assert.deepEqual(params, [AS_OF, ENT, AR_PAGE_SIZE + 1]);
  for (const forbidden of ['_enc', '_bidx', 'select *', 'note_enc']) assert.equal(sql.includes(forbidden), false, forbidden);
  assert.match(sql, /as band/);
  assert.match(sql, /as age_days/);
  // No ar_patient join unless a blind-index filter asks for it.
  assert.equal(sql.includes('claims.ar_patient'), false);
});

test('queue query: every filter binds a parameter; band filter compiles to DOS bounds; bidx filters join ar_patient', () => {
  const f = resolveArFilter({
    bands: ['31_60', '2yr_plus'], facilityCodes: ['CAMH'], payerNames: ['CIGNA'], statusCategories: ['AT_PAYER'],
    workStatuses: ['open'], assigneeUserIds: [USER], hasDenial: true, followupOverdue: true, minBalance: 500,
    patientNameBidx: ['a'.repeat(64)], claimId: '900000001',
  });
  const { sql, params } = buildArQueueQuery(null, f, { column: 'age', direction: 'desc' }, 51, ENT, AS_OF);
  assertParamsAligned(sql, params);
  assert.match(sql, /left join claims\.ar_patient p on/);
  assert.match(sql, /p\.patient_name_bidx = any\(\$\d+::text\[\]\)/);
  // 31_60 → dos_from <= asOf-31 and dos_from >= asOf-60; 2yr_plus → dos_from <= asOf-731 only.
  assert.match(sql, /c\.dos_from <= \(\$1::date - \$\d+::int\) and c\.dos_from >= \(\$1::date - \$\d+::int\)/);
  assert.ok(params.includes(31) && params.includes(60) && params.includes(731));
  assert.ok(params.some((p) => Array.isArray(p) && p.includes('CIGNA')), 'payer list bound as an array param');
  assert.equal(params.includes('900000001'), true);
  assert.equal(sql.includes('CIGNA'), false, 'values never inline');
  // `age desc` (oldest first) flips to dos_from ASC.
  assert.match(sql, /order by c\.dos_from ASC nulls last, c\.id ASC/);
  assert.match(sql, /c\.cmd_followup_date < \$1::date/);
});

test('queue query: keyset cursor continues after (value, id); null-value cursor walks the NULLS LAST tail', () => {
  const a = buildArQueueQuery({ id: 77, value: 1234.5 }, {}, { column: 'balance', direction: 'desc' }, 51, ENT, AS_OF);
  assertParamsAligned(a.sql, a.params);
  assert.match(a.sql, /\(c\.balance < \$\d+::numeric or \(c\.balance = \$\d+::numeric and c\.id < \$\d+\) or c\.balance is null\)/);
  const b = buildArQueueQuery({ id: 77, value: null }, {}, { column: 'current_payer_name', direction: 'asc' }, 51, ENT, AS_OF);
  assert.match(b.sql, /\(c\.current_payer_name is null and c\.id > \$\d+\)/);
  const c = buildArQueueQuery({ id: 9, value: '2026-01-01' }, {}, { column: 'dos_from', direction: 'asc' }, 51, ENT, AS_OF);
  assert.match(c.sql, /c\.dos_from > \$\d+::date/);
});

test('queue query: limit is clamped and the entity scope must not be empty', () => {
  const { params } = buildArQueueQuery(null, {}, { column: 'balance', direction: 'desc' }, 99_999, ENT, AS_OF);
  assert.equal(params[params.length - 1], AR_PAGE_SIZE * 4 + 1);
  assert.throws(() => buildArQueueQuery(null, {}, { column: 'balance', direction: 'desc' }, 51, [], AS_OF), /fail closed/);
  assert.throws(() => buildArQueueQuery(null, {}, { column: 'balance', direction: 'desc' }, 51, ENT, '09/09/2026'), /ISO date/);
});

test('arSortValue matches the sort expression shapes', () => {
  const row = { balance: '10.50', total_charges: '99.00', dos_from: '2026-01-02', facility_code: 'CAMH', current_payer_name: 'X', status_category: 'AT_PAYER', last_cmd_note_at: '2026-02-01T00:00:00Z', last_user_note_at: '2026-03-01T00:00:00Z', work_status: 'open', cmd_followup_date: null } as unknown as ArQueueRow;
  assert.equal(arSortValue(row, 'balance'), 10.5);
  assert.equal(arSortValue(row, 'age'), '2026-01-02');
  assert.equal(arSortValue(row, 'last_note_at'), '2026-03-01T00:00:00Z');
  assert.equal(arSortValue(row, 'cmd_followup_date'), null);
});

test('summary excludes the band filter; KPI includes it; both stay tenant-pinned', () => {
  const f = resolveArFilter({ bands: ['31_60'], facilityCodes: ['CAMH'] });
  const s = buildArSummaryQuery(f, ENT, AS_OF);
  assertParamsAligned(s.sql, s.params);
  assert.match(s.sql, /group by 1/);
  assert.equal(s.sql.includes('::int) and c.dos_from >='), false, 'summary must not be band-filtered');
  assert.match(s.sql, /c\.facility_code = any/);
  const k = buildArKpiQuery(f, ENT, AS_OF);
  assertParamsAligned(k.sql, k.params);
  assert.match(k.sql, /c\.dos_from <= \(\$1::date - \$\d+::int\)/);
  assert.match(k.sql, /as aged_31_plus_balance/);
});

test('detail builders: claim id validated, tenant pinned, notes include patient-level rows', () => {
  const lines = buildArChargeLinesQuery('900000001', ENT);
  assertParamsAligned(lines.sql, lines.params);
  assert.match(lines.sql, /from claims\.ar_charge where business_entity_id = any\(\$1::uuid\[\]\) and cmd_claim_id = \$2/);
  assert.throws(() => buildArChargeLinesQuery("1' or 1=1", ENT), /CMD numeric id/);
  const notes = buildArNotesQuery('900000001', '80000001', ENT);
  assertParamsAligned(notes.sql, notes.params);
  assert.match(notes.sql, /\(cmd_claim_id = \$2 or \(cmd_claim_id is null and cmd_patient_id = \$3\)\)/);
  assert.match(notes.sql, /note_enc/);
  const one = buildArClaimQuery('900000001', ENT, AS_OF);
  assert.equal(one.sql.includes(' and c.in_latest_snapshot'), false, 'a single claim read sees rows that left the latest snapshot');
  assert.equal(one.sql.includes('c.balance > 0'), false);
  assert.ok(one.params.includes('900000001'));
  const reveal = buildArPatientRevealQuery('80000001', ENT);
  assert.match(reveal.sql, /select patient_name_enc, patient_dob_enc, member_id_enc from claims\.ar_patient/);
  assert.equal(/status_raw|balance/.test(reveal.sql), false);
});

test('options + notifications: parameterised, bounded, actor excluded', () => {
  const fac = buildArFacilityOptionsQuery(ENT);
  assertParamsAligned(fac.sql, fac.params);
  assert.match(buildArAssigneeOptionsQuery().sql, /role in \('super_admin', 'admin'\)/);
  const n = buildArNotificationsQuery(USER, ENT, 500);
  assertParamsAligned(n.sql, n.params);
  assert.equal(n.params[2], 100, 'limit clamped');
  assert.match(n.sql, /e\.actor_user_id <> \$2::uuid/);
  assert.match(n.sql, /as unread/);
  const c = buildArNotificationCountQuery(USER, ENT);
  assertParamsAligned(c.sql, c.params);
  assert.throws(() => buildArNotificationCountQuery('me', ENT), /uuid/);
});
