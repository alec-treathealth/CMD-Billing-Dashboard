/**
 * Supabase Auth client for Client Components (browser). Uses the PUBLIC URL +
 * publishable (anon) key, both safe to ship to the browser. AUTH ONLY — all PHI/claims
 * data flows through Server Actions to the least-privilege node-postgres path, never
 * through Supabase PostgREST from the browser.
 */
import { createBrowserClient } from '@supabase/ssr';
import { supabaseAnonKey, supabaseUrl } from './env';

export function createSupabaseBrowserClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
