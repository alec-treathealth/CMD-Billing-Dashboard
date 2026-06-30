/**
 * /set-password — choose a password. Reached after clicking an invite or password-recovery
 * link (via /auth/confirm, which establishes the session first), or by a signed-in user who
 * wants to change their password. Protected: requires a verified session, else -> /login.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SetPasswordForm } from '@/components/set-password-form';
import { requireExecutive } from '@/lib/executive';

export const metadata: Metadata = { title: 'Set your password · CMD Billing' };
export const dynamic = 'force-dynamic';

export default async function SetPasswordPage() {
  const gate = await requireExecutive();
  if (!gate.ok) redirect('/login?next=/set-password');

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md flex-col justify-center p-6">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-ths sm:p-8">
        <h1 className="font-head text-2xl font-semibold tracking-tight text-ink900">
          Set your password
        </h1>
        <p className="mt-1 text-sm text-ink600">
          Choose a password to finish setting up your account. You’ll use it to sign in from
          now on.
        </p>
        <div className="mt-6">
          <SetPasswordForm />
        </div>
      </div>
    </main>
  );
}
