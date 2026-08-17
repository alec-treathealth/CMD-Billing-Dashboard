/**
 * Facility Resolution — the 'No Facility' attribution workbench (migrations 0084-0086).
 *
 * ⚠ MOVED 2026-08-17 (Alec's ruling): this route lived at /dashboard/collections/facility-resolution
 * and now belongs to the Claims Desk tab. The old path survives as a `redirect()` stub so live
 * links and bookmarks keep working — it is a forwarder, not a second copy. Nothing about the data,
 * the RBAC, or the server actions changed; only where the surface hangs in the nav. Its entry link
 * now renders in the Claims Desk header instead of the Collections one.
 *
 * NOTE, and it matters operationally: /billing-audit is behind the refactor notice for everyone
 * except alec@treathealth.ai, so the ENTRY LINK is only visible to that allowlist today. This page
 * deliberately does NOT take the claims-audit maintenance gate — an admin who works the queue can
 * still reach it by URL. Adding the gate here would have turned a nav move into a feature removal.
 *
 * Reads collections.cmd_facility_resolution (charge grain — NEVER summed line grain): the
 * method-breakdown overview plus the workable queue, and records manual assignments through the
 * 0085 SECURITY-DEFINER write path with a full audit trail.
 *
 * RBAC — stricter than the rest of the collections surface: admin/super_admin ONLY.
 *   - admissions_seat is redirected to Qualify (server-side, like every /dashboard route);
 *   - the 'user' role is redirected back to Collections — this page exists to CHANGE the book's
 *     attribution, and that is an operator/admin power. Enforced here AND in every server action
 *     (resolutionPrincipal), so a direct URL or a forged action call both fail closed.
 * DOM omission, not CSS: excluded roles never receive this page's HTML at all.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { FacilityResolutionView } from '@/components/collections/facility-resolution-view';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { loadResolutionOverview, queryResolutionQueue } from '@/lib/facility-resolution-actions';
import { clampView, resolveView } from '@/lib/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Facility Resolution | CMD Billing' };

export default async function FacilityResolutionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  // admissions_seat sees ONLY Qualify — block direct-URL access server-side.
  if (isQualifyOnlyRole(access.access.role)) redirect(QUALIFY_HOME);
  // Fail closed on an empty entitlement (entity-scoped role with a null entity).
  if (access.access.allowedViews.length === 0) {
    return <UnprovisionedNotice email={access.access.user?.email} />;
  }

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  if (view !== requested) redirect(`/billing-audit/facility-resolution?view=${view}`);

  // This surface CHANGES attribution — operator/admin only. 'user' keeps read access to the
  // Collections grid; send them back there rather than 404ing.
  const role = access.access.role;
  if (role !== 'admin' && role !== 'super_admin') {
    redirect(`/dashboard/collections?view=${view}`);
  }

  // Server-render the initial state: overview tiles + facility picker options + the first
  // unresolved-queue page, in parallel. Each action fails closed to {ok:false} internally, so an
  // errored slice degrades to the client's retry path instead of a 500.
  const [overview, queue] = await Promise.all([
    loadResolutionOverview(view),
    queryResolutionQueue(view, '', ['unresolved'], undefined, null),
  ]);

  return (
    <main className="mx-auto max-w-[1800px] space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Facility Resolution</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every &lsquo;No Facility&rsquo; charge, attributed by exact-evidence methods or worked
          by hand. Manual assignments are append-only and fully audited; nothing here rewrites
          ingest data.
        </p>
      </header>
      <FacilityResolutionView view={view} initialOverview={overview} initialQueue={queue} />
    </main>
  );
}
