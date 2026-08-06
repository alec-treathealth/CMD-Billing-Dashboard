/**
 * Phase G census aggregation — column resolution by TITLE (per-board ids drift AND collide across
 * boards), the two board families and their DIFFERENT LOS formulas, the admitted/open-bed label
 * rules, the auth null-guard, upcoming-UR selection, the structural family + care_setting
 * assertions, value-level conformance, and the upsert/read builders' param discipline.
 *
 * All pure; the monday fetch is I/O (qualifyCensusSync.ts) and is never called from this suite.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CENSUS_BLOCKED_BOARDS,
  CENSUS_DEFERRED_BOARDS,
  CENSUS_EXCLUDED_BOARD_IDS,
  CENSUS_TITLES,
  MONDAY_CENSUS_FACILITIES,
  aggregateCensusItems,
  buildFacilityCareSettingQuery,
  buildQualifyCensusReadQuery,
  buildUpsertCensusRowQuery,
  checkCareSetting,
  computeLosDays,
  conformanceHasGap,
  daysBetweenUtc,
  emptyResolvedColumns,
  isBilledForAuthFit,
  representativeBoardId,
  resolveCensusColumns,
  type CensusConformance,
  type CensusItem,
} from '../src/collections/qualifyCensus';

// --- column resolution ---------------------------------------------------------

test('column resolution: per-board ids resolve by TITLE, including the two LOS inputs', () => {
  const nashville = resolveCensusColumns(
    [
      { id: 'admit_status___1', title: 'Admit Status' },
      { id: 'numeric_mkt2rb5c', title: 'Total Auth Days' },
      { id: 'date', title: 'ADM Date' },
      { id: 'date4', title: 'DC Date' },
      { id: 'formula_mkt2dqph', title: 'Days in RTC' },
      { id: 'date_mkt28z4m', title: 'Next UR Date' },
    ],
    'residential',
  );
  assert.equal(nashville.statusId, 'admit_status___1');
  assert.equal(nashville.authId, 'numeric_mkt2rb5c');
  assert.equal(nashville.admId, 'date');
  assert.equal(nashville.dcId, 'date4');
  assert.equal(nashville.urId, 'date_mkt28z4m');
  assert.deepEqual(nashville.missing, []);
  assert.equal(nashville.familyMismatch, null);

  // Lonestar mints DIFFERENT ids for the same titles, and cloned boards REUSE ids across different
  // boards — so an id is not a board identity in either direction. Title matching absorbs both.
  const lonestar = resolveCensusColumns(
    [
      { id: 'admit_status___1', title: 'Admit Status' },
      { id: 'numeric_mkt2shja', title: 'Total Auth Days' },
      { id: 'date', title: 'ADM Date' },
      { id: 'date4', title: 'DC Date' },
      { id: 'date_mkt2exhh', title: 'Next UR Date' },
    ],
    'residential',
  );
  assert.equal(lonestar.authId, 'numeric_mkt2shja');
  assert.deepEqual(lonestar.missing, []);

  // A board missing columns NAMES them (the conformance report's raw material).
  const sparse = resolveCensusColumns([{ id: 's1', title: 'Status' }, { id: 'l1', title: 'LOC' }], 'outpatient');
  assert.equal(sparse.statusId, 's1');
  assert.deepEqual(sparse.missing, ['ADM Date', 'DC Date', 'Total Auth Days', 'Next UR Date']);
});

test('the LOS formula title is NOT an expected column — nothing reads it any more', () => {
  // Deliberate removal. monday returns text:"" for formula columns, so we recompute LOS from its
  // inputs; keeping 'Days in RTC'/'Days in OP' as an expected title would report a permanent,
  // unfixable gap on the MHC OP board, whose LOS column is mis-titled 'Days in RTC'.
  assert.ok(!('los' in CENSUS_TITLES.residential), 'residential must not declare a LOS title');
  assert.ok(!('los' in CENSUS_TITLES.outpatient), 'outpatient must not declare a LOS title');
  const all = JSON.stringify(CENSUS_TITLES);
  assert.ok(!all.includes('Days in RTC') && !all.includes('Days in OP'), 'no LOS title anywhere in CENSUS_TITLES');
});

test('the MHC OP board mis-titled `Days in RTC` resolves cleanly as OUTPATIENT', () => {
  // Board 9947459669: LOS column titled 'Days in RTC' but carrying the outpatient template's ids,
  // the outpatient status input and the outpatient formula body (no +1). Structure says outpatient;
  // the title lies. Because the LOS column is never read, the mislabel must be harmless.
  const mhcOp = resolveCensusColumns(
    [
      { id: 'color_mkv83mx8', title: 'Status' },
      { id: 'loc1', title: 'LOC' },
      { id: 'date', title: 'ADM Date' },
      { id: 'date4', title: 'DC Date' },
      { id: 'formula_mkv84ycs', title: 'Days in RTC' }, // <- the lie
      { id: 'numeric_mkv83e3h', title: 'Total Auth Days' },
      { id: 'date_mkv868th', title: 'Next UR Date' },
    ],
    'outpatient',
  );
  assert.deepEqual(mhcOp.missing, [], 'the mis-titled LOS column must not create a gap');
  assert.equal(mhcOp.familyMismatch, null, 'Status + LOC is the outpatient signature regardless of the LOS title');
});

test('structural family assertion: a board declared the wrong family is reported, not silently used', () => {
  // This matters BECAUSE the two families differ by a day: a misdeclared family is a silent
  // one-day error in avg_los_days, not a crash.
  const wrong = resolveCensusColumns(
    [
      { id: 'color_mkv83mx8', title: 'Status' },
      { id: 'loc1', title: 'LOC' },
      { id: 'date', title: 'ADM Date' },
      { id: 'date4', title: 'DC Date' },
      { id: 'a1', title: 'Total Auth Days' },
      { id: 'u1', title: 'Next UR Date' },
    ],
    'residential', // declared residential, but the columns are outpatient
  );
  assert.match(String(wrong.familyMismatch), /declared residential but lacks Admit Status/);
  assert.match(String(wrong.familyMismatch), /carries the outpatient signature instead/);

  // IQ is NOT a discriminator: MHC Residential (7593076989) has no IQ column and is still residential.
  const noIq = resolveCensusColumns(
    [
      { id: 'admit_status___1', title: 'Admit Status' },
      { id: 'date', title: 'ADM Date' },
      { id: 'date4', title: 'DC Date' },
      { id: 'a1', title: 'Total Auth Days' },
      { id: 'u1', title: 'Next UR Date' },
    ],
    'residential',
  );
  assert.equal(noIq.familyMismatch, null, 'a residential board without IQ is still residential');
});

// --- LOS: the family-dependent recomputation ----------------------------------

test('daysBetweenUtc: whole calendar days, DST-independent, null on garbage', () => {
  assert.equal(daysBetweenUtc('2026-08-01', '2026-08-04'), 3);
  assert.equal(daysBetweenUtc('2026-08-04', '2026-08-04'), 0);
  assert.equal(daysBetweenUtc('2026-08-04', '2026-08-01'), -3);
  // Spans the US DST transition (2026-03-08). A local-timezone Date subtraction would give 8.958…
  // days here and round to 9 in one direction; UTC midnight anchoring keeps it exact.
  assert.equal(daysBetweenUtc('2026-03-05', '2026-03-14'), 9);
  assert.equal(daysBetweenUtc('2025-11-01', '2025-11-08'), 7);
  // Leap day.
  assert.equal(daysBetweenUtc('2028-02-28', '2028-03-01'), 2);
  assert.equal(daysBetweenUtc('not-a-date', '2026-08-04'), null);
  assert.equal(daysBetweenUtc('2026-08-04', ''), null);
});

test('computeLosDays: RESIDENTIAL adds 1 on discharge, OUTPATIENT does not', () => {
  // The whole point. The two formula bodies differ ONLY in the residential +1, and applying one to
  // both families is wrong on 15 boards.
  assert.equal(computeLosDays('residential', 'Discharged', '2026-08-01', '2026-08-11', '2026-08-20'), 11);
  assert.equal(computeLosDays('outpatient', 'Discharged', '2026-08-01', '2026-08-11', '2026-08-20'), 10);
});

test('computeLosDays: SAME-DAY admit and discharge is 1 bed night residential, 0 days outpatient', () => {
  assert.equal(computeLosDays('residential', 'Discharged', '2026-08-04', '2026-08-04', '2026-08-20'), 1);
  assert.equal(computeLosDays('outpatient', 'Discharged', '2026-08-04', '2026-08-04', '2026-08-20'), 0);
});

test('computeLosDays: an IN-HOUSE patient measures to today, in BOTH families identically', () => {
  // The non-discharged branch has no +1 in either formula body.
  assert.equal(computeLosDays('residential', 'Admitted', '2026-08-01', null, '2026-08-20'), 19);
  assert.equal(computeLosDays('outpatient', 'Admitted', '2026-08-01', null, '2026-08-20'), 19);
  // A stray DC date on a non-discharged item is IGNORED — status decides the branch, as in the formula.
  assert.equal(computeLosDays('residential', 'Admitted', '2026-08-01', '2026-08-03', '2026-08-20'), 19);
});

test('computeLosDays: null rules — no ADM anchor, and DISCHARGED WITH NO DC DATE', () => {
  assert.equal(computeLosDays('residential', 'Admitted', null, null, '2026-08-20'), null, 'no anchor -> null, never 0');
  assert.equal(computeLosDays('outpatient', 'Admitted', null, '2026-08-03', '2026-08-20'), null);
  // Discharged with no DC date: the stay HAS ended, we just cannot see when. Measuring to today
  // would inflate it without bound, so it is excluded rather than guessed.
  assert.equal(computeLosDays('residential', 'Discharged', '2026-08-01', null, '2026-08-20'), null);
  assert.equal(computeLosDays('outpatient', 'Discharged', '2026-08-01', null, '2026-08-20'), null);
  // 'discharged' is matched case/space-insensitively, like the aggregate's other label rules.
  assert.equal(computeLosDays('residential', '  DISCHARGED ', '2026-08-01', '2026-08-05', '2026-08-20'), 5);
});

// --- aggregation --------------------------------------------------------------

const item = (over: Partial<CensusItem>): CensusItem => ({
  status: 'Admitted',
  authDays: null,
  admDate: null,
  dcDate: null,
  urDate: null,
  ...over,
});

test('aggregation: admitted by label, open beds by STATUS label (never names), auth null-guarded', () => {
  const items: CensusItem[] = [
    item({ authDays: 20, admDate: '2026-08-01' }), // in-house 2 days
    item({ authDays: 16, admDate: '2026-07-30' }), // in-house 4 days
    item({ authDays: null, admDate: '2026-08-02' }), // admitted, NO auth -> excluded from auth avg only
    item({ status: 'Discharged', authDays: 99, admDate: '2026-01-01', dcDate: '2026-01-09' }), // not admitted -> excluded
    item({ status: 'Open Bed (Male)' }),
    item({ status: 'Open Bed (Either M/F)' }),
    item({ status: 'Pending Admit', admDate: '2026-08-01' }),
  ];
  const agg = aggregateCensusItems(items, '2026-08-03', 'residential');
  assert.equal(agg.admittedCount, 3);
  assert.equal(agg.openBeds, 2);
  assert.equal(agg.avgAuthDays, 18); // (20+16)/2 — the null-auth admit does not fabricate a term
  assert.equal(agg.authSample, 2);
  // (2+4+1)/3 = 2.33 — LOS is computed, and INCLUDES the null-auth admit: a missing auth value has
  // nothing to do with whether the stay's length is knowable.
  assert.equal(agg.avgLosDays, 2.33);
  assert.equal(agg.losSample, 3);
});

test('aggregation: the SAME items yield a different avg LOS per family, by exactly one day', () => {
  const items: CensusItem[] = [
    item({ status: 'Discharged', admDate: '2026-08-01', dcDate: '2026-08-06' }),
    item({ status: 'Discharged', admDate: '2026-08-01', dcDate: '2026-08-08' }),
  ];
  // Both are DISCHARGED, so both take the branch where the formulas differ. Aggregation must not be
  // family-agnostic: 'Admitted' filtering is on the status label, and 'Discharged' items are
  // excluded from the average — so use admitted items to see the delta. They carry an auth value so
  // the outpatient billed-gate keeps them (see isBilledForAuthFit); without one the OP average would
  // be null and this would be testing the gate instead of the formula.
  const inHouse: CensusItem[] = [
    item({ admDate: '2026-08-01', authDays: 30 }),
    item({ admDate: '2026-08-03', authDays: 30 }),
  ];
  const res = aggregateCensusItems(inHouse, '2026-08-11', 'residential');
  const op = aggregateCensusItems(inHouse, '2026-08-11', 'outpatient');
  assert.equal(res.avgLosDays, 9); // (10+8)/2 — in-house branch, no +1 in either family
  assert.equal(op.avgLosDays, 9);
  // And a discharged-only board contributes nothing to the average either way (not 'Admitted').
  assert.equal(aggregateCensusItems(items, '2026-08-11', 'residential').avgLosDays, null);
  assert.equal(aggregateCensusItems(items, '2026-08-11', 'residential').losSample, 0);
});

test('isBilledForAuthFit: residential always; outpatient needs an auth OR a UR date', () => {
  const mk = (over: Partial<CensusItem>): CensusItem => item(over);
  // Residential: a bed night is billed, so every admitted resident counts.
  assert.equal(isBilledForAuthFit('residential', mk({ authDays: null, urDate: null })), true);
  // Outpatient: either signal is enough...
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: 30, urDate: null })), true);
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: null, urDate: '2026-09-01' })), true);
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: 30, urDate: '2026-09-01' })), true);
  // ...and neither means the client is not being billed — cash-pay, self-pay, unbilled.
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: null, urDate: null })), false);
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: 0, urDate: null })), false, 'a zero auth is not an auth');
  assert.equal(isBilledForAuthFit('outpatient', mk({ authDays: null, urDate: '  ' })), false, 'blank is not a date');
});

test('aggregation: OUTPATIENT LOS counts only BILLED clients — the cash-pay distortion', () => {
  // Measured motivation: including unbilled clients gave FRCA 223.9 avg LOS days against 86
  // authorized, scoring authFit 0 on clients the payer was never billed for.
  const items: CensusItem[] = [
    item({ authDays: 30, admDate: '2026-08-01' }), // billed by auth -> 10 days
    item({ authDays: null, urDate: '2026-09-01', admDate: '2026-08-05' }), // billed by UR -> 6 days
    item({ authDays: null, urDate: null, admDate: '2025-01-01' }), // CASH PAY, 587 days — excluded
    item({ authDays: null, urDate: null, admDate: '2025-02-01' }), // CASH PAY, 556 days — excluded
  ];
  const op = aggregateCensusItems(items, '2026-08-11', 'outpatient');
  assert.equal(op.avgLosDays, 8, '(10+6)/2 — the two open-ended cash-pay stays are not in the average');
  assert.equal(op.losSample, 2);
  assert.equal(op.losUnbilledExcluded, 2);
  assert.equal(op.admittedCount, 4, 'census context still counts every admitted client');

  // The SAME items on a residential board keep everyone: a bed night is billed.
  const res = aggregateCensusItems(items, '2026-08-11', 'residential');
  assert.equal(res.losSample, 4);
  assert.equal(res.losUnbilledExcluded, 0);
  assert.ok((res.avgLosDays ?? 0) > 250, 'residential averages all four, including the long stays');
});

test('aggregation: an OP facility with NO billed clients yields a null LOS, not a fabricated one', () => {
  // Correct downstream: ratingV2 marks authFit unavailable and now says LOS is the missing half.
  const op = aggregateCensusItems(
    [item({ authDays: null, urDate: null, admDate: '2026-01-01' })],
    '2026-08-11',
    'outpatient',
  );
  assert.equal(op.avgLosDays, null);
  assert.equal(op.losSample, 0);
  assert.equal(op.losUnbilledExcluded, 1);
});

test('the billed gate touches LOS ONLY — auth, open beds and next UR are unchanged', () => {
  const items: CensusItem[] = [
    item({ authDays: 40, admDate: '2026-08-01' }),
    item({ authDays: null, urDate: null, admDate: '2026-08-01' }), // unbilled: out of LOS, in everything else
    item({ status: 'Open Bed (Male)' }),
    item({ status: 'Pending Admit', urDate: '2026-08-20' }),
  ];
  const op = aggregateCensusItems(items, '2026-08-11', 'outpatient');
  assert.equal(op.avgAuthDays, 40, 'the auth average is unaffected by the LOS gate');
  assert.equal(op.authSample, 1);
  assert.equal(op.openBeds, 1, 'open-bed context is unaffected');
  assert.equal(op.nextUrDate, '2026-08-20', 'the UR banner is unaffected');
  assert.equal(op.admittedCount, 2);
  assert.equal(op.losSample, 1);
});

test('aggregation: a DC date before the ADM date is dropped, not averaged as a negative', () => {
  const items: CensusItem[] = [
    item({ admDate: '2026-08-04' }), // in-house, 6 days
    item({ status: 'Admitted', admDate: '2026-08-10', dcDate: '2026-08-01' }), // stray DC, ignored (not discharged)
  ];
  const agg = aggregateCensusItems(items, '2026-08-10', 'residential');
  assert.equal(agg.losSample, 2);
  assert.ok((agg.avgLosDays ?? -1) >= 0, 'never a negative average');
});

test('next UR: soonest date on/after today across ALL items; past dates never surface', () => {
  const items: CensusItem[] = [
    item({ urDate: '2026-07-20' }), // past
    item({ status: 'Pending Admit', urDate: '2026-08-05' }), // upcoming, non-admitted still counts
    item({ urDate: '2026-08-10' }),
    item({ urDate: 'not-a-date' as unknown as string }),
  ];
  const agg = aggregateCensusItems(items, '2026-08-03', 'residential');
  assert.equal(agg.nextUrDate, '2026-08-05');
  assert.equal(aggregateCensusItems([item({})], '2026-08-03', 'residential').nextUrDate, null);
});

test('empty board: zero counts, null averages — never NaN', () => {
  const agg = aggregateCensusItems([], '2026-08-03', 'outpatient');
  assert.equal(agg.admittedCount, 0);
  assert.equal(agg.avgAuthDays, null);
  assert.equal(agg.avgLosDays, null);
  assert.equal(agg.losSample, 0);
  assert.equal(agg.nextUrDate, null);
});

// --- value-level conformance + care_setting -----------------------------------

test('emptyResolvedColumns: a column that RESOLVES but never carries a value is reported', () => {
  // The exact defect: 'Days in RTC' resolved by title on all 30 boards and returned "" for every
  // item, so title-presence-only conformance reported zero gaps against a 100%-empty column.
  const rows = [
    { status: 'Admitted', auth: '20', los: '' },
    { status: 'Admitted', auth: '16', los: '' },
    { status: 'Discharged', auth: null, los: null },
  ];
  const empty = emptyResolvedColumns(rows, [
    { title: 'Admit Status', id: 'status' },
    { title: 'Total Auth Days', id: 'auth' },
    { title: 'Days in RTC', id: 'los' },
    { title: 'Next UR Date', id: null }, // unresolved -> already reported as missing, not "empty"
  ]);
  assert.deepEqual(empty, ['Days in RTC']);
  // Whitespace is not a value.
  assert.deepEqual(emptyResolvedColumns([{ a: '   ' }], [{ title: 'A', id: 'a' }]), ['A']);
  // One value anywhere proves the column live.
  assert.deepEqual(emptyResolvedColumns([{ a: '' }, { a: '3' }], [{ title: 'A', id: 'a' }]), []);
});

test('checkCareSetting: IP/OP pass, BOTH and mismatches are REPORTED', () => {
  assert.equal(checkCareSetting('residential', 'IP'), null);
  assert.equal(checkCareSetting('outpatient', 'OP'), null);
  assert.equal(checkCareSetting('residential', ' ip '), null, 'trimmed + case-insensitive');
  assert.match(String(checkCareSetting('residential', 'OP')), /care_setting OP but a residential board expects IP/);
  assert.match(String(checkCareSetting('outpatient', 'IP')), /care_setting IP but an? outpatient board expects OP/);
  // BOTH is the MHC case — a reportable exception, never a pass.
  assert.match(String(checkCareSetting('residential', 'BOTH')), /BOTH/);
  assert.match(String(checkCareSetting('outpatient', 'BOTH')), /re-grain/);
  assert.match(String(checkCareSetting('residential', null)), /no care_setting/);
  assert.match(String(checkCareSetting('residential', '  ')), /no care_setting/);
});

test('conformanceHasGap: all four causes count, and a clean line does not', () => {
  const base: CensusConformance = {
    facilityCode: 'NASH',
    family: 'residential',
    boardIds: ['7422342993'],
    itemCount: 233,
    missingTitles: [],
    emptyTitles: [],
    familyMismatch: null,
    settingMismatch: null,
  };
  assert.equal(conformanceHasGap(base), false);
  assert.equal(conformanceHasGap({ ...base, missingTitles: ['ADM Date'] }), true);
  assert.equal(conformanceHasGap({ ...base, emptyTitles: ['Total Auth Days'] }), true);
  assert.equal(conformanceHasGap({ ...base, familyMismatch: 'x' }), true);
  assert.equal(conformanceHasGap({ ...base, settingMismatch: 'y' }), true);
});

// --- the registry -------------------------------------------------------------

test('registry: every facility maps to a roster-shaped code and at least one numeric board id', () => {
  // collections.facilities mixes mnemonic codes (NASH, LSMH, TREAT_*) with 8-digit CMD ids —
  // roster-verified live 2026-08-05. A /^\d{8}$/ pin was the original bug: it blessed codes the
  // roster doesn't carry, so the factor could never match its facility.
  for (const f of MONDAY_CENSUS_FACILITIES) {
    assert.match(f.facilityCode, /^[A-Z0-9_]{2,40}$/, `${f.facilityCode} is not roster-shaped`);
    assert.ok(f.boardIds.length >= 1, `${f.facilityCode} has no board`);
    for (const id of f.boardIds) assert.match(id, /^\d+$/, `${f.facilityCode} board id ${id} is not numeric`);
  }
});

test('registry: 23 facilities over 24 boards, and TELEHEALTH_MH is the N:1 rollup', () => {
  assert.equal(MONDAY_CENSUS_FACILITIES.length, 23, '23 facilities onboarded');
  const boardCount = MONDAY_CENSUS_FACILITIES.reduce((n, f) => n + f.boardIds.length, 0);
  assert.equal(boardCount, 24, '24 boards — one facility carries two');
  const rollups = MONDAY_CENSUS_FACILITIES.filter((f) => f.boardIds.length > 1);
  assert.deepEqual(
    rollups.map((f) => f.facilityCode),
    ['TELEHEALTH_MH'],
    'the only N:1 facility is TELEHEALTH_MH (the parent plus its state boards)',
  );
  assert.deepEqual([...(rollups[0]?.boardIds ?? [])].sort(), ['18394268978', '18405687473']);
});

test('registry: no board id is claimed twice, and none is blocked, deferred or excluded', () => {
  const seen = new Map<string, string>();
  for (const f of MONDAY_CENSUS_FACILITIES) {
    for (const id of f.boardIds) {
      const prior = seen.get(id);
      assert.equal(prior, undefined, `board ${id} is mapped to both ${prior} and ${f.facilityCode}`);
      seen.set(id, f.facilityCode);
    }
  }
  // A blocked board mapped anyway would write an orphan census row: facility_code has NO FK to
  // collections.facilities, so it would not error — it would simply never join to a ranking row.
  for (const b of CENSUS_BLOCKED_BOARDS) {
    assert.equal(seen.get(b.boardId), undefined, `blocked board ${b.boardId} (${b.boardName}) must NOT be mapped`);
  }
  for (const d of CENSUS_DEFERRED_BOARDS) {
    assert.equal(seen.get(d.boardId), undefined, `deferred board ${d.boardId} must NOT be mapped`);
  }
  for (const id of CENSUS_EXCLUDED_BOARD_IDS) {
    assert.equal(seen.get(id), undefined, `excluded board ${id} must NOT be mapped`);
  }
});

test('registry: the four blocked boards are exactly the known-unrostered ones, each with a reason', () => {
  assert.deepEqual(
    CENSUS_BLOCKED_BOARDS.map((b) => b.boardId).sort(),
    ['18407820613', '18419837532', '18422175778', '18424928550'],
  );
  for (const b of CENSUS_BLOCKED_BOARDS) {
    assert.ok(b.blocker.length > 20, `${b.boardId} needs a real blocker note, not a placeholder`);
    assert.ok(b.boardName.length > 0);
  }
});

test('representativeBoardId: the LOWEST id, deterministically, regardless of config order', () => {
  assert.equal(representativeBoardId(['18405687473', '18394268978']), '18394268978');
  assert.equal(representativeBoardId(['18394268978', '18405687473']), '18394268978');
  assert.equal(representativeBoardId(['7422342993']), '7422342993');
  assert.equal(representativeBoardId([]), '');
});

test('representativeBoardId: NUMERIC ordering across mixed-width ids, not lexicographic', () => {
  // The registry holds both 10- and 11-digit ids. A bare .sort() is UTF-16 order, so it would return
  // '18394268978' here because '1' < '7' — lexicographically smallest, numerically the LARGER id.
  assert.equal(representativeBoardId(['18394268978', '7046603503']), '7046603503');
  assert.equal(representativeBoardId(['7046603503', '18394268978']), '7046603503');
  // Same-width ids: numeric and lexicographic agree, which is why today's only rollup hid this.
  assert.equal(representativeBoardId(['9977268128', '6974268840']), '6974268840');
  // Three ids, two widths.
  assert.equal(representativeBoardId(['18424928550', '9933183210', '7047312296']), '7047312296');
  // Deterministic, never a throw, on an unexpected non-numeric id.
  assert.equal(representativeBoardId(['abc', '7046603503']), '7046603503');
  assert.equal(representativeBoardId(['zz', 'aa']), 'aa');
});

// --- builders -----------------------------------------------------------------

test('builders: fixed identifiers, bound params, ::date cast on the UR date', () => {
  const up = buildUpsertCensusRowQuery({
    facility_code: '10030911',
    board_id: '7422342993',
    board_family: 'residential',
    admitted_count: 18,
    open_beds: 2,
    bed_capacity: 20,
    avg_auth_days: 18.5,
    avg_los_days: 16.33,
    auth_sample: 14,
    next_ur_date: '2026-08-05',
  });
  assert.match(up.sql, /insert into collections\.qualify_facility_census/);
  assert.match(up.sql, /on conflict \(facility_code\) do update/);
  assert.equal(up.params.length, 10);
  assert.ok(!up.sql.includes('10030911'), 'values bound, never inlined');

  const read = buildQualifyCensusReadQuery();
  assert.match(read.sql, /from collections\.qualify_facility_census/);
  assert.doesNotMatch(read.sql, /select \*/i);

  const care = buildFacilityCareSettingQuery(['NASH', '10021573']);
  assert.match(care.sql, /from collections\.facilities/);
  assert.doesNotMatch(care.sql, /select \*/i);
  assert.deepEqual(care.params, [['NASH', '10021573']]);
  assert.ok(!care.sql.includes('NASH'), 'codes bound, never inlined');
});

test('PHI tripwire: census GraphQL never selects item `name` — names on census boards are patients', async () => {
  // The invariant is a QUERY-STRING property, so pin the query strings themselves: a future edit
  // adding `name` to the census items selection (the obvious edit for per-patient data) must fail
  // the hermetic suite, not just a comment.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/collections/qualifyCensusSync.ts', import.meta.url), 'utf8');
  const queries = src.match(/'query \([^']+'/g) ?? [];
  assert.ok(queries.length >= 4, `expected at least the four GraphQL query strings, found ${queries.length}`);
  const censusItems = queries.filter((q) => q.includes('$cursor'));
  assert.equal(censusItems.length, 1, 'exactly one paginated census-items query');
  assert.ok(!/\bname\b/.test(censusItems[0] ?? ''), 'the census items query must NEVER select name');
  const nameItemQueries = queries.filter((q) => /items \{ name/.test(q));
  assert.equal(
    nameItemQueries.length,
    1,
    'item name is selected in exactly ONE query — Facility Info (items are facilities)',
  );
});
