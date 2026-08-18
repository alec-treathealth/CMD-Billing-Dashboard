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
import { DataFreshness } from '@/components/dashboard/data-freshness';
import { TenantTabs } from '@/components/dashboard/tenant-tabs';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { clampView, resolveView } from '@/lib/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Overview | CMD Billing' };

export default async function DashboardPage({
  searchParams,
}: {
  // Next 15: searchParams is a Promise; resolve before reading `?view=`.
  // The active view is shown by the on-page TenantTabs; here it only sets data scope.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  // admissions_seat sees ONLY Qualify — block direct-URL access to every other route, server-side.
  if (isQualifyOnlyRole(access.access.role)) redirect(QUALIFY_HOME);
  // Fail closed: a provisioned role entitled to NO views (entity-scoped role with a null
  // entity — forbidden by the app_user CHECK) must not fall through to clampView's
  // consolidated (cross-tenant) default. Treat it as unprovisioned.
  if (access.access.allowedViews.length === 0) {
    return <UnprovisionedNotice email={access.access.user?.email} />;
  }

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  // Reflect the effective view in the URL so the client switcher + brand theme match the data scope.
  if (view !== requested) redirect(`/dashboard?view=${view}`);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      {/* Tenant tabs sit ABOVE the title, on the page rather than in the global top bar (Alec,
          2026-08-18). Which tenant a number belongs to is the most consequential context here, and a
          collapsed dropdown stated it in a label the reader had to go find. Identical control and
          placement on Collections — the two pages share the `?view=` scope, so they must not differ
          in how it is chosen. */}
      <TenantTabs allowedViews={access.access.allowedViews} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Aggregate, non-PHI metrics across all claims and collections. No patient data is loaded
          here.
        </p>
        <DataFreshness view={view} />
      </header>
      <Dashboard view={view} canEditForecast={access.access.role === 'super_admin'} />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. Access requires per-user sign-in and is scoped by your assigned
        role. Do not share patient data outside the authorized billing audience.
      </footer>
    </main>
  );
}
