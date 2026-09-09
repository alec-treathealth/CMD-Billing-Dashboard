/**
 * Code Performance gate — the single server-only choke point every /code-performance Server Action
 * calls. Binds the real dashboardAccess() to the pure policy in principal.ts. SERVER-ONLY (cookies +
 * DB); client code imports contract.ts types instead.
 */
import { dashboardAccess } from '../access';
import { codePerfPrincipalFromAccess, type CodePerfPrincipal } from './principal';

export async function requireCodePerfPrincipal(): Promise<CodePerfPrincipal | null> {
  return codePerfPrincipalFromAccess(await dashboardAccess());
}
