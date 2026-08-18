/**
 * Payer Intel (/payer-intel) maintenance-mode flag. Mirrors lib/billing-audit/maintenance.ts, and
 * shares its bypass allowlist (lib/maintenance-bypass.ts) because the two surfaces were gated by the
 * same decision for the same two people.
 *
 * ON BY DEFAULT once this ships. KILL SWITCH: set env PAYER_INTEL_MAINTENANCE to "0" / "false" /
 * "off" to disable and restore the live board for everyone. Changing it on Vercel requires a
 * redeploy. To revert entirely, `git revert` the commit that added this — nothing else references it.
 *
 * ⚠ THIS GATE HAS A CONSEQUENCE THE CLAIMS DESK GATE DOES NOT, AND IT NEEDS TO BE UNDERSTOOD BEFORE
 * THE FIRST admissions_seat USER IS PROVISIONED.
 *
 * `admissions_seat` is a PAYER-INTEL-ONLY persona: `navLinksFor` returns exactly `[PAYER_INTEL_LINK]`
 * for it (lib/nav-model.ts). So for that role this is not "one tab is down" — it is the entire
 * product. A blocked admissions_seat user has no other surface to be sent to, which is why the
 * notice takes a `hasFullDashboard` flag and offers NO navigation links when it is false: dangling
 * "Go to Overview" links that redirect straight back would be worse than saying nothing.
 *
 * Measured at the time of writing: ZERO admissions_seat users exist (14 super_admin, 3 admin), so
 * today this affects nobody. It stops being theoretical the moment one is created — at which point
 * either add them to the bypass list or turn the flag off.
 *
 * Claims Desk has no equivalent problem: entity admin/user and admissions_seat cannot reach
 * /billing-audit at all, so everyone who CAN be blocked there still has Overview and Collections.
 */
import { bypassesMaintenance } from '../maintenance-bypass';

function maintenanceEnabled(): boolean {
  const v = (process.env.PAYER_INTEL_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** True when this viewer should see the maintenance notice instead of the Payer Intel board. */
export function payerIntelMaintenanceBlocks(email: string | null | undefined): boolean {
  if (!maintenanceEnabled()) return false;
  return !bypassesMaintenance(email);
}
