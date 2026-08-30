/**
 * SESSION-LOCAL cell overrides for the Billable Days grid.
 *
 * ⚠ NOTHING HERE PERSISTS. Overrides live in React state and are gone on reload, which is
 * the same stance as the parsed import itself. The UI says so out loud rather than letting a
 * biller discover it. When the `kipu.*` writer lands, the store behind these functions
 * changes and the call sites do not.
 *
 * ⚠ EVERY KEY CARRIES ITS WEEK, AND THAT IS LOAD-BEARING (Qodo 2, fixed 2026-08-30). Keys used
 * to be `${rowId}:${day}` for cells and a bare `rowId` for week status, while `gotoWeek`
 * deliberately PRESERVES both maps across a week change. So an edit made on one week silently
 * applied to the same client's Tuesday — and to their week status — in every other week of the
 * export, and the recount, the "adjusted" badge and the override tally all reported it as real.
 * Neither map may be read or written without the week that was on screen when the edit was made.
 *
 * The maps are still preserved across a week change on purpose: week-keyed entries are scoped
 * by construction, so navigating away and back keeps a biller's work instead of discarding it.
 *
 * ⚠ THE ENTITY (`?view=`) IS DELIBERATELY NOT IN THE KEY, and that rests on a routing fact,
 * not on a component guarantee. Row ids are per-import ordinals, so an override that survived
 * an entity switch would re-point at whoever occupies that ordinal under the other tenant — a
 * different person, not merely a different week. It cannot survive one today because the Claims
 * Desk carries NO in-place tenant switcher: `?view=` is only ever changed by `TenantTabs`,
 * which renders on /dashboard and /dashboard/collections only, so switching entity is a route
 * change and unmounts this panel with all of its state. `billableDaysEntityScope.test.tsx`
 * pins that premise; if it ever fails, add the entity to these keys rather than deleting it.
 *
 * ⚠ THE RECOUNT IS A SIMPLIFICATION, AND IT IS VISIBLE ON PURPOSE. The engine's real
 * billable-day count resolves a cap PER DAY from the authorization covering that day
 * (A13), so a client whose auths span two levels of care is capped within each regime
 * separately. This client-side recount applies ONE cap — the row's own `capDays` — to the
 * overridden codes, because reproducing A13 in the browser would mean shipping the rules
 * engine to the client, which is exactly what this design avoids.
 *
 * The consequence is bounded and declared: for a `multiLoc` row the adjusted number can
 * differ from what the server would compute. `isApproximate` reports that, the grid labels
 * it, and the persistence PR removes the whole problem by recomputing server-side.
 */
import type { KipuRowDTO } from '@/lib/billing-audit/kipu-import';
import { CODE_LEGEND, type WeekStatus } from './legend';

/** The codes a user may set on a cell — the workbook's own vocabulary. */
export const OVERRIDE_CODES = ['I', 'G', 'T', 'BPS', 'N/B', 'D/C'] as const;
export type OverrideCode = (typeof OVERRIDE_CODES)[number];

const BILLABLE = new Set(CODE_LEGEND.filter((c) => c.billable).map((c) => c.code));

/** `${week}|${rowId}:${dayIndex}` → the codes that replace the engine's for that cell. */
export type CellOverrides = ReadonlyMap<string, readonly string[]>;
/** `${week}|${rowId}` → the billing-workflow status a human set for that client's week. */
export type StatusOverrides = ReadonlyMap<string, WeekStatus>;

/** Week first, always — see the header. A key without one is scoped to nothing. */
export const cellKey = (week: string, rowId: string, dayIndex: number): string =>
  `${week}|${rowId}:${dayIndex}`;

export const statusKey = (week: string, rowId: string): string => `${week}|${rowId}`;

/** The codes actually shown for a day — the override when set, the engine's otherwise. */
export function effectiveCodes(
  row: KipuRowDTO,
  dayIndex: number,
  ov: CellOverrides,
  week: string,
): readonly string[] {
  const hit = ov.get(cellKey(week, row.id, dayIndex));
  return hit ?? row.days[dayIndex]?.codes ?? [];
}

export function rowHasOverride(row: KipuRowDTO, ov: CellOverrides, week: string): boolean {
  return row.days.some((d) => ov.has(cellKey(week, row.id, d.i)));
}

/**
 * Billable days after overrides, capped at the row's cap. Returns the engine's own number
 * untouched when the row has no override IN THIS WEEK, so an un-edited row can never drift.
 */
export function adjustedBillableDays(row: KipuRowDTO, ov: CellOverrides, week: string): number {
  if (!rowHasOverride(row, ov, week)) return row.billableDays;
  const n = row.days.filter((d) => effectiveCodes(row, d.i, ov, week).some((c) => BILLABLE.has(c))).length;
  return Math.min(n, row.capDays);
}

/** True when the adjusted count may disagree with a server recompute (see the header). */
export function isApproximate(row: KipuRowDTO, ov: CellOverrides, week: string): boolean {
  return row.multiLoc && rowHasOverride(row, ov, week);
}

/**
 * Every override held in this tab, across every week of the loaded export — which is what the
 * banner beside "Clear all" claims, and what "Clear all" acts on. Deliberately NOT scoped to
 * the visible week: a tally that silently dropped edits made on another week would understate
 * how much unsaved work a reload is about to discard.
 */
export function countOverrides(ov: CellOverrides, statuses: StatusOverrides): number {
  return ov.size + statuses.size;
}
