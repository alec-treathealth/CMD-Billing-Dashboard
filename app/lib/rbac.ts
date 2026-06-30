/**
 * RBAC policy — PURE, side-effect-free authorization rules.
 *
 * This module holds ONLY the role → entitlement decisions (which views a role may see, whether it
 * may reveal PHI, whether it may manage users). It touches no DB, no session, no secrets, so it is
 * trivially testable and safe to import from either the server gate (`access.ts`) or pure logic.
 * The actual session resolution + DB lookup lives in `access.ts` (impure); the row shape comes from
 * `server.ts` (`AppUserRow`). Keep policy HERE so there is one place to reason about "who can do what".
 *
 * Roles (migration 0025):
 *   • super_admin        — all three views; may reveal PHI; may manage users.
 *   • admin   + entity   — that entity's view only; may reveal PHI; may manage users.
 *   • user    + entity   — that entity's view only; NON-PHI only (no PHI reveal, no user mgmt).
 */
import { ALL_VIEWS, DEFAULT_VIEW, type DashboardView } from './views';

export type Role = 'super_admin' | 'admin' | 'user';
export type Entity = 'bxr' | 'indigo';

/** The view an entity maps to (1:1 today). */
const ENTITY_VIEW: Record<Entity, DashboardView> = {
  bxr: 'bxr',
  indigo: 'indigo',
};

/**
 * Views a (role, entity) may select. super_admin sees all three (incl. Consolidated = BXR+Indigo);
 * an entity-scoped role sees ONLY its entity's view. The list is non-empty and its first element is
 * that user's effective default (used by clampView). An admin/user is always entity-scoped per the
 * DB CHECK, so the empty-entity branch is an unreachable safe fallback.
 */
export function allowedViewsFor(role: Role, entity: Entity | null): DashboardView[] {
  if (role === 'super_admin') return [...ALL_VIEWS];
  if (entity) return [ENTITY_VIEW[entity]];
  return [DEFAULT_VIEW];
}

/** Admins and super-admins may unmask patient identifiers; plain users may not. */
export function canRevealPhi(role: Role): boolean {
  return role === 'super_admin' || role === 'admin';
}

/** Admins and super-admins may provision/manage users (in-app UI deferred). */
export function canManageUsers(role: Role): boolean {
  return role === 'super_admin' || role === 'admin';
}
