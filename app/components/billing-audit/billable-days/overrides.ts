/**
 * SESSION-LOCAL cell overrides for the Billable Days grid.
 *
 * ⚠ NOTHING HERE PERSISTS. Overrides live in React state and are gone on reload, which is
 * the same stance as the parsed import itself. The UI says so out loud rather than letting a
 * biller discover it. When the `kipu.*` writer lands, the store behind these functions
 * changes and the call sites do not.
 *
 * ── EVERY KEY CARRIES ITS SCOPE: (ENTITY, WEEK). BOTH HALVES ARE LOAD-BEARING ──────────────
 *
 * The WEEK half (Qodo 2, fixed 2026-08-30). Keys used to be `${rowId}:${day}` for cells and a
 * bare `rowId` for week status, while `gotoWeek` deliberately PRESERVES both maps across a week
 * change. So an edit made on one week silently applied to the same client's Tuesday — and to
 * their week status — in every other week of the export, and the recount, the "adjusted" badge
 * and the override tally all reported it as real.
 *
 * The ENTITY half (added 2026-08-31, with the Claims Desk tenant control). Row ids are
 * per-import ORDINALS, so an override that outlived an entity switch would not merely apply to
 * the wrong week — it would re-point at whoever occupies that ordinal under the other tenant,
 * i.e. a different person's billable days. That is strictly worse than the week case.
 *
 * ⚠ THIS REPLACED A ROUTING PREMISE THAT IS NOW GONE, AND THE PREMISE WAS THE ONLY REASON THE
 * ENTITY WAS EVER ABSENT. The entity used to be left out because the Claims Desk carried no
 * in-place tenant control: `?view=` was only ever changed by `TenantTabs`, which rendered on
 * /dashboard and /dashboard/collections only, so switching entity was a route change that
 * unmounted the panel and took its state with it. `TenantTabs` now renders on /billing-audit,
 * and a same-pathname `router.push('?view=…')` is a SOFT navigation: the page re-renders with a
 * new `view` prop and React keeps this panel MOUNTED, override maps and all. Measured, not
 * assumed — `cmd-explorer.tsx` carries a `prevView` reset for exactly this reason on the route
 * that already had the control, and that reset would be dead code if a view change remounted.
 *
 * ── WHY A BRANDED SCOPE RATHER THAN TWO STRING PARAMETERS ──────────────────────────────────
 * `entity` and `week` are both strings. A `cellKey(entity, week, rowId, day)` signature accepts
 * them in the wrong order without a type error and produces a key that is internally consistent
 * and silently wrong — the same class of defect as the omission above, reintroduced at the call
 * site. `OverrideScope` is branded, so it can only be built by `overrideScope(view, week)` and
 * a bare week string does not compile. The guarantee is structural, not asserted.
 *
 * The maps are still preserved across a week change on purpose: scope-keyed entries are scoped
 * by construction, so navigating away and back keeps a biller's work instead of discarding it.
 * The same now holds for an entity round trip (BXR → Indigo → BXR).
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
import type { DashboardView } from '@/lib/views';
import { CODE_LEGEND, type WeekStatus } from './legend';

/** The codes a user may set on a cell — the workbook's own vocabulary. */
export const OVERRIDE_CODES = ['I', 'G', 'T', 'BPS', 'N/B', 'D/C'] as const;
export type OverrideCode = (typeof OVERRIDE_CODES)[number];

const BILLABLE = new Set(CODE_LEGEND.filter((c) => c.billable).map((c) => c.code));

/**
 * The (entity, week) an override belongs to, as one opaque value. Branded so the only way to
 * obtain one is `overrideScope` — see the header for why two plain string params are unsafe here.
 */
export type OverrideScope = string & { readonly __overrideScope: unique symbol };

/** The ONE constructor. Entity first, week second; nothing else may build an OverrideScope. */
export const overrideScope = (view: DashboardView, week: string): OverrideScope =>
  `${view}|${week}` as OverrideScope;

/** `${entity}|${week}|${rowId}:${dayIndex}` → the codes that replace the engine's for that cell. */
export type CellOverrides = ReadonlyMap<string, readonly string[]>;
/** `${entity}|${week}|${rowId}` → the billing-workflow status a human set for that client's week. */
export type StatusOverrides = ReadonlyMap<string, WeekStatus>;

/** Scope first, always — see the header. A key without one is scoped to nothing. */
export const cellKey = (scope: OverrideScope, rowId: string, dayIndex: number): string =>
  `${scope}|${rowId}:${dayIndex}`;

export const statusKey = (scope: OverrideScope, rowId: string): string => `${scope}|${rowId}`;

/** The codes actually shown for a day — the override when set, the engine's otherwise. */
export function effectiveCodes(
  row: KipuRowDTO,
  dayIndex: number,
  ov: CellOverrides,
  scope: OverrideScope,
): readonly string[] {
  const hit = ov.get(cellKey(scope, row.id, dayIndex));
  return hit ?? row.days[dayIndex]?.codes ?? [];
}

export function rowHasOverride(row: KipuRowDTO, ov: CellOverrides, scope: OverrideScope): boolean {
  return row.days.some((d) => ov.has(cellKey(scope, row.id, d.i)));
}

/**
 * Billable days after overrides, capped at the row's cap. Returns the engine's own number
 * untouched when the row has no override IN THIS SCOPE, so an un-edited row can never drift.
 */
export function adjustedBillableDays(row: KipuRowDTO, ov: CellOverrides, scope: OverrideScope): number {
  if (!rowHasOverride(row, ov, scope)) return row.billableDays;
  const n = row.days.filter((d) => effectiveCodes(row, d.i, ov, scope).some((c) => BILLABLE.has(c))).length;
  return Math.min(n, row.capDays);
}

/** True when the adjusted count may disagree with a server recompute (see the header). */
export function isApproximate(row: KipuRowDTO, ov: CellOverrides, scope: OverrideScope): boolean {
  return row.multiLoc && rowHasOverride(row, ov, scope);
}

/**
 * Every override held in this tab, across every week AND every entity of the loaded export —
 * which is what the banner beside "Clear all" claims, and what "Clear all" acts on. Deliberately
 * NOT scoped to the visible week or entity: a tally that silently dropped edits made elsewhere
 * would understate how much unsaved work a reload is about to discard.
 */
export function countOverrides(ov: CellOverrides, statuses: StatusOverrides): number {
  return ov.size + statuses.size;
}
