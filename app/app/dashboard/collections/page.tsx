/**
 * Collections route (Phase 7.4) — the collections-focused dashboard view. Renders
 * the MTD/YTD KPIs, daily detail, and latest-month summary by facility. Aggregate,
 * non-PHI; reads only daily_collections + facilities (no patient data, no rows).
 */
import { DashboardNav } from '@/components/dashboard-nav';
import { CollectionsSections } from '@/components/dashboard';

export default function CollectionsPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Collections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily collections reporting (Checks / EFT / Gross), MTD &amp; YTD by facility. Aggregate,
          non-PHI; no patient data is loaded here.
        </p>
      </header>
      <DashboardNav />
      <CollectionsSections />
    </main>
  );
}
