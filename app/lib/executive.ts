/**
 * Executive authorization gate (default-deny). SERVER-ONLY.
 *
 * "Is the current request a logged-in user on the allowlist?" The single authoritative
 * check that protects the PHI surface. It combines:
 *   1. a VERIFIED Supabase session (auth.getUser() validates the JWT — never trust an
 *      unverified cookie), and
 *   2. membership in auth_config.allowed_emails (read own-row under RLS via the same
 *      authenticated client — the single source of truth, migration 0018).
 *
 * Fail-closed: no env / no session => 'unauthenticated'; verified but not allowlisted =>
 * 'forbidden'. Do not import from a Client Component — it reads cookies.
 */
import { createSupabaseServerClient } from './supabase/server';
import { supabaseAuthConfigured } from './supabase/env';
import { isAllowedEmail } from './supabase/allowlist';

export interface ExecutiveUser {
  /** Supabase auth user id (uuid). */
  id: string;
  /** Lowercased, allowlisted email. */
  email: string;
}

export type ExecutiveGate =
  | { ok: true; user: ExecutiveUser }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' };

/**
 * Resolve the current request's executive identity, or a typed denial. Default-deny.
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
  if (!(await isAllowedEmail(supabase, user.email))) return { ok: false, reason: 'forbidden' };

  return { ok: true, user: { id: user.id, email: user.email.toLowerCase() } };
}
