/**
 * Qualify route (Prompt 3) — the admissions lead-qualification surface. A top-level route (NOT a
 * dashboard sub-tab): an admissions_seat has NO dashboard views, so Qualify cannot live under
 * /dashboard. This is the QUALIFY_HOME the Prompt-2 route guards redirect admissions_seat toward.
 *
 * GATE (Q-A): only super_admin + admissions_seat reach Qualify. An entity admin/user has a real
 * dashboard home, so send them there; an unprovisioned/unauthenticated request is handled the same
 * way every other page does. The heavy authorization on the DATA lives in requireQualifyPrincipal
 * (in the Server Actions) — this page gate is the routing mirror of it.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { QualifyMaintenanceNotice } from '@/components/qualify/qualify-maintenance-notice';
import { qualifyMaintenanceBlocks } from '@/lib/qualify/maintenance';
import { qualifyV3FlowEnabled } from '@/lib/qualify/v3Flags';
import { QualifyTab } from '@/components/qualify/qualify-tab';
import { ResolutionFlowClient } from '@/components/qualify/v3/resolution-flow-client';
import { PolicyTapeMount } from '@/components/qualify/policy-tape-mount';

export const metadata: Metadata = { title: 'Qualify | CMD Billing' };

// Force per-request render so the role gate ALWAYS runs. Without this the page (no searchParams;
// dashboardAccess short-circuits cookies() when auth env is absent at build) can prerender STATIC
// and be served without the guard — the guard is a security control, not optional. (Mirrors
// /code-reference's rationale.)
export const dynamic = 'force-dynamic';

export default async function QualifyPage() {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  // Q-A: only super_admin + admissions_seat. admin/user have a dashboard home → send them there.
  const role = access.access.role;
  if (role !== 'super_admin' && role !== 'admissions_seat') redirect('/dashboard');

  // Maintenance gate: every viewer sees the notice except the bypass allowlist (alec@treathealth.ai),
  // so improvements can be verified live while everyone else is held out.
  if (qualifyMaintenanceBlocks(access.access.user?.email)) return <QualifyMaintenanceNotice />;

  // Server-derived amounts capability seeds the initial (pre-search) column layout so an
  // admissions_seat never even renders the $ column headers; every snapshot re-confirms it, and the
  // server strips the dollar VALUES regardless (single choke point in the action core).
  const viewerHasAmountsCapability = role !== 'admissions_seat';

  // ── v3: THE RENDERED UI (default ON since 2026-08-06 — Alec's staged-flow directive). v2 below
  // stays reachable via the QUALIFY_V3_FLOW=off kill switch; its render path is otherwise untouched,
  // including its urlState behaviour, which is grandfathered on prod and out of scope.
  //
  // NOTE WHAT IS *NOT* HERE: no searchParams. The v3 flow submits through a Server Action, so the
  // typed identifier travels in a POST body and never enters the query string. An earlier version of
  // this page read `searchParams.term`, which would have put a full member ID in browser history, the
  // Referer header and edge logs — PHI in a URL. Do not reintroduce a searchParams read here.
  // Authorization is re-checked inside the action by requireQualifyPrincipal; this page gate is the
  // routing mirror, not the control.
  if (qualifyV3FlowEnabled()) {
    // The policy tape sits ABOVE the flow and owns its own fetch, so it adds no latency to the
    // page and no state to the flow shell. It renders as ABSENT (not as an empty bar) whenever
    // there is nothing to show, so a quiet book costs no vertical space. Its own <main> matches
    // the flow's chrome — the route layout supplies none.
    return (
      <>
        <div className="mx-auto max-w-[1680px] px-6 pt-6 sm:px-8 sm:pt-8">
          <PolicyTapeMount />
        </div>
        <ResolutionFlowClient viewerHasAmountsCapability={viewerHasAmountsCapability} />
      </>
    );
  }

  return (
    <QualifyTab viewerHasAmountsCapability={viewerHasAmountsCapability} canRevealPhi={access.access.canRevealPhi} />
  );
}
