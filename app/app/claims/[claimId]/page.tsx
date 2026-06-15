/**
 * Claim detail route (Phase 7.5) — a single claim's NON-PHI projection.
 *
 * This Server Component reads the claim directly via getClaim() (the same non-PHI
 * column allowlist as the explorer list); no patient identifiers are queried or
 * shown. PHI reveal is intentionally NOT implemented here: doing it safely would
 * require extending the audited query_id / results path (a SECURITY DEFINER and
 * audit-chokepoint change), which is deferred to a later, reviewed phase. The route
 * therefore neither exposes PHI nor bypasses the audited reveal flow.
 *
 * `claimId` is validated as a bounded positive integer; anything else, or a claim
 * that does not exist, renders a safe not-found state. force-dynamic guarantees the
 * row is read fresh per request and never cached.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { money, rate } from '@/lib/format';
import { getClaim } from '@/lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Claim Detail | Claims Search' };

/** Non-PHI fields to show, in display order, with their formatter. */
const FIELDS: readonly { key: string; label: string; format: (v: unknown) => string }[] = [
  { key: 'id', label: 'Claim ID', format: plain },
  { key: 'source_year', label: 'Source year', format: plain },
  { key: 'date_of_service', label: 'Date of service', format: dateText },
  { key: 'facility_name', label: 'Facility', format: plain },
  { key: 'payer_name', label: 'Payer', format: plain },
  { key: 'hcpcs_code', label: 'HCPCS code', format: plain },
  { key: 'revenue_code', label: 'Revenue code', format: plain },
  { key: 'charge_amount', label: 'Charge amount', format: money },
  { key: 'allowed_amount', label: 'Allowed amount', format: money },
  { key: 'paid_amount', label: 'Paid amount', format: money },
  { key: 'adjustment', label: 'Adjustment', format: money },
  { key: 'balance_due_pt', label: 'Balance due (patient)', format: money },
  { key: 'collection_rate', label: 'Collection rate', format: rate },
];

function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function dateText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Strictly parse the route param as a bounded positive integer, else null. */
function parseClaimId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-10">
      <div>
        <Link href="/claims" className="text-sm text-teal700 underline-offset-2 hover:underline">
          ← Back to Claims Explorer
        </Link>
      </div>
      {children}
      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Internal tool — handles PHI. There is no application login: access is controlled solely by
        Vercel Deployment Protection. Do not share this URL outside the authorized billing audience.
      </footer>
    </main>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claim not found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </Shell>
  );
}

export default async function ClaimDetailPage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = await params;
  const id = parseClaimId(claimId);
  if (id === null) {
    return <NotFound message="That claim reference is not a valid claim id." />;
  }

  let claim: Record<string, unknown> | null = null;
  try {
    claim = await getClaim(id);
  } catch {
    return <NotFound message="The claim could not be loaded right now. Please try again." />;
  }
  if (claim === null) {
    return <NotFound message={`No claim exists with id ${id}.`} />;
  }

  return (
    <Shell>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claim {plain(claim.id)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Non-PHI claim detail. Patient identifiers (name, member ID, employer, group number) are not
          shown here and remain available only through the audited search reveal path.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claim record</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {FIELDS.map((f) => (
                <TableRow key={f.key}>
                  <TableCell className="w-[40%] text-muted-foreground">{f.label}</TableCell>
                  <TableCell className="tabular-nums">{f.format(claim![f.key])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Shell>
  );
}
