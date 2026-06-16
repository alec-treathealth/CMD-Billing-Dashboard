'use client';

/**
 * Claim detail PHI reveal (Phase 8.0) — the explicit, audited two-gate flow on
 * /claims/[claimId].
 *
 * The page is non-PHI by default. Revealing full claim details is opt-in and runs
 * through the SAME audited path as /ask:
 *   gate 1 — clicking "Reveal full claim details" calls the revealClaim server
 *            action, which mints an audited query_id scoped to EXACTLY this one
 *            synthetic claim id (search_claims with an `id` filter; non-PHI args).
 *   gate 2 — the masked PHI row is fetched via the existing fetchRows / results
 *            path and rendered by ResultsTable, where each PHI cell stays masked
 *            until the per-row "Reveal" button is pressed.
 *
 * PHI discipline: the row lives in component state for the session only — never
 * logged, never persisted to localStorage/sessionStorage/cookies, never cached.
 * The query_id is opaque and non-PHI. This component only ever touches claims via
 * the audited reveal path; it does not read VOB/eligibility/benefits data.
 */
import { useState } from 'react';

import { ResultsTable } from '@/components/results-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchRows, revealClaim, type ResultsActionResult } from '@/lib/actions';

function Notice({ tone, children }: { tone: 'error' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-status-danger/30 bg-status-danger/10 text-status-danger'
      : 'border-teal200 bg-teal50/60 text-ink600';
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function ClaimReveal({ claimId }: { claimId: number }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ResultsActionResult | null>(null);

  async function reveal() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      // Gate 1: mint the audited query_id scoped to this one synthetic id.
      const minted = await revealClaim(claimId);
      if (!minted.ok) {
        setError(minted.error);
        return;
      }
      // Gate 2: fetch the masked PHI row through the existing results path.
      const result = await fetchRows(minted.query_id);
      setRows(result);
      if (!result.ok) setError(result.error);
    } catch {
      setError('The claim details could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  const page = rows && rows.ok ? rows : null;
  const hasRows = page !== null && page.rows.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Full claim details (PHI)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Patient identifiers are masked by default. Revealing creates an audited access record for
          this claim; values then unmask per row on an explicit click.
        </p>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void reveal()}>
          {loading ? 'Preparing…' : 'Reveal full claim details'}
        </Button>

        {error !== null && <Notice tone="error">{error}</Notice>}

        {hasRows && <ResultsTable rows={page.rows} />}

        {page !== null && page.rows.length === 0 && !error && (
          <Notice tone="muted">
            No claim record is available to reveal (the access handle may have expired). Try again.
          </Notice>
        )}
      </CardContent>
    </Card>
  );
}
