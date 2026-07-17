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
  listAppUsers,
  recordAccess,
  upsertAppUser,
  type AppEntity,
  type AppRole,
  type ManagedUser,
} from '@/lib/server';
import { dashboardAccess } from '@/lib/access';
import { supabaseAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';
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
}

export interface ManageContext {
  callerRole: ManagerRole;
  callerEntity: Entity | null;
  callerUserId: string;
  /** Entities this caller may assign (all for super_admin; just their own for an entity admin). */
  assignableEntities: Entity[];
  /** Roles this caller may assign. */
  assignableRoles: AppRole[];
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

function toDto(gate: ManageGate, u: ManagedUser): ManagedUserDto {
  return { ...u, editable: u.userId !== gate.user.id && inScope(gate, u) };
}

export async function listManagedUsers(): Promise<ManageUsersResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;
  try {
    const all = await listAppUsers();
    const visible = all.filter((u) => gate.role === 'super_admin' || inScope(gate, u));
    return {
      ok: true,
      data: {
        callerRole: gate.role,
        callerEntity: gate.entity,
        callerUserId: gate.user.id,
        assignableEntities: gate.role === 'super_admin' ? [...ENTITIES] : gate.entity ? [gate.entity] : [],
        assignableRoles: gate.role === 'super_admin' ? [...ROLES] : ['admin', 'user'],
        users: visible.map((u) => toDto(gate, u)),
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

  // Re-read the target server-side (never trust the client for the target's current state/email).
  let target: ManagedUser | undefined;
  try {
    target = (await listAppUsers()).find((u) => u.userId === targetUserId);
  } catch {
    return { ok: false, error: 'Could not load that user right now.' };
  }
  if (!target) return { ok: false, error: 'That user no longer exists.' };
  if (!inScope(gate, target)) return { ok: false, error: 'You may not manage that user.' };

  try {
    await upsertAppUser(targetUserId, target.email, role, entity);
  } catch (err) {
    return { ok: false, error: mutationError(err) };
  }
  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'provision_user',
    detail: { target: targetUserId, role, entity }, // non-PHI: uid + assigned role only
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
 * enforced. Invite emails use Supabase's configured templates/SMTP (default sender is rate-limited to
 * external domains — custom SMTP recommended for reliable delivery).
 */
export async function inviteUser(
  email: string,
  role: AppRole,
  entity: AppEntity | null,
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

  const origin = (await headers()).get('origin') ?? undefined;

  let userId: string | null = null;
  try {
    const { data, error } = await supabaseAdminClient().auth.admin.inviteUserByEmail(
      normEmail,
      origin ? { redirectTo: `${origin}/auth/confirm?next=/set-password` } : undefined,
    );
    if (error) throw error;
    userId = data.user?.id ?? null;
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

  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'invite_user',
    detail: { target: userId, role, entity }, // non-PHI: uid + assigned role only
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
  };
  try {
    const fresh = (await listAppUsers()).find((u) => u.userId === userId);
    return { ok: true, user: fresh ? { ...fresh, editable: inScope(gate, fresh) } : fallback };
  } catch {
    return { ok: true, user: fallback };
  }
}
