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
import { ResolutionFlow } from '@/components/qualify/v3/resolution-flow';
import { resolveCoverage, trailingWindowFor } from '@/lib/qualify/resolutionService';

export const metadata: Metadata = { title: 'Qualify | CMD Billing' };

// Force per-request render so the role gate ALWAYS runs. Without this the page (no searchParams;
// dashboardAccess short-circuits cookies() when auth env is absent at build) can prerender STATIC
// and be served without the guard — the guard is a security control, not optional. (Mirrors
// /code-reference's rationale.)
export const dynamic = 'force-dynamic';

export default async function QualifyPage({
  searchParams,
}: {
  // Next 15: searchParams is a PROMISE. Awaited below, inside the v3 branch only, so the v2 path
  // does nothing new and cannot be slowed or changed by this addition.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // ── v3 (P3): ADDITIVE, dark by default ────────────────────────────────────────────────────────
  // Mounted only when QUALIFY_V3_FLOW is on, and it REPLACES nothing when off — v2 below is
  // untouched, including its urlState behaviour, which is grandfathered on prod and out of scope.
  //
  // The term is read from searchParams because S0 submits a plain GET form, so the whole S0->S2 path
  // works with JavaScript disabled and the keyboard path is the DOM order. It is a member-ID PREFIX
  // or a full member ID — PHI — so it is used to resolve and then dropped: `handle.echo` (prefix-safe,
  // '' for a full id) is the only thing rendered back, and nothing here writes it anywhere else.
  // canRevealPhi gates the lookup exactly as v2 does; without it the flow renders its empty state.
  if (qualifyV3FlowEnabled()) {
    const sp = (await searchParams) ?? {};
    const raw = typeof sp.term === 'string' ? sp.term : '';
    const term = access.access.canRevealPhi ? raw : '';
    const today = new Date().toISOString().slice(0, 10);
    const days = Number(typeof sp.windowDays === 'string' ? sp.windowDays : '30');
    const window = trailingWindowFor(today, Number.isInteger(days) && days > 0 && days <= 3650 ? days : 30);
    const chosenRaw = typeof sp.candidate === 'string' ? Number(sp.candidate) : Number.NaN;
    const { resolution, reason } = await resolveCoverage({
      term,
      from: window.from,
      to: window.to,
      today,
      ...(Number.isInteger(chosenRaw) && chosenRaw >= 0 ? { chosenIndex: chosenRaw } : {}),
    });
    return (
      <ResolutionFlow resolution={resolution} reason={reason} echo={resolution?.handle.echo ?? ''} />
    );
  }

  return (
    <QualifyTab viewerHasAmountsCapability={viewerHasAmountsCapability} canRevealPhi={access.access.canRevealPhi} />
  );
}
