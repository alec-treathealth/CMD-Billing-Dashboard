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
import { bypassesMaintenance } from '../maintenance-bypass';

// ⚠ THE ALLOWLIST MOVED to lib/maintenance-bypass.ts (2026-08-18) and is now SHARED with Payer
// Intel, which was gated by the same decision for the same two people. It was a local one-email Set
// here. Sharing it means someone added for one surface cannot silently be missing from the other —
// a drift that reads like a permissions bug rather than a missed edit. Qualify deliberately keeps
// its own; see the note in that file.

function maintenanceEnabled(): boolean {
  const v = (process.env.CLAIMS_AUDIT_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** True when this viewer should see the maintenance notice instead of the Claims Desk surface. */
export function claimsAuditMaintenanceBlocks(email: string | null | undefined): boolean {
  if (!maintenanceEnabled()) return false;
  return !bypassesMaintenance(email);
}
