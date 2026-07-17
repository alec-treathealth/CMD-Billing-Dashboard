/**
 * Single-account owner-only gate for private operational surfaces Alec requested be visible only to him.
 * Staff email is non-PHI. Keep this server-safe and dependency-free so it can be used from layout chrome,
 * pages, and Server Actions without pulling in auth/DB code.
 */
export const ALEC_OWNER_EMAIL = 'alec@treathealth.ai';

export function isAlecOwnerEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === ALEC_OWNER_EMAIL;
}
