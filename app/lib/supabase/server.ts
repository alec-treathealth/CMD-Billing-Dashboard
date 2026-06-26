/**
 * Supabase Auth client for Server Components, Server Actions, and Route Handlers.
 *
 * Cookie-backed session per @supabase/ssr. In a Server Component the cookie store
 * is read-only, so `setAll` may throw — that is expected and ignored, because the
 * middleware (lib/supabase/middleware.ts) is what actually refreshes and writes the
 * session cookie on each request. This client is for AUTH only; all PHI/claims data
 * still flows through the least-privilege node-postgres path (src/queries), never
 * through Supabase's PostgREST.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseAnonKey, supabaseUrl } from './env';

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Read-only cookie store (Server Component render). The middleware
          // refreshes the session cookie, so this is safe to ignore here.
        }
      },
    },
  });
}
