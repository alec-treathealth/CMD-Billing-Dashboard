/**
 * Session-refresh middleware helper (@supabase/ssr). Runs on every matched request to
 * keep the auth cookie fresh AND to gate the app:
 *   - public paths (/login, /auth/callback) and /api/* (own Bearer auth) pass through;
 *   - any other path requires a signed-in user (else -> /login?next=...);
 *   - a signed-in user whose email is NOT on the auth_config allowlist is signed out and
 *     bounced to /login?error=unauthorized (covers off-boarding after signup).
 *
 * Per Supabase guidance: no logic between createServerClient() and getUser(); return the
 * same response object so refreshed cookies are preserved. The authoritative server-side
 * gate is still requireExecutive() (closest to the data); this is the first layer + UX.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAnonKey, supabaseAuthConfigured, supabaseUrl } from './env';
import { isAllowedEmail } from './allowlist';

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Paths reachable WITHOUT a session. /api/* carries its own Bearer auth. */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/auth/callback') ||
    pathname.startsWith('/api/')
  );
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Until auth env is configured, do nothing — pre-existing routes are unaffected
  // (safe rollout: deploy code first, flip auth on by setting the env vars).
  if (!supabaseAuthConfigured()) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: refresh the token first; no logic between createServerClient and getUser.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (isPublicPath(path)) return supabaseResponse;

  // Protected path: require a signed-in user.
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  // Signed in — enforce the allowlist (own-row read under RLS). Removing someone from
  // auth_config.allowed_emails locks them out on their next request.
  const allowed = await isAllowedEmail(supabase, user.email);
  if (!allowed) {
    try {
      await supabase.auth.signOut();
    } catch {
      /* best-effort; cookies are also cleared on the redirect below */
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('error', 'unauthorized');
    const redirect = NextResponse.redirect(url);
    for (const c of supabaseResponse.cookies.getAll()) redirect.cookies.set(c);
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith('sb-')) redirect.cookies.set(c.name, '', { maxAge: 0 });
    }
    return redirect;
  }

  return supabaseResponse;
}
