/**
 * Code Reference route (Phase 9) — a read-only, static BH billing reference.
 *
 * This is a Server Component shell around <CodeReference />, which holds a static,
 * non-PHI dataset of HCPCS/CPT + Revenue Code combinations and filters it entirely
 * client-side. There is no data access here: no API route, no Supabase query, no
 * PHI. The page only frames the reference with the standard TreatHealthOS chrome.
 */
import type { Metadata } from 'next';
import { Info } from 'lucide-react';
import { CodeReference } from '@/components/code-reference';

export const metadata: Metadata = { title: 'Behavioral Health Code Reference | Claims Search' };

export default function CodeReferencePage() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Behavioral Health Code Reference</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          HCPCS + Revenue Code combinations for mental/behavioral health billing.
        </p>
      </header>

      {/* Teal info banner — billing guidance, not data. */}
      <div className="flex gap-3 rounded-lg border border-teal200 bg-teal50 p-4 text-sm text-teal900 shadow-ths">
        <Info aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-teal700" />
        <p>
          Revenue codes and HCPCS/CPT codes must appear on the same UB-04 claim line (FL 42/44). If
          multiple HCPCS codes apply to one revenue code, repeat the revenue code on a separate line
          for each. Always verify combinations against your payer&apos;s specific billing manual —
          Medicare rules are baseline; commercial payers override.
        </p>
      </div>

      <CodeReference />

      <footer className="mt-6 text-xs text-muted-foreground">
        Sources: CMS Medicare Coverage Database, CMS Transmittals, NUBC UB-04 Manual, Novitas
        Solutions MAC, Ensora Health (updated May 2026). HCPCS codes are reviewed quarterly by CMS
        (Jan 1, Apr 1, Jul 1, Oct 1). Last dataset review: June 2026.
      </footer>
    </main>
  );
}
