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
    /* BOUNDED FLEX COLUMN — the Collections shape (app/app/dashboard/collections/page.tsx), for the
       same reason: the content below scrolls inside its own container and the DOCUMENT does not.
       Everything in the view depends on this element having a REAL height, because `flex-1 min-h-0`
       further down resolves against it; without the bound every descendant falls back to content
       height and the page becomes one long scroll again.

       The height is the viewport minus the 3.5rem (`h-14`) global header AND the 0.25rem (`h-1`)
       <TenantScopeRail> the layout renders under it. HeaderGate DOES render both here —
       `/code-performance` is not in lib/shell.ts's full-page set (/login, /forgot-password,
       /set-password, /qualify/m) — so neither subtraction is an assumption.

       ⚠️ THE RAIL SUBTRACTION IS UNCONDITIONAL, THOUGH THE RAIL IS NOT (Qodo #350 finding 5). It
       renders only when a session has a tenant scope (`offered.length > 0`), so an
       `admissions_seat` would see no rail — but that role is redirected off this route server-side,
       so on this page the rail is always there in practice. The failure modes are ASYMMETRIC and
       that is what settles it: under-filling by 4px is invisible, while over-filling by 4px puts a
       document scrollbar on a route whose entire point is one inner scroll area. Bias toward
       under-fill. Do not make this conditional to reclaim 4px — <ContentInset> pads only
       horizontally, so these two are the whole vertical chrome, and a conditional height would have
       to re-derive the pill's `offeredViews` from a server component to know which case it is in.

       `dvh`, not `vh`: on mobile the visual viewport shrinks as the URL bar retracts, and viewport-
       RELATIVE units are also what keep this usable at 200% zoom (WCAG 1.4.4). Never a px height.

       ⚠️ `max-w-[1800px]`, NOT `max-w-7xl`. This route shipped at 7xl (1280px) while Collections and
       Claims Desk both use 1800px, so the surface carrying the widest table in the app was ~520px
       NARROWER than its neighbours — the table was clipped at both edges and the leading code column
       scrolled out of reach. 1800px is the house width for a wide-table route. */
    <main className="mx-auto flex h-[calc(100dvh-3.5rem-0.25rem)] max-w-[1800px] flex-col gap-3 p-6 sm:px-10 sm:pt-4 sm:pb-6">
      {/* ONE ROW for the title and the standing disclosure. The SUBTITLE and the FOOTER that used to
          bracket this page are gone, not lost: the methodology sentence ("all ratios are sum-over-sum
          … allowed figures use reliable tiers only") and the raw-payer-name caveat both moved into the
          view's "Reading these numbers" disclosure, next to the numbers they qualify. Between them
          they cost ~110px of a viewport-bounded route to restate two things that never change. */}
      <header className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Code Performance</h1>
        <p className="text-xs text-ink400">HCPCS/CPT × revenue-code pairings · aggregate, non-PHI</p>
      </header>

      {principal ? (
        <CodePerformanceView tenants={principal.tenants} defaultTenant={principal.defaultTenant} />
      ) : (
        <div className="rounded-lg border border-teal200 bg-teal50 p-4 text-sm text-teal900 shadow-ths">
          This session has no tenant scope on this surface. Sign in with a provisioned account to see billing-code performance.
        </div>
      )}
    </main>
  );
}
