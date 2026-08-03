/**
 * Phase G census aggregation — column resolution by TITLE (per-board ids drift; the recon trap),
 * the two board families, the admitted/open-bed label rules, auth null-guard, upcoming-UR
 * selection, and the upsert/read builders' param discipline. All pure; the monday fetch is I/O
 * (qualifyCensusSync.ts) and is exercised by the operator CLI, never this suite.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  resolveCensusColumns,
  aggregateCensusItems,
  buildUpsertCensusRowQuery,
  buildQualifyCensusReadQuery,
  MONDAY_CENSUS_BOARDS,
  type CensusItem,
} from '../src/collections/qualifyCensus';

test('column resolution: per-board ids resolve by TITLE; family picks the status/LOS vocabulary', () => {
  const nashville = resolveCensusColumns(
    [
      { id: 'admit_status___1', title: 'Admit Status' },
      { id: 'numeric_mkt2rb5c', title: 'Total Auth Days' },
      { id: 'formula_mkt2dqph', title: 'Days in RTC' },
      { id: 'date_mkt28z4m', title: 'Next UR Date' },
    ],
    'residential',
  );
  assert.equal(nashville.statusId, 'admit_status___1');
  assert.equal(nashville.authId, 'numeric_mkt2rb5c');
  assert.equal(nashville.losId, 'formula_mkt2dqph');
  assert.equal(nashville.urId, 'date_mkt28z4m');
  assert.deepEqual(nashville.missing, []);

  // Lonestar mints DIFFERENT ids for the same titles — title matching absorbs that (recon trap #1).
  const lonestar = resolveCensusColumns(
    [
      { id: 'admit_status___1', title: 'Admit Status' },
      { id: 'numeric_mkt2shja', title: 'Total Auth Days' },
      { id: 'formula_mkt2bdqf', title: 'Days in RTC' },
      { id: 'date_mkt2exhh', title: 'Next UR Date' },
    ],
    'residential',
  );
  assert.equal(lonestar.authId, 'numeric_mkt2shja');

  // Outpatient family: 'Status' + 'Days in OP'; a board missing columns NAMES them (conformance).
  const op = resolveCensusColumns([{ id: 's1', title: 'Status' }], 'outpatient');
  assert.equal(op.statusId, 's1');
  assert.deepEqual(op.missing, ['Total Auth Days', 'Days in OP', 'Next UR Date']);
});

const item = (over: Partial<CensusItem>): CensusItem => ({ status: 'Admitted', authDays: null, losDays: null, urDate: null, ...over });

test('aggregation: admitted by label, open beds by STATUS label (never names), auth null-guarded', () => {
  const items: CensusItem[] = [
    item({ authDays: 20, losDays: 17 }),
    item({ authDays: 16, losDays: 21 }),
    item({ authDays: null, losDays: 10 }), // admitted, NO auth set → excluded from auth avg (the plan's guard)
    item({ status: 'Discharged', authDays: 99, losDays: 99 }), // not admitted → excluded entirely
    item({ status: 'Open Bed (Male)' }),
    item({ status: 'Open Bed (Either M/F)' }),
    item({ status: 'Pending Admit' }),
  ];
  const agg = aggregateCensusItems(items, '2026-08-03');
  assert.equal(agg.admittedCount, 3);
  assert.equal(agg.openBeds, 2);
  assert.equal(agg.avgAuthDays, 18); // (20+16)/2 — the null-auth admit does not fabricate a term
  assert.equal(agg.authSample, 2);
  assert.equal(agg.avgLosDays, 16); // (17+21+10)/3
});

test('next UR: soonest date on/after today across ALL items; past dates never surface', () => {
  const items: CensusItem[] = [
    item({ urDate: '2026-07-20' }), // past
    item({ status: 'Pending Admit', urDate: '2026-08-05' }), // upcoming, non-admitted still counts
    item({ urDate: '2026-08-10' }),
    item({ urDate: 'not-a-date' as unknown as string }),
  ];
  const agg = aggregateCensusItems(items, '2026-08-03');
  assert.equal(agg.nextUrDate, '2026-08-05');
  assert.equal(aggregateCensusItems([item({})], '2026-08-03').nextUrDate, null);
});

test('empty board: zero counts, null averages — never NaN', () => {
  const agg = aggregateCensusItems([], '2026-08-03');
  assert.equal(agg.admittedCount, 0);
  assert.equal(agg.avgAuthDays, null);
  assert.equal(agg.avgLosDays, null);
  assert.equal(agg.nextUrDate, null);
});

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
});

test('board registry: verified boards map to real 8-digit facility codes', () => {
  for (const b of MONDAY_CENSUS_BOARDS) {
    assert.match(b.facilityCode, /^\d{8}$/);
    assert.match(b.boardId, /^\d+$/);
  }
});

test('PHI tripwire: census GraphQL never selects item `name` — names on census boards are patients', async () => {
  // The invariant is a QUERY-STRING property, so pin the query strings themselves: a future edit
  // adding `name` to the census items selection (the obvious edit for per-patient data) must fail
  // the hermetic suite, not just a comment.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/collections/qualifyCensusSync.ts', import.meta.url), 'utf8');
  const queries = src.match(/'query \([^']+'/g) ?? [];
  assert.ok(queries.length >= 4, `expected the four GraphQL query strings, found ${queries.length}`);
  const censusItems = queries.filter((q) => q.includes('$cursor'));
  assert.equal(censusItems.length, 1, 'exactly one paginated census-items query');
  assert.ok(!/\bname\b/.test(censusItems[0] ?? ''), 'the census items query must NEVER select name');
  const nameItemQueries = queries.filter((q) => /items \{ name/.test(q));
  assert.equal(nameItemQueries.length, 1, 'item name is selected in exactly ONE query — Facility Info (items are facilities)');
});
