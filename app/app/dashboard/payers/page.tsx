/**
 * Payers route (Phase 7.4) — the payer-focused dashboard view. Renders the
 * per-payer billed/allowed/paid + collection-gap overview. Aggregate, non-PHI;
 * the widget reads only the cached payer_gap summary (no patient data, no rows).
 */
import { DashboardNav } from '@/components/dashboard-nav';
import { PayerOverview } from '@/components/dashboard';

export default function PayersPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Payers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-payer billed / allowed / paid, average collection rate, and collection gap. Aggregate,
          non-PHI; no patient data is loaded here.
        </p>
      </header>
      <DashboardNav />
      <PayerOverview />
    </main>
  );
}
