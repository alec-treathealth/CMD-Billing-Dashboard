/**
 * Claims Desk (/billing-audit) maintenance-mode flag. While the Claims Desk workbench is being
 * refactored into an AI system, /billing-audit renders a "being rebuilt" notice instead of the
 * workbench for EVERY user except the bypass allowlist below — so the rebuild can be verified live
 * (and worked off-branch) while everyone else sees the notice.
 *
 * ON BY DEFAULT during the refactor. KILL SWITCH: set env CLAIMS_AUDIT_MAINTENANCE to "0" /
 * "false" / "off" to disable and restore the live workbench for everyone. Changing it on Vercel
 * requires a redeploy. To fully revert, `git revert` the commit that added this flag — nothing else
 * references it. (Mirrors lib/qualify/maintenance.ts.)
 */

// Only these emails bypass the maintenance notice and reach the live Claims Desk surface.
const MAINTENANCE_BYPASS_EMAILS = new Set(['alec@treathealth.ai']);

function maintenanceEnabled(): boolean {
  const v = (process.env.CLAIMS_AUDIT_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** True when this viewer should see the maintenance notice instead of the Claims Desk surface. */
export function claimsAuditMaintenanceBlocks(email: string | null | undefined): boolean {
  if (!maintenanceEnabled()) return false;
  return !MAINTENANCE_BYPASS_EMAILS.has((email ?? '').trim().toLowerCase());
}
