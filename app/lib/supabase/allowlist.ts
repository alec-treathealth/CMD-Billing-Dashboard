/**
 * Allowlist membership check against auth_config.allowed_emails (the single source of
 * truth, migration 0018). Takes a Supabase client carrying the user's JWT and reads the
 * user's OWN row under RLS — a returned row means authorized. No next/headers import, so
 * it is safe to use from BOTH middleware and Server Components/Actions.
 *
 * Requires the `auth_config` schema to be exposed in the Supabase API settings.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function isAllowedEmail(
  supabase: SupabaseClient,
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const { data, error } = await supabase
    .schema('auth_config')
    .from('allowed_emails')
    .select('email')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  return !error && data != null;
}
