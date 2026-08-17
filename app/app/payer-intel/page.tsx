import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { dashboardAccess } from '@/lib/access';
import { UnprovisionedNotice } from '@/components/dashboard/unprovisioned-notice';
import { getPayerIntelBoardCore } from '@/lib/payer-intel/core';
import { buildPayerIntelRealDeps } from '@/lib/payer-intel/deps';
import { loadPayerIntelFacilityNames, loadPayerIntelPayerVocabulary } from '@/lib/payer-intel/loaders';
import { requirePayerIntelPrincipalFromAccess } from '@/lib/payer-intel/principal';
import type { PayerIntelBoard, PayerIntelUrlState } from '@/lib/payer-intel/contract';
import { PayerIntelView } from '@/components/payer-intel/payer-intel-view';

export const metadata: Metadata = { title: 'Payer Intel | CMD Billing' };

/**
 * REQUIRED even though this page reads searchParams: the role gate below must run on EVERY
 * request — a static prerender would serve the shell without it (the qualify/page.tsx failure
 * mode, documented there at :26-29).
 */
export const dynamic = 'force-dynamic';

/**
 * /payer-intel — the consolidated Collections-search × Qualify-intelligence tab.
 *
 * ROLE POSTURE (see lib/payer-intel/principal.ts for the ruling): super_admin +
 * admissions_seat — the Qualify set, because the surface is cross-tenant. admissions_seat is
 * ADMITTED here (unlike every other non-Qualify page — no isQualifyOnlyRole redirect): names
 * yes, dollars never; every dollar field is stripped server-side off the principal's hasAmounts.
 *
 * searchParams carry ONLY the non-PHI facet allowlist (payer · prefix echo · facility codes ·
 * funding) — decoded here, server-side, so the client island needs no useSearchParams/Suspense.
 * Identifiers (group numbers) travel exclusively in Server Action POST bodies.
 */
export default async function PayerIntelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await dashboardAccess();
  if (!access.ok) {
    if (access.reason === 'unauthenticated') redirect('/login');
    return <UnprovisionedNotice email={access.user.email} />;
  }
  // The page gate is the routing mirror; every server action re-gates via requirePayerIntelPrincipal.
  const principal = requirePayerIntelPrincipalFromAccess(access);
  if (!principal.ok) redirect('/dashboard');

  const params = await searchParams;
  const asArray = (v: string | string[] | undefined): string[] =>
    Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const one = (v: string | string[] | undefined): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  const prefixRaw = (one(params.prefix) ?? '').toUpperCase();
  const initialUrlState: PayerIntelUrlState = {
    payer: one(params.payer),
    prefix: /^[A-Z0-9]{1,3}$/.test(prefixRaw) ? prefixRaw : null,
    facilityCodes: asArray(params.fac).filter((f) => f.length > 0 && f.length <= 40).slice(0, 20),
    funding: asArray(params.funding).filter((f) => f === 'Self-Funded' || f === 'Fully Insured'),
  };

  // Parallel server fetch (the collections page pattern): the ambient board + the facet
  // vocabularies the pickers need. Board failures fall back to an empty-but-honest shell rather
  // than 500ing the whole tab.
  const emptyBoard: PayerIntelBoard = {
    gainers: { available: false, asOf: null, deltaDays: 90, items: [] },
    decliners: { items: [], windowDays: 90, thresholdPts: 5 },
    census: { rows: [], syncedAt: null },
    searches: { starred: [], recent: [] },
    viewerHasAmountsCapability: principal.hasAmounts,
  };
  const [board, facilities, payers] = await Promise.all([
    getPayerIntelBoardCore(buildPayerIntelRealDeps()).catch((err) => {
      console.error('payer intel board failed at page load', err instanceof Error ? err.message : '');
      return emptyBoard;
    }),
    loadPayerIntelFacilityNames().catch(() => []),
    loadPayerIntelPayerVocabulary(principal.entityIds).catch(() => []),
  ]);

  return (
    <main className="mx-auto max-w-[1240px] space-y-6 p-6 sm:p-10">
      <header>
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink900">Payer Intel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One place to ask how a policy pays and where it places — the Collections engine under
          Qualify&apos;s instruments.
        </p>
      </header>
      <PayerIntelView
        initialBoard={board}
        initialUrlState={initialUrlState}
        facetOptions={{
          facilities: facilities
            .map((f) => ({ code: f.facility_code, name: f.facility_name, careSetting: f.care_setting }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          payers,
        }}
      />
    </main>
  );
}
