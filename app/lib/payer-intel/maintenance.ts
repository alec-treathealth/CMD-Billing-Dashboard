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
function maintenanceEnabled(): boolean {
  const v = (process.env.PAYER_INTEL_MAINTENANCE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * True when this viewer should see the maintenance notice instead of the Payer Intel board.
 *
 * ⚠ STASHED FOR EVERYONE — NO BYPASS, RULED BY ALEC 2026-09-11: "the qualify/payer-intel tab should
 * be stashed and not visible to anyone, not even me or ryan. it should be stashed and only powering
 * the features on the platform that are live."
 *
 * So while the flag is on, this returns TRUE for every viewer including alec@ and ryan@. It no
 * longer consults `bypassesMaintenance`, which REVERSES the 2026-08-18 decision to share one
 * allowlist with Claims Desk — deliberately, and only for this surface.
 *
 * ⚠ THE SHARED ALLOWLIST ITSELF MUST STAY. It is still live for AR Management (/billing-audit),
 * which is a SHIPPED surface — nav entry, notifications bell, migrations 0109-0111. Emptying
 * lib/maintenance-bypass.ts to stash Payer Intel would have locked both of those people out of AR
 * Management, which is the opposite of what was asked. Decoupling here is what keeps the two
 * independent; do not "restore consistency" by pointing this back at the shared list.
 *
 * STASHED IS NOT DELETED, and that distinction is the whole point of the ruling: /payer-intel still
 * resolves and its loaders are still wired, because live surfaces import out of this tree (the tape
 * core, the rating bands, the marquee hook, the watcher definer wrapper). What is gone is the
 * ability for anyone to USE the board. To bring it back, turn PAYER_INTEL_MAINTENANCE off — the
 * kill switch is unchanged and still the single lever.
 */
export function payerIntelMaintenanceBlocks(_email: string | null | undefined): boolean {
  return maintenanceEnabled();
}
