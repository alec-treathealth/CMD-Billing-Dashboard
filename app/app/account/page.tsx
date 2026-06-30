/**
 * /account — the signed-in user's own identity. NON-PHI: nothing about any patient.
 *
 * It demonstrates the auth foundation end-to-end:
 *   1. requireExecutive() is the authoritative default-deny gate (verified Supabase session);
 *   2. an unauthenticated user is bounced to /login;
 *   3. on authorized access, ONE durable row is written to claims.access_audit via
 *      recordAccess(), attributed to the REAL user (email + uid). The write is awaited and
 *      fail-closed.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { requireExecutive } from '@/lib/executive';
import { signOut } from '@/lib/auth-actions';
import { recordAccess } from '@/lib/server';

export const metadata: Metadata = { title: 'Account | CMD Billing' };
export const dynamic = 'force-dynamic';

function SignOutButton() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="outline" size="sm">
        Sign out
      </Button>
    </form>
  );
}

export default async function AccountPage() {
  const gate = await requireExecutive();

  if (!gate.ok) redirect('/login?next=/account');

  // Authorized user: write one durable, attributed audit row for this access.
  const auditId = await recordAccess({
    actorEmail: gate.user.email,
    actorUserId: gate.user.id,
    action: 'view_account',
    detail: { path: '/account' },
  });

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 sm:p-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed-in session — verified and audited. No patient data is loaded on this page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/set-password" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Change password
          </Link>
          <SignOutButton />
        </div>
      </header>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="font-medium text-muted-foreground">Signed in as</dt>
          <dd className="font-mono">{gate.user.email}</dd>
          <dt className="font-medium text-muted-foreground">User id</dt>
          <dd className="font-mono text-xs">{gate.user.id}</dd>
          <dt className="font-medium text-muted-foreground">This access logged</dt>
          <dd className="font-mono text-xs">claims.access_audit · {auditId}</dd>
        </dl>
      </section>

      <p className="text-xs text-muted-foreground">
        Internal tool — access is gated by per-user login (invite-only) and recorded in a durable
        audit trail. It exposes no PHI.
      </p>
    </main>
  );
}
