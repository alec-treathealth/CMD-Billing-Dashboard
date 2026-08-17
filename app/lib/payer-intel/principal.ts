/**
 * Payer Intel principal — the PURE authorization + pinned-scope policy for the /payer-intel tab.
 * No runtime server import (the access shape is type-only), so it is hermetically unit-testable;
 * gate.ts feeds it the real dashboardAccess() result.
 *
 * DELIBERATELY THE QUALIFY POSTURE, NOT THE COLLECTIONS ONE, because this tab exposes
 * Qualify-class cross-tenant data (policy ratings, prefix cohorts, cross-tenant search):
 *   · ROLE SET: exactly { super_admin, admissions_seat }. Entity admin/user are DENIED,
 *     fail-closed — granting a tenant-scoped role a cross-tenant surface would widen tenant
 *     scope, which is a ruling, not a default. Widen it HERE (one reviewed line), never at a
 *     call site.
 *   · TENANT SCOPE: the pinned [BXR, Indigo] pair — NOT the entitlement union and NOT
 *     viewEntityScope (the Qualify principal's finding-2a shape).
 *   · R-AMOUNTS: `hasAmounts = role !== 'admissions_seat'` — decided ONLY here. Alec's ruling
 *     (2026-08-13): admissions seats may see NAMES wherever it makes the job easier, never
 *     payment amounts. Every dollar-bearing field the tab returns is stripped at the core's
 *     single choke point when this flag is false.
 *
 * Duplicated from app/lib/qualify/principal.ts rather than imported BECAUSE that module's header
 * forbids exporting its pinned constant, and because the two tabs' role policies must be able to
 * diverge independently (a future ruling may open Payer Intel to entity admins without touching
 * Qualify).
 */
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../views';

/** Module-LOCAL cross-tenant scope. Not exported — consume `entityIds` off the returned principal. */
const PAYER_INTEL_ENTITY_IDS: readonly string[] = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];

/** The minimal dashboardAccess() shape this policy reads — structurally satisfied by the real
 *  AccessResult, passed by gate.ts with no import here (keeps this module hermetically testable). */
export type PayerIntelAccessInput =
  | { ok: false; reason: 'unauthenticated' | 'unprovisioned' }
  | { ok: true; access: { user: { email: string; id: string } | null; role: string } };

export type PayerIntelPrincipal =
  | {
      ok: true;
      actor: { email: string; userId: string };
      entityIds: string[];
      /** R-AMOUNTS: dollars visible to everyone EXCEPT admissions_seat. Decided ONLY here. */
      hasAmounts: boolean;
    }
  | { ok: false; error: string };

/** Default-deny; fail-closed on no session / unprovisioned / the no-auth staged-rollout fallback
 *  (user === null — nothing to audit against) / any role outside { super_admin, admissions_seat }. */
export function requirePayerIntelPrincipalFromAccess(result: PayerIntelAccessInput): PayerIntelPrincipal {
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'unprovisioned'
          ? 'Your account is not provisioned for this dashboard.'
          : 'Sign in to use Payer Intel.',
    };
  }
  const { access } = result;
  if (!access.user) {
    return { ok: false, error: 'Payer Intel requires per-user sign-in.' };
  }
  if (access.role !== 'super_admin' && access.role !== 'admissions_seat') {
    return { ok: false, error: 'Your role does not have access to Payer Intel.' };
  }
  return {
    ok: true,
    actor: { email: access.user.email, userId: access.user.id },
    entityIds: [...PAYER_INTEL_ENTITY_IDS],
    hasAmounts: access.role !== 'admissions_seat',
  };
}
