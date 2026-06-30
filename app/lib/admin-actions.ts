'use server';

/**
 * User-management Server Actions (the ONLY browser path to provision/change/revoke dashboard roles).
 *
 * AUTHORIZATION lives here (the DB functions in migration 0026 can't see the session and enforce only
 * data integrity + the last-super-admin guard):
 *   • caller must be signed in, provisioned, and canManageUsers (admin or super_admin);
 *   • a super_admin manages anyone and assigns any role/entity;
 *   • an entity admin manages ONLY users in their own entity (or unprovisioned users), and may assign
 *     ONLY role∈{admin,user} within their OWN entity — never super_admin, never another entity;
 *   • no one may edit or revoke THEIR OWN row (prevents accidental self-demotion / lockout).
 * Every successful mutation writes a non-PHI audit row (claims.access_audit) naming the real actor.
 * Inputs are validated/bounded; client-supplied identity is never trusted (target state is re-read).
 */
import {
  deleteAppUser,
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
const ROLES: readonly AppRole[] = ['super_admin', 'admin', 'user'];
const ENTITIES: readonly AppEntity[] = ['bxr', 'indigo'];

export interface ManagedUserDto extends ManagedUser {
  /** Whether the CURRENT caller may edit this row (UI affordance; the action re-checks server-side). */
  editable: boolean;
}

export interface ManageContext {
  callerRole: Exclude<Role, 'user'>;
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
  role: Exclude<Role, 'user'>;
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
  if (!access.user || !access.canManageUsers || access.role === 'user') {
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
  // Coherence first: super_admin has no entity; admin/user require one.
  const coherent =
    (role === 'super_admin' && entity === null) ||
    (role !== 'super_admin' && entity !== null);
  if (!coherent) return false;
  if (gate.role === 'super_admin') return true;
  // Entity admin: only admin/user within their OWN entity.
  return role !== 'super_admin' && entity === gate.entity;
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

export async function revokeUser(targetUserId: string): Promise<MutateUserResult> {
  const auth = await requireManage();
  if (!auth.ok) return auth;
  const { gate } = auth;

  if (typeof targetUserId !== 'string' || !UUID_RE.test(targetUserId)) {
    return { ok: false, error: 'Invalid user reference.' };
  }
  if (targetUserId === gate.user.id) return { ok: false, error: "You can't revoke your own access." };

  let target: ManagedUser | undefined;
  try {
    target = (await listAppUsers()).find((u) => u.userId === targetUserId);
  } catch {
    return { ok: false, error: 'Could not load that user right now.' };
  }
  if (!target) return { ok: false, error: 'That user no longer exists.' };
  if (target.role === null) return { ok: true }; // already unprovisioned — no-op
  if (!inScope(gate, target)) return { ok: false, error: 'You may not manage that user.' };

  try {
    await deleteAppUser(targetUserId);
  } catch (err) {
    return { ok: false, error: mutationError(err) };
  }
  await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'revoke_user',
    detail: { target: targetUserId },
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
  } catch {
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
