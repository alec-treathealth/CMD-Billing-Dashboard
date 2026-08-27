/**
 * SESSION-LOCAL cell overrides for the Billable Days grid.
 *
 * ⚠ NOTHING HERE PERSISTS. Overrides live in React state and are gone on reload, which is
 * the same stance as the parsed import itself. The UI says so out loud rather than letting a
 * biller discover it. When the `kipu.*` writer lands, the store behind these functions
 * changes and the call sites do not.
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

/** `${rowId}:${dayIndex}` → the codes that replace the engine's for that cell. */
export type CellOverrides = ReadonlyMap<string, readonly string[]>;
export type StatusOverrides = ReadonlyMap<string, WeekStatus>;

export const cellKey = (rowId: string, dayIndex: number): string => `${rowId}:${dayIndex}`;

/** The codes actually shown for a day — the override when set, the engine's otherwise. */
export function effectiveCodes(row: KipuRowDTO, dayIndex: number, ov: CellOverrides): readonly string[] {
  const hit = ov.get(cellKey(row.id, dayIndex));
  return hit ?? row.days[dayIndex]?.codes ?? [];
}

export function rowHasOverride(row: KipuRowDTO, ov: CellOverrides): boolean {
  return row.days.some((d) => ov.has(cellKey(row.id, d.i)));
}

/**
 * Billable days after overrides, capped at the row's cap. Returns the engine's own number
 * untouched when the row has no override, so an un-edited row can never drift.
 */
export function adjustedBillableDays(row: KipuRowDTO, ov: CellOverrides): number {
  if (!rowHasOverride(row, ov)) return row.billableDays;
  const capped = row.days.filter((d) => effectiveCodes(row, d.i, ov).some((c) => BILLABLE.has(c) && c !== 'BPS')).length;
  const bps = row.days.filter((d) => effectiveCodes(row, d.i, ov).includes('BPS')).length;
  return Math.min(capped, row.capDays) + bps;
}

/** True when the adjusted count may disagree with a server recompute (see the header). */
export function isApproximate(row: KipuRowDTO, ov: CellOverrides): boolean {
  return row.multiLoc && rowHasOverride(row, ov);
}

export function countOverrides(ov: CellOverrides, statuses: StatusOverrides): number {
  return ov.size + statuses.size;
}
