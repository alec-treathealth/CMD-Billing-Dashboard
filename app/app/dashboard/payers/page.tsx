/**
 * Payers route (Phase 7.4) — the payer-focused dashboard view. Renders the
 * per-payer billed/allowed/paid + collection-gap overview. Aggregate, non-PHI;
 * the widget reads only the cached payer_gap summary (no patient data, no rows).
 */
import type { Metadata } from 'next';
import { DashboardNav } from '@/components/dashboard-nav';
import { PayerChartWidget, PayerOverview } from '@/components/dashboard';

export const metadata: Metadata = { title: 'Payers | Claims Search' };

export default function PayersPage() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Payers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-payer billed / allowed / paid, average collection rate, and collection gap. Aggregate,
          non-PHI; no patient data is loaded here.
        </p>
      </header>
      <DashboardNav />
      <PayerChartWidget defaultTopN={15} />
      <PayerOverview />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. There is no application login: access is controlled solely by
        Vercel Deployment Protection. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}
