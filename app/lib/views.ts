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
// THE ONE DATA SEAM — change ONLY this when real Indigo data is wired in.
// ===========================================================================
//
// `viewToEntityIds` maps a view to the business_entity_id(s) its data lives under.
//
// IMPORTANT — current reality (verified against the live repo, 2026-06-29):
//   • The dashboard overview reads the `claims` / `collections` schemas, which have
//     NO `business_entity_id` column and NO GUC scoping (the `app.business_entity_id`
//     GUC + set_config pattern exists ONLY in the unrelated `staging.*`/`ref.*` ML
//     pipeline, which the dashboard never reads). So these entity ids are CARRIED
//     through the UI as the scoping seam but are NOT YET CONSUMED by any reader.
//   • There is NO separate Indigo business_entity_id anywhere in the repo. The Indigo
//     ETL (SQL Schemas/004) ingests under CMD_BUSINESS_ENTITY_ID — which is the BXR
//     UUID — and distinguishes Indigo only by source_type='INDIGO_CLAIMS', and only
//     in staging.claim_line (not in the dashboard's tables). So `INDIGO_ENTITY_ID` is
//     a documented placeholder (null), NOT a real UUID — do not invent one.
//
// Until Indigo data is ingested into the dashboard's data source, indigo and
// consolidated both resolve to BXR-or-stub (i.e. just [BXR]) — every view renders
// BXR data. When the real data layer lands:
//   1. set INDIGO_ENTITY_ID to Indigo's real business_entity_id,
//   2. have viewToEntityIds return it for 'indigo' / 'consolidated', and
//   3. teach the dashboard readers to scope by these ids (add a tenant column /
//      WHERE filter, or a GUC) — that wiring belongs at the readers, but the
//      view→entity decision belongs HERE and ONLY here.

/** BXR Consulting LLC (CMD account #475729) — the only real tenant today. */
export const BXR_ENTITY_ID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

/**
 * Indigo's business_entity_id — UNKNOWN. No definitive Indigo UUID exists in the
 * repo (see the seam note above); left null rather than inventing one. Set this to
 * the real UUID when Indigo data is onboarded.
 */
export const INDIGO_ENTITY_ID: string | null = null;

/**
 * The view → business_entity_id(s) resolver. De-duplicated; null placeholders are
 * dropped (so consolidated == [BXR] today, [BXR, INDIGO] once INDIGO_ENTITY_ID is set).
 */
export function viewToEntityIds(view: DashboardView): string[] {
  const ids: (string | null)[] =
    view === 'bxr'
      ? [BXR_ENTITY_ID]
      : view === 'indigo'
        ? // STUB: no Indigo entity/data yet → render BXR data until the data layer lands.
          [INDIGO_ENTITY_ID ?? BXR_ENTITY_ID]
        : // consolidated = BXR + Indigo summed (Indigo is a no-op placeholder for now).
          [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
  return [...new Set(ids.filter((id): id is string => id !== null))];
}
