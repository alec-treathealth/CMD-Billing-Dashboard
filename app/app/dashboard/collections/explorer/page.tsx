/**
 * Collections Explorer (CMD batch report) — a new sub-route beside /dashboard/collections.
 * Renders Derek's 14-column charge-line detail from the CMD Batch Reporting API. Patient
 * identifiers are masked by default and revealed per row on an explicit, audited click.
 * The daily Checks/EFT/Gross view on /dashboard/collections is unaffected.
 */
import type { Metadata } from 'next';
import { DashboardNav } from '@/components/dashboard-nav';
import { CmdCollectionsExplorer } from '@/components/dashboard/cmd-explorer';

export const metadata: Metadata = { title: 'Collections Explorer | CMD Billing' };

export default function CollectionsExplorerPage() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Collections Explorer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Charge-line detail from the CMD daily batch report. Patient identifiers are masked by
          default and revealed per row on an explicit, audited click.
        </p>
      </header>
      <DashboardNav />
      <CmdCollectionsExplorer />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. Identifiers are masked by default; each reveal is recorded in
        the access audit. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}
