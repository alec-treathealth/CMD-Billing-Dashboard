/**
 * Supabase Auth callback — exchanges an auth `code` (PKCE) for a session cookie, then
 * redirects to the sanitized `next` path (default /dashboard). Used by the OAuth/PKCE code
 * flow; email links (invite/recovery/confirm) use the token-hash route at /auth/confirm
 * instead. Password sign-in does not use either. The session gate still applies on the next
 * navigation (middleware + requireExecutive), so landing here never bypasses authorization.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function safeNext(value: string | null): string {
  if (value && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/dashboard';
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL('/login?error=auth', url.origin));
}
