/**
 * Collections route — the CMD charge-line detail (cmd_explorer_rows) via <CollectionsView />.
 * Filterable by Facility/Month; patient identifiers are masked by default and revealed in
 * bulk on an explicit, audited "Reveal all" click. Entity scope comes from the top-bar view
 * switcher (?view=), resolved here and passed down through the viewToEntityIds seam.
 *
 * RBAC: gated + view-clamped like the overview. `canRevealPhi` (admins + super-admins) is passed
 * down so a plain `user` role never sees the "Reveal all" control (and the reveal action is gated
 * server-side regardless).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CollectionsView } from '@/components/dashboard';
import { DataFreshness } from '@/components/dashboard/data-freshness';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { listGridViews, loadCmdReport } from '@/lib/actions';
import { clampView, resolveView } from '@/lib/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Collections | CMD Billing' };

export default async function CollectionsPage({
  searchParams,
}: {
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
  if (view !== requested) redirect(`/dashboard/collections?view=${view}`);

  // Server-render the initial grid: fetch the first page (default sort, no filter) + the caller's
  // saved column views IN PARALLEL, server-side, so the explorer paints WITH data in the initial
  // HTML instead of firing serialized client round-trips on mount. Both are fast (the row query is
  // index-backed; saved views is a tiny per-user lookup). Facility options are deliberately NOT
  // fetched here: it's a non-critical filter dropdown whose rare cold rebuild is slow, and we must
  // never let it block the page render — the client fetches it after paint. Each action fails
  // closed to {ok:false} internally, so a slice that errors just degrades to its client fetch.
  const [report, savedViews] = await Promise.all([
    loadCmdReport(null, {}, undefined, view),
    listGridViews(),
  ]);

  return (
    <main className="mx-auto max-w-[1800px] space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Collections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          CMD charge-line detail, filterable by facility and month. Patient identifiers are
          masked by default and revealed in bulk on an explicit, audited action.
        </p>
        <DataFreshness view={view} />
      </header>
      <CollectionsView
        view={view}
        canRevealPhi={access.access.canRevealPhi}
        initialData={{ report, views: savedViews }}
      />
    </main>
  );
}
