/**
 * /forgot-password — request a password-reset email. Public. Sends a recovery link (via
 * /auth/confirm -> /set-password); the action always reports success to avoid disclosing
 * whether an account exists. If an already-signed-in user lands here, send them onward.
 * Continuity-styled companion to /login: full-page warm-paper sheet (global header hidden
 * via HeaderGate), wordmark on top, Fraunces display heading.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ForgotPasswordForm } from '@/components/forgot-password-form';
import { Wordmark } from '@/components/wordmark';
import { requireExecutive } from '@/lib/executive';

export const metadata: Metadata = { title: 'Reset password · TH Veris' };
export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  const gate = await requireExecutive();
  if (gate.ok) redirect('/dashboard');

  return (
    <main className="flex min-h-screen flex-col bg-[#F6F4EF] p-8">
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-[380px]">
          <div className="mb-8">
            <Wordmark />
          </div>
          <h1 className="font-display text-[26px] font-semibold text-[#16211C]">
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-[#75847D]">
            Enter your work email and we’ll send a link to set a new password.
          </p>
          <div className="mt-7">
            <ForgotPasswordForm />
          </div>
          <p className="mt-4 text-sm text-[#44544D]">
            Remembered it?{' '}
            <Link
              href="/login"
              className="font-medium text-[#0D5C4D] underline-offset-4 hover:underline"
            >
              Back to sign in
            </Link>
          </p>
          <p className="mt-8 text-center text-xs text-[#75847D]">
            © 2026 TreatHealth · Access restricted to authorized staff.
          </p>
        </div>
      </div>
    </main>
  );
}
