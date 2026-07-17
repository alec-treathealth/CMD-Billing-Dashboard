/**
 * Qualify access gate — the SINGLE authorization + tenant-scope choke point for every Qualify server
 * action. SERVER-ONLY: imports dashboardAccess (reads cookies + DB). Never import from a Client
 * Component. The PURE policy (the Q-A role set + pinned cross-tenant scope, finding 2a) lives in
 * principal.ts so it is unit-testable without a live session; this module only feeds it the real
 * dashboardAccess() result.
 */
import { dashboardAccess } from '@/lib/access';
import {
  requireQualifyPrincipalFromAccess,
  type QualifyPrincipal,
} from '@/lib/qualify/principal';

export type { QualifyPrincipal };
export { requireQualifyPrincipalFromAccess };

/** Resolve the current request into a Qualify principal, or a typed denial (default-deny; fail-closed). */
export async function requireQualifyPrincipal(): Promise<QualifyPrincipal> {
  return requireQualifyPrincipalFromAccess(await dashboardAccess());
}
