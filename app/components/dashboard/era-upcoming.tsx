'use client';

/**
 * "ERA-Confirmed Upcoming Payments" — the Overview module over staging.era_835_payment
 * (payment grain, migration 013). Sum(BPR02) is safe there by construction: one row per
 * remittance. Rendered inside the OverviewKpis toggle panel (next to "All Facilities
 * Table"), not as a standalone top-of-page card.
 *
 * LABEL IS DELIBERATE: "ERA-Confirmed", never plain "Upcoming Payments". The tile shows
 * remits payers have adjudicated onto an 835 with a future effective date — honest at ANY
 * coverage rate, which is why it can ship before the coverage measurement (finding 6:
 * do not compute a coverage rate yet). A bare "Upcoming Payments" would imply a
 * completeness nobody has measured.
 *
 * HEADLINE COUNTS ARE SPLIT, deliberately: "N incoming · M zero-dollar", never one blended
 * "N remits". BPR04 = 'NON' remits carry $0.00 by definition, so counting them as payments
 * implies deposits that will never arrive. Both counts come from the single uncapped
 * TOTALS_SQL aggregate — this component does no arithmetic on them and must not start
 * (subtracting, or counting the groups array, would silently understate once the
 * breakdown is capped). NON rows DO stay in the breakdown table: they are real ERA
 * activity, and the row-level "No payment" method label already tells the truth there.
 *
 * ⚠️ READ-PATH CONTRACT (013): payment_amount is nullable, sum() skips NULLs, so a remit
 * with an unreadable BPR02 contributes $0 SILENTLY. The payload therefore always carries
 * unquantified_remits over the same window, and this component MUST render the floor
 * banner whenever it is > 0. Do not remove the banner to tidy the card — without it the
 * tile understates while looking authoritative.
 *
 * Non-PHI throughout (facility code / payer / date / method / amounts / remit counts) —
 * facility_code is a BXR short code or Indigo CMD customer id, never a patient attribute,
 * so there is no reveal gate here.
 * EraUpcomingBody is a pure presentational leaf (relative + type-only imports) so the
 * render suite can assert on real markup without pulling server-only modules.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { count, money } from '../../lib/format';
import type { EraUpcomingSummary } from '../../../src/veris/era835Upcoming.js';

/** Amber "data caveat" treatment — same family as the explorer's cohort caveats. */
const FLOOR_BANNER_CLASS =
  'rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 ' +
  'dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200';

/**
 * X12 BPR04 payment-method code → billing-desk English. DISPLAY ONLY: the stored value
 * stays the verbatim payer code so it can be reconciled against the raw 835.
 *
 * ⚠️ `NON` is "Non-Payment Data" — a $0 informational remit (full denial, or everything
 * applied to patient responsibility). It is NOT a check; `CHK` is. On the first live BXR
 * window all 32 NON remits were exactly $0.00 while all 7 CHK remits were positive, so
 * labelling NON as "Check" would both promise money that was never paid and collide with
 * the real checks. Do not "simplify" these two into one label.
 *
 * `ACH` displays as "EFT" because that is what the billing team calls it; it is the same
 * code, not a different one.
 *
 * Codes we have not confirmed semantics for (e.g. BOP, "Financial Institution Option")
 * are deliberately ABSENT: an unmapped code renders as its raw self, which is loud, over
 * a guessed label, which is silently wrong.
 */
const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  ACH: 'EFT',
  CHK: 'Check',
  FWT: 'Wire',
  NON: 'No payment',
};

/** BPR04 → display label. Null/blank → em dash; unknown code → the code itself. */
export function paymentMethodLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code.trim() === '') return '—';
  const key = code.trim().toUpperCase();
  return PAYMENT_METHOD_LABELS[key] ?? key;
}

/** Pure body: given the payload, render empty / data (+ floor banner) states. */
export function EraUpcomingBody({ data }: { data: EraUpcomingSummary }) {
  if (data.remits === 0) {
    // Calm empty state — the table is expected to be empty until the ERA ingest cron
    // runs. This is "nothing scheduled", not an error and not a zero-dollar datum.
    return (
      <div className="py-2">
        <p className="text-sm text-foreground">No ERA-confirmed payments scheduled.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Shows finalized 835 remittances with an effective payment date of today or later.
          Entries appear once ERA ingest is running and payers adjudicate upcoming deposits.
        </p>
      </div>
    );
  }

  const earliest = data.groups[0]?.payment_date;
  // When EVERY upcoming remit is unquantified, the quantified sum is 0.00 — but showing
  // "$0.00" would be a fabricated zero for money we simply cannot read. Render the
  // unknown as unknown; the floor banner below carries the explanation.
  const allUnquantified = data.unquantified_remits >= data.remits;
  return (
    <div className="space-y-3">
      <div>
        <div className="ths-num whitespace-nowrap text-2xl font-semibold leading-tight tabular-nums text-[var(--brand-ink)]">
          {allUnquantified ? '—' : money(data.total)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {count(data.incoming_remits)} incoming
          {/* Suppressed at zero on purpose: with no non-payments in the window, a bare
              "N incoming" is the honest read and a "· 0 zero-dollar" clause is noise. */}
          {data.zero_dollar_remits > 0 ? ` · ${count(data.zero_dollar_remits)} zero-dollar` : ''}
          {earliest ? ` · earliest ${earliest}` : ''}
        </div>
      </div>

      {data.unquantified_remits > 0 && (
        <p className={FLOOR_BANNER_CLASS}>
          {count(data.unquantified_remits)}{' '}
          {data.unquantified_remits === 1 ? 'remit carries' : 'remits carry'} an unreadable
          amount and {data.unquantified_remits === 1 ? 'is' : 'are'} not included — the total
          shown is a floor, not the full sum.
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Facility</TableHead>
            <TableHead>Payer</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Remits</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.groups.map((g, i) => (
            <TableRow
              key={`${g.payment_date}-${g.facility_code}-${g.payer_name ?? ''}-${g.payment_method ?? ''}-${i}`}
            >
              <TableCell className="whitespace-nowrap tabular-nums">{g.payment_date}</TableCell>
              <TableCell className="whitespace-nowrap font-medium">{g.facility_code}</TableCell>
              <TableCell>
                {g.payer_name ?? <span className="text-muted-foreground">(unnamed payer)</span>}
              </TableCell>
              {/* title keeps the raw BPR04 available for anyone reconciling against the 835. */}
              <TableCell className="text-muted-foreground" title={g.payment_method ?? undefined}>
                {paymentMethodLabel(g.payment_method)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{count(g.remits)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(g.amount)}
                {g.unquantified_remits > 0 && (
                  <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                    +{count(g.unquantified_remits)} unq.
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {data.groups_truncated && (
        <p className="text-xs text-muted-foreground">
          Breakdown capped at the first 50 date/payer groups — the headline total and remit
          count include everything.
        </p>
      )}
    </div>
  );
}
