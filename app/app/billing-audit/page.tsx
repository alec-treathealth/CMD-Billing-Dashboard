/**
 * AR Management route (/billing-audit — the route and internal names are unchanged; the display
 * label became "AR Management" on 2026-09-09). The default tab is the AR QUEUE: every open claim
 * across the BXR facilities from CMD's daily customer data snapshot, organised by age band, with CMD
 * follow-up notes, denial reasoning, in-app notes and work dispositions (claims.ar_*, migrations
 * 0109/0110). The IP/OP claim-audit workbench (claims.audit_row) and Billable Days remain as tabs.
 *
 * RBAC: gated + view-clamped like Collections (NOT the deploy-protection-only /claims page) —
 * this plane is PHI, so a plain `user` never gets the reveal control, entity scope comes from the
 * ?view= switcher, and reads are tenant-scoped server-side. The audit data is BXR-only today; a
 * non-BXR view resolves to an empty (fail-closed) workbench until that tenant's plane lands —
 * never a cross-tenant leak.
 *
 * ⚠ THE CLAMP IS ROUTE-SCOPED HERE, WHICH IS THE ONE WAY THIS DIFFERS FROM COLLECTIONS. That
 * page clamps against the raw RBAC entitlement and defaults to `consolidated`; this desk has no
 * cross-tenant plane, so it offers BXR + Indigo only and defaults to BXR. The switcher is the nav
 * <TenantScope> pill (app/layout.tsx, since 2026-09-08), which narrows its own option set with the
 * SAME `claimsDeskViews` this page uses — see `lib/billing-audit/views.ts`. An in-place tenant
 * control first reached this route 2026-08-31 (as TenantTabs); before that its absence was
 * load-bearing for the Billable Days override keys (`billable-days/overrides.ts`), and a same-route
 * ?view= change is still a SOFT navigation for the same reason.
 *
 * Initial render: the server fetches the IP first page for the DEFAULT (YTD) window plus both
 * scopes' filter options, so the grid paints with data (and the client starts on the SAME window
 * the seeded page was fetched with — no first-render refetch/mismatch). OP rows fetch on first view.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BillingAuditWorkbench } from '@/components/billing-audit/workbench';
import { ClaimsAuditMaintenanceNotice } from '@/components/billing-audit/maintenance-notice';
import { claimsAuditMaintenanceBlocks } from '@/lib/billing-audit/maintenance';
import { presetWindow, DEFAULT_PRESET } from '@/components/billing-audit/date-presets';
import type { TagOption } from '@/components/billing-audit/tag-picker';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { loadAuditRows, loadAuditFilterOptions, type AuditFilter } from '@/lib/actions';
import { claimsDeskViews, resolveClaimsDeskView, urlView } from '@/lib/billing-audit/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';
import { loadArOptionsAction, loadArQueue, loadArSummaryAction } from '@/lib/ar/actions';

export const metadata: Metadata = { title: 'AR Management | CMD Billing' };

export default async function BillingAuditPage({
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
  if (access.access.allowedViews.length === 0) {
    return <UnprovisionedNotice email={access.access.user?.email} />;
  }

  // Refactor gate: every viewer sees the notice except the bypass allowlist (alec@treathealth.ai),
  // so the AI rebuild can be worked/verified live while everyone else is held out. Placed before the
  // audit-row fetch so blocked viewers never trigger the PHI queries.
  if (claimsAuditMaintenanceBlocks(access.access.user?.email)) return <ClaimsAuditMaintenanceNotice />;

  // Route-scoped tenant resolution. `views.ts`'s DEFAULT_VIEW is `consolidated`, which this
  // screen has no plane for — it resolved a bare /billing-audit to a view that renders a "switch
  // to BXR" notice, so the Billable Days tab was unreachable without hand-editing the URL. The
  // Claims Desk default is BXR, and the offered set is the RBAC entitlement ∩ this screen's
  // planes; see `lib/billing-audit/views.ts` for why that is a surface capability and not an
  // entitlement decision.
  const params = await searchParams;
  const deskViews = claimsDeskViews(access.access.allowedViews);
  const view = resolveClaimsDeskView(params, access.access.allowedViews);
  // Fail closed, exactly as the empty-entitlement branch above does: entitled to no tenant this
  // screen serves is a deny, never a defaulted scope.
  if (view === null) return <UnprovisionedNotice email={access.access.user?.email} />;
  // Reflect the effective view in the URL so the tabs, the brand theme and the data scope agree.
  // Only ever narrows (unsupported/unentitled/absent → the default), so it cannot widen access.
  if (urlView(params) !== view) redirect(`/billing-audit?view=${view}`);

  // Default window = YTD (Derek's spec). Seed the IP page with the SAME window the client starts
  // on. Options are cheap non-PHI aggregates; each slice fails closed to a safe fallback so a slow
  // option rebuild never blocks the page.
  const ytd = presetWindow(DEFAULT_PRESET);
  const initialFilter: AuditFilter = { dateFrom: ytd.dateFrom, dateTo: ytd.dateTo };
  // The AR queue is the default tab, so its summary, options and first page are seeded here too —
  // the strip and grid paint with data, and the client's first filter change is the first refetch.
  // ⚠ THE IP/OP AUDIT SEEDS ARE GONE FROM THE RENDER PATH (2026-09-10). Their tabs are hidden
  // (workbench.tsx SHOW_SCOPE_TABS), so seeding them meant three audit-plane queries on every
  // render of a page that cannot show them — and because every AR note or work write calls
  // revalidateTag and re-renders this tree, that cost was paid again on each one. The panels fetch
  // on first view if the tabs are re-enabled; restore these three calls only if you want them
  // pre-painted again. The ip*/op* PROPS below stay and receive empty seeds, so the panels keep
  // typechecking and behave correctly the moment the tabs return.
  const [arOptions, arSummary, arPage] = await Promise.all([
    loadArOptionsAction(view),
    loadArSummaryAction(view, {}),
    loadArQueue(view, null, {}, undefined),
  ]);
  const role = access.access.role;

  const facilityTags = (o: { facility_code: string; label: string | null; n: number }): TagOption =>
    ({ value: o.facility_code, label: o.label ?? o.facility_code, count: o.n });
  const payerTags = (o: { payer_name: string; n: number }): TagOption =>
    ({ value: o.payer_name, label: o.payer_name, count: o.n });

  return (
    <main className="mx-auto max-w-[1800px] space-y-6 p-6 sm:p-10">
      {/* The tenant selector is in the top nav (<TenantScope>, app/layout.tsx) as of 2026-09-08. It
          narrows to this desk's two planes via the same `claimsDeskViews` used below, so the nav and
          the data scope cannot disagree. Nothing on this page writes ?view=; `deskViews` is kept
          because the fail-closed empty check below still needs it. */}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">AR Management</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every open claim aged 31 days or more, with CMD follow-up notes, denial reasoning and work
          dispositions. Patient identifiers are masked by default and revealed only through an
          explicit, audited action.
        </p>
        {/* The Facility Resolution entry point was REMOVED from this header 2026-09-10 (Alec).
            The ROUTE and its own gate are untouched — /billing-audit/facility-resolution still
            renders for admin/super_admin by direct URL, and every one of its Server Actions still
            re-gates independently. Only this link is gone, so removing it takes away no capability
            and no one's access; it stops advertising desk work from the AR queue's header. */}
      </header>
      <BillingAuditWorkbench
        view={view}
        canRevealPhi={access.access.canRevealPhi}
        canWork={role === 'admin' || role === 'super_admin'}
        arSeed={{
          summary: arSummary.ok ? arSummary.summary : null,
          options: arOptions.ok ? arOptions.options : null,
          page: arPage.ok ? { rows: arPage.rows, nextCursor: arPage.nextCursor, latestNotes: arPage.latestNotes } : null,
        }}
        initialFilter={initialFilter}
        ipPage={null}
        ipFacilities={[]}
        ipPayers={[]}
        opFacilities={[]}
        opPayers={[]}
      />
    </main>
  );
}
