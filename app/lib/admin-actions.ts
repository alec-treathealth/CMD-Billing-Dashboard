'use server';

/**
 * User-management Server Actions (the ONLY browser path to provision/change dashboard roles and delete users).
 *
 * AUTHORIZATION lives here (the DB functions in migration 0026 can't see the session and enforce only
 * data integrity + the last-super-admin guard):
 *   • caller must be signed in, provisioned, and canManageUsers (admin or super_admin);
 *   • a super_admin manages anyone and assigns any role/entity;
 *   • an entity admin manages ONLY users in their own entity (or unprovisioned users), and may assign
 *     ONLY role∈{admin,user} within their OWN entity — never super_admin, never another entity;
 *   • no one may edit or delete THEIR OWN account (prevents accidental self-demotion / lockout).
 * Every successful mutation writes a non-PHI audit row (claims.access_audit) naming the real actor.
 * Inputs are validated/bounded; client-supplied identity is never trusted (target state is re-read).
 */
import {
  deleteAppUser,
  deleteOrphanAppUsers,
  facilitiesDimension,
  facilityGrantsByUser,
  listAppUsers,
  recordAccess,
  setAppUserFacilities,
  upsertAppUser,
  type AppEntity,
  type AppRole,
  type ManagedUser,
} from '@/lib/server';
import {
  facilityBelongsToEntity,
  facilityIsActiveForEntity,
} from '../../src/collections/cmdCustomers.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '@/lib/views';
import { dashboardAccess } from '@/lib/access';
import { supabaseAdminClient } from '@/lib/supabase/admin';
import { canonicalAppOrigin } from '@/lib/auth/email-link';
import type { ExecutiveUser } from '@/lib/executive';
import type { Entity, Role } from '@/lib/rbac';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: readonly AppRole[] = ['super_admin', 'admin', 'user', 'admissions_seat'];
const ENTITIES: readonly AppEntity[] = ['bxr', 'indigo'];

// Roles that can be a MANAGER (caller of these actions). admissions_seat + user have
// canManageUsers=false, so they can never reach past requireManage — the type excludes them.
type ManagerRole = Exclude<Role, 'user' | 'admissions_seat'>;

export interface ManagedUserDto extends ManagedUser {
  /** Whether the CURRENT caller may edit this row (UI affordance; the action re-checks server-side). */
  editable: boolean;
  /**
   * Granted facility codes (0112). Meaningful ONLY for role='user'; empty for every other role.
   * An empty array on a `user` means DENY — the UI must not render it as "all".
   */
  facilityCodes: string[];
}

/** One selectable facility for the provisioning checkbox list. Non-PHI reference data. */
export interface AssignableFacility {
  code: string;
  name: string;
  /** 'IP' | 'OP' | 'BOTH' | null — groups the checkbox list. */
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
  /** Which tenant owns it; the UI shows only the selected tenant's facilities. */
  entity: AppEntity;
  /**
   * True when the facility is owned but no longer polled from CMD (retired). Still grantable, so a
   * scoped user keeps access to its HISTORY — but flagged, because granting it alone yields a user
   * who sees nothing current. Measured 2026-09-10: 10036020 MADISON RECOVERY CENTER and 10036030
   * MISSOURI BEHAVIORAL HEALTH (both Indigo, retired 2026-08-02, dimension row + zero data rows).
   */
  retired: boolean;
}

export interface ManageContext {
  callerRole: ManagerRole;
  callerEntity: Entity | null;
  callerUserId: string;
  /** Entities this caller may assign (all for super_admin; just their own for an entity admin). */
  assignableEntities: Entity[];
  /** Roles this caller may assign. */
  assignableRoles: AppRole[];
  /**
   * The facility roster the checkbox list renders, already filtered to the caller's assignable
   * tenants. Non-PHI reference data (code + name + care setting).
   */
  assignableFacilities: AssignableFacility[];
  users: ManagedUserDto[];
}

export type ManageUsersResult = { ok: true; data: ManageContext } | { ok: false; error: string };
export type MutateUserResult = { ok: true } | { ok: false; error: string };
export type InviteUserResult = { ok: true; user: ManagedUserDto } | { ok: false; error: string };

interface ManageGate {
  user: ExecutiveUser;
  role: ManagerRole;
  entity: Entity | null;
}

/** Resolve the caller and require canManageUsers, or a typed denial message. */
async function requireManage(): Promise<{ ok: true; gate: ManageGate } | { ok: false; error: string }> {
  const result = await dashboardAccess();
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'unprovisioned'
          ? 'Your account is not provisioned for this dashboard.'
          : 'Sign in to manage users.',
    };
  }
  const { access } = result;
  // canManageUsers is the semantic gate (super_admin|admin); the explicit role checks also NARROW
  // access.role to ManagerRole for the type system (a non-manager role — user or admissions_seat —
  // must never become gate.role).
  if (
    !access.user ||
    !access.canManageUsers ||
    access.role === 'user' ||
    access.role === 'admissions_seat'
  ) {
    return { ok: false, error: 'You do not have permission to manage users.' };
  }
  return { ok: true, gate: { user: access.user, role: access.role, entity: access.entity } };
}

/** Is `target` within the caller's management scope (by CURRENT role/entity)? Self is excluded elsewhere. */
function inScope(gate: ManageGate, target: ManagedUser): boolean {
  if (gate.role === 'super_admin') return true;
  // Entity admin: only unprovisioned users or users already in their entity; never a super_admin.
  return target.role !== 'super_admin' && (target.role === null || target.entity === gate.entity);
}

/** May the caller assign this (role, entity) combination? */
function canAssign(gate: ManageGate, role: AppRole, entity: AppEntity | null): boolean {
  // Coherence first: entity-less roles (super_admin, admissions_seat) take NO entity; admin/user
  // require one. Mirrors the DB app_user_role_entity_ck + upsert_app_user checks (migrations 0025/0055).
  const entityLess = role === 'super_admin' || role === 'admissions_seat';
  const coherent = (entityLess && entity === null) || (!entityLess && entity !== null);
  if (!coherent) return false;
  if (gate.role === 'super_admin') return true;
  // Entity admin: only admin/user within their OWN entity — never super_admin, never admissions_seat
  // (admissions_seat is cross-tenant and provisioned by super_admins only).
  return (role === 'admin' || role === 'user') && entity === gate.entity;
}

function toDto(
  gate: ManageGate,
  u: ManagedUser,
  grants: Record<string, string[]>,
): ManagedUserDto {
  return {
    ...u,
    editable: u.userId !== gate.user.id && inScope(gate, u),
    // Only the `user` seat has meaningful grants; every other role is whole-tenant or cross-tenant
    // and the read path never consults them. Reporting [] for those avoids a UI that implies a
    // restriction that is not enforced.
    facilityCodes: u.role === 'user' ? (grants[u.userId] ?? []) : [],
  };
}

/**
 * The facility roster a caller may assign from, as flat non-PHI options.
 *
 * ⚠ TENANT ATTRIBUTION COMES FROM CODE, NOT THE DATABASE. collections.facilities has no
 * business_entity_id — it is tenant-agnostic reference data — so ownership is resolved through
 * facilityBelongsToEntity (OWNED_CMD_CUSTOMERS, src/collections/cmdCustomers.ts). This is also why
 * migration 0112's definer cannot validate tenant coherence and this layer must.
 *
 * OWNERSHIP, not the active polling roster, is the filter: ownership is permanent, so a retired
 * facility stays grantable and its history stays reachable. Retired ones are FLAGGED rather than
 * hidden — see AssignableFacility.retired.
 */
async function assignableFacilitiesFor(entities: readonly AppEntity[]): Promise<AssignableFacility[]> {
  const dim = await facilitiesDimension();
  const idFor: Record<AppEntity, string> = { bxr: BXR_ENTITY_ID, indigo: INDIGO_ENTITY_ID };
  const out: AssignableFacility[] = [];
  for (const f of dim) {
    for (const entity of entities) {
      if (!facilityBelongsToEntity(f.facility_code, idFor[entity])) continue;
      out.push({
        code: f.facility_code,
        name: f.facility_name,
        careSetting: f.care_setting,
        entity,
        // `facilityIsActiveForEntity` answers a DIFFERENT question from facilityBelongsToEntity and
        // must be used WITH it, never instead of it (that module's own warning) — owned-and-retired
        // and not-owned are different states and deserve different treatment.
        retired: !facilityIsActiveForEntity(f.facility_code, idFor[entity]),
      });
      break;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Validate a facility grant for (role, entity) and return the clean set, or a typed error.
 *
 * ⚠ THIS IS WHERE TENANT COHERENCE IS ENFORCED, AND IT IS THE ONLY PLACE IT CAN BE. Migration
 * 0112's definer validates that a code EXISTS in collections.facilities, but that table has no
 * business_entity_id — it is tenant-agnostic reference data — so the DB structurally cannot tell
 * whether NASH belongs to BXR or Indigo. facilityBelongsToEntity (OWNED_CMD_CUSTOMERS) is the only
 * source of that fact, and it lives in TypeScript. A successful definer call therefore proves
 * existence, NEVER tenant coherence. Do not "simplify" by trusting the definer.
 *
 * REQUIRES AT LEAST ONE facility for the `user` seat (R4 makes a grant an explicit snapshot, and an
 * empty snapshot is a user who can see nothing). The READ path still fails closed on an empty set
 * independently — a provisioning rule is not an access control.
 */
function validateFacilityGrant(
  role: AppRole,
  entity: AppEntity | null,
  codes: unknown,
): { ok: true; codes: string[] } | { ok: false; error: string } {
  if (role !== 'user') {
    // Facility grants are meaningless for every other role; the read path never consults them.
    // Silently empty rather than an error, so switching a user to admin does not require the
    // caller to first clear a list the new role ignores.
    return { ok: true, codes: [] };
  }
  if (!Array.isArray(codes)) return { ok: false, error: 'Choose at least one facility.' };
  const clean = [...new Set(codes.filter((c): c is string => typeof c === 'string' && c.trim() !== ''))];
  if (clean.length === 0) return { ok: false, error: 'Choose at least one facility for this user.' };
  if (clean.length > 500) return { ok: false, error: 'Too many facilities selected.' };
  if (!entity) return { ok: false, error: 'Choose a tenant before assigning facilities.' };
  const entityId = entity === 'bxr' ? BXR_ENTITY_ID : INDIGO_ENTITY_ID;
  const foreign = clean.find((c) => !facilityBelongsToEntity(c, entityId));
  if (foreign !== undefined) {
    return { ok: false, error: 'That facility does not belong to the selected tenant.' };
  }
  return { ok: true, codes: clean };
}

export async function listManagedUsers(): Promise<ManageUsersResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;
  try {
    const assignableEntities: AppEntity[] =
      gate.role === 'super_admin' ? [...ENTITIES] : gate.entity ? [gate.entity] : [];
    const [all, grants, assignableFacilities] = await Promise.all([
      listAppUsers(),
      facilityGrantsByUser(),
      assignableFacilitiesFor(assignableEntities),
    ]);
    const visible = all.filter((u) => gate.role === 'super_admin' || inScope(gate, u));
    return {
      ok: true,
      data: {
        callerRole: gate.role,
        callerEntity: gate.entity,
        callerUserId: gate.user.id,
        assignableEntities,
        assignableRoles: gate.role === 'super_admin' ? [...ROLES] : ['admin', 'user'],
        assignableFacilities,
        users: visible.map((u) => toDto(gate, u, grants)),
      },
    };
  } catch {
    return { ok: false, error: 'Could not load users right now.' };
  }
}

/** Map a DB-layer failure to a safe message (typed SQLSTATE, never a raw string match). */
function mutationError(err: unknown): string {
  // 23514 = check_violation: the only one reachable post-validation is the last-super-admin guard.
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23514') {
    return 'That change would remove the last super admin, or is not a valid role/entity combination.';
  }
  return 'Could not update that user right now.';
}

export async function setUserRole(
  targetUserId: string,
  role: AppRole,
  entity: AppEntity | null,
  /** Facility grant for the `user` seat (0112). Required and non-empty when role='user'. */
  facilityCodes: string[] = [],
): Promise<MutateUserResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;

  if (typeof targetUserId !== 'string' || !UUID_RE.test(targetUserId)) {
    return { ok: false, error: 'Invalid user reference.' };
  }
  if (!ROLES.includes(role)) return { ok: false, error: 'Invalid role.' };
  if (entity !== null && !ENTITIES.includes(entity)) return { ok: false, error: 'Invalid entity.' };
  if (targetUserId === gate.user.id) return { ok: false, error: "You can't change your own role." };
  if (!canAssign(gate, role, entity)) {
    return { ok: false, error: 'You may not assign that role or entity.' };
  }
  const grant = validateFacilityGrant(role, entity, facilityCodes);
  if (!grant.ok) return { ok: false, error: grant.error };

  // Re-read the target server-side (never trust the client for the target's current state/email).
  let target: ManagedUser | undefined;
  try {
    target = (await listAppUsers()).find((u) => u.userId === targetUserId);
  } catch {
    return { ok: false, error: 'Could not load that user right now.' };
  }
  if (!target) return { ok: false, error: 'That user no longer exists.' };
  if (!inScope(gate, target)) return { ok: false, error: 'You may not manage that user.' };

  // ⚠ TWO COMMITTED WRITES, NOT ONE TRANSACTION — so the failure path COMPENSATES (Qodo #361-1).
  //
  // upsertAppUser and setAppUserFacilities are separate pooled queries, each its own transaction.
  // Without compensation a failure in the second left the ROLE changed and the GRANTS stale while
  // the caller was told the change failed. The dangerous direction is user→user: if the previous
  // grant set is WIDER than the requested one, the target keeps access the admin just tried to
  // remove, and no audit row records it. (admin→user fails closed — a former admin has no grants —
  // but "usually closed" is not a property worth relying on.)
  //
  // The right fix is one definer that sets role, entity and grants atomically; that is a NEW
  // migration and is filed as a follow-up rather than bolted onto a PR whose migration is already
  // applied to production. Compensation closes the observable hole now.
  const priorRole = target.role;
  const priorEntity = target.entity;
  try {
    await upsertAppUser(targetUserId, target.email, role, entity);
  } catch (err) {
    // Nothing has changed yet — no compensation needed.
    return { ok: false, error: mutationError(err) };
  }
  try {
    // ALWAYS called, including with an empty set. Promoting a `user` to admin must CLEAR their
    // grants rather than leave rows that would silently take effect again if the role were ever
    // set back to `user`. 0112's definer permits an empty set for any role precisely so this
    // clear-on-role-change works without first restoring the old role.
    await setAppUserFacilities(targetUserId, grant.codes, gate.user.id);
  } catch (err) {
    // Roll the role/entity back to what it was, so a failed save leaves the principal exactly as
    // the admin found it. `priorRole` is null only for an unprovisioned target, which has no row
    // to restore — deleting is the correct inverse of the upsert that just created one.
    let restored = true;
    try {
      if (priorRole === null) await deleteAppUser(targetUserId);
      else await upsertAppUser(targetUserId, target.email, priorRole, priorEntity);
    } catch (restoreErr) {
      restored = false;
      console.error('[setUserRole] compensation FAILED — role may be partially applied:', restoreErr);
    }
    // A failed compensation is an access-control state nobody asked for, so it is audited even
    // though the action failed. The successful-rollback case needs no audit: nothing changed.
    if (!restored) {
      await recordAccess({
        actorEmail: gate.user.email,
        actorUserId: gate.user.id,
        action: 'provision_user_partial_failure',
        detail: { target: targetUserId, attemptedRole: role, attemptedEntity: entity, priorRole, priorEntity },
      });
    }
    return {
      ok: false,
      error: restored
        ? mutationError(err)
        : 'The change failed and could not be fully rolled back. Re-check this user before continuing.',
    };
  }
  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'provision_user',
    // non-PHI: uid + assigned role + facility CODES (reference data, never patient data).
    detail: { target: targetUserId, role, entity, facilities: grant.codes },
  });
  return { ok: true };
}

/**
 * Delete a user entirely: remove the dashboard role row AND hard-delete the underlying Supabase Auth
 * account (so "Delete" means gone — the user can no longer authenticate). Strict, non-negotiable order:
 *   1. self-delete guard;
 *   2. deleteAppUser() FIRST — its last-super-admin guard (in claims.delete_app_user) is the real check
 *      and MUST succeed before anything irreversible happens;
 *   3. only THEN hard-delete the auth account;
 *   4. if (3) throws, surface a specific, retryable error — do NOT restore the role row to compensate
 *      (the role is intentionally gone; a retry re-runs step 2 as a no-op and re-attempts the delete).
 */
export async function deleteUser(targetUserId: string): Promise<MutateUserResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;

  if (typeof targetUserId !== 'string' || !UUID_RE.test(targetUserId)) {
    return { ok: false, error: 'Invalid user reference.' };
  }
  // 1. Self-delete guard.
  if (targetUserId === gate.user.id) return { ok: false, error: "You can't delete your own account." };

  let target: ManagedUser | undefined;
  try {
    target = (await listAppUsers()).find((u) => u.userId === targetUserId);
  } catch {
    return { ok: false, error: 'Could not load that user right now.' };
  }
  if (!target) return { ok: false, error: 'That user no longer exists.' };
  if (!inScope(gate, target)) return { ok: false, error: 'You may not manage that user.' };

  // 2. Role row first — the last-super-admin guard lives here and must pass before we touch auth.
  //    (If the user is already unprovisioned, this is a no-op DELETE and we still proceed to auth.)
  try {
    await deleteAppUser(targetUserId);
  } catch (err) {
    return { ok: false, error: mutationError(err) };
  }
  // Audit the role removal NOW, so it is recorded even if the auth-account deletion below fails.
  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'delete_user_role',
    detail: { target: targetUserId }, // non-PHI: uid + action only
  });

  // 3. Only now hard-delete the Supabase Auth account (service-role, server-side only).
  try {
    const { error } = await supabaseAdminClient().auth.admin.deleteUser(targetUserId);
    if (error) throw error;
  } catch {
    // 4. Role is gone but the auth account is not — report a specific, retryable error. Do NOT
    //    re-create the role row to compensate; a retry re-runs step 2 (no-op) and retries the delete.
    return {
      ok: false,
      error: 'Role removed, but the auth account could not be deleted — click Delete again to retry.',
    };
  }
  // Distinct audit row for the irreversible auth-account deletion (separate from the role removal above).
  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'delete_auth_account',
    detail: { target: targetUserId }, // non-PHI: uid + action only
  });
  return { ok: true };
}

/**
 * Invite a brand-new user (SUPER_ADMIN only): create their Supabase Auth account + email the invite via
 * the admin API (service-role, server-side ONLY), then assign their dashboard role. If the email already
 * has an account, falls back to assigning the role to that existing user. Audited; role/entity coherence
 * enforced.
 *
 * Invite emails are rendered + sent by THIS app's Send Email hook (app/app/api/auth-email-hook/route.ts)
 * via Resend — NOT Supabase's built-in templates/SMTP. The link is built on the CANONICAL app origin
 * (never the request host, which may be a preview deploy) so it resolves in prod and the installed PWA
 * stays same-origin. For an admissions_seat we pass `seat=admissions` in redirect_to; the hook reads it
 * and sends a two-choice invite ("Set up on mobile" → /qualify/m, "Set up on web" → /qualify), each of
 * which still passes through /set-password first.
 */
export async function inviteUser(
  email: string,
  role: AppRole,
  entity: AppEntity | null,
  /** Facility grant for the `user` seat (0112). Required and non-empty for role='user'. */
  facilityCodes: string[] = [],
): Promise<InviteUserResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;
  if (gate.role !== 'super_admin') {
    return { ok: false, error: 'Only a super admin can invite new users.' };
  }

  const normEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(normEmail) || normEmail.length > 320) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  if (!ROLES.includes(role)) return { ok: false, error: 'Invalid role.' };
  if (entity !== null && !ENTITIES.includes(entity)) return { ok: false, error: 'Invalid entity.' };
  if (!canAssign(gate, role, entity)) {
    return { ok: false, error: 'That role/entity combination is not valid.' };
  }
  // Validated BEFORE the invite is sent: a rejected grant must not leave a provisioned account and
  // a delivered email behind, which is exactly what happens if this runs after inviteUserByEmail.
  const grant = validateFacilityGrant(role, entity, facilityCodes);
  if (!grant.ok) return { ok: false, error: grant.error };

  // Always build the invite link on the canonical prod origin (not the request host). For an
  // admissions_seat, flag the two-choice (mobile / web) invite the Send Email hook renders.
  const origin = canonicalAppOrigin();
  const seatParam = role === 'admissions_seat' ? '&seat=admissions' : '';
  const redirectTo = `${origin}/auth/confirm?next=/set-password${seatParam}`;

  let userId: string | null = null;
  // Whether THIS call created the Auth account. Compensation may only remove an account we made;
  // the existing-account fallback below must never delete a pre-existing sign-in.
  let authAccountIsNew = false;
  try {
    const { data, error } = await supabaseAdminClient().auth.admin.inviteUserByEmail(
      normEmail,
      { redirectTo },
    );
    if (error) throw error;
    userId = data.user?.id ?? null;
    authAccountIsNew = userId !== null;
  } catch (err) {
    // Surface the real reason (rate limit, invalid address, GoTrue error) in the server logs — the
    // Admin API error is otherwise swallowed here and invisible in Vercel logs. Staff email/uid only,
    // no patient PHI.
    console.error('[inviteUser] admin.inviteUserByEmail failed:', err);
    // Most likely the email already has an account — fall back to assigning the role to that user.
    try {
      userId = (await listAppUsers()).find((u) => u.email.toLowerCase() === normEmail)?.userId ?? null;
    } catch {
      userId = null;
    }
    if (!userId) {
      return {
        ok: false,
        error: 'Could not send the invite. Check the address and email delivery, then try again.',
      };
    }
  }
  if (!userId) return { ok: false, error: 'The invite did not return a user. Please try again.' };

  try {
    await upsertAppUser(userId, normEmail, role, entity);
  } catch (err) {
    return { ok: false, error: mutationError(err) };
  }

  // Reap any same-email rows orphaned by a prior out-of-band auth deletion (their uid no longer
  // exists in auth.users), keeping the row we just upserted. Covers both the invite-succeeded and
  // existing-account-fallback branches (both converge on `userId` above). Best-effort: the invite
  // itself has already succeeded, so a cleanup failure must not fail the action.
  try {
    await deleteOrphanAppUsers(normEmail, userId);
  } catch {
    // Non-fatal — the orphan (if any) stays until the next successful invite/cleanup.
  }

  // Facilities AFTER the role row exists: 0112's definer reads claims.app_user to check the role,
  // so calling it before upsertAppUser would raise "no such provisioned user".
  //
  // ⚠ AND THE FAILURE PATH COMPENSATES (Qodo #361-2). The invite email has already been sent and
  // the role row already committed by the time this runs, so a bare `return { ok: false }` left a
  // provisioned, emailed account with no grants — and no invite audit — while telling the admin it
  // failed. The residual state is FAIL-CLOSED (a `user` with zero grants sees nothing, by
  // allowedFacilitiesFor), so this is a reliability and orphaned-account problem rather than an
  // over-permissive one; it is still not a state anyone asked for.
  if (grant.codes.length > 0) {
    try {
      await setAppUserFacilities(userId, grant.codes, gate.user.id);
    } catch (err) {
      // Remove the role row we just created, and the Auth account ONLY if this call created it.
      // An existing-account fallback must keep its account and its previous role untouched.
      let cleaned = true;
      try {
        await deleteAppUser(userId);
        if (authAccountIsNew) await supabaseAdminClient().auth.admin.deleteUser(userId);
      } catch (cleanupErr) {
        cleaned = false;
        console.error('[inviteUser] compensation FAILED — orphaned account may remain:', cleanupErr);
      }
      if (!cleaned) {
        await recordAccess({
          actorEmail: gate.user.email,
          actorUserId: gate.user.id,
          action: 'invite_user_partial_failure',
          detail: { target: userId, role, entity, authAccountIsNew },
        });
      }
      return {
        ok: false,
        error: cleaned
          ? mutationError(err)
          : 'The invite failed and the partial account could not be removed. Check this address before retrying.',
      };
    }
  }

  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'invite_user',
    // non-PHI: uid + assigned role + the facility CODES (reference data, never patient data).
    detail: { target: userId, role, entity, facilities: grant.codes },
  });

  // Return an accurate row for the UI (re-read so confirmed-status / created_at reflect reality).
  const fallback: ManagedUserDto = {
    userId,
    email: normEmail,
    emailConfirmed: false,
    createdAt: new Date().toISOString(),
    role,
    entity,
    editable: true,
    facilityCodes: grant.codes,
  };
  try {
    const fresh = (await listAppUsers()).find((u) => u.userId === userId);
    return {
      ok: true,
      user: fresh
        ? { ...fresh, editable: inScope(gate, fresh), facilityCodes: grant.codes }
        : fallback,
    };
  } catch {
    return { ok: true, user: fallback };
  }
}
