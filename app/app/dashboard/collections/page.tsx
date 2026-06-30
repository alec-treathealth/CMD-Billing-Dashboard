/**
 * Collections route — the unified collections surface. One tab, two views (Payment Type /
 * All Collections) selected via a dropdown inside <CollectionsView />. Aggregate/non-PHI by
 * default; the All Collections charge-line detail masks patient identifiers and reveals them
 * per row on an explicit, audited click. Entity scope comes from the top-bar view switcher
 * (?view=), resolved here and passed down through the viewToEntityIds seam.
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
          Daily Checks / EFT / Gross by facility, plus the full charge-line detail. Patient
          identifiers in the charge-line view are masked by default and revealed per row on an
          explicit, audited click.
        </p>
      </header>
      <DashboardNav />
      <CollectionsView view={view} />
    </main>
  );
}
