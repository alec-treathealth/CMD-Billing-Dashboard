/**
 * Shown when a user is signed in (valid Supabase session) but has NO role row in claims.app_user
 * (migration 0025) — i.e. default-deny / not yet provisioned. This is a friendly, non-500 dead-end:
 * no data is loaded, and they can Sign out to switch accounts. An admin grants a role to let them in.
 *
 * Server component: the Sign out button posts the existing `signOut` server action (no client JS).
 */
import { signOut } from '@/lib/auth-actions';

export function UnprovisionedNotice({ email }: { email?: string | null }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-4 p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Account not provisioned</h1>
      <p className="text-sm text-muted-foreground">
        {email ? <>You&rsquo;re signed in as <span className="font-medium">{email}</span>, but your </> : 'Your '}
        account hasn&rsquo;t been granted access to this dashboard yet. An administrator needs to
        assign you a role. Once that&rsquo;s done, sign in again.
      </p>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink900 transition-colors hover:bg-teal50"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
