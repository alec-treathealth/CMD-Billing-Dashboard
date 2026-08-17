/**
 * Payer Intel gate — the single server-only choke point every /payer-intel Server Action calls.
 * Delegates the pure policy to principal.ts (hermetically tested there); this file only binds the
 * real dashboardAccess().
 *
 * SERVER-ONLY (cookies + DB via dashboardAccess). Never import from a Client Component — client
 * code imports contract.ts types instead.
 */
import { dashboardAccess } from '../access';
import { requirePayerIntelPrincipalFromAccess, type PayerIntelPrincipal } from './principal';

export async function requirePayerIntelPrincipal(): Promise<PayerIntelPrincipal> {
  return requirePayerIntelPrincipalFromAccess(await dashboardAccess());
}
