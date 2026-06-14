'use client';

/**
 * Default dashboard — non-PHI, aggregate-only. Each widget auto-loads on mount via
 * a dedicated Server Action that calls a vetted query function directly (no LLM)
 * and returns ONLY the non-PHI summary. The dashboard NEVER fetches rows, so no
 * PHI is reachable here. Each widget owns its loading/error state; if one fails it
 * shows a generic message and the rest of the page stays usable.
 */
import { useEffect, useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { count, money, percent, rate } from '@/lib/format';
import {
  loadClaimsByYear,
  loadCollectionsSummary,
  loadPayerGap,
  loadTopHcpcs,
  loadTopRevenue,
  type CollectionsMonthlySummary,
  type DashboardResult,
  type DistributionSummary,
  type PayerGapSummary,
} from '@/lib/actions';
import { facilityLabel } from '../../src/collections/summaryTypes';

type WidgetState<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

/** Run a dashboard action once on mount; expose loading/error/ready state. */
function useWidget<T>(action: () => Promise<DashboardResult<T>>): WidgetState<T> {
  const [state, setState] = useState<WidgetState<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    action()
      .then((r) => {
        if (!live) return;
        setState(r.ok ? { status: 'ready', data: r.data } : { status: 'error' });
      })
      .catch(() => {
        if (live) setState({ status: 'error' });
      });
    return () => {
      live = false;
    };
    // action identity is stable (module-level server action); run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

function WidgetCard({
  title,
  state,
  children,
}: {
  title: string;
  state: { status: string };
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {state.status === 'error' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Unable to load this metric.
          </div>
        )}
        {state.status === 'ready' && children}
      </CardContent>
    </Card>
  );
}

/** A light proportional bar (0–100). Decorative; values are also shown as text. */
function MiniBar({ pct }: { pct: number | null }) {
  const w = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="h-1.5 w-full rounded bg-muted">
      <div className="h-1.5 rounded bg-primary/60" style={{ width: `${w}%` }} />
    </div>
  );
}

function PayerOverview() {
  const state = useWidget<PayerGapSummary>(loadPayerGap);
  return (
    <WidgetCard title="Payer overview" state={state}>
      {state.status === 'ready' && (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {count(state.data.rows_analyzed)} claims analyzed across{' '}
            {count(state.data.by_payer.length)} payers
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payer</TableHead>
                <TableHead className="text-right">Claims</TableHead>
                <TableHead className="text-right">Charged</TableHead>
                <TableHead className="text-right">Allowed</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Avg rate</TableHead>
                <TableHead className="text-right">Collection gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...state.data.by_payer]
                .sort((a, b) => b.claim_count - a.claim_count)
                .slice(0, 15)
                .map((r, i) => (
                  <TableRow key={`${r.payer_name ?? 'null'}-${i}`}>
                    <TableCell>
                      {r.payer_name ?? <span className="text-muted-foreground">(blank)</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.claim_count)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total_charge)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total_allowed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total_paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rate(r.avg_collection_rate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total_collection_gap)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">Top 15 payers by claim volume.</p>
        </div>
      )}
    </WidgetCard>
  );
}

/** A compact distribution widget: top-N buckets by count with a proportional bar. */
function DistributionWidget({
  title,
  action,
  topN,
  sort,
  caption,
}: {
  title: string;
  action: () => Promise<DashboardResult<DistributionSummary>>;
  topN: number;
  sort: 'metric' | 'value';
  caption?: string;
}) {
  const state = useWidget<DistributionSummary>(action);
  return (
    <WidgetCard title={title} state={state}>
      {state.status === 'ready' && (
        <div className="space-y-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{state.data.field.replace(/_/g, ' ')}</TableHead>
                <TableHead className="text-right">Claims</TableHead>
                <TableHead className="w-[30%]">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...state.data.buckets]
                .sort((a, b) =>
                  sort === 'metric'
                    ? (b.metric_value ?? 0) - (a.metric_value ?? 0)
                    : String(a.value).localeCompare(String(b.value)),
                )
                .slice(0, topN)
                .map((b, i) => (
                  <TableRow key={`${b.value ?? 'null'}-${i}`}>
                    <TableCell>
                      {b.value ?? <span className="text-muted-foreground">(blank)</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{count(b.metric_value)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MiniBar pct={b.pct_of_total} />
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {percent(b.pct_of_total)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
        </div>
      )}
    </WidgetCard>
  );
}

/**
 * Collections summary — latest month, by facility. Non-PHI: aggregates only
 * collections.daily_collections + facilities (never collections_raw /
 * payment_lines / source_group_code). A null facility renders as "(unassigned)".
 */
function CollectionsSummaryWidget() {
  const state = useWidget<CollectionsMonthlySummary>(loadCollectionsSummary);
  return (
    <WidgetCard title="Collections — latest month by facility" state={state}>
      {state.status === 'ready' && <CollectionsBody data={state.data} />}
    </WidgetCard>
  );
}

function CollectionsBody({ data }: { data: CollectionsMonthlySummary }) {
  const latestMonth = data.by_month_facility.reduce<string | null>(
    (m, r) => (m === null || r.month > m ? r.month : m),
    null,
  );
  const rows = data.by_month_facility
    .filter((r) => r.month === latestMonth)
    .sort((a, b) => b.gross_amount - a.gross_amount);
  const totalGross = rows.reduce((acc, r) => acc + (r.gross_amount || 0), 0);

  if (latestMonth === null || rows.length === 0) {
    return <div className="text-sm text-muted-foreground">No collections in range.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground">
        {latestMonth} · {count(rows.length)} facilities · {money(totalGross)} gross
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Facility</TableHead>
            <TableHead className="text-right">Checks</TableHead>
            <TableHead className="text-right">EFT</TableHead>
            <TableHead className="text-right">Gross</TableHead>
            <TableHead className="w-[24%]">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const pct = totalGross > 0 ? (r.gross_amount / totalGross) * 100 : null;
            return (
              <TableRow key={`${r.facility_code ?? 'unassigned'}-${i}`}>
                <TableCell>
                  {r.facility_name === null ? (
                    <span className="text-muted-foreground">{facilityLabel(r)}</span>
                  ) : (
                    facilityLabel(r)
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.checks_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.eft_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.gross_amount)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <MiniBar pct={pct} />
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {percent(pct)}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Latest month by gross. &quot;(unassigned)&quot; = group-code lineage with no facility code.
      </p>
    </div>
  );
}

export function Dashboard() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Overview</h2>
        <p className="text-sm text-muted-foreground">
          Aggregate, non-PHI metrics across all claims. No patient data is loaded here.
        </p>
      </div>
      <PayerOverview />
      <div className="grid gap-4 lg:grid-cols-3">
        <DistributionWidget
          title="Claims by year"
          action={loadClaimsByYear}
          topN={10}
          sort="value"
        />
        <DistributionWidget
          title="Top procedure (HCPCS) codes"
          action={loadTopHcpcs}
          topN={10}
          sort="metric"
          caption="Top 10 by claim count."
        />
        <DistributionWidget
          title="Top revenue codes"
          action={loadTopRevenue}
          topN={10}
          sort="metric"
          caption="Top 10 by claim count."
        />
      </div>

      <div className="pt-2">
        <h2 className="text-lg font-semibold tracking-tight">Collections</h2>
        <p className="text-sm text-muted-foreground">
          Monthly collections by facility (latest month). Aggregate, non-PHI; no patient data is
          loaded here.
        </p>
      </div>
      <CollectionsSummaryWidget />
    </section>
  );
}
