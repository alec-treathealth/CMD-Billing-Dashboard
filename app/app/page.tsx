/**
 * Phase 5 landing page — the natural-language claims search console.
 *
 * This is a Server Component shell; all data access happens through the Server
 * Actions invoked by <SearchConsole /> (gate 1, option a), so RESULTS_API_SECRET
 * stays on the server and never reaches the browser bundle. Reaching this page is
 * gated by Vercel deployment protection, not by app-level login (no per-user auth
 * yet — the audit principal is the fixed label 'phase5-ui').
 */
import { Dashboard } from '@/components/dashboard';
import { SearchConsole } from '@/components/search-console';

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl space-y-10 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claims Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask a question about three years of out-of-network behavioral-health claims. Results
          summaries are PHI-free; underlying patient rows are masked until revealed.
        </p>
      </header>
      <SearchConsole />
      <Dashboard />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. There is no application login: access is controlled solely by
        Vercel Deployment Protection. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}
