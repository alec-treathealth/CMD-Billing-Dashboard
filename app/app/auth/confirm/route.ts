/**
 * Email-link verification (Supabase token-hash flow). Invite, password-recovery, and email
 * confirmation links point here. We verify the one-time token, which establishes a session
 * cookie, then redirect:
 *   - invite / recovery  -> /set-password (the user must choose a password)
 *   - anything else      -> the sanitized `next` (default /dashboard)
 * A missing/invalid/expired token redirects to /login?error=auth. Public route (no session
 * exists yet when the link is clicked); the gate applies on the next navigation.
 *
 * Requires the email templates to link here, e.g.
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { safeInternalPath } from '@/lib/auth/safe-path';

function safeNext(value: string | null): string {
  return safeInternalPath(value) ?? '/dashboard';
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;

  // Invite and recovery must end at /set-password regardless of any supplied `next`. A safe `after`
  // (the two-choice seat invite's mobile/web destination) is carried through to /set-password, which
  // redirects there once the password is set.
  const after = safeInternalPath(url.searchParams.get('after'));
  const next =
    type === 'invite' || type === 'recovery'
      ? after
        ? `/set-password?after=${encodeURIComponent(after)}`
        : '/set-password'
      : safeNext(url.searchParams.get('next'));

  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL('/login?error=auth', url.origin));
}
