/**
 * THE canonical business-calendar window primitive. Pure: no I/O, no pg, no Next.js, no clock read
 * you cannot inject. Every value it returns is a calendar (date-only) ISO string plus one integer.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────────────────────────
 * Four places in this repo build a date window and they do not agree. Two anchor "today" to the
 * ops calendar day (app/lib/qualify/contract.ts's qualifyWindowBounds, and businessTodayIso in
 * src/veris/era835Upcoming.ts); one takes `today - N` off the RAW UTC date and sets no upper bound
 * at all (app/lib/actions.ts, the Collections recencyDays filter); one is pure string arithmetic
 * that never reads a clock (app/lib/payer-intel/core.ts's addDaysIsoLocal). This module is the
 * replacement for the first three. It is deliberately shipped with NO consumers — making the
 * correct thing exist and proving it is one artifact; rewiring each caller is a later one.
 *
 * ── WHY IT LIVES AT src/ ROOT, WHICH IS NOT A STYLE CHOICE ─────────────────────────────────────
 * `app/` may import `src/`, never the reverse (CLAUDE.md's two-package layout). The consumers
 * straddle both packages: qualifyWindowBounds and windowAgeMultiplier are in `app/lib/qualify/`,
 * businessTodayIso is in `src/veris/`. A home under `app/` is UNREACHABLE from src/ and would make
 * the duplication permanent — it would become a fifth implementation rather than the replacement
 * for four. Only a src/ home can serve both sides.
 *
 * Root rather than a subdirectory because every src/ subdirectory is domain-scoped (`collections/`,
 * `veris/`, `queries/`, `kipu/`) and a shared primitive filed under one domain reads as that
 * domain's. src/ root is where this repo already keeps exactly this kind of thing — tenants.ts,
 * normalize.ts, cacheTags.ts, ssl.ts.
 *
 * ⚠ CONSEQUENCE WORTH KNOWING: a file at src/ root matches NO `.claude/rules/*.md` path glob. That
 * is the documented blind spot, not an exemption — the artifact-kind obligations still bind.
 *
 * ── WHAT THIS UNBLOCKS, AND WHAT IT DOES NOT DO ────────────────────────────────────────────────
 * src/veris/era835Upcoming.ts:47-52 records that ERA_BUSINESS_TZ is "DELIBERATELY DUPLICATED from
 * app/lib/qualify/contract.ts (QUALIFY_BUSINESS_TZ) rather than imported: app/ may import src/,
 * never the reverse, and this module lives in src/." That rationale is import DIRECTION and nothing
 * else — the same comment says "Two constants, one value." A src/-root home dissolves it: both
 * sides can now import BUSINESS_TZ from here.
 *
 * So the duplication becomes COLLAPSIBLE and stops being justified. It is deliberately NOT
 * collapsed here — this artifact changes no consumer. Until it is, three copies of one string are
 * live and they must not drift.
 *
 * ── TIMEZONE, AND WHY A FIXED OFFSET IS WRONG ──────────────────────────────────────────────────
 * America/Los_Angeles, the IANA zone, resolved per-instant by Intl — NOT a fixed -8. A fixed offset
 * is wrong for roughly eight months of the year and wrong in both directions across the two DST
 * transitions. The failure it prevents is recorded at app/lib/qualify/contract.ts:1071-1077: Vercel
 * runs TZ=UTC, so from ~17:00 Pacific to midnight Pacific `new Date().toISOString()` is ALREADY
 * TOMORROW, and any surface anchored on the raw UTC date disagrees with the one beside it by a
 * whole day for that entire stretch every single day (audit 2026-08-12, P1-1).
 */

/**
 * The billing/admissions team's calendar zone — the ops "today" that anchors every trailing window.
 *
 * ⚠ THREE LIVE COPIES OF THIS STRING until the consumers are rewired: here, QUALIFY_BUSINESS_TZ
 * (app/lib/qualify/contract.ts) and ERA_BUSINESS_TZ (src/veris/era835Upcoming.ts). If the business
 * ever moves zones, all three change together. This one is the intended survivor.
 */
export const BUSINESS_TZ = 'America/Los_Angeles';

/**
 * Civil Y-M-D in BUSINESS_TZ as an ISO date string — the ONE anchor every trailing window shares.
 *
 * `formatToParts`, not a formatted string: a formatted string is locale-dependent and would break
 * under a different default locale. `en-CA` yields ISO-shaped parts, but the parts are read by TYPE
 * rather than by position so even that is not load-bearing.
 *
 * `now` is injectable so the DST and midnight-rollover boundaries are unit-testable rather than
 * only reachable by waiting for a Tuesday in November.
 */
export function businessDayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (t: string): string => {
    const found = parts.find((p) => p.type === t);
    // Cannot happen for the three fields requested above, but this module is the thing everything
    // else will trust — it fails loud rather than emitting "undefined-undefined-undefined".
    if (found === undefined) throw new Error(`businessDayIso: Intl returned no ${t} part`);
    return found.value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The three window KINDS. Calendar windows are a distinct kind, NOT a trailing preset — "September"
 * and "the last 30 days" are different questions and a month is not 30 days long. Collapsing them
 * would silently answer one with the other.
 */
export type BusinessWindow =
  | { kind: 'trailing'; days: number }
  /** `month` is 1-12, calendar convention — NOT the 0-11 JS Date convention. */
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  /**
   * An arbitrary range the user picked.
   *
   * ⚠ THE INPUT IS TWO **INCLUSIVE** CALENDAR DATES — `to` is the last day the user wants to SEE.
   * The OUTPUT stays half-open like every other kind, so `bounds.to === to + 1 day`. Getting this
   * backwards is the single most likely way to reintroduce an off-by-one: a picker that says
   * "Jan 1 to Jan 31" means 31 days, and a half-open bound of '2026-01-31' would silently drop the
   * 31st. Both dates are ISO 'yyyy-mm-dd'.
   *
   * ── HOW THIS RELATES TO THE `month` KIND, AND WHERE IT DELIBERATELY DOES NOT ─────────────────
   * A custom range spanning a whole calendar month returns `from`, `to` and `windowDays`
   * BYTE-IDENTICAL to the equivalent `{ kind: 'month' }` window. That is what makes W6's fold
   * lossless: retiring the Collections month/year picker costs the LABEL and nothing else.
   *
   * ⚠ THE PRIOR WINDOW IS DIFFERENT, BY DESIGN, AND IT IS NOT AN OVERSIGHT. Custom's prior is the
   * ADJACENT EQUAL-LENGTH span (trailing-shaped); the `month` kind's prior is the PREVIOUS CALENDAR
   * MONTH. Those coincide only when adjacent months happen to share a length — measured across
   * 2026, they agree for exactly 2 of 12 months (January and August) and diverge for the other 10.
   * February 2026 is the worked example: both give from 2026-02-01 / to 2026-03-01 / 28 days, but
   * `priorFrom` is 2026-01-01 calendar vs 2026-01-04 custom.
   *
   * Detecting a calendar-aligned range and switching prior semantics was considered and REJECTED
   * (2026-08-30): a primitive whose prior-window SHAPE depends on whether the caller's dates happen
   * to land on month boundaries is a trap. Feb 1-28 and Feb 1-27 must return same-shaped priors.
   *
   * ── THE CONTRACT FOR CONSUMERS ───────────────────────────────────────────────────────────────
   * The Collections explorer filter carries only `from`/`to` and consumes NO prior window, so the
   * fold is lossless for that surface. Any consumer that DOES read priors — Qualify, W-C — must
   * treat a custom range as TRAILING-shaped, not calendar-shaped. Stated here so it is a contract
   * rather than something rediscovered later from a Δ that looks wrong.
   *
   * NO MAXIMUM SPAN IS ENFORCED HERE, deliberately. Collections caps custom ranges at 366 days,
   * but that is a PRODUCT rule for one surface, not a property of the calendar — another consumer
   * may legitimately want two years. The cap belongs at the app boundary; this primitive only
   * refuses ranges it cannot represent correctly.
   */
  | { kind: 'custom'; from: string; to: string };

export interface BusinessWindowBounds {
  /** Inclusive lower bound, ISO yyyy-mm-dd. */
  from: string;
  /** EXCLUSIVE upper bound, ISO yyyy-mm-dd. The window is half-open: [from, to). */
  to: string;
  /** Inclusive lower bound of the prior window. */
  priorFrom: string;
  /** Exclusive upper bound of the prior window. ALWAYS === `from` — the two are adjacent and
   *  never overlap, which is what makes a Δ between them meaningful. */
  priorTo: string;
  /**
   * The TRUE day-count of the resolved bounds: `to − from`, in days.
   *
   * ⚠ THIS IS DERIVED FROM THE BOUNDS, NOT FROM THE PRESET LABEL, and for calendar windows it is
   * NOT a round number. February 2026 reports 28, February 2028 reports 29, March reports 31. A
   * bounds primitive reports the truth; it does not round to protect a downstream consumer
   * (ruled 2026-08-30).
   *
   * It matters because app/lib/qualify/ratingV2.ts:228 `windowAgeMultiplier` TIERS on this number
   * at <= 30 / 60 / 90 / 180 / 270. One off-by-one crosses a tier: 91 falls into the <= 180 band
   * and cuts the data-confidence factor from 0.9 to 0.75. A trailing N therefore reports exactly N
   * and lands on its own tier edge — see test/businessWindow.test.ts, which pins every edge.
   *
   * ⚠ THE CALENDAR CONSEQUENCE IS OPEN AND DELIBERATELY NOT SOLVED HERE: the same "one month"
   * selection lands on either side of the <= 30 edge depending on the month, so data is scored as
   * less trustworthy because March is longer. Whether calendar windows should feed the multiplier
   * at all is a Qualify decision, filed as a follow-up, to be made before any consumer rewiring.
   */
  windowDays: number;
}

/**
 * Supported calendar-year range for month and year windows — INCLUSIVE, and validated rather than
 * assumed. Matches the server-side bound this repo already enforces on the Collections month filter
 * (app/lib/actions.ts, `year < 2000 || year > 2100`).
 *
 * ⚠ THIS GUARD IS NOT PEDANTRY — WITHOUT IT `Date` SILENTLY LIES, in two different ways (both
 * reproduced 2026-08-30, Qodo review of PR #296):
 *
 *   - `Date.UTC` REMAPS YEARS 0-99 TO 1900-1999. `{ kind: 'year', year: 50 }` returned
 *     `from: '1950-01-01'` — well-formed, plausible, and off by nineteen centuries. It even passed
 *     the ISO-shape assertion in this module's own test suite, because that test only ever ran on
 *     2026. Plausible wrong output is the failure mode this module exists to prevent.
 *   - `toISOString()` SWITCHES TO EXTENDED YEARS above 9999, and `.slice(0, 10)` then truncates
 *     `+010000-01-01T…` to `'+010000-01'`. `{ kind: 'year', year: 10000 }` produced exactly that,
 *     AND an incoherent prior window (`priorFrom: '9999-01-01'`, `priorTo: '+010000-01'`) — the two
 *     no longer meet, breaking the adjacency invariant every Δ depends on.
 *
 * The bound also keeps the NEIGHBOURING years well-formed, which is what makes it sufficient rather
 * than merely narrow: `to` reaches year+1 and `priorFrom` reaches year-1, so 1999-2101 must all
 * serialize as four digits. They do.
 *
 * ⚠ DELIBERATELY NOT Qualify's 2024-2035 (`QUALIFY_CAL_YEAR_MIN`/`MAX`, app/lib/qualify/contract.ts).
 * That is a CLIENT TRUST BOUNDARY for a user-supplied window — policy, and it expires. This is a
 * general primitive that src/veris/ and Collections will also consume; rejecting 2036 would be a
 * bug in 2036. The two guards answer different questions and should stay separate.
 */
export const BUSINESS_YEAR_MIN = 2000;
export const BUSINESS_YEAR_MAX = 2100;

/** Milliseconds in a day. Exact for UTC-midnight arithmetic — UTC has no DST, which is precisely
 *  why every calculation below happens in UTC AFTER the civil date has been resolved. */
const MS_PER_DAY = 86_400_000;

/** UTC midnight for a civil y-m-d. `month` is 1-12 here; Date.UTC takes 0-11, hence the −1.
 *  Date.UTC normalizes out-of-range components, which is load-bearing: month 12 becomes January of
 *  the next year and month 0 becomes December of the previous one, so the calendar-window and
 *  prior-window arithmetic needs no year-boundary special case. */
const utcMidnight = (year: number, month1to12: number, day: number): Date =>
  new Date(Date.UTC(year, month1to12 - 1, day));

/** An integer year this module can serialize correctly — see BUSINESS_YEAR_MIN/MAX for why the
 *  range exists at all. Integer-ness alone is NOT enough; that was the original defect. */
const isSupportedYear = (year: number): boolean =>
  Number.isInteger(year) && year >= BUSINESS_YEAR_MIN && year <= BUSINESS_YEAR_MAX;

/** ISO yyyy-mm-dd of a UTC-midnight Date. */
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Shift a UTC-midnight Date by whole days, staying on UTC midnight. */
const shiftDays = (base: Date, days: number): Date =>
  new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));

/** Whole days between two UTC midnights. Exact integer division — no DST, no rounding. */
const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);

/**
 * Strict ISO 'yyyy-mm-dd' → UTC midnight, or null if it is not a REAL date in the supported range.
 *
 * Strict on purpose: `new Date('2026-02-30')` does not throw, it rolls forward to March 2nd, and
 * `Date.UTC(2026, 1, 30)` does the same. A picker or a URL param can produce that, and silently
 * accepting it would return bounds for a range the user never asked for. The round-trip check
 * (re-serialize and compare) is what catches the roll.
 */
function parseIsoDate(value: string): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!isSupportedYear(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = utcMidnight(year, month, day);
  // Round-trip: rejects 2026-02-30, 2026-04-31, and every other rolled-forward impossibility.
  return iso(d) === value ? d : null;
}

/**
 * The ops calendar day `days` from now, as an ISO date — business-today shifted by whole days.
 *
 * ⚠ THIS EXISTS SO "INCLUDE SCHEDULED" DOES NOT BECOME A WINDOW KIND (ruled 2026-08-30). The
 * obvious alternative — a `graceDays` field on BusinessWindow — was rejected because `windowDays`
 * is defined as the TRUE day-count of the resolved bounds: a "90d + scheduled" window would then
 * honestly report 104, and 104 crosses `windowAgeMultiplier`'s <=90 → <=180 edge, cutting data
 * confidence 0.9 → 0.75 the moment Qualify adopts this primitive. The scheduled toggle is an
 * UPPER-BOUND OVERRIDE, not a different window, so it overrides `bounds.to` at the call site and
 * leaves `windowDays` describing the window the user actually chose.
 *
 * Negative `days` is allowed and shifts backward — no reason to forbid it, and a one-directional
 * helper would invite a caller to write the subtraction themselves.
 */
export function businessDayPlus(days: number, now: Date = new Date()): string {
  if (!Number.isInteger(days)) throw new Error(`businessDayPlus: days must be an integer, got ${days}`);
  const anchor = new Date(`${businessDayIso(now)}T00:00:00Z`);
  const shifted = shiftDays(anchor, days);
  // ⚠ THE RESULT IS RANGE-CHECKED, NOT JUST THE INPUT (added 2026-08-31, Qodo review of PR #298).
  // Integer-ness alone was the ORIGINAL defect in this module and it is the same defect here one
  // level down: a large-but-valid integer shifts past year 9999, `toISOString()` switches to
  // extended years, and `iso`'s `.slice(0, 10)` truncates `+010000-01-01T…` to `'+010000-01'` — a
  // malformed date returned from a function whose declared type says ISO yyyy-mm-dd. A shift large
  // enough to leave `Date`'s representable range gives an Invalid Date instead, whose
  // getUTCFullYear() is NaN; isSupportedYear rejects that too, so both failure modes throw here
  // rather than escaping as plausible-looking garbage. Checking the OUTPUT is what makes this
  // sufficient — there is no input bound that is both correct and independent of the anchor.
  const year = shifted.getUTCFullYear();
  if (!isSupportedYear(year)) {
    throw new Error(
      `businessDayPlus: ${days} days from ${businessDayIso(now)} lands in year ${year}, ` +
        `outside the supported ${BUSINESS_YEAR_MIN}-${BUSINESS_YEAR_MAX} range`,
    );
  }
  return iso(shifted);
}

/**
 * Resolve any BusinessWindow to half-open bounds [from, to), the adjacent prior window, and the
 * true day-count.
 *
 * TRAILING anchors on the ops calendar day in BUSINESS_TZ, then does plain calendar arithmetic on
 * it: `to` = business-today + 1 (exclusive, so ALL of today is in-window) and `from` = to − N, which
 * spans exactly N days. The prior window is the adjacent equal-length span ending where this one
 * begins. CALENDAR windows need no anchoring — they are explicit — so `now` is unused for them.
 *
 * FAILS LOUD on a nonsensical window rather than returning plausible-looking garbage. Everything
 * downstream will treat this module as the authority, and a silently-wrong date range is the class
 * of bug that gets discovered a quarter later in a number nobody could reproduce.
 */
export function businessWindowBounds(
  window: BusinessWindow,
  now: Date = new Date(),
): BusinessWindowBounds {
  if (window.kind === 'month') {
    if (!isSupportedYear(window.year) || !Number.isInteger(window.month) || window.month < 1 || window.month > 12) {
      throw new Error(`businessWindowBounds: invalid month window ${window.year}-${window.month}`);
    }
    const from = utcMidnight(window.year, window.month, 1);
    // month + 1 → the 1st of next month; Date.UTC rolls 13 into January of year+1.
    const to = utcMidnight(window.year, window.month + 1, 1);
    // month − 1 → the 1st of the previous month; Date.UTC rolls 0 into December of year−1.
    const priorFrom = utcMidnight(window.year, window.month - 1, 1);
    return {
      from: iso(from),
      to: iso(to),
      priorFrom: iso(priorFrom),
      priorTo: iso(from),
      windowDays: daysBetween(from, to),
    };
  }

  if (window.kind === 'year') {
    if (!isSupportedYear(window.year)) {
      throw new Error(`businessWindowBounds: invalid year window ${window.year}`);
    }
    const from = utcMidnight(window.year, 1, 1);
    const to = utcMidnight(window.year + 1, 1, 1);
    const priorFrom = utcMidnight(window.year - 1, 1, 1);
    return {
      from: iso(from),
      to: iso(to),
      priorFrom: iso(priorFrom),
      priorTo: iso(from),
      windowDays: daysBetween(from, to),
    };
  }

  if (window.kind === 'custom') {
    const fromDate = parseIsoDate(window.from);
    // `to` is INCLUSIVE on input — the last day the user wants to see — so the half-open upper
    // bound is one day later. See the union's docblock for why this is stated so loudly.
    const toInclusive = parseIsoDate(window.to);
    if (fromDate === null || toInclusive === null) {
      throw new Error(`businessWindowBounds: invalid custom range ${window.from}..${window.to}`);
    }
    if (fromDate.getTime() > toInclusive.getTime()) {
      throw new Error(`businessWindowBounds: custom range starts after it ends (${window.from}..${window.to})`);
    }
    const to = shiftDays(toInclusive, 1);
    const span = daysBetween(fromDate, to);
    // Prior window: adjacent and equal-length, identical contract to trailing.
    return {
      from: iso(fromDate),
      to: iso(to),
      priorFrom: iso(shiftDays(fromDate, -span)),
      priorTo: iso(fromDate),
      windowDays: span,
    };
  }

  const days = window.days;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`businessWindowBounds: trailing window needs a positive integer day count, got ${days}`);
  }
  // The civil date in the business zone — NOT the UTC date. This single line is the whole reason
  // this module exists; see the header's TIMEZONE note.
  const anchor = new Date(`${businessDayIso(now)}T00:00:00Z`);
  const to = shiftDays(anchor, 1);
  const from = shiftDays(to, -days);
  const priorTo = from;
  const priorFrom = shiftDays(from, -days);
  return {
    from: iso(from),
    to: iso(to),
    priorFrom: iso(priorFrom),
    priorTo: iso(priorTo),
    windowDays: daysBetween(from, to),
  };
}
