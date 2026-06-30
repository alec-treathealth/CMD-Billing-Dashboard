/**
 * Manage Users — in-app RBAC provisioning (admins + super_admins only). Lists Supabase Auth users +
 * their dashboard role and lets the caller assign / change / revoke roles within their scope. The page
 * gates on canManageUsers (a plain `user` or unprovisioned account is bounced to /dashboard); every
 * mutation is re-authorized in the Server Actions. No PHI is reachable here — only staff identity + role.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { listManagedUsers } from '@/lib/admin-actions';
import { UserManager } from '@/components/admin/user-manager';

export const metadata: Metadata = { title: 'Manage Users | CMD Billing' };

export default async function AdminUsersPage() {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    redirect('/dashboard'); // unprovisioned → no admin surface
  }
  if (!access.access.canManageUsers) redirect('/dashboard');

  const result = await listManagedUsers();
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Manage users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign dashboard roles. <span className="font-medium">Admins</span> may reveal PHI and manage
          users; <span className="font-medium">Users</span> see non-PHI metrics only. Entity admins
          manage only their own entity.
        </p>
      </header>
      {result.ok ? (
        <UserManager initial={result.data} />
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {result.error}
        </div>
      )}
    </main>
  );
}
