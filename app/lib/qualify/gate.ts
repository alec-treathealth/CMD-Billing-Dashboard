/**
 * Qualify access gate — the SINGLE authorization + tenant-scope choke point for every Qualify server
 * action. SERVER-ONLY: imports dashboardAccess (reads cookies + DB). Never import from a Client
 * Component. The PURE policy (the Q-A role set + pinned cross-tenant scope, finding 2a) lives in
 * principal.ts so it is unit-testable without a live session; this module only feeds it the real
 * dashboardAccess() result.
 */
import { dashboardAccess } from '@/lib/access';
import { qualifyMaintenanceBlocks } from '@/lib/qualify/maintenance';
import {
  requireQualifyPrincipalFromAccess,
  type QualifyPrincipal,
} from '@/lib/qualify/principal';

export type { QualifyPrincipal };
export { requireQualifyPrincipalFromAccess };

/**
 * Resolve the current request into a Qualify principal, or a typed denial (default-deny;
 * fail-closed).
 *
 * ⚠ THE MAINTENANCE CHECK BELONGS HERE, NOT ONLY ON THE PAGES. Server Actions are the browser's only
 * data path and they gate on ROLE alone, so with the stash wired only at app/app/qualify/*, all 29
 * actions behind this symbol still answered a POST while the pages rendered the notice — including
 * the mutating ones (saveQualifyTrendWatcher, saveQualifyPatientWatcher, deleteQualifyWatcher,
 * recordQualifyRecentSearch, clearQualifyRecentSearches, all writing through the 0097 definers) and
 * the PHI reveals. Closed at the front door, open at the back.
 *
 * ⚠ DO NOT MOVE THIS INTO principal.ts:requireQualifyPrincipalFromAccess — the pages and the
 * registry editor gate both delegate to it, and a denial there changes page routing rather than
 * action behaviour. It is also what five root hermetic suites build their principals from, so
 * gating it would turn a policy test into a maintenance-flag test. gate.ts has ZERO test importers,
 * which is exactly why it is the right seam.
 *
 * ROLE IS CHECKED FIRST, deliberately: answering "paused for maintenance" to someone whose role may
 * never see this surface would leak that it exists.
 */
export async function requireQualifyPrincipal(): Promise<QualifyPrincipal> {
  const principal = await requireQualifyPrincipalFromAccess(await dashboardAccess());
  if (!principal.ok) return principal;
  if (qualifyMaintenanceBlocks(principal.actor.email)) {
    return { ok: false, error: 'Qualify is paused for maintenance.' };
  }
  return principal;
}
