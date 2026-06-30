/**
 * Sign-in page. Public by necessity. If an already-authorized user lands here, send them to
 * their destination. Renders the email+password form; accounts are created only by admin
 * invite (self-signup is disabled), so there is no sign-up affordance — just sign-in and a
 * password-reset link. TreatHealthOS-styled.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { requireExecutive } from '@/lib/executive';

export const metadata: Metadata = { title: 'Sign in · CMD Billing' };
export const dynamic = 'force-dynamic';

function safeNext(value: string | string[] | undefined): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/dashboard';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const linkError = sp.error === 'auth';
  const resetSent = sp.notice === 'reset-sent';

  // Already an authorized user? Skip the form.
  const gate = await requireExecutive();
  if (gate.ok) redirect(next);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md flex-col justify-center p-6">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-ths sm:p-8">
        <h1 className="font-head text-2xl font-semibold tracking-tight text-ink900">Sign in</h1>
        <p className="mt-1 text-sm text-ink600">
          Internal billing &amp; RCM console. This tool handles PHI and every access is audited.
        </p>
        {linkError ? (
          <div
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            That link was invalid or has expired. Request a new one below.
          </div>
        ) : null}
        {resetSent ? (
          <div
            role="status"
            className="mt-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-ink700"
          >
            If an account exists for that email, a password reset link is on its way.
          </div>
        ) : null}
        <div className="mt-6">
          <LoginForm next={next} />
        </div>
        <p className="mt-4 text-sm text-ink600">
          <Link
            href="/forgot-password"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </div>
      <p className="mt-4 text-center text-xs text-ink400">
        Accounts are by invitation. Need access? Ask your admin to send you an invite.
      </p>
    </main>
  );
}
