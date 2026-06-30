/**
 * /forgot-password — request a password-reset email. Public. Sends a recovery link (via
 * /auth/confirm -> /set-password); the action always reports success to avoid disclosing
 * whether an account exists. If an already-signed-in user lands here, send them onward.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ForgotPasswordForm } from '@/components/forgot-password-form';
import { requireExecutive } from '@/lib/executive';

export const metadata: Metadata = { title: 'Reset password · CMD Billing' };
export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  const gate = await requireExecutive();
  if (gate.ok) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md flex-col justify-center p-6">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-ths sm:p-8">
        <h1 className="font-head text-2xl font-semibold tracking-tight text-ink900">
          Reset your password
        </h1>
        <p className="mt-1 text-sm text-ink600">
          Enter your work email and we’ll send a link to set a new password.
        </p>
        <div className="mt-6">
          <ForgotPasswordForm />
        </div>
        <p className="mt-4 text-sm text-ink600">
          Remembered it?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
