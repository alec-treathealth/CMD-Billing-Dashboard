/**
 * Qualify principal — the PURE Q-A authorization + pinned-scope policy. No runtime server import
 * (AccessResult is type-only; views is a pure module), so it is hermetically unit-testable. gate.ts
 * feeds it the real dashboardAccess() result.
 *
 * TWO deliberate divergences from the collections requirePhiPrincipal, both load-bearing:
 *   1) ROLE SET (Q-A): admits EXACTLY { super_admin, admissions_seat }. An entity admin/user is
 *      denied, fail-closed — this keeps a CROSS-TENANT surface limited to already-cross-tenant
 *      (super_admin) or defined-cross-tenant (admissions_seat) roles.
 *   2) TENANT SCOPE (finding 2a): returns the PINNED [BXR, Indigo] array — NOT the entitlement union
 *      and NOT viewEntityScope. Do NOT "fix" it to the single-tenant pattern.
 */
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../views';

/**
 * Module-LOCAL cross-tenant constant. Deliberately NOT exported: no single-tenant surface may import
 * or reuse it (finding 2a). Callers consume `entityIds` off the returned principal instead.
 */
const QUALIFY_ENTITY_IDS: readonly string[] = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];

/**
 * The minimal shape of dashboardAccess()'s result this policy reads — structurally satisfied by the
 * real AccessResult (app/lib/access.ts), so gate.ts passes it directly with NO import here (keeps this
 * module free of the server-only access→server→pg graph, so it stays hermetically testable).
 */
export type QualifyAccessInput =
  | { ok: false; reason: 'unauthenticated' | 'unprovisioned' }
  | { ok: true; access: { user: { email: string; id: string } | null; role: string } };

export type QualifyPrincipal =
  | {
      ok: true;
      actor: { email: string; userId: string };
      entityIds: string[];
      /** R-AMOUNTS: dollars visible to everyone EXCEPT admissions_seat. Decided ONLY here. */
      hasAmounts: boolean;
    }
  | { ok: false; error: string };

/**
 * Apply the Qualify authorization + pinned scope to an already-resolved dashboard AccessResult.
 * Default-deny; fail-closed on no session / unprovisioned / no-auth fallback / any role outside
 * { super_admin, admissions_seat }.
 */
export function requireQualifyPrincipalFromAccess(result: QualifyAccessInput): QualifyPrincipal {
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'unprovisioned'
          ? 'Your account is not provisioned for this dashboard.'
          : 'Sign in to use Qualify.',
    };
  }
  const { access } = result;
  // No real principal (no-auth staged-rollout fallback) → deny; nothing to audit a reveal against.
  if (!access.user) {
    return { ok: false, error: 'Qualify requires per-user sign-in.' };
  }
  // Q-A: ONLY super_admin and admissions_seat reach Qualify. admin/user denied, fail-closed.
  if (access.role !== 'super_admin' && access.role !== 'admissions_seat') {
    return { ok: false, error: 'Your role does not have access to Qualify.' };
  }
  // Pinned cross-tenant scope (finding 2a). Defensive copy. NOT the entitlement union / viewEntityScope.
  return {
    ok: true,
    actor: { email: access.user.email, userId: access.user.id },
    entityIds: [...QUALIFY_ENTITY_IDS],
    hasAmounts: access.role !== 'admissions_seat',
  };
}
