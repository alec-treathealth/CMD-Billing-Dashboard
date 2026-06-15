/**
 * Dashboard route — the non-PHI aggregate overview (Phase 7.3 split).
 *
 * This page mounts ONLY <Dashboard />; the AI SearchConsole no longer shares the
 * page, so first paint here does not wait on the agent bundle. The dashboard's
 * aggregate reads are cached (see lib/server.ts), so warm loads are memory reads.
 * No PHI is reachable here: the dashboard never fetches rows.
 */
import type { Metadata } from 'next';
import { Dashboard } from '@/components/dashboard';
import { DashboardNav } from '@/components/dashboard-nav';

export const metadata: Metadata = { title: 'Dashboard | Claims Search' };

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Aggregate, non-PHI metrics across all claims and collections. No patient data is loaded
          here.
        </p>
      </header>
      <DashboardNav />
      <Dashboard />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. There is no application login: access is controlled solely by
        Vercel Deployment Protection. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}
