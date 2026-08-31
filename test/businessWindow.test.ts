/**
 * src/businessWindow.ts — the canonical window primitive.
 *
 * Hermetic: node:test only, no DB, no LLM, no clock the test does not inject. Every `now` below is
 * an explicit instant, so the DST and midnight-rollover cases are real assertions rather than
 * something that only fires twice a year.
 *
 * The tier-edge half of the contract (windowDays → windowAgeMultiplier) is asserted APP-SIDE, in
 * app/test/businessWindowRating.test.tsx (ruled 2026-08-30).
 *
 * ⚠ NOT because a root test cannot reach app/ — it demonstrably can, and this very file does it
 * below to import qualifyWindowBounds, exactly as test/qualifyRatingV2.test.ts already imports
 * ratingV2. The import-direction rule constrains SHIPPED modules, not the root test suite. The
 * split is a deliberate placement: the rating tiers are a Qualify concern and belong with Qualify's
 * own suite, so a change to them fails next to the code that owns them. Recording the real reason
 * because the plausible-sounding one is wrong and would mislead the next reader.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUSINESS_TZ,
  BUSINESS_YEAR_MAX,
  BUSINESS_YEAR_MIN,
  businessDayIso,
  businessWindowBounds,
  type BusinessWindow,
} from '../src/businessWindow.js';
import { qualifyWindowBounds, type QualifyTrailingDays } from '../app/lib/qualify/contract';

/** Whole days between two ISO date strings. Independent of the module under test on purpose — a
 *  helper that reused businessWindow's own arithmetic could not catch an error in it. */
const daysApart = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

// ── EXACT-N: the core arithmetic claim ──────────────────────────────────────────────────────────
test('trailing: to − from is EXACTLY N days, for every N the product offers', () => {
  // Off-by-one here is the whole risk. An inclusive-inclusive window spans N+1 days and a
  // "N-1 back from today" one spans N-1; both look right in a UI and are wrong in a Δ.
  const now = new Date('2026-08-30T19:00:00Z');
  for (const days of [7, 14, 30, 60, 90, 180, 270, 365]) {
    const b = businessWindowBounds({ kind: 'trailing', days }, now);
    assert.equal(daysApart(b.from, b.to), days, `[${b.from}, ${b.to}) must span ${days} days`);
    assert.equal(b.windowDays, days, 'windowDays must agree with the bounds it was derived from');
  }
});

test('trailing: the upper bound is EXCLUSIVE and is business-tomorrow, so all of today is in-window', () => {
  // 12:00 Pacific on 2026-08-30 → business day 2026-08-30 → to = 08-31.
  const b = businessWindowBounds({ kind: 'trailing', days: 30 }, new Date('2026-08-30T19:00:00Z'));
  assert.equal(b.to, '2026-08-31');
  assert.equal(b.from, '2026-08-01');
});

// ── THE FAILURE THE MODULE EXISTS TO PREVENT ────────────────────────────────────────────────────
test('late-afternoon Pacific: UTC is already tomorrow and the window must NOT slide forward', () => {
  // THE EXACT CONTRACT contract.ts:1071-1077 DOCUMENTS. Vercel runs TZ=UTC. From ~17:00 Pacific to
  // midnight Pacific, new Date().toISOString() is already the NEXT day — so a window anchored on
  // the raw UTC date is a full day ahead of the surface beside it, every day, for that stretch.
  //
  // 2026-08-30T23:30:00Z is 16:30 PDT on 08-30. Still 08-30 Pacific, but note UTC has not rolled
  // yet either — this is the control.
  const before = businessWindowBounds({ kind: 'trailing', days: 30 }, new Date('2026-08-30T23:30:00Z'));
  assert.equal(before.to, '2026-08-31', 'control: 16:30 PDT, UTC still 08-30');

  // 2026-08-31T02:00:00Z is 19:00 PDT on 08-30 — UTC has rolled to 08-31, Pacific has NOT.
  const after = businessWindowBounds({ kind: 'trailing', days: 30 }, new Date('2026-08-31T02:00:00Z'));
  assert.equal(after.to, '2026-08-31', '19:00 PDT on 08-30 — the business day is STILL 08-30');
  assert.deepEqual(after, before, 'the whole window is identical either side of the UTC midnight roll');

  // A raw-UTC anchor would have produced this instead. Asserted as the WRONG answer so the test
  // states what it is defending against, not merely that today's output is stable.
  assert.notEqual(after.to, '2026-09-01', 'a UTC-anchored window would have slid a day forward');
});

test('the Pacific day rolls at LOCAL midnight — 08:00Z under PST, 07:00Z under PDT', () => {
  // PST (UTC-8): local midnight is 08:00Z.
  assert.equal(businessDayIso(new Date('2026-01-15T07:59:59Z')), '2026-01-14', '23:59:59 PST');
  assert.equal(businessDayIso(new Date('2026-01-15T08:00:00Z')), '2026-01-15', '00:00:00 PST');
  // PDT (UTC-7): local midnight is 07:00Z. A FIXED OFFSET WOULD GET ONE OF THESE TWO PAIRS WRONG.
  assert.equal(businessDayIso(new Date('2026-07-15T06:59:59Z')), '2026-07-14', '23:59:59 PDT');
  assert.equal(businessDayIso(new Date('2026-07-15T07:00:00Z')), '2026-07-15', '00:00:00 PDT');
});

// ── DST ─────────────────────────────────────────────────────────────────────────────────────────
test('DST spring-forward: the day the clocks skip 02:00 is still exactly one calendar day', () => {
  // 2026-03-08 is the US spring-forward. 02:00 PST jumps to 03:00 PDT, so that civil day is 23
  // HOURS long. Calendar arithmetic must be unaffected — the window is counted in DAYS, not hours,
  // which is why every calculation happens on UTC midnights after the civil date is resolved.
  const b = businessWindowBounds({ kind: 'trailing', days: 7 }, new Date('2026-03-08T20:00:00Z'));
  assert.equal(b.to, '2026-03-09');
  assert.equal(b.from, '2026-03-02');
  assert.equal(daysApart(b.from, b.to), 7, 'a 23-hour day does not shorten the window');
  assert.equal(b.windowDays, 7);

  // And the day boundary itself moves with the transition: on 03-07 local midnight is 08:00Z…
  assert.equal(businessDayIso(new Date('2026-03-08T07:00:00Z')), '2026-03-07', '23:00 PST on 03-07');
  assert.equal(businessDayIso(new Date('2026-03-08T08:00:00Z')), '2026-03-08', '00:00 PST — day rolls');
  // …and by 03-09 it is 07:00Z, an hour earlier in UTC terms.
  assert.equal(businessDayIso(new Date('2026-03-09T07:00:00Z')), '2026-03-09', '00:00 PDT — day rolls');
});

test('DST fall-back: the day the clocks repeat 01:00 is still exactly one calendar day', () => {
  // 2026-11-01 is the US fall-back — 02:00 PDT returns to 01:00 PST, a 25-HOUR civil day.
  const b = businessWindowBounds({ kind: 'trailing', days: 7 }, new Date('2026-11-01T20:00:00Z'));
  assert.equal(b.to, '2026-11-02');
  assert.equal(b.from, '2026-10-26');
  assert.equal(daysApart(b.from, b.to), 7, 'a 25-hour day does not lengthen the window');
  assert.equal(b.windowDays, 7);

  assert.equal(businessDayIso(new Date('2026-11-01T06:30:00Z')), '2026-10-31', '23:30 PDT on 10-31');
  assert.equal(businessDayIso(new Date('2026-11-02T07:30:00Z')), '2026-11-01', '23:30 PST on 11-01');
  assert.equal(businessDayIso(new Date('2026-11-02T08:00:00Z')), '2026-11-02', '00:00 PST — day rolls');
});

test('a trailing window that SPANS a DST transition still spans exactly N days', () => {
  // 30 days back from 2026-03-20 crosses spring-forward; from 2026-11-15 crosses fall-back. Each
  // window contains a 23- or 25-hour civil day, and neither may be 29 or 31 days long.
  for (const [now, label] of [
    [new Date('2026-03-20T20:00:00Z'), 'spans spring-forward'],
    [new Date('2026-11-15T20:00:00Z'), 'spans fall-back'],
  ] as const) {
    const b = businessWindowBounds({ kind: 'trailing', days: 30 }, now);
    assert.equal(daysApart(b.from, b.to), 30, label);
  }
});

// ── CALENDAR WINDOWS ────────────────────────────────────────────────────────────────────────────
test('calendar month: half-open [1st, 1st of next), and December rolls the YEAR', () => {
  const dec = businessWindowBounds({ kind: 'month', year: 2026, month: 12 });
  assert.equal(dec.from, '2026-12-01');
  assert.equal(dec.to, '2027-01-01', 'month 13 must roll into January of the next year');
  assert.equal(dec.priorFrom, '2026-11-01');
  assert.equal(dec.priorTo, '2026-12-01');
  assert.equal(dec.windowDays, 31);

  // And the mirror case: January's PRIOR window rolls BACKWARD across the year boundary.
  const jan = businessWindowBounds({ kind: 'month', year: 2026, month: 1 });
  assert.equal(jan.from, '2026-01-01');
  assert.equal(jan.to, '2026-02-01');
  assert.equal(jan.priorFrom, '2025-12-01', 'month 0 must roll into December of the previous year');
  assert.equal(jan.priorTo, '2026-01-01');
});

test('calendar month: windowDays is the TRUE length — 28, 29, 30 or 31, never rounded', () => {
  // RULED 2026-08-30: a bounds primitive reports the truth; it does not round to protect a
  // downstream consumer. The consequence for windowAgeMultiplier is real and is filed as an open
  // Qualify decision — see the windowDays docblock.
  assert.equal(businessWindowBounds({ kind: 'month', year: 2026, month: 2 }).windowDays, 28, 'Feb 2026');
  assert.equal(businessWindowBounds({ kind: 'month', year: 2028, month: 2 }).windowDays, 29, 'Feb 2028 is a leap year');
  assert.equal(businessWindowBounds({ kind: 'month', year: 2026, month: 3 }).windowDays, 31, 'March');
  assert.equal(businessWindowBounds({ kind: 'month', year: 2026, month: 4 }).windowDays, 30, 'April');
  // 2100 is NOT a leap year (divisible by 100, not by 400) — the case a naive %4 check gets wrong.
  assert.equal(businessWindowBounds({ kind: 'month', year: 2100, month: 2 }).windowDays, 28, 'Feb 2100');
});

test('calendar year: half-open, prior is the previous year, and leap years report 366', () => {
  const y = businessWindowBounds({ kind: 'year', year: 2026 });
  assert.deepEqual(y, {
    from: '2026-01-01', to: '2027-01-01',
    priorFrom: '2025-01-01', priorTo: '2026-01-01',
    windowDays: 365,
  });
  assert.equal(businessWindowBounds({ kind: 'year', year: 2028 }).windowDays, 366, '2028 is a leap year');
});

test('calendar windows ignore `now` entirely — they are explicit, not anchored', () => {
  const a = businessWindowBounds({ kind: 'month', year: 2026, month: 6 }, new Date('2020-01-01T00:00:00Z'));
  const b = businessWindowBounds({ kind: 'month', year: 2026, month: 6 }, new Date('2099-12-31T23:59:59Z'));
  assert.deepEqual(a, b);
});

// ── PRIOR-WINDOW ADJACENCY ──────────────────────────────────────────────────────────────────────
test('prior window is ADJACENT and equal-length for trailing — Qualify Δ depends on both', () => {
  const now = new Date('2026-08-30T19:00:00Z');
  for (const days of [7, 14, 30, 60, 90, 180, 270, 365]) {
    const b = businessWindowBounds({ kind: 'trailing', days }, now);
    assert.equal(b.priorTo, b.from, `priorTo must meet from exactly (${days}d) — no gap, no overlap`);
    assert.equal(daysApart(b.priorFrom, b.priorTo), days, `prior window must also span ${days} days`);
    // Non-overlap restated as the property that actually matters: the two spans share no day.
    assert.ok(b.priorTo <= b.from, 'prior window must end no later than this one begins');
  }
});

test('prior window is adjacent for calendar windows too', () => {
  for (const w of [
    { kind: 'month', year: 2026, month: 3 },
    { kind: 'month', year: 2026, month: 1 },
    { kind: 'year', year: 2026 },
  ] as BusinessWindow[]) {
    const b = businessWindowBounds(w);
    assert.equal(b.priorTo, b.from, 'priorTo === from');
  }
});

// ── FAIL LOUD ───────────────────────────────────────────────────────────────────────────────────
test('a nonsensical window THROWS rather than returning plausible garbage', () => {
  // Everything downstream will treat this module as the authority. A silently-wrong date range is
  // the class of bug found a quarter later in a number nobody can reproduce.
  assert.throws(() => businessWindowBounds({ kind: 'trailing', days: 0 }), /positive integer/);
  assert.throws(() => businessWindowBounds({ kind: 'trailing', days: -30 }), /positive integer/);
  assert.throws(() => businessWindowBounds({ kind: 'trailing', days: 1.5 }), /positive integer/);
  assert.throws(() => businessWindowBounds({ kind: 'trailing', days: NaN }), /positive integer/);
  assert.throws(() => businessWindowBounds({ kind: 'month', year: 2026, month: 0 }), /invalid month/);
  assert.throws(() => businessWindowBounds({ kind: 'month', year: 2026, month: 13 }), /invalid month/);
});

// ── THE YEAR RANGE — regression, found by Qodo on PR #296 ───────────────────────────────────────
test('REGRESSION: a two-digit year is REJECTED, not silently remapped to the 1900s', () => {
  // `Date.UTC` remaps years 0-99 to 1900-1999. Before the guard, { kind: 'year', year: 50 }
  // returned from '1950-01-01' — well-formed, plausible, and off by nineteen centuries. It even
  // passed the ISO-shape test below, because that test only ever ran on 2026. THAT is why
  // integer-ness alone was not enough: the output was not malformed, it was WRONG.
  assert.throws(() => businessWindowBounds({ kind: 'year', year: 50 }), /invalid year/);
  assert.throws(() => businessWindowBounds({ kind: 'year', year: 99 }), /invalid year/);
  assert.throws(() => businessWindowBounds({ kind: 'month', year: 50, month: 3 }), /invalid month/);
  assert.throws(() => businessWindowBounds({ kind: 'year', year: 0 }), /invalid year/);
});

test('REGRESSION: an extended year is REJECTED, not truncated into a malformed string', () => {
  // Above 9999 `toISOString()` switches to extended years and `.slice(0, 10)` truncates
  // '+010000-01-01T…' to '+010000-01'. Worse, the PRIOR window then stopped meeting this one:
  // priorFrom was '9999-01-01' while priorTo was '+010000-01', breaking the adjacency invariant.
  assert.throws(() => businessWindowBounds({ kind: 'year', year: 10000 }), /invalid year/);
  assert.throws(() => businessWindowBounds({ kind: 'month', year: 10000, month: 1 }), /invalid month/);
  assert.throws(() => businessWindowBounds({ kind: 'year', year: -1 }), /invalid year/);
});

test('the supported year range is inclusive at BOTH edges, and its NEIGHBOURS still serialize', () => {
  // The edges must WORK, not merely not-throw — a guard that quietly narrowed the usable range
  // would be its own bug. The neighbouring years are the real test: `to` reaches year+1 and
  // `priorFrom` reaches year-1, so 1999 and 2101 must both come out as four digits.
  const lo = businessWindowBounds({ kind: 'year', year: BUSINESS_YEAR_MIN });
  assert.equal(lo.from, '2000-01-01');
  assert.equal(lo.priorFrom, '1999-01-01', 'the year BELOW the minimum still serializes correctly');
  const hi = businessWindowBounds({ kind: 'year', year: BUSINESS_YEAR_MAX });
  assert.equal(hi.to, '2101-01-01', 'the year ABOVE the maximum still serializes correctly');
  for (const v of [lo.from, lo.to, lo.priorFrom, lo.priorTo, hi.from, hi.to, hi.priorFrom, hi.priorTo]) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${v} must be a bare four-digit calendar date`);
  }
  // And just outside is refused, in both directions.
  assert.throws(() => businessWindowBounds({ kind: 'year', year: BUSINESS_YEAR_MIN - 1 }), /invalid year/);
  assert.throws(() => businessWindowBounds({ kind: 'year', year: BUSINESS_YEAR_MAX + 1 }), /invalid year/);
});

test('the year guard is NOT Qualify\'s client trust boundary — 2036 is valid here', () => {
  // Qodo proposed adopting QUALIFY_CAL_YEAR_MIN/MAX (2024-2035). Deliberately not: that is a
  // policy bound on a USER-SUPPLIED window and it expires. This is a general primitive that
  // src/veris/ and Collections will also consume, so rejecting 2036 would be a bug in 2036.
  // Pinned so a future "harmonisation" has to argue with this test rather than silently narrow it.
  assert.equal(businessWindowBounds({ kind: 'year', year: 2036 }).from, '2036-01-01');
  assert.equal(businessWindowBounds({ kind: 'year', year: 2023 }).from, '2023-01-01');
});

test('every returned bound is a plain ISO date string, never a timestamp', () => {
  const all = [
    businessWindowBounds({ kind: 'trailing', days: 30 }, new Date('2026-08-30T19:00:00Z')),
    businessWindowBounds({ kind: 'month', year: 2026, month: 2 }),
    businessWindowBounds({ kind: 'year', year: 2026 }),
  ];
  for (const b of all) {
    for (const v of [b.from, b.to, b.priorFrom, b.priorTo]) {
      assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${v} must be a bare calendar date`);
    }
  }
  assert.match(businessDayIso(), /^\d{4}-\d{2}-\d{2}$/, 'the real clock still yields an ISO date');
  assert.equal(BUSINESS_TZ, 'America/Los_Angeles');
});

// ── EQUIVALENCE WITH THE INCUMBENT ──────────────────────────────────────────────────────────────
test('EQUIVALENCE: identical bounds to qualifyWindowBounds across the shared input space', () => {
  // The replacement must be behaviourally identical to the only rigorous implementation in the repo
  // for every input it already handles. If this ever fails, the divergence is the finding — do NOT
  // "fix" qualifyWindowBounds to match; the two disagreeing is the thing worth knowing.
  //
  // windowDays is EXCLUDED from the comparison because qualifyWindowBounds does not return it.
  // That absence is the reason this module exists (ratingV2 is fed a resolved day-count), so it is
  // an addition, not a divergence.
  //
  // ⚠ ONE DELIBERATE, ONE-WAY DIVERGENCE OUTSIDE THIS GRID (added 2026-08-30 for the PR #296
  // review): businessWindowBounds is now STRICTER than the incumbent on calendar years — it refuses
  // anything outside BUSINESS_YEAR_MIN..MAX, where qualifyWindowBounds would happily return
  // '1950-01-01' for year 50. The divergence is entirely in the fail-loud direction and only on
  // inputs the incumbent gets WRONG, so it is not a behaviour change for any real caller — Qualify's
  // own trust boundary (isQualifyWindow) already rejects those before they reach either function.
  // Stated here so "equivalence passes" is not read as "identical on every input".
  const instants = [
    '2026-08-30T19:00:00Z', // midday Pacific
    '2026-08-31T02:00:00Z', // 19:00 PDT — UTC already tomorrow
    '2026-01-15T07:59:59Z', // 23:59:59 PST
    '2026-01-15T08:00:00Z', // 00:00:00 PST
    '2026-03-08T09:00:00Z', // spring-forward day
    '2026-03-09T07:30:00Z', // first PDT day
    '2026-11-01T06:30:00Z', // 23:30 PDT, fall-back eve
    '2026-11-02T07:30:00Z', // 23:30 PST
    '2026-12-31T23:00:00Z', // year boundary, UTC ahead
    '2028-02-29T20:00:00Z', // leap day
  ].map((s) => new Date(s));

  // ⚠ THE SHARED SPACE IS SIX VALUES, NOT EIGHT. QualifyTrailingDays is `30|60|90|180|270|365`, so
  // 7 and 14 — which businessWindowBounds accepts and which Collections' recencyDays filter already
  // uses — are NOT expressible against the incumbent and CANNOT be equivalence-tested here. They are
  // covered by the arithmetic tests above. Iterating the union rather than a literal list means a
  // preset added to Qualify is picked up here automatically instead of silently going uncompared.
  const SHARED_TRAILING: readonly QualifyTrailingDays[] = [30, 60, 90, 180, 270, 365];
  let compared = 0;
  for (const now of instants) {
    for (const days of SHARED_TRAILING) {
      const mine = businessWindowBounds({ kind: 'trailing', days }, now);
      const theirs = qualifyWindowBounds({ kind: 'trailing', days }, now);
      assert.deepEqual(
        { from: mine.from, to: mine.to, priorFrom: mine.priorFrom, priorTo: mine.priorTo },
        theirs,
        `trailing ${days}d at ${now.toISOString()}`,
      );
      compared += 1;
    }
    // Calendar windows do not consult `now`, but run them inside the loop anyway — if either
    // implementation ever starts reading the clock for a calendar window, this catches it.
    for (const month of [1, 2, 3, 6, 12]) {
      const w = { kind: 'month', year: 2026, month } as const;
      const mine = businessWindowBounds(w, now);
      assert.deepEqual(
        { from: mine.from, to: mine.to, priorFrom: mine.priorFrom, priorTo: mine.priorTo },
        qualifyWindowBounds(w, now),
        `month 2026-${month}`,
      );
      compared += 1;
    }
    for (const year of [2025, 2026, 2028]) {
      const w = { kind: 'year', year } as const;
      const mine = businessWindowBounds(w, now);
      assert.deepEqual(
        { from: mine.from, to: mine.to, priorFrom: mine.priorFrom, priorTo: mine.priorTo },
        qualifyWindowBounds(w, now),
        `year ${year}`,
      );
      compared += 1;
    }
  }
  // Guard against the assertion loop silently doing nothing — a vacuously-green equivalence test
  // would be worse than no equivalence test.
  assert.equal(compared, 140, 'the comparison must actually have run over the whole grid');
});
