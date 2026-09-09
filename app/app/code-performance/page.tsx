/**
 * Code Performance route (renamed from Code Reference, 2026-09-08) — billing-code performance over
 * collections.cmd_explorer_charge_rollup: procedure-code × revenue-code pairings with yield, velocity
 * and data-quality metrics, per tenant, per window, per facility set. Aggregate and non-PHI; the
 * browser's only data path is the two Server Actions in app/lib/code-performance/actions.ts.
 *
 * Access: every provisioned role except admissions_seat, which is redirected server-side exactly as
 * the old Code Reference page did (that role sees Payer Intel only). The tenant set the client may
 * toggle between is derived here from the RBAC entitlement and re-derived inside every action — the
 * toggle is a hint, never the gate.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CodePerformanceView } from '@/components/code-performance/code-performance-view';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { dashboardAccess } from '@/lib/access';
import { codePerfPrincipalFromAccess } from '@/lib/code-performance/principal';
import { isQualifyOnlyRole, QUALIFY_HOME } from '@/lib/rbac';

export const metadata: Metadata = { title: 'Code Performance | TreatHealthOS' };

// Force per-request render so the admissions_seat guard ALWAYS runs (the guard is a security control).
export const dynamic = 'force-dynamic';

export default async function CodePerformancePage() {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  if (isQualifyOnlyRole(access.access.role)) redirect(QUALIFY_HOME);
  const principal = codePerfPrincipalFromAccess(access);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Code Performance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          HCPCS/CPT × revenue-code pairings: yield, velocity and data quality, per tenant. All ratios are sum-over-sum on the
          charge rollup; allowed figures use reliable tiers only.
        </p>
      </header>

      {principal ? (
        <CodePerformanceView tenants={principal.tenants} defaultTenant={principal.defaultTenant} />
      ) : (
        <div className="rounded-lg border border-teal200 bg-teal50 p-4 text-sm text-teal900 shadow-ths">
          This session has no tenant scope on this surface. Sign in with a provisioned account to see billing-code performance.
        </div>
      )}

      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Aggregate, non-PHI. Descriptions come from <code>ref.code_description</code> and are marked until reviewed. Payer names are
        raw CMD strings. Days to money is charge → last posting. Zero-paid share is a signal, not a denial rate.
      </footer>
    </main>
  );
}
