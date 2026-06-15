/**
 * Claims route (Phase 7.4) — the Claims Data Explorer foundation.
 *
 * A server-component shell over <ClaimsExplorer />, which fetches one bounded page
 * of NON-PHI claim rows at a time through the loadClaimsPage Server Action (gate 1,
 * option a): the secret stays server-side and the full table never ships to the
 * client. Patient identifiers are excluded from this list entirely — reveal stays
 * on the audited results path, not here.
 */
import type { Metadata } from 'next';
import { ClaimsExplorer } from '@/components/claims-explorer';

export const metadata: Metadata = { title: 'Claims Explorer | Claims Search' };

export default function ClaimsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claims Explorer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse claims by facility, payer, and year, 50 rows at a time. Non-PHI fields only;
          patient identifiers are not loaded here.
        </p>
      </header>
      <ClaimsExplorer />
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. There is no application login: access is controlled solely by
        Vercel Deployment Protection. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}
