/**
 * Dashboard "view" scoping seam.
 *
 * A view selects WHICH business entity's data the overview renders. All three
 * views render the IDENTICAL UI — only the data scope differs. The view lives in
 * the URL (`?view=`), read server-side in the overview page (survives refresh,
 * shareable) — never in localStorage/cookies (CLAUDE.md §2: nothing app-state in
 * browser storage; also keeps it server-readable). The view param is non-PHI and
 * is fine in the URL.
 *
 * This module is pure and side-effect-free: it holds no secrets, touches no DB,
 * and is safe to import from both Server Components (resolveView) and Client
 * Components (viewOptions / viewToEntityIds / viewTitle).
 */

/** The three dashboard views. Consolidated = BXR + Indigo summed. */
export type DashboardView = 'consolidated' | 'bxr' | 'indigo';

/** Canonical default when `?view=` is absent or invalid. */
export const DEFAULT_VIEW: DashboardView = 'consolidated';

/**
 * The view allowlist (label + value). THIS is the seam for real per-user
 * entitlements later: today every authenticated user gets all three; when
 * entitlements land, filter this list (or resolveView's acceptance) by the
 * session's allowed entities. The order here is the order the dropdown renders.
 */
export const viewOptions: ReadonlyArray<{ value: DashboardView; label: string }> = [
  { value: 'consolidated', label: 'Consolidated' },
  { value: 'bxr', label: 'BXR Consulting' },
  { value: 'indigo', label: 'Indigo Billing' },
] as const;

const VIEW_VALUES: ReadonlySet<string> = new Set(viewOptions.map((o) => o.value));

/** All three views, in dropdown order — the set a super-admin sees. */
export const ALL_VIEWS: ReadonlyArray<DashboardView> = viewOptions.map((o) => o.value);

/**
 * Constrain a requested view to the caller's entitlement. If `requested` is allowed it
 * passes through; otherwise it falls back to the first allowed view (an entity-scoped user's
 * single view), or DEFAULT_VIEW if the allowlist is somehow empty. Pure; the role→allowlist
 * decision lives in `rbac.ts` (this only enforces it). Defense-in-depth: the page also scopes
 * data by the clamped view, so a hand-edited `?view=` can never widen access.
 */
export function clampView(
  requested: DashboardView,
  allowed: ReadonlyArray<DashboardView>,
): DashboardView {
  if (allowed.includes(requested)) return requested;
  return allowed[0] ?? DEFAULT_VIEW;
}

/** The screen title for a view ("Consolidated View" / "BXR Consulting" / "Indigo Billing"). */
export function viewTitle(view: DashboardView): string {
  switch (view) {
    case 'consolidated':
      return 'Consolidated View';
    case 'bxr':
      return 'BXR Consulting';
    case 'indigo':
      return 'Indigo Billing';
  }
}

/**
 * Parse `?view=` into a validated DashboardView. Accepts the resolved searchParams
 * object (in Next 15 the page awaits the searchParams Promise first). A repeated
 * param (`?view=a&view=b`) arrives as an array → take the first. Anything not in the
 * allowlist (garbage, empty, missing) falls back safely to DEFAULT_VIEW.
 */
export function resolveView(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): DashboardView {
  const raw = searchParams?.view;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && VIEW_VALUES.has(value)) {
    return value as DashboardView;
  }
  return DEFAULT_VIEW;
}

// ===========================================================================
// THE DATA SEAM — view → business_entity_id(s). BOTH tenants are now real.
// ===========================================================================
//
// `viewToEntityIds` maps a view to the business_entity_id(s) its data lives under, and is
// the ONE place that decision lives. As of the collections-tenancy work (0028 on
// cmd_explorer_rows; 0030 on daily_collections + cmd_payer_facility_monthly) the
// collections.* tables carry business_entity_id, and BOTH the explorer readers AND the aggregate
// overview readers (summary/kpis/daily/payer/freshness) scope by these ids server-side via
// app/lib/actions.ts viewEntityScope (review finding #1 — landed). Every reader consumes THIS
// function — the view→entity decision stays here and only here.
//
// Both UUIDs are FIXED, business-owner-confirmed constants — never regenerate. They MUST
// equal the src-side source of truth in src/tenants.ts (the app/ side cannot import from
// src/, so each keeps its own copy); test/tenantIdParity.test.ts locks the two together.

/** BXR Consulting LLC (CMD account #475729). */
export const BXR_ENTITY_ID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

/** Indigo Billing (CMD account #474623) — the second real tenant (collections plane). */
export const INDIGO_ENTITY_ID = '141d459c-f371-4229-9a92-ace198e940bb';

/**
 * The view → business_entity_id(s) resolver. 'bxr'/'indigo' resolve to their single tenant;
 * 'consolidated' = both tenants summed (a super-admin-only surface). De-duplicated so two
 * constants accidentally set equal can never double-count.
 */
export function viewToEntityIds(view: DashboardView): string[] {
  switch (view) {
    case 'bxr':
      return [BXR_ENTITY_ID];
    case 'indigo':
      return [INDIGO_ENTITY_ID];
    case 'consolidated':
      return [...new Set([BXR_ENTITY_ID, INDIGO_ENTITY_ID])];
  }
}
