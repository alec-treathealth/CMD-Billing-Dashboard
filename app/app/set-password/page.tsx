/**
 * /set-password — choose a password. Reached after clicking an invite or password-recovery
 * link (via /auth/confirm, which establishes the session first), or by a signed-in user who
 * wants to change their password. Protected: requires a verified session, else -> /login.
 * Continuity-styled companion to /login: full-page warm-paper sheet (global header hidden
 * via HeaderGate), wordmark on top, Fraunces display heading.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SetPasswordForm } from '@/components/set-password-form';
import { Wordmark } from '@/components/wordmark';
import { requireExecutive } from '@/lib/executive';
import { safeInternalPath } from '@/lib/auth/safe-path';

export const metadata: Metadata = { title: 'Set your password · TreatHealthOS' };
export const dynamic = 'force-dynamic';

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const gate = await requireExecutive();
  if (!gate.ok) redirect('/login?next=/set-password');

  // Two-choice seat invite: land on the chosen surface (/qualify/m or /qualify) after saving the
  // password. Safe-path validated here AND re-validated in the action; the destination self-gates.
  const after = safeInternalPath((await searchParams)?.after) ?? undefined;

  return (
    <main className="flex min-h-screen flex-col bg-[#F6F4EF] p-8">
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-[380px]">
          <div className="mb-8">
            <Wordmark />
          </div>
          <h1 className="font-display text-[26px] font-semibold text-[#16211C]">
            Set your password
          </h1>
          <p className="mt-1 text-sm text-[#75847D]">
            Choose a password to finish setting up your account. You’ll use it to sign in from
            now on.
          </p>
          <div className="mt-7">
            <SetPasswordForm after={after} />
          </div>
          <p className="mt-8 text-center text-xs text-[#75847D]">
            © 2026 TreatHealth · Access restricted to authorized staff.
          </p>
        </div>
      </div>
    </main>
  );
}
