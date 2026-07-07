/**
 * Veris tenant-scope resolver — PURE, side-effect-free policy.
 *
 * Given an AUTHENTICATED principal's role + entity (resolved elsewhere from the session,
 * never from client input), decide which tenant scope a Veris read runs under:
 *   • `admin` / `user`  → their ONE entity's business_entity_id → withTenant(entityId).
 *   • `super_admin`     → not tenant-scoped; may read the consolidated (cross-tenant)
 *                         surface, OR switch into a single tenant's view. The requested
 *                         view SELECTS WITHIN their full entitlement — it can never widen
 *                         access, because a super_admin is already entitled to every tenant.
 *
 * This mirrors the dashboard's pure/impure split (app/lib/rbac.ts is pure policy;
 * app/lib/access.ts does the impure session+DB resolution). It lives in `src/` — not
 * `app/` — so BOTH the app-layer seam (app→src is allowed) AND the src-side isolation
 * probe / hermetic tests (src→app is forbidden) can import the SAME decision. Keeping it
 * here is what lets the isolation test exercise the authenticated decision path directly.
 *
 * SECURITY INVARIANTS (do not regress):
 *   1. For `admin`/`user`, the tenant is ALWAYS their session entity. A `requestedView`
 *      that disagrees is IGNORED and flagged as an anomaly — never allowed to re-scope.
 *   2. `entityId` comes from the canonical constants in `src/tenants.ts` (the single
 *      source of truth), never an inline literal or a client-supplied value.
 *   3. `super_admin`'s consolidated read is a distinct `mode` — the caller routes it to
 *      the explicit `core.consolidated_summary()` path (019), never an RLS bypass.
 */
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

/** The three role labels (mirrors app/lib/rbac.ts `Role`; src cannot import from app/). */
export type VerisRole = 'super_admin' | 'admin' | 'user';
/** The two real tenants (mirrors app/lib/rbac.ts `Entity`). */
export type VerisEntity = 'bxr' | 'indigo';
/** A requested display view (mirrors app/lib/views.ts `DashboardView`). */
export type VerisView = 'consolidated' | 'bxr' | 'indigo';

/** entity → canonical business_entity_id (single source of truth = src/tenants.ts). */
const ENTITY_ID: Readonly<Record<VerisEntity, string>> = {
  bxr: BXR_ENTITY_ID,
  indigo: INDIGO_ENTITY_ID,
};

/** The resolved scope a Veris read runs under. */
export type VerisScope =
  | { readonly mode: 'tenant'; readonly entity: VerisEntity; readonly entityId: string }
  | { readonly mode: 'consolidated' };

/**
 * Result of resolving a principal to a Veris scope. `anomaly` (non-PHI) is set when a
 * client-supplied `requestedView` was ignored because it disagreed with a tenant-scoped
 * role's session entity — the caller logs it. `ok:false` only happens defensively (a
 * tenant-scoped role with no entity, which the DB CHECK on claims.app_user prevents).
 */
export type VerisScopeResult =
  | { readonly ok: true; readonly scope: VerisScope; readonly anomaly: string | null }
  | { readonly ok: false; readonly reason: 'no_tenant' };

/**
 * Resolve an authenticated principal (role + entity) — plus an OPTIONAL client-supplied
 * display view — to the tenant scope its Veris reads run under. Pure and total; performs
 * no I/O. The role/entity MUST already have been resolved from the verified session.
 */
export function resolveVerisScope(
  role: VerisRole,
  entity: VerisEntity | null,
  requestedView?: VerisView,
): VerisScopeResult {
  if (role === 'super_admin') {
    // Entitled to all tenants. The requested view selects WITHIN that entitlement; with none
    // supplied, the default surface is the consolidated (cross-tenant) view. ONLY a recognized
    // single-tenant view ('bxr'/'indigo') narrows scope — anything else (incl. an unvalidated /
    // out-of-type requestedView) falls back to consolidated, so ENTITY_ID is never indexed with
    // an unknown key (which would silently yield entityId: undefined).
    if (requestedView === 'bxr' || requestedView === 'indigo') {
      return {
        ok: true,
        scope: { mode: 'tenant', entity: requestedView, entityId: ENTITY_ID[requestedView] },
        anomaly: null,
      };
    }
    return { ok: true, scope: { mode: 'consolidated' }, anomaly: null };
  }

  // admin | user: ALWAYS scoped to their own session entity — the session is the sole
  // authority. Defensive: a tenant-scoped role must carry an entity (enforced by the
  // claims.app_user CHECK); if it somehow does not, fail closed.
  if (!entity) return { ok: false, reason: 'no_tenant' };

  // A requestedView that disagrees with the session entity is a client trying to view
  // another (or the consolidated) scope — IGNORED, and reported so the caller can log it.
  const anomaly =
    requestedView && requestedView !== entity
      ? `ignored client view '${requestedView}' for ${role} scoped to '${entity}'`
      : null;

  return {
    ok: true,
    scope: { mode: 'tenant', entity, entityId: ENTITY_ID[entity] },
    anomaly,
  };
}
