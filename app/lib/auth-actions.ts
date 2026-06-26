'use server';

/**
 * Auth Server Actions: email + password sign-in (allowlist-gated) and sign-out.
 *
 * Defensive about disclosure: input is validated/bounded with zod; every failure returns
 * the SAME generic message (no field-level or account-existence disclosure). After a
 * successful Supabase sign-in we RE-CHECK the VERIFIED identity against the allowlist
 * (auth_config.allowed_emails) and sign out if it is not a member. The signup hook
 * (migration 0018) already blocks non-allowlisted accounts at creation; this re-check
 * also covers an account whose email was later removed from the allowlist.
 */
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from './supabase/server';
import { isAllowedEmail } from './supabase/allowlist';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});

export interface SignInResult {
  error: string;
}

const GENERIC_FAILURE: SignInResult = { error: 'Invalid credentials or not authorized.' };

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

  // Authoritative allowlist check on the VERIFIED identity.
  if (!(await isAllowedEmail(supabase, data.user.email))) {
    await supabase.auth.signOut();
    return GENERIC_FAILURE;
  }

  redirect(sanitizeNext(formData.get('next')));
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/** Only allow internal absolute paths as a post-login destination; default /dashboard. */
function sanitizeNext(value: FormDataEntryValue | null): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }
  return '/dashboard';
}
