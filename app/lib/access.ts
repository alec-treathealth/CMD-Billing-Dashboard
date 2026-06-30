/**
 * Authorization gate (default-deny). SERVER-ONLY.
 *
 * `dashboardAccess()` answers "who is this request, and what may they do?" by combining the
 * authenticated identity (`requireExecutive` → verified Supabase session) with the per-user role
 * row (`appUserFor` → claims.app_user, migration 0025). It returns a resolved `Access` (allowed
 * views + PHI-reveal / user-mgmt capability) or a typed denial. The role→capability policy is pure
 * and lives in `rbac.ts`; this module only resolves the principal and applies it.
 *
 * Wrapped in React `cache()` so the layout AND the page of a single render share one evaluation
 * (one getUser + one DB lookup per request). Do NOT import from a Client Component — it reads
 * cookies + the DB. PHI/claims data still flows only through the least-privilege claims_reader
 * node-postgres path; this is for AUTHORIZATION, never PostgREST data.
 *
 * Staged-rollout fallback: when Supabase auth is NOT configured (local dev / a deploy before the
 * env is set), there is no per-user principal, so we return a benign UNSCOPED access (all views,
 * PHI reveal OFF — a reveal needs a real principal to audit and fails closed downstream anyway).
 * This preserves the pre-RBAC behavior so adding the gate never 500s the non-authed routes.
 */
import { cache } from 'react';
import { requireExecutive, type ExecutiveUser } from './executive';
import { appUserFor } from './server';
import { supabaseAuthConfigured } from './supabase/env';
import { allowedViewsFor, canManageUsers, canRevealPhi, type Entity, type Role } from './rbac';
import type { DashboardView } from './views';

export interface Access {
  /** The signed-in principal, or null in the no-auth staged-rollout fallback. */
  user: ExecutiveUser | null;
  role: Role;
  entity: Entity | null;
  /** Views this principal may select (non-empty; first element is their default). */
  allowedViews: DashboardView[];
  /** May unmask patient identifiers (admins + super-admins). */
  canRevealPhi: boolean;
  /** May provision/manage users (admins + super-admins; UI deferred). */
  canManageUsers: boolean;
}

export type AccessResult =
  | { ok: true; access: Access }
  | { ok: false; reason: 'unauthenticated' }
  // Signed in, but no role row yet — carries the user so the chrome can still offer Sign out.
  | { ok: false; reason: 'unprovisioned'; user: ExecutiveUser };

function accessFor(user: ExecutiveUser | null, role: Role, entity: Entity | null): Access {
  return {
    user,
    role,
    entity,
    allowedViews: allowedViewsFor(role, entity),
    canRevealPhi: canRevealPhi(role),
    canManageUsers: canManageUsers(role),
  };
}

export const dashboardAccess = cache(async (): Promise<AccessResult> => {
  // No per-user auth yet → unscoped, PHI-reveal-off fallback (pre-RBAC behavior preserved).
  if (!supabaseAuthConfigured()) {
    return { ok: true, access: { ...accessFor(null, 'super_admin', null), canRevealPhi: false } };
  }

  const gate = await requireExecutive();
  if (!gate.ok) return { ok: false, reason: 'unauthenticated' };

  const row = await appUserFor(gate.user.id);
  if (!row) return { ok: false, reason: 'unprovisioned', user: gate.user };

  return { ok: true, access: accessFor(gate.user, row.role, row.entity) };
});
