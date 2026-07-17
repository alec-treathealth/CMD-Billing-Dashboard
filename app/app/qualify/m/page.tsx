/**
 * Qualify mobile PWA route (Prompt 4b) at /qualify/m. Same Q-A gate as desktop /qualify — admit
 * {super_admin, admissions_seat}; admin/user → /dashboard; unauth → /login; unprovisioned → notice.
 * Same session, no separate login. Amounts capability is server-derived and passed to the client app
 * (snapshots re-confirm it; the server strips dollar VALUES regardless).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { QualifyMobileApp } from '@/components/qualify/m/qualify-mobile-app';

export const metadata: Metadata = { title: 'Lead lookup | Qualify' };

// Force per-request render so the role gate ALWAYS runs (never a static prerender served without it).
export const dynamic = 'force-dynamic';

export default async function QualifyMobilePage() {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  const role = access.access.role;
  if (role !== 'super_admin' && role !== 'admissions_seat') redirect('/dashboard');

  return <QualifyMobileApp viewerHasAmountsCapability={role !== 'admissions_seat'} />;
}
