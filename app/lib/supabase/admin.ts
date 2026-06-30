/**
 * Supabase ADMIN client (service-role). SERVER-ONLY — NEVER import from a Client Component.
 *
 * The service-role key bypasses RLS and can read/write everything (including PHI), so it is the most
 * sensitive secret in the system. It is used for EXACTLY ONE app feature: creating + emailing invites
 * for brand-new users (Supabase Auth account creation is privileged and cannot go through the
 * least-privilege claims_reader path). It is read from the server env only (never NEXT_PUBLIC, never
 * returned to the browser) and is confined to this module + the inviteUser Server Action.
 *
 * Everything else in the app continues to use the least-privilege claims_reader node-postgres path and
 * the anon/publishable Supabase auth client — this client must NOT be used for data reads/writes.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl } from './env';

function serviceRoleKey(): string {
  // Server-only. If a NEXT_PUBLIC_* variant ever appears, that is a misconfiguration (it would ship to
  // the browser) — we deliberately read ONLY the non-public name.
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v || v.trim() === '') {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY (server-only). Required for in-app user invites; set it in the app env.',
    );
  }
  return v;
}

let cached: SupabaseClient | undefined;

/** Lazily build the admin client (no session persistence — one-shot admin calls only). */
export function supabaseAdminClient(): SupabaseClient {
  cached ??= createClient(supabaseUrl(), serviceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
