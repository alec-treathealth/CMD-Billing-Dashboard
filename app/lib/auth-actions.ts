'use server';

/**
 * Auth Server Actions for the invite-only model: sign-in, sign-out, set/reset password.
 *
 * Accounts are created only by an admin invite from the Supabase dashboard (self-signup is
 * disabled), so a valid Supabase session is authorization — there is no allowlist to
 * re-check. Disclosure discipline: input is validated/bounded with zod; sign-in returns ONE
 * generic message on any failure (no account-existence disclosure), and a password-reset
 * request always reports success (no email enumeration).
 *
 * The invite and recovery email links land on /auth/confirm (token-hash verification), which
 * establishes a session and routes the user to /set-password to choose their password.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createSupabaseServerClient } from './supabase/server';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});

export interface SignInResult {
  error: string;
}

const GENERIC_FAILURE: SignInResult = { error: 'Invalid credentials.' };

/**
 * Attempt sign-in. Returns a generic error on any failure; on success it does not
 * return — it redirects to the sanitized `next` path (default /dashboard).
 */
export async function signIn(formData: FormData): Promise<SignInResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return GENERIC_FAILURE;

  const { email, password } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return GENERIC_FAILURE;

  redirect(sanitizeNext(formData.get('next')));
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

const passwordSchema = z.object({
  password: z.string().min(8).max(200),
});

export interface SetPasswordResult {
  error: string;
}

/**
 * Set (or change) the signed-in user's password. Used to finish invite acceptance and
 * password recovery (both arrive here with a session established by /auth/confirm), and by a
 * signed-in user changing their password. Requires a verified session; redirects to
 * /dashboard on success.
 */
export async function setPassword(formData: FormData): Promise<SetPasswordResult> {
  const parsed = passwordSchema.safeParse({ password: formData.get('password') });
  if (!parsed.success) {
    return { error: 'Choose a password of at least 8 characters.' };
  }

  const supabase = await createSupabaseServerClient();
  // The invite/recovery link (or an existing login) must have established a session.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Your link has expired. Request a new one and try again.' };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: 'Could not set your password. Please try again.' };
  }

  redirect('/dashboard');
}

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

export interface RequestPasswordResetResult {
  error: string;
}

/**
 * Send a password-reset email. Always reports success to the caller (no account-existence
 * disclosure); the recovery link routes to /auth/confirm -> /set-password. On success it
 * does not return — it redirects to /login with a neutral notice.
 */
export async function requestPasswordReset(
  formData: FormData,
): Promise<RequestPasswordResetResult> {
  const parsed = emailSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) return { error: 'Enter a valid work email.' };

  const supabase = await createSupabaseServerClient();
  const origin = (await headers()).get('origin');
  await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    origin ? { redirectTo: `${origin}/auth/confirm?next=/set-password` } : undefined,
  );

  redirect('/login?notice=reset-sent');
}

/** Only allow internal absolute paths as a post-login destination; default /dashboard. */
function sanitizeNext(value: FormDataEntryValue | null): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }
  return '/dashboard';
}
