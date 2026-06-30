/**
 * Collections route — the CMD charge-line detail (cmd_explorer_rows) via <CollectionsView />.
 * Filterable by Facility/Month; patient identifiers are masked by default and revealed in
 * bulk on an explicit, audited "Reveal all" click. Entity scope comes from the top-bar view
 * switcher (?view=), resolved here and passed down through the viewToEntityIds seam.
 */
import type { Metadata } from 'next';
import { DashboardNav } from '@/components/dashboard-nav';
import { CollectionsView } from '@/components/dashboard';
import { resolveView } from '@/lib/views';

export const metadata: Metadata = { title: 'Collections | CMD Billing' };

export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = resolveView(await searchParams);
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Collections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          CMD charge-line detail, filterable by facility and month. Patient identifiers are
          masked by default and revealed in bulk on an explicit, audited action.
        </p>
      </header>
      <DashboardNav />
      <CollectionsView view={view} />
    </main>
  );
}
