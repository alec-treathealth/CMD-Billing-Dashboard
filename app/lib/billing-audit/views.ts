/**
 * WHICH TENANTS THE CLAIMS DESK OFFERS — a route-scoped SURFACE capability, not an entitlement.
 *
 * ── WHY THIS IS NOT AN RBAC DECISION ───────────────────────────────────────────────────────
 * `.claude/rules/nextjs-app.md`: *"`app/lib/rbac.ts` is pure policy — the view→entitlement
 * decision lives there and nowhere else."* This module does NOT make that decision and must
 * never be read as making it. `allowedViewsFor` still answers "which tenants may this person
 * see"; this answers the different question "which tenants does this SCREEN have data for".
 *
 * The two compose in one direction only: the result is an INTERSECTION, so this file can
 * narrow what RBAC granted and can never widen it. An Indigo-scoped admin does not gain BXR
 * by loading this route, and adding a view here cannot entitle anyone to it.
 *
 * ── WHY CONSOLIDATED IS ABSENT ─────────────────────────────────────────────────────────────
 * The Claims Desk is entity-scoped by construction. `.claude/rules/billing-audit.md`: *"Audit
 * data is BXR-only today. A non-BXR view resolves to an empty, fail-closed workbench until
 * that tenant's plane lands — never a cross-tenant leak."* A cross-tenant sum of a
 * charge-line-grain audit workbench is not a smaller version of the same screen — it is a
 * different screen nobody has specified. Offering the tab would promise one.
 *
 * `consolidated` therefore CLAMPS to the route default rather than throwing: a hand-edited
 * `?view=consolidated` narrows to BXR, which is the same fail-closed direction every other
 * clamp in this app takes. Narrowing is always safe; widening is the thing that never happens.
 *
 * ── THE DEFAULT IS BXR, AND ONLY ON THIS ROUTE ─────────────────────────────────────────────
 * `DEFAULT_VIEW` in `app/lib/views.ts` is `consolidated`, which is correct for the overview and
 * wrong here: it resolved a bare `/billing-audit` to a view this screen renders an "switch to
 * BXR" notice for, so the tab was unreachable without hand-editing the URL. The override is
 * deliberately local to this module — `DEFAULT_VIEW` is shared by /dashboard and
 * /dashboard/collections and must not move on their behalf.
 *
 * ⚠ ORDER IS LOAD-BEARING, AND IT COUPLES TO `TenantTabs`. The tabs component runs its OWN
 * `clampView(resolveView(param), allowedViews)` and falls back to `allowedViews[0]`. If this
 * list did not put the route default first, a bare URL would light a different tab than the
 * page scoped its data to. `claimsDeskViews` therefore intersects in THIS array's order, not
 * the caller's.
 */
import { type DashboardView } from '@/lib/views';

/** The tenants this screen has a data plane for, in tab order. Route default FIRST — see above. */
export const CLAIMS_DESK_VIEWS: readonly DashboardView[] = ['bxr', 'indigo'] as const;

/** Where a bare `/billing-audit` lands. Deliberately NOT `views.ts`'s `DEFAULT_VIEW`. */
export const CLAIMS_DESK_DEFAULT_VIEW: DashboardView = 'bxr';

/**
 * The tenants a given person may select ON THIS ROUTE: their entitlement ∩ this screen's planes,
 * in `CLAIMS_DESK_VIEWS` order. Empty means "no tenant on this screen" and the caller MUST fail
 * closed rather than substitute a default — an empty allowlist is a deny everywhere else in this
 * app (`allowedViewsFor`'s own docblock says so) and must stay a deny here.
 */
export function claimsDeskViews(allowedViews: readonly DashboardView[]): DashboardView[] {
  return CLAIMS_DESK_VIEWS.filter((v) => allowedViews.includes(v));
}

/**
 * Resolve `?view=` for the Claims Desk. An explicit, supported, ENTITLED param wins; anything
 * else — absent, garbage, `consolidated`, or a tenant this person may not see — clamps to the
 * route default (or, if they are not entitled to that, to their first supported tenant).
 *
 * Returns `null` when the intersection is empty, so the caller cannot accidentally render a
 * scoped screen with an unscoped view. That is the one case a `DashboardView` return type could
 * not express honestly.
 */
export function resolveClaimsDeskView(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  allowedViews: readonly DashboardView[],
): DashboardView | null {
  const desk = claimsDeskViews(allowedViews);
  if (desk.length === 0) return null;

  const raw = searchParams?.view;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  // A supported + entitled param is honoured verbatim. `desk` is already the intersection, so
  // membership here is BOTH checks at once — there is no path that accepts an unentitled view.
  if (typeof requested === 'string' && (desk as readonly string[]).includes(requested)) {
    return requested as DashboardView;
  }
  // Clamp. Prefer the route default; fall back to their first supported tenant when they are not
  // entitled to it (an Indigo-scoped admin, whose `desk` is exactly ['indigo']).
  const fallback = desk.includes(CLAIMS_DESK_DEFAULT_VIEW) ? CLAIMS_DESK_DEFAULT_VIEW : desk[0];
  return fallback ?? null;
}

/** The `?view=` value currently in the URL, or `undefined`. Used to decide whether to redirect. */
export function urlView(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const raw = searchParams?.view;
  return Array.isArray(raw) ? raw[0] : raw;
}
