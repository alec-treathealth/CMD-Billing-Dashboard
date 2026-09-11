/**
 * Payer Intel gate — the single server-only choke point every /payer-intel Server Action calls.
 * Delegates the pure policy to principal.ts (hermetically tested there); this file only binds the
 * real dashboardAccess().
 *
 * SERVER-ONLY (cookies + DB via dashboardAccess). Never import from a Client Component — client
 * code imports contract.ts types instead.
 */
import { dashboardAccess } from '../access';
import { payerIntelMaintenanceBlocks } from './maintenance';
import { requirePayerIntelPrincipalFromAccess, type PayerIntelPrincipal } from './principal';

/**
 * ⚠ THE MAINTENANCE CHECK BELONGS HERE, NOT ONLY ON THE PAGE.
 *
 * Server Actions are the browser's ONLY data path and they gate on ROLE alone. With the stash wired
 * only at app/app/payer-intel/page.tsx, all 10 exported actions still answered a POST while the page
 * rendered the notice — a stale tab, or a direct action request, could still search, load facets,
 * generate an AI read, and MUTATE stars, search history and watchers. The board was closed at the
 * front door and open at the back.
 *
 * This is the one chokepoint that closes all 10: seven reach it through `deps.ts requirePrincipal`,
 * two call it directly (actions.ts searchPayerIntelEmployers / loadPayerIntelFacetOptions), and
 * rerunPayerIntelSavedSearch inherits it by delegating to runPayerIntelSearch.
 *
 * ⚠ DO NOT MOVE THIS INTO principal.ts:requirePayerIntelPrincipalFromAccess. The PAGE uses that one,
 * and a denial there makes page.tsx take `redirect('/dashboard')` INSTEAD of rendering the notice —
 * a dead end for an `admissions_seat` user, whose only nav link IS /payer-intel. The page keeps its
 * own maintenance branch; this covers the actions.
 *
 * ROLE IS CHECKED FIRST, deliberately: answering "paused for maintenance" to someone whose role may
 * never see this surface would leak that it exists.
 */
export async function requirePayerIntelPrincipal(): Promise<PayerIntelPrincipal> {
  const principal = await requirePayerIntelPrincipalFromAccess(await dashboardAccess());
  if (!principal.ok) return principal;
  if (payerIntelMaintenanceBlocks(principal.actor.email)) {
    return { ok: false, error: 'Payer Intel is paused for maintenance.' };
  }
  return principal;
}
