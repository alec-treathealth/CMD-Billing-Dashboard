/**
 * Hermetic SQL-shape tests for the AR Management query builders (src/billingAudit/arQuery.ts).
 * No DB. They pin the invariants the PHI rules depend on: every value is a `$n` parameter, the
 * tenant predicate is always present, sorts are allowlisted, cursors validated, band filters
 * compile to DOS date bounds, and no encrypted column ever appears in the queue projection.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AR_BANDS, AR_MIN_AGE_DAYS, AR_QUEUE_BANDS } from '../src/billingAudit/arBuckets.js';
import {
  AR_PAGE_SIZE,
  arSortValue,
  buildArAssigneeLookupQuery,
  buildArAssigneeOptionsQuery,
  buildArChargeLinesQuery,
  buildArClaimPatientQuery,
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
  buildArLatestNotesQuery,
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
  assert.match(sql, /order by c\.balance DESC nulls last, c\.id DESC limit \$4/);
  // AR_MIN_AGE_DAYS binds between the entity list and the limit — the aged-only predicate.
  assert.deepEqual(params, [AS_OF, ENT, AR_MIN_AGE_DAYS, AR_PAGE_SIZE + 1]);
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
  // The overdue predicate reads the SAME effective date the grid shows (work due date, else CMD's).
  assert.match(sql, /coalesce\(w\.due_on, c\.cmd_followup_date\) < \$1::date/);
  assert.equal(/ c\.cmd_followup_date < \$1::date/.test(sql), false);
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
  assert.match(k.sql, /coalesce\(w\.due_on, c\.cmd_followup_date\) < \$1::date\)::int as followup_overdue/);
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
  // Assignees are TENANT-scoped: every super_admin plus this tenant's admins; the slug is allowlisted.
  const asg = buildArAssigneeOptionsQuery('bxr');
  assertParamsAligned(asg.sql, asg.params);
  assert.match(asg.sql, /role = 'super_admin' or \(role = 'admin' and entity = \$1\)/);
  assert.deepEqual(asg.params, ['bxr']);
  assert.throws(() => buildArAssigneeOptionsQuery('consolidated'), /bxr or indigo/);
  const look = buildArAssigneeLookupQuery(USER);
  assertParamsAligned(look.sql, look.params);
  assert.match(look.sql, /select user_id::text as user_id, email, role, entity from claims\.app_user where user_id = \$1::uuid/);
  assert.throws(() => buildArAssigneeLookupQuery('me'), /uuid/);
  const pat = buildArClaimPatientQuery('900000001', ENT);
  assertParamsAligned(pat.sql, pat.params);
  assert.match(pat.sql, /select cmd_patient_id from claims\.ar_claim where business_entity_id = any\(\$1::uuid\[\]\) and cmd_claim_id = \$2/);
  const n = buildArNotificationsQuery(USER, ENT, 500);
  assertParamsAligned(n.sql, n.params);
  assert.equal(n.params[2], 100, 'limit clamped');
  assert.match(n.sql, /e\.actor_user_id <> \$2::uuid/);
  assert.match(n.sql, /as unread/);
  const c = buildArNotificationCountQuery(USER, ENT);
  assertParamsAligned(c.sql, c.params);
  assert.throws(() => buildArNotificationCountQuery('me', ENT), /uuid/);
});

test('patient search is ONE or-group — a member-id term must not be ANDed against the name index', () => {
  // searchArPatientsAction emits a NAME token AND a MEMBER-ID token for any term containing a digit,
  // because it cannot know which kind was typed. ANDed, that asks for a patient whose NAME is their
  // member id: zero rows for every member-id search, and — since this predicate set also feeds the
  // summary and the KPI — a hero reading "Open AR - 0 claims / $0" for a patient who has open AR.
  const nameTok = 'a'.repeat(64);
  const memberTok = 'b'.repeat(64);
  const { sql } = buildArQueueQuery(null, resolveArFilter({ patientNameBidx: [nameTok], memberIdBidx: [memberTok] }), resolveArSort({}), 51, ENT, AS_OF);
  assert.match(sql, /\(p\.patient_name_bidx = any\(\$\d+::text\[\]\) or p\.member_id_bidx = any\(\$\d+::text\[\]\)\)/, 'the two clauses are ORed inside one group');
  assert.ok(!/patient_name_bidx = any\(\$\d+::text\[\]\) and/.test(sql), 'never ANDed against the next patient clause');
});

test('patient search or-group covers all three indexes and still works with a single token', () => {
  const tok = 'c'.repeat(64);
  const one = buildArQueueQuery(null, resolveArFilter({ memberIdBidx: [tok] }), resolveArSort({}), 51, ENT, AS_OF).sql;
  assert.match(one, /\(p\.member_id_bidx = any\(\$\d+::text\[\]\)\)/, 'a lone token is still a valid group');
  const all = buildArQueueQuery(null, resolveArFilter({ patientNameBidx: [tok], patientNamePrefixBidx: [tok], memberIdBidx: [tok] }), resolveArSort({}), 51, ENT, AS_OF).sql;
  assert.match(all, /\(p\.patient_name_bidx = any\(\$\d+::text\[\]\) or p\.patient_name_pfx3_bidx = any\(\$\d+::text\[\]\) or p\.member_id_bidx = any\(\$\d+::text\[\]\)\)/, 'all three ORed together');
  // The summary and the KPI share arBaseConds, so they must carry the same group — that shared
  // predicate set is why a broken search became a wrong headline number, not merely an empty list.
  for (const q of [
    buildArSummaryQuery(resolveArFilter({ memberIdBidx: [tok] }), ENT, AS_OF).sql,
    buildArKpiQuery(resolveArFilter({ memberIdBidx: [tok] }), ENT, AS_OF).sql,
  ]) assert.match(q, /\(p\.member_id_bidx = any\(\$\d+::text\[\]\)\)/);
});

test('every AR read excludes the 0-30 day set, and KEEPS an undated claim', () => {
  // Ruled 2026-09-10: the 0-30d population is not on this queue. Enforced in arBaseConds, so the
  // queue, the tiles and the KPI cannot disagree about the population they describe.
  const q = buildArQueueQuery(null, resolveArFilter({}), resolveArSort({}), 51, ENT, AS_OF);
  const s = buildArSummaryQuery(resolveArFilter({}), ENT, AS_OF).sql;
  const k = buildArKpiQuery(resolveArFilter({}), ENT, AS_OF).sql;
  for (const sql of [q.sql, s, k]) {
    assert.match(sql, /\(c\.dos_from is null or c\.dos_from <= \(\$\d+::date - \$\d+::int\)\)/, 'aged-only predicate present');
  }
  assert.ok(q.params.includes(AR_MIN_AGE_DAYS), `the bound age is the constant (${AR_MIN_AGE_DAYS}), not a literal`);
  // The NULL branch is the point: a bare comparison would drop undated claims silently, which on an
  // AR queue means money vanishing. Undated claims stay visible.
  assert.ok(!/c\.dos_from <= \(\$\d+::date - \$\d+::int\)\s+and/.test(q.sql.replace(/\(c\.dos_from is null or /, '')), 'no bare comparison');
});

test('AR_QUEUE_BANDS drops 0_30 while AR_BANDS stays the total taxonomy', () => {
  // AR_BANDS must remain exhaustive so the SQL CASE can never yield a null band for a stray row;
  // the tile set is a separate, narrower list.
  assert.equal(AR_BANDS.length, 9);
  assert.equal(AR_QUEUE_BANDS.length, 8);
  assert.ok(AR_BANDS.some((b) => b.key === '0_30'), 'the taxonomy still classifies a 0-30d row');
  assert.ok(!AR_QUEUE_BANDS.some((b) => b.key === '0_30'), 'the queue does not offer it as a tile');
});

test('buildArLatestNotesQuery resolves claim-level AND patient-level notes, one lateral per pair', () => {
  // Migration 0110 made CMD notes patient-level (cmd_claim_id NULL on most), so "this claim's
  // latest note" cannot be answered from the claim id alone — hence pairs.
  const { sql, params } = buildArLatestNotesQuery(
    [{ cmdClaimId: '900000001', cmdPatientId: '80000001' }, { cmdClaimId: '900000002', cmdPatientId: '80000002' }],
    ENT,
  );
  assert.match(sql, /from unnest\(\$2::text\[\], \$3::text\[\]\) as k\(cmd_claim_id, cmd_patient_id\)/);
  assert.match(sql, /cmd_claim_id = k\.cmd_claim_id or \(cmd_claim_id is null and cmd_patient_id = k\.cmd_patient_id\)/);
  assert.match(sql, /order by noted_at desc, id desc limit 1/, 'latest note only');
  assert.match(sql, /business_entity_id = any\(\$1::uuid\[\]\)/, 'tenant-scoped');
  assert.deepEqual(params[1], ['900000001', '900000002']);
  assert.deepEqual(params[2], ['80000001', '80000002']);
  // A claim id can only reach its OWN patient's notes: the pair comes from a tenant-scoped read.
  assert.throws(() => buildArLatestNotesQuery([{ cmdClaimId: '900000001', cmdPatientId: 'x' }], ENT), /patient id/);
  assert.throws(() => buildArLatestNotesQuery([{ cmdClaimId: 'nope', cmdPatientId: '80000001' }], ENT), /claim/);
});
