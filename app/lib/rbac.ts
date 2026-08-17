/**
 * RBAC policy — PURE, side-effect-free authorization rules.
 *
 * This module holds ONLY the role → entitlement decisions (which views a role may see, whether it
 * may reveal PHI, whether it may manage users). It touches no DB, no session, no secrets, so it is
 * trivially testable and safe to import from either the server gate (`access.ts`) or pure logic.
 * The actual session resolution + DB lookup lives in `access.ts` (impure); the row shape comes from
 * `server.ts` (`AppUserRow`). Keep policy HERE so there is one place to reason about "who can do what".
 *
 * Roles (migrations 0025, 0055):
 *   • super_admin        — all three views; may reveal PHI; may manage users.
 *   • admin   + entity   — that entity's view only; may reveal PHI; may manage users.
 *   • user    + entity   — that entity's view only; NON-PHI only (no PHI reveal, no user mgmt).
 *   • admissions_seat    — NO dashboard views (Qualify tab ONLY, nav/route enforced in app code);
 *                          entity-less (cross-tenant); MAY reveal PHI (audited, on Qualify);
 *                          may NOT manage users. Amounts-gating is handled in the Qualify contract
 *                          (viewerHasAmountsCapability = role !== 'admissions_seat'), not here.
 */
import { ALL_VIEWS, type DashboardView } from './views';

export type Role = 'super_admin' | 'admin' | 'user' | 'admissions_seat';
export type Entity = 'bxr' | 'indigo';

/** The view an entity maps to (1:1 today). */
const ENTITY_VIEW: Record<Entity, DashboardView> = {
  bxr: 'bxr',
  indigo: 'indigo',
};

/**
 * Views a (role, entity) may select. super_admin sees all three (incl. Consolidated = BXR+Indigo);
 * an entity-scoped role sees ONLY its entity's view; the first element is that user's effective
 * default (used by clampView). An admin/user is always entity-scoped per the app_user CHECK, so
 * the entity-less branch is unreachable — but it FAILS CLOSED (empty list, NOT DEFAULT_VIEW).
 * DEFAULT_VIEW is 'consolidated' (cross-tenant); returning it for a misconfigured entity-scoped
 * role would silently grant BXR+Indigo. Every consumer treats an empty allowlist as "deny".
 */
export function allowedViewsFor(role: Role, entity: Entity | null): DashboardView[] {
  if (role === 'super_admin') return [...ALL_VIEWS];
  // admissions_seat sees NO dashboard views — its only surface is the cross-tenant Qualify tab
  // (nav + route enforced in app code; scope pinned by requireQualifyPrincipal). It is deliberately
  // NOT view-scoped, so it must never fall through to an entity/default view.
  if (role === 'admissions_seat') return [];
  if (entity) return [ENTITY_VIEW[entity]];
  return [];
}

/**
 * Who may unmask patient identifiers. super_admin + admin (dashboard), and admissions_seat (Qualify:
 * masked-by-default with an audited reveal, per ruling R-PHI). Plain `user` may not.
 */
export function canRevealPhi(role: Role): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'admissions_seat';
}

/** Admins and super-admins may provision/manage users (in-app UI deferred). */
export function canManageUsers(role: Role): boolean {
  return role === 'super_admin' || role === 'admin';
}

/**
 * Where an admissions_seat is sent when it hits a protected route it may not use.
 *
 * ⚠ REPOINTED 2026-08-17 to `/payer-intel`, because the Qualify TAB came down that day (Alec) and
 * a redirect to a nav-less surface is a dead end. The NAME is kept — eight route guards import it
 * — and renaming them would be churn that hides the one thing that actually changed: the value.
 * Read it as "the seat's home", not "the Qualify page".
 */
export const QUALIFY_HOME = '/payer-intel';

/**
 * admissions_seat is a SINGLE-SURFACE persona (nav-hidden AND route-blocked everywhere else).
 * Every protected route that excludes it calls this and redirects to QUALIFY_HOME — server-side,
 * not just nav-hiding. Pure so the guard is unit-testable without a live session.
 *
 * ⚠ /payer-intel must NEVER call this: the seat is admitted there, and as of 2026-08-17 that is
 * the ONLY surface it may use.
 */
export function isQualifyOnlyRole(role: Role): boolean {
  return role === 'admissions_seat';
}
