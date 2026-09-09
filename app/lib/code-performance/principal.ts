/**
 * Code Performance principal — PURE policy (hermetically tested in app/test). Decides which tenants a
 * session may look at on /code-performance and clamps the client's tenant hint to that set.
 *
 * Posture matches `viewEntityScope` in app/lib/actions.ts: collections-plane data FAILS CLOSED —
 * no real signed-in principal → nothing; an entitlement with no bxr/indigo view → nothing;
 * admissions_seat → nothing (the page also redirects that role server-side, the same gate the old
 * Code Reference page carried). `super_admin`'s 'consolidated' view does not appear here: this
 * surface is single-tenant by construction (see contract.ts).
 */
import type { AccessResult } from '../access';
import type { Role } from '../rbac';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID, type DashboardView } from '../views';
import { CODE_PERF_TENANTS, type CodePerfTenant } from './contract';

export interface CodePerfPrincipal {
  role: Role;
  /** Tenants this session may select, in display order (bxr, indigo). Never empty. */
  tenants: CodePerfTenant[];
  defaultTenant: CodePerfTenant;
}

/** The bxr/indigo subset of an entitlement, in fixed display order. 'consolidated' contributes nothing. */
export function codePerfTenantsFromViews(views: readonly DashboardView[]): CodePerfTenant[] {
  return CODE_PERF_TENANTS.filter((t) => views.includes(t));
}

/** Clamp a client hint to the allowed set: the hint if allowed, else the first allowed, else null. */
export function resolveCodePerfTenant(
  requested: unknown,
  allowed: readonly CodePerfTenant[],
): CodePerfTenant | null {
  if (typeof requested === 'string' && (allowed as readonly string[]).includes(requested)) {
    return requested as CodePerfTenant;
  }
  return allowed[0] ?? null;
}

export function codePerfEntityId(tenant: CodePerfTenant): string {
  return tenant === 'bxr' ? BXR_ENTITY_ID : INDIGO_ENTITY_ID;
}

/** null = deny. The caller returns `{ ok: false, reason: 'forbidden' }` and never touches the reader. */
export function codePerfPrincipalFromAccess(result: AccessResult): CodePerfPrincipal | null {
  if (!result.ok) return null;
  const { access } = result;
  // No real principal (the no-auth staged-rollout fallback) → no tenant data. Fail closed.
  if (!access.user) return null;
  if (access.role === 'admissions_seat') return null;
  const tenants = codePerfTenantsFromViews(access.allowedViews);
  const defaultTenant = tenants[0];
  if (!defaultTenant) return null;
  return { role: access.role, tenants, defaultTenant };
}
