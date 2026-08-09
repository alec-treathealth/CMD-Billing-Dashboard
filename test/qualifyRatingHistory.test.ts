/**
 * qualifyRatingHistory — the nightly (prefix × payer) rating snapshot behind the smoke-shell
 * tape's 90d delta (mig 0093). Hermetic: fake read/write DBs (plain {query} objects routed by
 * regex, the refreshChargeRollup.test.ts idiom), injected clock, injected rate callback.
 *
 * What must hold:
 *   - statement ORDER per date: run-log start row FIRST (durability), then the aggregate read,
 *     then ONE upsert, then the ok=true close — and a failure records ok=false on the SAME row
 *     and RETHROWS (never swallowed).
 *   - the GROUPING SETS pair-grain row (facility null) anchors the stored pair aggregates and is
 *     NEVER handed to the rate callback as a facility.
 *   - catch-up: dates are capped per run, oldest first, and dates_pending is exact.
 *   - builders: values are bound $n params only; the tape projection is NON-DOLLAR.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDaysIso,
  buildMissingAsOfDatesQuery,
  buildPolicyTapeQuery,
  buildRatingDailyUpsert,
  buildRatingHistoryAggQuery,
  runQualifyRatingHistory,
  QUALIFY_TAPE_DELTA_DAYS,
  QUALIFY_TAPE_MIN_MEMBERS,
  QUALIFY_TAPE_TOP_N,
  type QualifyRatingHistoryAggRow,
  type QualifyRatingQueryDb,
  type QualifyRatingDailyRow,
} from '../src/collections/qualifyRatingHistory.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

const ENTITY_IDS = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];

// ── date helper ──────────────────────────────────────────────────────────────────────────────────

test('addDaysIso does UTC day math and rejects garbage', () => {
  assert.equal(addDaysIso('2026-08-08', -89), '2026-05-11');
  assert.equal(addDaysIso('2026-08-08', 1), '2026-08-09');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28'); // non-leap
  assert.equal(addDaysIso('2024-03-01', -1), '2024-02-29'); // leap
  assert.throws(() => addDaysIso('08/08/2026', 1));
  assert.throws(() => addDaysIso("2026-08-08'; drop table x; --", 1));
});

// ── builders ─────────────────────────────────────────────────────────────────────────────────────

test('buildMissingAsOfDatesQuery binds anchor/horizon/cap and reads only the run ledger', () => {
  const q = buildMissingAsOfDatesQuery('2026-08-08', 180, 180);
  assert.deepEqual(q.params, ['2026-08-08', 180, 180]);
  assert.match(q.sql, /generate_series\(\$1::date - \(\$2::int - 1\), \$1::date/);
  assert.match(q.sql, /collections\.qualify_rating_run/);
  assert.match(q.sql, /r\.ok = true/);
  assert.match(q.sql, /order by d\.d asc limit \$3::int/);
  // no literal dates baked into the SQL
  assert.doesNotMatch(q.sql, /2026-/);
});

test('buildRatingHistoryAggQuery mirrors the ranking aggregate discipline', () => {
  const q = buildRatingHistoryAggQuery(ENTITY_IDS, '2026-05-11', '2026-08-09');
  assert.deepEqual(q.params, [ENTITY_IDS, '2026-05-11', '2026-08-09']);
  // half-open payment window, tenant scope as a bound array — never literals
  assert.match(q.sql, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.match(q.sql, /payment_received >= \$2::date and payment_received < \$3::date/);
  // both grains from one scan
  assert.match(q.sql, /group by grouping sets/);
  assert.match(q.sql, /\(member_id_prefix_bidx, primary_payer, facility\), \(member_id_prefix_bidx, primary_payer\)/);
  // the 0059 reliable-allowed ruling: e2 excluded from the allowed sums
  assert.match(q.sql, /filter \(where allowed_tier <> 'e2'\)/);
  // the token is counted, never projected bare — distinct count only
  assert.match(q.sql, /count\(distinct member_id_bidx\)::int as distinct_patients/);
  assert.doesNotMatch(q.sql, /select \*/i);
  // dimension crosswalk (FACILITY_DIM_JOINS mirror)
  assert.match(q.sql, /left join collections\.cmd_facility_aliases a on upper\(a\.facility_text\) = upper\(agg\.facility\)/);
});

test('buildRatingHistoryAggQuery fail-closes on a bad entity scope', () => {
  assert.throws(() => buildRatingHistoryAggQuery([], '2026-05-11', '2026-08-09'));
  assert.throws(() => buildRatingHistoryAggQuery(['not-a-uuid'], '2026-05-11', '2026-08-09'));
});

test('buildRatingDailyUpsert aligns one array per column and upserts on the 0093 PK', () => {
  const rows: QualifyRatingDailyRow[] = [
    {
      token: 'a'.repeat(64),
      payer: 'ANTHEM BLUE CROSS',
      rating: 71,
      band: '65',
      lineCount: 40,
      distinctMembers: 6,
      confirmedClaims: 30,
      pctAllowed: 55.2,
      medianDaysToPayment: 23,
      facilityCount: 2,
      ratedFacilities: 2,
      billed: 1000,
      allowed: 552,
      paid: 400,
    },
    {
      token: 'b'.repeat(64),
      payer: 'CIGNA',
      rating: null,
      band: null,
      lineCount: 2,
      distinctMembers: 1,
      confirmedClaims: 1,
      pctAllowed: null,
      medianDaysToPayment: null,
      facilityCount: 1,
      ratedFacilities: 0,
      billed: 100,
      allowed: null,
      paid: 0,
    },
  ];
  const q = buildRatingDailyUpsert('2026-08-08', 90, rows);
  assert.equal(q.params.length, 16); // as_of + window + 14 aligned arrays
  assert.equal(q.params[0], '2026-08-08');
  assert.equal(q.params[1], 90);
  for (const p of q.params.slice(2)) {
    assert.ok(Array.isArray(p));
    assert.equal((p as unknown[]).length, rows.length);
  }
  assert.match(q.sql, /on conflict \(as_of_date, member_id_prefix_bidx, primary_payer\) do update/);
  assert.match(q.sql, /computed_at = now\(\)/);
  // nullable rating rides as a null array element, not a 0
  assert.equal((q.params[4] as unknown[])[1], null);
});

test('buildPolicyTapeQuery: bounded params, member floor, and a NON-DOLLAR projection', () => {
  const q = buildPolicyTapeQuery();
  assert.deepEqual(q.params, [QUALIFY_TAPE_DELTA_DAYS, QUALIFY_TAPE_MIN_MEMBERS, QUALIFY_TAPE_TOP_N]);
  assert.match(q.sql, /prev\.as_of_date = l\.d - \$1::int/);
  assert.match(q.sql, /cur\.distinct_members >= \$2::int/);
  assert.match(q.sql, /limit \$3::int/);
  assert.match(q.sql, /cur\.rating is not null and prev\.rating is not null/);
  assert.match(q.sql, /left join collections\.qualify_prefix_echo/);
  // dollar columns exist on the table and MUST NOT be projected here (admissions_seat parity)
  assert.doesNotMatch(q.sql, /billed_amount|allowed_amount|paid_amount/);
  // clamps
  const clamped = buildPolicyTapeQuery({ deltaDays: 999999, minMembers: -5, limit: 5000 });
  assert.deepEqual(clamped.params, [3650, 0, 100]);
});

// ── orchestration fakes ──────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string;
  params?: unknown[];
}

function classify(sql: string): string {
  if (/generate_series/i.test(sql)) return 'missing_dates';
  if (/insert into collections\.qualify_rating_run/i.test(sql)) return 'run_start';
  if (/grouping sets/i.test(sql)) return 'agg_read';
  if (/insert into collections\.qualify_policy_rating_daily/i.test(sql)) return 'upsert';
  if (/update collections\.qualify_rating_run/i.test(sql)) return 'run_finish';
  return 'other';
}

/** A pair-grain row + facility rows for one (token, payer) pair. */
function pairFixture(
  token: string,
  payer: string,
  facs: Array<Partial<QualifyRatingHistoryAggRow> & { facility: string }>,
  pair: Partial<QualifyRatingHistoryAggRow>,
): QualifyRatingHistoryAggRow[] {
  const base = {
    member_id_prefix_bidx: token,
    primary_payer: payer,
    line_count: 10,
    distinct_patients: 4,
    confirmed_claims: 8,
    billed: 1000,
    allowed: 500,
    pct_allowed: 50,
    paid: 400,
    median_days_to_payment: 20,
    facility_name: null,
    care_setting: null,
    facility_code: null,
  };
  return [
    { ...base, ...pair, facility: null } as QualifyRatingHistoryAggRow,
    ...facs.map((f) => ({ ...base, ...f }) as QualifyRatingHistoryAggRow),
  ];
}

function fakeDbs(opts: {
  missing: string[];
  aggRows?: QualifyRatingHistoryAggRow[];
  failAggOnDate?: string;
}): { readDb: QualifyRatingQueryDb; writeDb: QualifyRatingQueryDb; calls: Call[] } {
  const calls: Call[] = [];
  let nextRunId = 7;
  let currentAsOf: string | null = null;
  const writeDb: QualifyRatingQueryDb = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/generate_series/i.test(sql)) {
        return { rows: opts.missing.map((d) => ({ as_of: d })) as never[] };
      }
      if (/insert into collections\.qualify_rating_run/i.test(sql)) {
        currentAsOf = String(params[0]);
        return { rows: [{ id: String(nextRunId++) }] as never[] };
      }
      return { rows: [] };
    },
  };
  const readDb: QualifyRatingQueryDb = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/grouping sets/i.test(sql)) {
        if (opts.failAggOnDate && currentAsOf === opts.failAggOnDate) {
          throw new Error('canceling statement due to statement timeout');
        }
        return { rows: (opts.aggRows ?? []) as never[] };
      }
      return { rows: [] };
    },
  };
  return { readDb, writeDb, calls };
}

function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

// ── orchestration ────────────────────────────────────────────────────────────────────────────────

test('one date: start row FIRST, one agg read, one upsert, ok close — in that order', async () => {
  const token = 'c'.repeat(64);
  const aggRows = [
    ...pairFixture(token, 'ANTHEM', [{ facility: 'TREAT CA', facility_code: 'TREAT_CA', distinct_patients: 5 }], {
      distinct_patients: 5,
      line_count: 22,
    }),
  ];
  const { readDb, writeDb, calls } = fakeDbs({ missing: ['2026-08-08'], aggRows });
  const rated: unknown[] = [];
  const stats = await runQualifyRatingHistory({
    readDb,
    writeDb,
    entityIds: ENTITY_IDS,
    today: '2026-08-09',
    now: fakeClock([1000, 2000, 61000, 61000]),
    rate: (input) => {
      rated.push(input);
      return { rating: 71, band: '65', ratedFacilities: 1 };
    },
  });

  assert.deepEqual(
    calls.map((c) => classify(c.sql)),
    ['missing_dates', 'run_start', 'agg_read', 'upsert', 'run_finish'],
  );
  // the catch-up horizon is anchored at YESTERDAY — the newest CLOSED date — never today
  // (an as_of=today snapshot would rate a mostly-empty final day and freeze wrong)
  const missingCall = calls.find((c) => classify(c.sql) === 'missing_dates')!;
  assert.equal(missingCall.params?.[0], '2026-08-08');
  assert.equal(stats.ok, true);
  assert.equal(stats.dates_computed, 1);
  assert.equal(stats.pairs_written, 1);
  assert.equal(stats.dates_pending, 0);
  assert.equal(stats.from_date, '2026-08-08');

  // the rate callback saw ONLY the facility row, keyed to the pair's payer, with the 90d window
  assert.equal(rated.length, 1);
  const input = rated[0] as {
    payer: string;
    facilities: Array<{ facility: string; distinctPatients: number }>;
    asOf: string;
    windowDays: number;
  };
  assert.equal(input.payer, 'ANTHEM');
  assert.equal(input.asOf, '2026-08-08');
  assert.equal(input.windowDays, 90);
  assert.deepEqual(
    input.facilities.map((f) => f.facility),
    ['TREAT CA'],
  );

  // the agg read was windowed [as_of-89, as_of+1)
  const agg = calls.find((c) => classify(c.sql) === 'agg_read')!;
  assert.equal(agg.params?.[1], '2026-05-11');
  assert.equal(agg.params?.[2], '2026-08-09');

  // the upsert carried the pair-grain (deduped) member count and the callback's rating
  const upsert = calls.find((c) => classify(c.sql) === 'upsert')!;
  assert.deepEqual(upsert.params?.[2], [token]); // token array
  assert.deepEqual(upsert.params?.[4], [71]); // rating array
  assert.deepEqual(upsert.params?.[7], [5]); // distinct_members from the PAIR row
});

test('the pair-grain row is never rated as a facility, and pairs group correctly', async () => {
  const tokenA = 'a'.repeat(64);
  const tokenB = 'b'.repeat(64);
  const aggRows = [
    ...pairFixture(
      tokenA,
      'ANTHEM',
      [
        { facility: 'ONE', distinct_patients: 3 },
        { facility: 'TWO', distinct_patients: 4 },
      ],
      { distinct_patients: 6 },
    ),
    ...pairFixture(tokenB, 'CIGNA', [{ facility: 'THREE', distinct_patients: 1 }], { distinct_patients: 1 }),
  ];
  const { readDb, writeDb, calls } = fakeDbs({ missing: ['2026-08-08'], aggRows });
  const seen: Array<{ payer: string; count: number }> = [];
  await runQualifyRatingHistory({
    readDb,
    writeDb,
    entityIds: ENTITY_IDS,
    today: '2026-08-08',
    now: fakeClock([0]),
    rate: (input) => {
      seen.push({ payer: input.payer, count: input.facilities.length });
      return { rating: null, band: null, ratedFacilities: 0 };
    },
  });
  assert.deepEqual(seen, [
    { payer: 'ANTHEM', count: 2 },
    { payer: 'CIGNA', count: 1 },
  ]);
  const upsert = calls.find((c) => classify(c.sql) === 'upsert')!;
  assert.deepEqual(upsert.params?.[11], [2, 1]); // facility_count per pair ($12 = params[11])
});

test('catch-up caps dates per run, oldest first, with an exact pending count', async () => {
  const missing = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'];
  const { readDb, writeDb, calls } = fakeDbs({ missing, aggRows: [] });
  const stats = await runQualifyRatingHistory({
    readDb,
    writeDb,
    entityIds: ENTITY_IDS,
    today: '2026-08-08',
    maxDatesPerRun: 2,
    now: fakeClock([0]),
    rate: () => ({ rating: null, band: null, ratedFacilities: 0 }),
  });
  assert.equal(stats.dates_computed, 2);
  assert.equal(stats.dates_pending, 2);
  assert.equal(stats.from_date, '2026-08-01');
  assert.equal(stats.to_date, '2026-08-02');
  // an EMPTY window writes no daily rows but still closes its run row ok (so it never re-runs)
  assert.equal(calls.filter((c) => classify(c.sql) === 'upsert').length, 0);
  assert.equal(calls.filter((c) => classify(c.sql) === 'run_finish').length, 2);
  const finishes = calls.filter((c) => classify(c.sql) === 'run_finish');
  assert.equal(finishes[0]?.params?.[1], 0); // pairs_written 0, ok=true rides in the SQL
  assert.match(finishes[0]!.sql, /ok = true/);
});

test('a poison date records ok=false, does NOT starve newer dates, and the run still fails', async () => {
  const { readDb, writeDb, calls } = fakeDbs({
    missing: ['2026-08-07', '2026-08-08'],
    aggRows: [],
    failAggOnDate: '2026-08-07',
  });
  await assert.rejects(
    runQualifyRatingHistory({
      readDb,
      writeDb,
      entityIds: ENTITY_IDS,
      today: '2026-08-09',
      now: fakeClock([0]),
      rate: () => ({ rating: null, band: null, ratedFacilities: 0 }),
    }),
    /1 of 2 as_of date\(s\) failed.*statement timeout/,
  );
  const kinds = calls.map((c) => classify(c.sql));
  // the FIRST date failed and was recorded; the SECOND date still ran to completion (no
  // starvation) — and the run threw at the end (never swallowed)
  assert.deepEqual(kinds, [
    'missing_dates',
    'run_start',
    'agg_read',
    'run_finish',
    'run_start',
    'agg_read',
    'run_finish',
  ]);
  const finishes = calls.filter((c) => classify(c.sql) === 'run_finish');
  assert.match(finishes[0]!.sql, /ok = false/);
  assert.match(String(finishes[0]!.params?.[1]), /statement timeout/);
  assert.match(finishes[1]!.sql, /ok = true/);
});

test('nothing pending: no run rows, no reads, honest zero stats', async () => {
  const { readDb, writeDb, calls } = fakeDbs({ missing: [] });
  const stats = await runQualifyRatingHistory({
    readDb,
    writeDb,
    entityIds: ENTITY_IDS,
    today: '2026-08-08',
    now: fakeClock([0]),
    rate: () => {
      throw new Error('rate must not be called');
    },
  });
  assert.deepEqual(calls.map((c) => classify(c.sql)), ['missing_dates']);
  assert.equal(stats.dates_computed, 0);
  assert.equal(stats.pairs_written, 0);
  assert.equal(stats.from_date, null);
});

test('a malformed anchor date fail-closes before touching the DB', async () => {
  const { readDb, writeDb, calls } = fakeDbs({ missing: [] });
  await assert.rejects(
    runQualifyRatingHistory({
      readDb,
      writeDb,
      entityIds: ENTITY_IDS,
      today: 'tomorrow-ish',
      now: fakeClock([0]),
      rate: () => ({ rating: null, band: null, ratedFacilities: 0 }),
    }),
    /Invalid anchor date/,
  );
  assert.equal(calls.length, 0);
});
