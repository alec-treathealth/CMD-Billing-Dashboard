'use client';

/**
 * Dashboard — overview composition: the claim-distribution widgets and the
 * /dashboard landing section. Split out of the former dashboard.tsx.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { count, percent } from '@/lib/format';
import {
  loadClaimsByYear,
  loadTopHcpcs,
  loadTopRevenue,
  type DashboardResult,
  type DistributionSummary,
} from '@/lib/actions';
import { MiniBar, useWidget, WidgetCard } from './widgets';
import { CollectionsKpisWidget } from './collections';
import { OverviewBarChart } from './overview-bar-chart';

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
                <TableHead className="w-[42%]">Share</TableHead>
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
/** The three claim-distribution widgets (by year, top HCPCS, top revenue). */
export function ClaimsDistributions() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <DistributionWidget title="Claims by year" action={loadClaimsByYear} topN={10} sort="value" />
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
  );
}
/**
 * The /dashboard overview: headline collections KPIs, the merged Master BXR Chart
 * (one bar chart with View + Month dropdowns — facility MTD/YTD or payer paid vs.
 * collection gap), and claim distributions. Full collections detail lives on its
 * own sub-route. Aggregate, non-PHI; no patient data loaded.
 */
export function Dashboard() {
  return (
    <section className="space-y-4">
      <CollectionsKpisWidget kpiOnly />
      <OverviewBarChart />
      <ClaimsDistributions />
    </section>
  );
}
