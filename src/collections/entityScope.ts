/**
 * Fail-closed tenant scope for collections READS (review finding #1, the Indigo read-gate).
 *
 * Every aggregate collections reader now takes an explicit `entityIds` (the business_entity_id(s)
 * the caller is entitled to, derived SERVER-SIDE from the RBAC-clamped view — see
 * app/lib/actions.ts viewEntityScope). This helper is the single choke point that enforces the
 * R1 invariant: an EMPTY or malformed scope must NEVER read (it would otherwise silently return
 * every tenant's rows). It throws instead — reads fail closed, exactly like the writer path's
 * withTenant UUID gate (src/veris/withTenant.ts).
 *
 * The ids are always canonical UUID literals from viewToEntityIds (app/lib/views.ts); the format
 * check is defense-in-depth. Returns a defensive copy so a caller can bind the validated value.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Assert a non-empty array of canonical UUIDs; throw (fail-closed) otherwise. */
export function assertEntityScope(entityIds: readonly string[] | undefined, where: string): string[] {
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    throw new Error(`${where}: entityIds required (fail-closed — an empty scope must never read all tenants)`);
  }
  for (const id of entityIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`${where}: entityIds must be canonical business_entity_id UUIDs`);
    }
  }
  return [...entityIds];
}
