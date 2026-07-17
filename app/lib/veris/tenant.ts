/**
 * Veris auth seam (composition root) — SERVER-ONLY.
 *
 * The ONE place a Veris (staging.*) request learns "which tenant am I" — ALWAYS from the
 * authenticated session, NEVER from a request body / query string / header. It combines
 * the existing dashboard identity (`dashboardAccess()` → verified Supabase session +
 * `claims.app_user` role row, migration 0025) with the pure policy resolver
 * (`src/veris/tenantScope`). This EXTENDS the dashboard's identity onto Veris (Alec's S5
 * ruling: extend + reuse `claims.app_user`, no parallel membership table).
 *
 * A future Veris Server Action / route (S10) calls this, then runs
 * `withTenant(scope.entityId, …)` for a `mode:'tenant'` scope, or the
 * `core.consolidated_summary()` path (019) for `mode:'consolidated'` — never an RLS bypass.
 *
 * FAIL CLOSED for PHI: unlike the dashboard's non-PHI overview, Veris must NOT inherit
 * `dashboardAccess()`'s permissive no-auth staged-rollout fallback (which returns an
 * unscoped `super_admin` when Supabase env is absent). Here, an absent / unprovisioned /
 * entity-less principal yields nothing. Do not import from a Client Component.
 */
import { dashboardAccess } from '../access';
import { resolveVerisScope, type VerisScope } from '../../../src/veris/tenantScope.js';
import type { DashboardView } from '../views';

export type { VerisScope };

export type VerisAccess =
  | { ok: true; scope: VerisScope; user: { id: string; email: string } }
  | { ok: false; reason: 'unauthenticated' | 'unprovisioned' | 'no_tenant' };

/**
 * Resolve the current request to its Veris tenant scope. `requestedView` is an OPTIONAL
 * display hint from the client; for a tenant-scoped role it can only ever be ignored (the
 * session entity is the authority) — for a super_admin it selects within full entitlement.
 * Returns a typed denial (never throws) so callers fail closed.
 */
export async function resolveVerisAccess(requestedView?: DashboardView): Promise<VerisAccess> {
  const result = await dashboardAccess();
  if (!result.ok) return { ok: false, reason: result.reason };

  const { access } = result;
  // Veris fails closed: the dashboard's no-auth fallback (no real signed-in principal)
  // grants nothing on the PHI plane.
  if (!access.user) return { ok: false, reason: 'unauthenticated' };

  // admissions_seat is a Qualify (collections-plane) role, NOT a Veris/staging tenant role — it never
  // resolves to a staging.* tenant scope. Fail closed here (and narrow access.role to VerisRole). The
  // Veris claims plane is paused regardless; admissions_seat has no business on it.
  if (access.role === 'admissions_seat') return { ok: false, reason: 'no_tenant' };

  const resolved = resolveVerisScope(access.role, access.entity, requestedView);
  if (!resolved.ok) return { ok: false, reason: 'no_tenant' };

  if (resolved.anomaly) {
    // Non-PHI anomaly line: a client-supplied view was ignored because it disagreed with
    // the session's tenant. Log the auth user id (never email/PHI) for traceability.
    console.warn(`[veris-auth] ${resolved.anomaly} (user=${access.user.id})`);
  }

  return {
    ok: true,
    scope: resolved.scope,
    user: { id: access.user.id, email: access.user.email },
  };
}
