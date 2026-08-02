/**
 * Freshness of the billing-audit work table's CURRENT PAGE.
 *
 * WHY PAGE-LOCAL, NOT A TABLE-WIDE max(). `claims.audit_row` is a worklist whose rows are
 * updated in place and never deleted. If a feed change stops refreshing one status class
 * (e.g. PAID, or balance-due-patient beyond the filter window), those rows stay on the page
 * looking current forever. A table-wide freshness figure is dominated by whichever class is
 * still refreshing, so it would HIDE exactly that — the failure mode this indicator exists to
 * expose. Page-local means: when you are looking at frozen rows, the stamp is THEIR age.
 *
 * WHY THIS IS A SEPARATE PURE MODULE. `work-table.tsx` is a `'use client'` component whose
 * import graph pulls `@/lib/actions` → `@/lib/access`, whose RSC `cache()` crashes the
 * `node:test` runtime — so nothing importable from there is testable. Same constraint, same
 * remedy, as `app/lib/qualify/qualifyGuards.ts`: keep the decision logic pure and unit-test it
 * from the root suite, leave only rendering in the component.
 *
 * WHY NUMERIC COMPARISON RATHER THAN LEXICAL. An earlier draft compared the raw strings and
 * relied on `ingested_at` being a fixed-width ISO-8601 Z value — which it is today, because
 * `src/billingAudit/auditQuery.ts` projects
 * `to_char(t.ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`. But that invariant lives in a
 * different file with nothing binding the two together: project the column as a bare
 * `timestamptz` and Postgres yields `2026-08-02 08:50:21.568+00` — space-separated, variable
 * fractional seconds, numeric offset — where lexical max and chronological max diverge
 * silently, and this module would start reporting the wrong row's age with no error anywhere.
 * Comparing parsed epoch milliseconds removes the hidden coupling and is correct for any
 * format `Date.parse` accepts. Unparseable values are skipped, never allowed to win.
 */

/** Days after which the page's newest ingest is called out as stale. The consolidated feed
 *  refreshes nightly, so anything past two days has missed at least one full cycle. */
export const STALE_AFTER_DAYS = 2;

const MS_PER_DAY = 86_400_000;

/** The winning row's own timestamp string, plus its parsed epoch ms. */
export interface PageFreshness {
  /** Verbatim value from the row that won — safe to display; never reformatted here. */
  readonly iso: string;
  /** `Date.parse(iso)`, guaranteed non-NaN. */
  readonly ms: number;
}

/** Shape this needs from a grid row. Structural, so it does not import the full row type. */
export interface HasIngestedAt {
  readonly ingested_at: string | null;
}

/**
 * Newest parseable `ingested_at` across the page, or null when the page has none.
 *
 * Rows with a null or unparseable timestamp are skipped rather than treated as newest or
 * oldest — an unreadable value is an absence of evidence about freshness, and letting one win
 * either way would misreport the page.
 */
export function newestIngestOnPage(rows: readonly HasIngestedAt[]): PageFreshness | null {
  let best: PageFreshness | null = null;
  for (const r of rows) {
    if (!r.ingested_at) continue;
    const ms = Date.parse(r.ingested_at);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best.ms) best = { iso: r.ingested_at, ms };
  }
  return best;
}

/**
 * Is the page's newest ingest older than the staleness threshold?
 *
 * `nowMs` is passed in rather than read from the clock so this stays pure and so the caller
 * controls WHEN the clock is read — the component reads it after mount, because the seeded
 * first page renders server-side and a server clock would hydrate differently.
 */
export function isPageStale(
  freshness: PageFreshness | null,
  nowMs: number | null,
  staleAfterDays: number = STALE_AFTER_DAYS,
): boolean {
  if (freshness === null || nowMs === null) return false;
  return nowMs - freshness.ms > staleAfterDays * MS_PER_DAY;
}

/**
 * UTC calendar date for display (`YYYY-MM-DD`).
 *
 * Derived from the parsed instant rather than sliced off the string, so it stays correct if
 * the projection format ever changes — and pinned to UTC rather than the viewer's locale,
 * which would both disagree with the ingest timestamp's own basis and hydrate inconsistently.
 */
export function freshnessDisplayDate(freshness: PageFreshness): string {
  return new Date(freshness.ms).toISOString().slice(0, 10);
}
