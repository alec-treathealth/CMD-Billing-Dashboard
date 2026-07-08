/**
 * Sign-in page. Public by necessity. If an already-authorized user lands here, send them to
 * their destination. Renders the email+password form; accounts are created only by admin
 * invite (self-signup is disabled), so there is no sign-up affordance — just sign-in and a
 * password-reset link. TreatHealthOS-styled: split layout under the global brand bar — dark
 * teal brand panel (md+ only) beside the warm-ground form panel.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { LoginForm } from '@/components/login-form';
import { requireExecutive } from '@/lib/executive';

export const metadata: Metadata = { title: 'Sign in · TH Veris' };
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
  const resetSent = sp.notice === 'reset-sent';
  // The expired/consumed invite-link error is seeded into the form's single `authError` state
  // (one alert surface) rather than rendered as a separate page-level banner — so it can never
  // stack with a subsequent "Invalid credentials." and clears on the first field change.
  const initialError =
    sp.error === 'auth' ? 'That link was invalid or has expired. Request a new one below.' : null;

  // Already an authorized user? Skip the form.
  const gate = await requireExecutive();
  if (gate.ok) redirect(next);

  return (
    <main className="grid min-h-[calc(100vh-3.5rem)] md:grid-cols-2">
      {/* Form panel. First in the DOM so the h1 precedes the brand panel's h2 and so the
          form is the whole page below md; `md:order-last` puts it visually right on md+. */}
      <section className="flex flex-col bg-ground px-6 py-10 sm:px-10 md:order-last">
        <div className="flex flex-1 flex-col justify-center">
          <div className="mx-auto w-full max-w-[420px]">
            <h1 className="font-head text-2xl font-semibold tracking-tight text-ink900">
              Sign in
            </h1>
            <p className="mt-1 text-sm text-ink600">
              Internal billing &amp; RCM console. This tool handles PHI and every access is
              audited.
            </p>
            {resetSent ? (
              <div
                role="status"
                className="mt-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-ink700"
              >
                If an account exists for that email, a password reset link is on its way.
              </div>
            ) : null}
            <div className="mt-6">
              <LoginForm next={next} initialError={initialError} />
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
        </div>
        <footer className="mx-auto w-full max-w-[420px] pt-8 text-xs text-ink400">
          Accounts are by invitation — ask your admin to send you an invite.
          <span className="mt-1 block">
            © 2026 TreatHealth · Access restricted to authorized staff.
          </span>
        </footer>
      </section>
      {/* Brand panel — informational copy only, hidden below md (form panel takes over). */}
      <section className="hidden flex-col justify-between bg-gradient-to-br from-teal900 to-teal700 p-10 md:flex">
        <p className="leading-tight">
          <span className="font-head text-lg font-bold text-white">TreatHealthOS</span>{' '}
          <span className="text-xs font-semibold uppercase tracking-[0.22em] text-teal200/70">
            · Billing · RCM
          </span>
        </p>
        <div className="max-w-md">
          <h2 className="font-head text-3xl font-semibold leading-tight text-white lg:text-4xl">
            The claim is only half the story.
            <span className="block text-teal200">The money is the other half.</span>
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-teal50/80">
            Veris reads every payer batch and collection sheet, then surfaces denials,
            underpayments, and aging risk before they cost you the recovery.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-teal50/80">
            <li className="flex items-center gap-3">
              <Fingerprint className="h-4 w-4 shrink-0 text-teal200" aria-hidden />
              Every figure traces to its source — payer, batch, and date.
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-teal200" aria-hidden />
              PHI stays encrypted end to end. Nothing sensitive touches a log.
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
