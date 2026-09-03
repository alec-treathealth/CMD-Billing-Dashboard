/**
 * GROUPED-MODE SORT POLICY — which column the Collections grid may order groups by, and the window
 * cap that decides when an aggregate ordering is affordable.
 *
 * ⚠ ITS OWN MODULE ON PURPOSE, AND THE REASON IS THE BROWSER. The client needs this predicate to
 * decide whether a header control is enabled, and the Server Action needs the identical predicate
 * to clamp. The obvious home was cmdExplorerQuery.ts next to the builder that consumes it — but
 * importing that file into a client component ships every SQL string in it to the browser. Keeping
 * the rule in a tiny leaf module means ONE definition, imported by both sides, with nothing else
 * riding along. cmdExplorerQuery.ts re-exports these so existing server-side import paths are
 * unchanged.
 *
 * There is no PHI and no secret here — it is arithmetic on a day count.
 */

/**
 * The columns grouped mode can order by. `payment_received` is a GROUPING KEY; `charge_amount` is
 * an AGGREGATE (`sum`), and that difference is the entire reason for the cap below.
 */
export type GroupedSortColumn = 'payment_received' | 'charge_amount';

export const GROUPED_SORTABLE = new Set<string>(['payment_received', 'charge_amount']);

/**
 * Longest window, in DAYS, for which grouped mode may order by an aggregate. Ruled 2026-09-03.
 *
 * ── WHY A CAP EXISTS AT ALL ────────────────────────────────────────────────────────────────────
 * Ordering by the payment date is served by `cmd_charge_rollup_entity_payment_id_desc`, an index
 * whose order MATCHES the query's, so the plan reads ~708 rows, materialises ~87 groups and stops.
 * An aggregate ordering cannot stop early — you cannot know which group holds the largest total
 * until every group is summed — so it reads the whole window. Measured (warm, median of 3, BXR at
 * 90d): 708 rows -> 14,489 and 891 buffers -> 10,708, i.e. 2.8 ms -> 62 ms.
 *
 * The cost therefore tracks WINDOW SIZE, not page depth: it is flat at ~62 ms on page 1 and on
 * page 10, because it starts at its ceiling rather than degrading as you page. Measured across the
 * presets on the worst tenant scope (Consolidated, both entities):
 *
 *     7d  10 ms  ·  30d  74 ms  ·  90d  207 ms  ·  180d  402 ms  ·  1y  724 ms
 *
 * 90 is where the curve turns — it caps the worst case near 200 ms, and 180d is already 2x that.
 *
 * ⚠ AND IT DELIBERATELY EQUALS THE TAB'S DEFAULT WINDOW. Sorting therefore works in the state the
 * tab opens in, and only becomes unavailable when a reader widens the window on purpose. A cap
 * TIGHTER than the default would disable the feature by default, which reads as broken rather than
 * as a limit.
 *
 * ⚠ THE UNIT IS THE WINDOW'S OWN DAY COUNT, NOT `to - from`. A trailing preset resolves to a
 * half-open `[from, to)` whose `to` is business-today + 1, so the 90d preset spans 91 days;
 * "Include scheduled" then pushes `to` a further FUTURE_PAYMENT_HORIZON_DAYS out, making it 105.
 * Capping raw `to - from` at 90 would have switched sorting off at the DEFAULT preset, and off
 * again whenever Include-scheduled was ticked. Pass the preset's day count (7/14/30/90/180/365) or,
 * for a custom range, `businessWindowBounds().windowDays`.
 */
export const GROUPED_AGG_SORT_MAX_WINDOW_DAYS = 90;

/**
 * Inclusive day count of a custom `[from, to]` range — both ISO 'YYYY-MM-DD', `to` INCLUSIVE as the
 * picker presents it. Returns null for a malformed, unreal or inverted range.
 *
 * ⚠ DELIBERATELY NOT `businessWindowBounds`, AND THAT IS A HARD CONSTRAINT RATHER THAN A
 * PREFERENCE. That function is the OPS CALENDAR — it reads a clock and knows a timezone — and the
 * Collections client is forbidden from importing it: issue #304's rule is that the client never
 * derives the ops day, it only compares two integers the server sent, and
 * app/test/cmd-recency-default.test.tsx pins the import itself precisely because "you cannot call
 * what you do not import". Importing it here to measure a window the USER typed would hand the
 * client the ability to derive today as a side effect.
 *
 * So this is pure arithmetic on two given dates and reads no clock. The risk it introduces — a
 * second definition of "how wide is this range" — is closed by a test that asserts it agrees with
 * `businessWindowBounds(...).windowDays` across a spread of ranges, run in the root suite where
 * importing the ops calendar is allowed.
 *
 * Real-date validation matters: `2026-02-30` must be refused, not rolled forward to March 2nd. The
 * round-trip comparison below is what refuses it.
 */
export function customWindowDays(from: string, to: string): number | null {
  const parse = (iso: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const t = Date.parse(`${iso}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    // Date.parse rolls 2026-02-30 forward; a round trip catches that.
    return new Date(t).toISOString().slice(0, 10) === iso ? t : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null || a > b) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Is `column` orderable in grouped mode for a window of `windowDays`?
 *
 * `windowDays` of `null` means "unresolved", and is treated as too wide — fail CLOSED, so a caller
 * that cannot say how big its window is never reaches the expensive path.
 */
export function groupedSortAllowed(column: string, windowDays: number | null): boolean {
  if (column === 'payment_received') return true; // index-served at every window
  if (!GROUPED_SORTABLE.has(column)) return false;
  return windowDays !== null && Number.isFinite(windowDays) && windowDays <= GROUPED_AGG_SORT_MAX_WINDOW_DAYS;
}

/**
 * Clamp a grouped sort to what the allowlist AND the window permit, keeping the direction.
 *
 * Mirrors `resolveCmdExplorerSort`'s shape. The direction survives a clamp for the same reason it
 * survives the grouping toggle: asc/desc was an intentional choice, and a window change is not a
 * reason to discard it.
 *
 * ⚠ ON THE SERVER THIS IS A BACKSTOP, NOT THE UI'S MECHANISM. If it ever fires on a request from
 * our own client, the header is lying — the client normalises the sort in the same state update
 * that widens the window past the cap, exactly as toggling grouping normalises it. The clamp
 * exists so a stale or hand-made request cannot buy a 724 ms full-year aggregate query, and
 * clamping is the right failure direction: worst case a reader gets payment-date order, never a
 * timeout.
 */
export function resolveGroupedSort(
  column: string | undefined,
  direction: 'asc' | 'desc',
  windowDays: number | null,
): { column: GroupedSortColumn; direction: 'asc' | 'desc' } {
  const dir = direction === 'asc' ? 'asc' : 'desc';
  if (column !== undefined && groupedSortAllowed(column, windowDays)) {
    return { column: column as GroupedSortColumn, direction: dir };
  }
  return { column: 'payment_received', direction: dir };
}
