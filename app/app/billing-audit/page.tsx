/**
 * Billing Audit route — the billing team's IP/OP claim-audit workbench, moved off CMD batch
 * reports + the "JT Master Issues" sheet into the app (claims.audit_row / billing_code_decision
 * / flag). The landing is a flat, dense work table with a collapsible pivot strip; a patient
 * drill exposes charge-line detail with a canRevealPhi-gated identifier reveal.
 *
 * RBAC: gated + view-clamped exactly like Collections (NOT the deploy-protection-only /claims
 * page) — this plane is PHI, so a plain `user` never gets the reveal control, entity scope comes
 * from the ?view= switcher, and reads are tenant-scoped server-side. The audit data is BXR-only
 * today; a non-BXR view resolves to an empty (fail-closed) workbench until that tenant's plane
 * lands — never a cross-tenant leak.
 *
 * BUILD STATUS: component build in progress (milestone 1 — route + subtab shell + nav). The
 * filter bar, work table (reader server action + keyset paging), pivot strip, and patient drill
 * land in later milestones; the flag engine that fills the Flag Queue stays Phase 3 (soak-gated).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BillingAuditWorkbench } from '@/components/billing-audit/workbench';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { clampView, resolveView } from '@/lib/views';

export const metadata: Metadata = { title: 'Billing Audit | CMD Billing' };

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
  // Fail closed: a provisioned role entitled to NO views (entity role with a null entity) must
  // not fall through to clampView's consolidated default. Treat it as unprovisioned.
  if (access.access.allowedViews.length === 0) {
    return <UnprovisionedNotice email={access.access.user?.email} />;
  }

  const requested = resolveView(await searchParams);
  const view = clampView(requested, access.access.allowedViews);
  if (view !== requested) redirect(`/billing-audit?view=${view}`);

  return (
    <main className="mx-auto max-w-[1800px] space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          IP and OP claim-audit workbench. Patient identifiers are masked by default and revealed
          only through an explicit, audited action.
        </p>
      </header>
      <BillingAuditWorkbench view={view} canRevealPhi={access.access.canRevealPhi} />
    </main>
  );
}
