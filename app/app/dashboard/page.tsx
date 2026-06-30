/**
 * Dashboard route — the non-PHI aggregate overview (Phase 7.3 split).
 *
 * This page mounts ONLY <Dashboard />; the AI SearchConsole no longer shares the
 * page, so first paint here does not wait on the agent bundle. The dashboard's
 * aggregate reads are cached (see lib/server.ts), so warm loads are memory reads.
 * No PHI is reachable here: the dashboard never fetches rows.
 *
 * RBAC: the signed-in user's entitlement (dashboardAccess) gates the page and clamps the
 * requested `?view=` to an allowed view. An entity-scoped user is redirected to their canonical
 * `?view=` so the URL, branding (brand-theme), and switcher all agree.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Dashboard } from '@/components/dashboard';
import { DashboardNav } from '@/components/dashboard-nav';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { clampView, resolveView } from '@/lib/views';

export const metadata: Metadata = { title: 'Overview | CMD Billing' };

export default async function DashboardPage({
  searchParams,
}: {
  // Next 15: searchParams is a Promise; resolve before reading `?view=`.
  // The active view is shown by the top-bar ViewSwitcher; here it only sets data scope.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  // Reflect the effective view in the URL so the client switcher + brand theme match the data scope.
  if (view !== requested) redirect(`/dashboard?view=${view}`);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Aggregate, non-PHI metrics across all claims and collections. No patient data is loaded
          here.
        </p>
      </header>
      <DashboardNav />
      <Dashboard view={view} />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. Access requires per-user sign-in and is scoped by your assigned
        role. Do not share patient data outside the authorized billing audience.
      </footer>
    </main>
  );
}
