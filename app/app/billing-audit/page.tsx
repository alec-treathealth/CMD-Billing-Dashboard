/**
 * Billing Audit route — the billing team's IP/OP claim-audit workbench, moved off CMD batch
 * reports + the "JT Master Issues" sheet into the app (claims.audit_row / billing_code_decision
 * / flag). The landing is a flat, dense, charge-line-grain work table with a filter bar; a patient
 * drill (Phase-4 build 5) exposes charge-line detail with a canRevealPhi-gated identifier reveal.
 *
 * RBAC: gated + view-clamped exactly like Collections (NOT the deploy-protection-only /claims
 * page) — this plane is PHI, so a plain `user` never gets the reveal control, entity scope comes
 * from the ?view= switcher, and reads are tenant-scoped server-side. The audit data is BXR-only
 * today; a non-BXR view resolves to an empty (fail-closed) workbench until that tenant's plane
 * lands — never a cross-tenant leak.
 *
 * Initial render: the server fetches the IP first page for the DEFAULT (YTD) window plus both
 * scopes' filter options, so the grid paints with data (and the client starts on the SAME window
 * the seeded page was fetched with — no first-render refetch/mismatch). OP rows fetch on first view.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BillingAuditWorkbench } from '@/components/billing-audit/workbench';
import { ClaimsAuditMaintenanceNotice } from '@/components/billing-audit/maintenance-notice';
import { claimsAuditMaintenanceBlocks } from '@/lib/billing-audit/maintenance';
import { presetWindow, DEFAULT_PRESET } from '@/components/billing-audit/date-presets';
import type { TagOption } from '@/components/billing-audit/tag-picker';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { loadAuditRows, loadAuditFilterOptions, type AuditFilter } from '@/lib/actions';
import { clampView, resolveView } from '@/lib/views';
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

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  if (view !== requested) redirect(`/billing-audit?view=${view}`);

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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claims Desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          IP and OP claim-audit workbench. Patient identifiers are masked by default and revealed
          only through an explicit, audited action.
        </p>
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
