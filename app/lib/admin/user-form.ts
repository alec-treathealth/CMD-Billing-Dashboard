/**
 * Manage Users — entity-coherence rules for the role/entity picker, shared by BOTH the invite form and
 * the per-row editor in user-manager.tsx and unit-tested in test/user-form.test.tsx.
 *
 * SINGLE SOURCE OF TRUTH for "which roles carry no entity". This MUST mirror the server gate
 * canAssign() in admin-actions.ts and the DB check claims.app_user_role_entity_ck (migration 0055):
 * super_admin and admissions_seat are ENTITY-LESS (cross-tenant; entity IS NULL), while admin and user
 * are entity-scoped. The client shaping is convenience only — the Server Action re-authorizes every
 * mutation — but an out-of-sync client silently submits payloads the server rejects. That was exactly
 * the admissions_seat bug this module fixes: the form treated admissions_seat like admin/user, so it
 * sent a stale/defaulted entity and the server bounced it ("You may not assign that role or entity.").
 */
import type { AppEntity, AppRole } from '@/lib/server';

/** Roles that take NO entity. Mirrors canAssign()'s `entityLess` + app_user_role_entity_ck (0055). */
export function isEntityLessRole(role: AppRole | ''): boolean {
  return role === 'super_admin' || role === 'admissions_seat';
}

/** Entity value to SUBMIT for a (role, drafted-entity) pair: entity-less roles send null and DROP any
 * stale/leftover selection; entity roles send the chosen entity (null if none has been picked yet). */
export function entityForSubmit(role: AppRole, entity: AppEntity | ''): AppEntity | null {
  return isEntityLessRole(role) ? null : entity || null;
}

/** Next entity value when the ROLE changes in a draft: entity-less roles clear it (so an entity left
 * over from a prior admin/user selection never survives the switch and get submitted anyway); a
 * freshly-chosen entity role with nothing selected gets the default; anything else is left as-is. */
export function entityAfterRoleChange(
  role: AppRole | '',
  currentEntity: AppEntity | '',
  defaultEntity: AppEntity | '',
): AppEntity | '' {
  if (isEntityLessRole(role)) return '';
  if (role !== '' && currentEntity === '') return defaultEntity;
  return currentEntity;
}
