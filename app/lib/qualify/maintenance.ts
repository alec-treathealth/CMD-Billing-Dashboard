/**
 * Qualify maintenance-mode flag. While the Qualify surface is being refactored into an AI system,
 * /qualify and /qualify/m render a "being rebuilt" notice instead of the tab for EVERY user except
 * the bypass allowlist below — so the rebuild can be verified live while everyone else sees the notice.
 *
 * ON BY DEFAULT during the refactor. KILL SWITCH: set env QUALIFY_MAINTENANCE to "0" / "false" /
 * "off" to disable and restore the live tab for everyone. Changing it on Vercel requires a redeploy.
 * To fully revert, `git revert` the commit that added this flag — nothing else references it.
 */

// Only these emails bypass the maintenance notice and reach the live Qualify surface.
const MAINTENANCE_BYPASS_EMAILS = new Set(['alec@treathealth.ai']);

function maintenanceEnabled(): boolean {
  const v = (process.env.QUALIFY_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** True when this viewer should see the maintenance notice instead of the Qualify surface. */
export function qualifyMaintenanceBlocks(email: string | null | undefined): boolean {
  if (!maintenanceEnabled()) return false;
  return !MAINTENANCE_BYPASS_EMAILS.has((email ?? '').trim().toLowerCase());
}
