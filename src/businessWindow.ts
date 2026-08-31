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
  | { kind: 'year'; year: number };

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

/** Milliseconds in a day. Exact for UTC-midnight arithmetic — UTC has no DST, which is precisely
 *  why every calculation below happens in UTC AFTER the civil date has been resolved. */
const MS_PER_DAY = 86_400_000;

/** UTC midnight for a civil y-m-d. `month` is 1-12 here; Date.UTC takes 0-11, hence the −1.
 *  Date.UTC normalizes out-of-range components, which is load-bearing: month 12 becomes January of
 *  the next year and month 0 becomes December of the previous one, so the calendar-window and
 *  prior-window arithmetic needs no year-boundary special case. */
const utcMidnight = (year: number, month1to12: number, day: number): Date =>
  new Date(Date.UTC(year, month1to12 - 1, day));

/** ISO yyyy-mm-dd of a UTC-midnight Date. */
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Shift a UTC-midnight Date by whole days, staying on UTC midnight. */
const shiftDays = (base: Date, days: number): Date =>
  new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));

/** Whole days between two UTC midnights. Exact integer division — no DST, no rounding. */
const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);

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
    if (!Number.isInteger(window.year) || !Number.isInteger(window.month) || window.month < 1 || window.month > 12) {
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
    if (!Number.isInteger(window.year)) {
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
