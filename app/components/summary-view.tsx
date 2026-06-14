/**
 * Renders the non-PHI `summary_stats` returned by /api/agent. The five query
 * functions return five different summary shapes, discriminated by `tool_name`
 * (the union itself carries no discriminant field — see src/queries/types.ts), so
 * this switches on tool_name and renders the matching view. Nothing here is PHI:
 * the agent path is PHI-free by construction.
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { count, money, percent, plain, rate } from '@/lib/format';
import type {
  ClientHistorySummary,
  DistributionSummary,
  FunctionName,
  PayerGapSummary,
  ReadmissionSummary,
  SearchClaimsSummary,
  SummaryStats,
} from '../../src/queries/types';

/** A labelled metric tile for the flat-aggregate summaries. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-l-2 border-l-teal500 bg-teal50/50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="ths-num mt-1 text-lg font-semibold tabular-nums text-teal700">{value}</div>
    </div>
  );
}

function DistributionView({ s }: { s: DistributionSummary }) {
  const metricLabel = s.metric === 'count' ? 'Count' : s.metric.replace(/_/g, ' ');
  const fmt = (v: unknown) =>
    s.metric === 'count' ? count(v) : s.metric === 'avg_collection_rate' ? rate(v) : money(v);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{s.field.replace(/_/g, ' ')}</TableHead>
          <TableHead className="text-right capitalize">{metricLabel}</TableHead>
          <TableHead className="text-right">% of total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {s.buckets.map((b, i) => (
          <TableRow key={`${b.value ?? 'null'}-${i}`}>
            <TableCell>{b.value ?? <span className="text-muted-foreground">(blank)</span>}</TableCell>
            <TableCell className="text-right tabular-nums">{fmt(b.metric_value)}</TableCell>
            <TableCell className="text-right tabular-nums">{percent(b.pct_of_total)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PayerGapView({ s }: { s: PayerGapSummary }) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">{count(s.rows_analyzed)} claims analyzed</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Payer</TableHead>
            <TableHead className="text-right">Claims</TableHead>
            <TableHead className="text-right">Charged</TableHead>
            <TableHead className="text-right">Allowed</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Avg rate</TableHead>
            <TableHead className="text-right">Write-down</TableHead>
            <TableHead className="text-right">Collection gap</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.by_payer.map((r, i) => (
            <TableRow key={`${r.payer_name ?? 'null'}-${i}`}>
              <TableCell>{r.payer_name ?? <span className="text-muted-foreground">(blank)</span>}</TableCell>
              <TableCell className="text-right tabular-nums">{count(r.claim_count)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.total_charge)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.total_allowed)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.total_paid)}</TableCell>
              <TableCell className="text-right tabular-nums">{rate(r.avg_collection_rate)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.total_write_down)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.total_collection_gap)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SearchClaimsView({ s }: { s: SearchClaimsSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="Rows matched" value={count(s.rows_matched)} />
      <Stat label="Total charged" value={money(s.total_charge)} />
      <Stat label="Total allowed" value={money(s.total_allowed)} />
      <Stat label="Total paid" value={money(s.total_paid)} />
      <Stat label="Avg collection rate" value={rate(s.avg_collection_rate)} />
      <Stat label="Rate anomalies" value={count(s.rate_anomaly_count)} />
      <Stat label="Date from" value={plain(s.date_from)} />
      <Stat label="Date to" value={plain(s.date_to)} />
      <Stat label="Facilities" value={count(s.distinct_facilities)} />
      <Stat label="Payers" value={count(s.distinct_payers)} />
    </div>
  );
}

function ClientHistoryView({ s }: { s: ClientHistorySummary }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        <span>{count(s.rows_matched)} claims matched</span>
        <span>match threshold {s.match_threshold}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Year</TableHead>
            <TableHead className="text-right">Claims</TableHead>
            <TableHead className="text-right">Facilities</TableHead>
            <TableHead className="text-right">Payers</TableHead>
            <TableHead className="text-right">Charged</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Avg rate</TableHead>
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.by_source_year.map((y) => (
            <TableRow key={y.source_year}>
              <TableCell className="font-medium">{y.source_year}</TableCell>
              <TableCell className="text-right tabular-nums">{count(y.claim_count)}</TableCell>
              <TableCell className="text-right tabular-nums">{count(y.distinct_facilities)}</TableCell>
              <TableCell className="text-right tabular-nums">{count(y.distinct_payers)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(y.total_charge)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(y.total_paid)}</TableCell>
              <TableCell className="text-right tabular-nums">{rate(y.avg_collection_rate)}</TableCell>
              <TableCell>{plain(y.date_from)}</TableCell>
              <TableCell>{plain(y.date_to)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReadmissionView({ s }: { s: ReadmissionSummary }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Candidate pairs" value={count(s.candidate_pairs)} />
        <Stat label="Exact" value={count(s.by_confidence.exact)} />
        <Stat label="Strong" value={count(s.by_confidence.strong)} />
        <Stat label="Possible" value={count(s.by_confidence.possible)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Facilities</div>
          <div className="flex flex-wrap gap-1">
            {s.facilities.length === 0 ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              s.facilities.map((f) => (
                <Badge key={f} variant="secondary">
                  {f}
                </Badge>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Payers</div>
          <div className="flex flex-wrap gap-1">
            {s.payers.length === 0 ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              s.payers.map((p) => (
                <Badge key={p} variant="secondary">
                  {p}
                </Badge>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const TOOL_TITLES: Record<FunctionName, string> = {
  distribution: 'Distribution',
  payer_gap_analysis: 'Payer gap analysis',
  search_claims: 'Claim search',
  client_history: 'Client history',
  readmission_candidates: 'Readmission candidates',
};

export function SummaryView({
  toolName,
  summary,
}: {
  toolName: FunctionName;
  summary: SummaryStats;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{TOOL_TITLES[toolName]}</CardTitle>
        <Badge variant="outline" className="font-mono text-xs">
          {toolName}
        </Badge>
      </CardHeader>
      <CardContent>
        {toolName === 'distribution' && <DistributionView s={summary as DistributionSummary} />}
        {toolName === 'payer_gap_analysis' && <PayerGapView s={summary as PayerGapSummary} />}
        {toolName === 'search_claims' && <SearchClaimsView s={summary as SearchClaimsSummary} />}
        {toolName === 'client_history' && <ClientHistoryView s={summary as ClientHistorySummary} />}
        {toolName === 'readmission_candidates' && (
          <ReadmissionView s={summary as ReadmissionSummary} />
        )}
      </CardContent>
    </Card>
  );
}
