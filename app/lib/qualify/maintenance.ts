/**
 * Qualify maintenance-mode flag. When enabled, /qualify and /qualify/m render a "Down for
 * maintenance" notice instead of the tab for EVERY user except the bypass allowlist below — so
 * improvements can be verified live while everyone else sees the notice.
 *
 * TOGGLE: set env QUALIFY_MAINTENANCE to "1" / "true" / "on" to enable; unset (or any other value)
 * to disable. Changing it on Vercel requires a redeploy. To fully revert, `git revert` the commit
 * that added this flag — nothing else references it.
 */

// Only these emails bypass the maintenance notice and reach the live Qualify surface.
const MAINTENANCE_BYPASS_EMAILS = new Set(['alec@treathealth.ai']);

function maintenanceEnabled(): boolean {
  const v = (process.env.QUALIFY_MAINTENANCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** True when this viewer should see the maintenance notice instead of the Qualify surface. */
export function qualifyMaintenanceBlocks(email: string | null | undefined): boolean {
  if (!maintenanceEnabled()) return false;
  return !MAINTENANCE_BYPASS_EMAILS.has((email ?? '').trim().toLowerCase());
}
