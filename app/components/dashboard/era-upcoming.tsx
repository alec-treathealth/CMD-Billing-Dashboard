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
 * ⚠️ READ-PATH CONTRACT (013): payment_amount is nullable, sum() skips NULLs, so a remit
 * with an unreadable BPR02 contributes $0 SILENTLY. The payload therefore always carries
 * unquantified_remits over the same window, and this component MUST render the floor
 * banner whenever it is > 0. Do not remove the banner to tidy the card — without it the
 * tile understates while looking authoritative.
 *
 * Non-PHI throughout (payer / date / method / amounts / remit counts) — no reveal gate.
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
          {count(data.remits)} {data.remits === 1 ? 'remit' : 'remits'}
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
            <TableHead>Payer</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Remits</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.groups.map((g, i) => (
            <TableRow key={`${g.payment_date}-${g.payer_name ?? ''}-${g.payment_method ?? ''}-${i}`}>
              <TableCell className="whitespace-nowrap tabular-nums">{g.payment_date}</TableCell>
              <TableCell>
                {g.payer_name ?? <span className="text-muted-foreground">(unnamed payer)</span>}
              </TableCell>
              <TableCell className="text-muted-foreground">{g.payment_method ?? '—'}</TableCell>
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
