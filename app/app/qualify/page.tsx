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
import { QualifyTab } from '@/components/qualify/qualify-tab';

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

  // Server-derived amounts capability seeds the initial (pre-search) column layout so an
  // admissions_seat never even renders the $ column headers; every snapshot re-confirms it, and the
  // server strips the dollar VALUES regardless (single choke point in the action core).
  const viewerHasAmountsCapability = role !== 'admissions_seat';
  return (
    <QualifyTab viewerHasAmountsCapability={viewerHasAmountsCapability} canRevealPhi={access.access.canRevealPhi} />
  );
}
