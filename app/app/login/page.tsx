/**
 * Sign-in page. Public by necessity. If an already-authorized user lands here, send them to
 * their destination. Renders the email+password form; accounts are created only by admin
 * invite (self-signup is disabled), so there is no sign-up affordance — just sign-in and a
 * password-reset link. Styled to match the TreatHealthOS Continuity login: full-viewport
 * split (the global header is hidden here via HeaderGate) — dark evergreen brand rail
 * (lg+ only) beside the warm-paper form panel, Fraunces display face.
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

/** TreatHealthOS wordmark, product line underneath — mirrors the Continuity app's Logo. */
function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <span className="relative inline-flex select-none flex-col">
      <span className="inline-flex items-baseline gap-1.5">
        <span
          aria-hidden
          className={`inline-block h-2.5 w-2.5 translate-y-[-1px] rounded-[3px] ${dark ? 'bg-[#5FBFA8]' : 'bg-[#0D5C4D]'}`}
        />
        <span
          className={`font-display text-lg font-semibold tracking-tight ${dark ? 'text-white' : 'text-[#16211C]'}`}
        >
          TreatHealth<span className={dark ? 'text-[#5FBFA8]' : 'text-[#0D5C4D]'}>OS</span>
        </span>
      </span>
      <span
        className={`mt-0.5 pl-4 text-[10px] font-semibold uppercase tracking-[0.22em] ${dark ? 'text-white/50' : 'text-[#75847D]'}`}
      >
        Billing · RCM
      </span>
    </span>
  );
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
    <main className="flex min-h-screen">
      {/* Form panel. First in the DOM so the h1 precedes the brand panel's h2 and so the
          form is the whole page below lg; `lg:order-last` puts it visually right on lg+. */}
      <section className="flex flex-1 flex-col bg-[#F6F4EF] p-8 lg:order-last">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[380px]">
            <div className="mb-8 lg:hidden">
              <Wordmark />
            </div>
            <h1 className="font-display text-[26px] font-semibold text-[#16211C]">Sign in</h1>
            <p className="mt-1 text-sm text-[#75847D]">
              Internal billing &amp; RCM console. This tool handles PHI and every access is
              audited.
            </p>
            {resetSent ? (
              <div
                role="status"
                className="mt-4 rounded-lg border border-[#0D5C4D]/25 bg-[#E8F0EC] px-3 py-2 text-sm text-[#44544D]"
              >
                If an account exists for that email, a password reset link is on its way.
              </div>
            ) : null}
            <div className="mt-7">
              <LoginForm next={next} initialError={initialError} />
            </div>
            <p className="mt-4 text-sm">
              <Link
                href="/forgot-password"
                className="font-medium text-[#0D5C4D] underline-offset-4 hover:underline"
              >
                Forgot your password?
              </Link>
            </p>
            <p className="mt-8 text-center text-xs text-[#75847D]">
              Accounts are by invitation — ask your admin to send you an invite.
            </p>
          </div>
        </div>
      </section>
      {/* Brand rail — informational copy only, hidden below lg (form panel takes over). */}
      <section className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-[#0E1F1A] p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            background:
              'radial-gradient(720px 420px at 18% 8%, rgba(95,191,168,0.22), transparent 60%), radial-gradient(600px 500px at 85% 90%, rgba(138,106,34,0.16), transparent 55%)',
          }}
        />
        <Wordmark dark />
        <div className="relative max-w-md">
          <h2 className="font-display text-[40px] font-semibold leading-[1.12] text-white">
            The claim is only half the story.
            <span className="block text-[#5FBFA8]">The money is the other half.</span>
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-white/60">
            Veris reads every payer batch and collection sheet, then surfaces denials,
            underpayments, and aging risk before they cost you the recovery.
          </p>
          <div className="mt-8 space-y-3">
            <p className="flex items-start gap-3 text-[13px] text-white/70">
              <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-[#5FBFA8]" aria-hidden />
              Every figure traces to its source — payer, batch, and date.
            </p>
            <p className="flex items-start gap-3 text-[13px] text-white/70">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#5FBFA8]" aria-hidden />
              PHI stays encrypted end to end. Nothing sensitive touches a log.
            </p>
          </div>
        </div>
        <p className="relative text-[11px] text-white/35">
          © 2026 TreatHealth · Access restricted to authorized staff.
        </p>
      </section>
    </main>
  );
}
