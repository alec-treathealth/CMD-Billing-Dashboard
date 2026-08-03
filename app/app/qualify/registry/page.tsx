import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { qualifyMaintenanceBlocks } from '@/lib/qualify/maintenance';
import { QualifyMaintenanceNotice } from '@/components/qualify/qualify-maintenance-notice';
import { getCodingRegistry } from '@/lib/qualify/registry-actions';
import { RegistryClient } from '@/components/qualify/registry-client';

/**
 * /qualify/registry — the CODE DECISION REGISTRY (Phase A): which code combo we bill for a payer at
 * a facility, when it was decided, and whether the decision is confirmed or still under test. The
 * repo's first editable write surface — super_admin ONLY (registry-actions re-gates every action
 * server-side; this page gate is the front door, not the lock).
 *
 * force-dynamic is a SECURITY control: without it the role guard could be prerendered away.
 */
export const dynamic = 'force-dynamic';

export default async function QualifyRegistryPage() {
  const access = await dashboardAccess();
  if (!access.ok) redirect('/login?next=%2Fqualify%2Fregistry');
  if (!access.access.user || access.access.role !== 'super_admin') redirect('/qualify');
  if (qualifyMaintenanceBlocks(access.access.user.email)) return <QualifyMaintenanceNotice />;

  const registry = await getCodingRegistry();
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Code decision registry</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Which code combo we bill for each payer at each facility — versioned, never overwritten. The sheet is the
          historical record; this is the source of truth after the seed.
        </p>
      </header>
      <RegistryClient initial={registry} />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — no PHI lives on this surface (payers, facilities, codes, dates only). Every change writes an
        append-only audit row.
      </footer>
    </main>
  );
}
