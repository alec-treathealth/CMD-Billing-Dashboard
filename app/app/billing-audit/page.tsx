/**
 * Billing Audit route — the billing team's IP/OP claim-audit workbench, moved off CMD batch
 * reports + the "JT Master Issues" sheet into the app (claims.audit_row / billing_code_decision
 * / flag). The landing is a flat, dense, charge-line-grain work table with a filter bar; a patient
 * drill (Phase-4 build 5) exposes charge-line detail with a canRevealPhi-gated identifier reveal.
 *
 * RBAC: gated + view-clamped like Collections (NOT the deploy-protection-only /claims page) —
 * this plane is PHI, so a plain `user` never gets the reveal control, entity scope comes from the
 * ?view= switcher, and reads are tenant-scoped server-side. The audit data is BXR-only today; a
 * non-BXR view resolves to an empty (fail-closed) workbench until that tenant's plane lands —
 * never a cross-tenant leak.
 *
 * ⚠ THE CLAMP IS ROUTE-SCOPED HERE, WHICH IS THE ONE WAY THIS DIFFERS FROM COLLECTIONS. That
 * page clamps against the raw RBAC entitlement and defaults to `consolidated`; this desk has no
 * cross-tenant plane, so it offers BXR + Indigo only and defaults to BXR. The switcher itself is
 * `TenantTabs`, the same component both /dashboard routes use, given a narrowed option set — see
 * `lib/billing-audit/views.ts`. It landed on this route 2026-08-31; before that the route had no
 * in-place tenant control at all, and that absence was load-bearing for the Billable Days
 * override keys (`billable-days/overrides.ts`).
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
import { TenantTabs } from '@/components/dashboard/tenant-tabs';
import { claimsDeskViews, resolveClaimsDeskView, urlView } from '@/lib/billing-audit/views';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Claims Desk | CMD Billing' };

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
  const [ipReport, ipOpts, opOpts] = await Promise.all([
    loadAuditRows('IP', null, initialFilter, undefined, view),
    loadAuditFilterOptions('IP', view),
    loadAuditFilterOptions('OP', view),
  ]);

  const facilityTags = (o: { facility_code: string; label: string | null; n: number }): TagOption =>
    ({ value: o.facility_code, label: o.label ?? o.facility_code, count: o.n });
  const payerTags = (o: { payer_name: string; n: number }): TagOption =>
    ({ value: o.payer_name, label: o.payer_name, count: o.n });

  return (
    <main className="mx-auto max-w-[1800px] space-y-6 p-6 sm:p-10">
      {/* Tenant tabs, above the title — the same control and placement as Overview and
          Collections (Alec, 2026-08-18: "keep this consistent"). Offered set excludes
          Consolidated: this desk is entity-scoped and has no cross-tenant plane. The component
          renders NOTHING when only one tenant is on offer, so an entity-scoped admin sees no
          chrome implying a choice they do not have. */}
      <TenantTabs allowedViews={deskViews} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claims Desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          IP and OP claim-audit workbench. Patient identifiers are masked by default and revealed
          only through an explicit, audited action.
        </p>
        {/* Facility Resolution entry point — MOVED here from the Collections header (Alec,
            2026-08-17): attributing a 'No Facility' charge is desk work. admin/super_admin ONLY,
            the same gate the destination page and every one of its server actions enforce, and
            rendered by DOM omission rather than CSS, so a plain 'user' never receives the link. */}
        {access.access.role === 'admin' || access.access.role === 'super_admin' ? (
          <Link
            href={`/billing-audit/facility-resolution?view=${view}`}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-ink900 hover:border-teal700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Facility Resolution
            <span aria-hidden>→</span>
            <span className="sr-only">— attribute charges CMD posted with no facility</span>
          </Link>
        ) : null}
      </header>
      <BillingAuditWorkbench
        view={view}
        canRevealPhi={access.access.canRevealPhi}
        initialFilter={initialFilter}
        ipPage={ipReport.ok ? { rows: ipReport.rows, nextCursor: ipReport.nextCursor } : null}
        ipFacilities={ipOpts.ok ? ipOpts.options.facilities.map(facilityTags) : []}
        ipPayers={ipOpts.ok ? ipOpts.options.payers.map(payerTags) : []}
        opFacilities={opOpts.ok ? opOpts.options.facilities.map(facilityTags) : []}
        opPayers={opOpts.ok ? opOpts.options.payers.map(payerTags) : []}
      />
    </main>
  );
}
