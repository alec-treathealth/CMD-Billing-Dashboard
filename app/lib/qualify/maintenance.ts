/**
 * Qualify maintenance-mode flag. /qualify and /qualify/m render a "being rebuilt" notice instead of
 * the tab for EVERY user — with NO exceptions as of 2026-09-11 (Alec: stashed, "not visible to
 * anyone, not even me or ryan"). This docblock promised a bypass allowlist until that ruling;
 * there is no longer one to be on.
 *
 * ON BY DEFAULT during the refactor. KILL SWITCH: set env QUALIFY_MAINTENANCE to "0" / "false" /
 * "off" to disable and restore the live tab for everyone. Changing it on Vercel requires a redeploy.
 * To fully revert, `git revert` the commit that added this flag — nothing else references it.
 */

// ⚠ NO BYPASS — STASHED FOR EVERYONE, RULED BY ALEC 2026-09-11 (same ruling as Payer Intel).
// This was `new Set(['alec@treathealth.ai'])`; the one entry is removed rather than the Set kept
// empty-but-consulted, so there is no list for a future edit to quietly re-populate.
//
// Qualify deliberately never shared Claims Desk's allowlist (see lib/maintenance-bypass.ts), so
// unlike Payer Intel there was nothing to decouple here — only the single email to drop.

function maintenanceEnabled(): boolean {
  const v = (process.env.QUALIFY_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** True when this viewer should see the maintenance notice instead of the Qualify surface. */
export function qualifyMaintenanceBlocks(_email: string | null | undefined): boolean {
  return maintenanceEnabled();
}
