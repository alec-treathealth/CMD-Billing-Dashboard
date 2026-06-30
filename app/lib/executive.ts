/**
 * Authentication gate (default-deny). SERVER-ONLY.
 *
 * "Is the current request a signed-in user?" The single authoritative check that protects
 * every PHI surface. Authorization model is invite-only: accounts are created only by an
 * admin invite (self-signup is disabled in Supabase), so a VERIFIED Supabase session IS
 * authorization — there is no separate allowlist to consult.
 *
 * It validates the session with auth.getUser() (which verifies the JWT — never trust an
 * unverified cookie). Fail-closed: no env / no session => 'unauthenticated'. Do not import
 * from a Client Component — it reads cookies.
 */
import { createSupabaseServerClient } from './supabase/server';
import { supabaseAuthConfigured } from './supabase/env';

export interface ExecutiveUser {
  /** Supabase auth user id (uuid). */
  id: string;
  /** Lowercased email of the signed-in user. */
  email: string;
}

export type ExecutiveGate =
  | { ok: true; user: ExecutiveUser }
  | { ok: false; reason: 'unauthenticated' };

/**
 * Resolve the current request's signed-in identity, or a typed denial. Default-deny.
 */
export async function requireExecutive(): Promise<ExecutiveGate> {
  // Fail-closed if auth isn't configured yet (no env => nobody is authorized).
  if (!supabaseAuthConfigured()) return { ok: false, reason: 'unauthenticated' };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user || !user.email) return { ok: false, reason: 'unauthenticated' };

  return { ok: true, user: { id: user.id, email: user.email.toLowerCase() } };
}
