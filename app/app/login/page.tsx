/**
 * Sign-in page. Public by necessity. If an already-authorized user lands here, send them
 * to their destination. Renders the email+password form; the allowlist is enforced by the
 * signIn action + requireExecutive, never in the browser. TreatHealthOS-styled.
 */
import type { Metadata } from 'next';
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
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const unauthorized = sp.error === 'unauthorized';

  // Already an authorized user? Skip the form.
  const gate = await requireExecutive();
  if (gate.ok) redirect(next);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md flex-col justify-center p-6">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-ths sm:p-8">
        <h1 className="font-head text-2xl font-semibold tracking-tight text-ink900">Sign in</h1>
        <p className="mt-1 text-sm text-ink600">
          Internal billing &amp; RCM console. Access is restricted to an authorized
          allowlist and every access is audited. This tool handles PHI.
        </p>
        {unauthorized ? (
          <div
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            That account is not authorized for this tool.
          </div>
        ) : null}
        <div className="mt-6">
          <LoginForm next={next} />
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-ink400">
        Accounts are provisioned by an administrator, not self-served. Trouble signing in?
        Contact your admin.
      </p>
    </main>
  );
}
