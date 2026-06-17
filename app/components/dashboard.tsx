'use client';

/**
 * Default dashboard — non-PHI, aggregate-only. Each widget auto-loads on mount via
 * a dedicated Server Action that calls a vetted query function directly (no LLM)
 * and returns ONLY the non-PHI summary. The dashboard NEVER fetches rows, so no
 * PHI is reachable here. Each widget owns its loading/error state; if one fails it
 * shows a generic message and the rest of the page stays usable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';

import { PayerChart } from '@/components/payer-chart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { count, money, moneyAxis, percent, rate } from '@/lib/format';
import {
  loadClaimsByYear,
  loadCollectionsDaily,
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadCollectionsSummary,
  loadPayerGap,
  loadTopHcpcs,
  loadTopRevenue,
  type CollectionsDailyResult,
  type CollectionsKpis,
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
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
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

/** A proportional bar (0–100). Values are also shown as text; bar reinforces them. */
function MiniBar({ pct }: { pct: number | null }) {
  const w = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-teal50">
      <div
        className="h-full rounded-full bg-teal700"
        style={{ width: `${Math.max(w, w > 0 ? 3 : 0)}%` }}
      />
    </div>
  );
}

/**
 * Payer chart widget — interactive, multi-dimensional payer chart (group/metric/
 * sort/show controls live inside PayerChart). Defaults to Top 10. `defaultTopN` is
 * preserved for callers that want a different default.
 */
export function PayerChartWidget({ defaultTopN = 10 }: { defaultTopN?: number }) {
  const state = useWidget<PayerGapSummary>(loadPayerGap);
  return (
    <WidgetCard title="Payer Chart - Multidimensional" state={state}>
      {state.status === 'ready' && <PayerChart data={state.data} defaultTopN={defaultTopN} />}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Payer Detail Explorer (Phase 8.x) — a filterable, sortable, configurable table
// of the per-payer non-PHI summary. Replaces the static top-15 table + bar chart
// on /dashboard/payers (the chart lives on the Overview page). All filtering and
// sorting is CLIENT-SIDE over the already-loaded cached payer_gap summary — no new
// API calls, no row data, no patient identifiers. Column visibility is session-only
// React state and is never persisted.
// ---------------------------------------------------------------------------

type PayerColKey = 'payer' | 'claims' | 'charged' | 'allowed' | 'paid' | 'avg_rate' | 'gap';

const PAYER_COLUMNS: readonly { key: PayerColKey; label: string; numeric: boolean }[] = [
  { key: 'payer', label: 'Payer', numeric: false },
  { key: 'claims', label: 'Claims', numeric: true },
  { key: 'charged', label: 'Charged', numeric: true },
  { key: 'allowed', label: 'Allowed', numeric: true },
  { key: 'paid', label: 'Paid', numeric: true },
  { key: 'avg_rate', label: 'Avg Rate', numeric: true },
  { key: 'gap', label: 'Collection Gap', numeric: true },
];

interface PayerSort {
  key: PayerColKey;
  direction: 'asc' | 'desc';
}

const PAYER_SORT_PRESETS: readonly { id: string; label: string; sort: PayerSort }[] = [
  { id: 'claims-desc', label: 'Claims (desc)', sort: { key: 'claims', direction: 'desc' } },
  { id: 'charged-desc', label: 'Charged (desc)', sort: { key: 'charged', direction: 'desc' } },
  { id: 'paid-desc', label: 'Paid (desc)', sort: { key: 'paid', direction: 'desc' } },
  { id: 'gap-desc', label: 'Collection gap (desc)', sort: { key: 'gap', direction: 'desc' } },
  { id: 'rate-asc', label: 'Avg rate (asc)', sort: { key: 'avg_rate', direction: 'asc' } },
];

const PAYER_DEFAULT_SORT: PayerSort = { key: 'claims', direction: 'desc' };

/** Show-N options for the explorer (0 = All). */
const PAYER_SHOW_OPTIONS = [10, 25, 50, 0] as const;
const PAYER_DEFAULT_SHOW = 0; // All

type PayerRow = PayerGapSummary['by_payer'][number];

/** The comparable value for a payer row under a given column (number or string). */
function payerSortValue(r: PayerRow, key: PayerColKey): number | string {
  switch (key) {
    case 'payer':
      return (r.payer_name ?? '').toLowerCase();
    case 'claims':
      return r.claim_count;
    case 'charged':
      return r.total_charge;
    case 'allowed':
      return r.total_allowed;
    case 'paid':
      return r.total_paid;
    case 'avg_rate':
      return r.avg_collection_rate ?? -1; // nulls sort below any real 0..1 rate
    case 'gap':
      return r.total_collection_gap;
  }
}

const payerSelectCls =
  'h-9 rounded-md border border-input bg-background px-2 text-sm ring-offset-background ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Render a single payer cell for a column (label/number/gap-with-minibar). */
function PayerCell({ r, col }: { r: PayerRow; col: PayerColKey }) {
  switch (col) {
    case 'payer':
      return r.payer_name ?? <span className="text-muted-foreground">(blank)</span>;
    case 'claims':
      return <span className="tabular-nums">{count(r.claim_count)}</span>;
    case 'charged':
      return <span className="tabular-nums">{money(r.total_charge)}</span>;
    case 'allowed':
      return <span className="tabular-nums">{money(r.total_allowed)}</span>;
    case 'paid':
      return <span className="tabular-nums">{money(r.total_paid)}</span>;
    case 'avg_rate':
      return <span className="tabular-nums">{rate(r.avg_collection_rate)}</span>;
    case 'gap': {
      const pct = r.total_charge > 0 ? (r.total_collection_gap / r.total_charge) * 100 : 0;
      return (
        <div className="flex items-center justify-end gap-2">
          <span className="tabular-nums">{money(r.total_collection_gap)}</span>
          <span className="w-16 shrink-0">
            <MiniBar pct={pct} />
          </span>
        </div>
      );
    }
  }
}

export function PayerDetailExplorer() {
  const state = useWidget<PayerGapSummary>(loadPayerGap);
  return (
    <WidgetCard title="Payer detail explorer" state={state}>
      {state.status === 'ready' && <PayerDetailBody data={state.data} />}
    </WidgetCard>
  );
}

function PayerDetailBody({ data }: { data: PayerGapSummary }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PayerSort>(PAYER_DEFAULT_SORT);
  const [showN, setShowN] = useState<number>(PAYER_DEFAULT_SHOW);
  const [hidden, setHidden] = useState<Set<PayerColKey>>(() => new Set());
  const [showColumnPanel, setShowColumnPanel] = useState(false);

  const visibleColumns = useMemo(
    () => PAYER_COLUMNS.filter((c) => !hidden.has(c.key)),
    [hidden],
  );

  // Filter (search) → sort → limit. Pure client-side over the loaded summary.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? data.by_payer.filter((r) => (r.payer_name ?? '').toLowerCase().includes(q))
      : [...data.by_payer];
    matched.sort((a, b) => {
      const av = payerSortValue(a, sort.key);
      const bv = payerSortValue(b, sort.key);
      let cmp: number;
      if (typeof av === 'string' || typeof bv === 'string') {
        cmp = String(av).localeCompare(String(bv));
      } else {
        cmp = av - bv;
      }
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return matched;
  }, [data.by_payer, search, sort]);

  const shown = showN > 0 ? filtered.slice(0, showN) : filtered;

  const activePresetId =
    PAYER_SORT_PRESETS.find((p) => p.sort.key === sort.key && p.sort.direction === sort.direction)?.id ??
    '';

  function toggleSort(key: PayerColKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'payer' ? 'asc' : 'desc' },
    );
  }

  function toggleColumn(key: PayerColKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function reset() {
    setSearch('');
    setSort(PAYER_DEFAULT_SORT);
    setShowN(PAYER_DEFAULT_SHOW);
    setHidden(new Set());
  }

  return (
    <div className="space-y-4">
      {/* Filter bar — wraps on mobile. All controls are client-side. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search payer…"
          aria-label="Search payer"
          className="h-9 w-full sm:w-56"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort by
          <select
            value={activePresetId}
            onChange={(e) => {
              const preset = PAYER_SORT_PRESETS.find((p) => p.id === e.target.value);
              if (preset) setSort({ ...preset.sort });
            }}
            aria-label="Sort payers by"
            className={payerSelectCls}
          >
            {activePresetId === '' && <option value="">Custom</option>}
            {PAYER_SORT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Show
          <select
            value={showN}
            onChange={(e) => setShowN(Number(e.target.value))}
            aria-label="Number of payers to show"
            className={payerSelectCls}
          >
            {PAYER_SHOW_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'All' : `Top ${n}`}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowColumnPanel((s) => !s)}
          aria-expanded={showColumnPanel}
          className={showColumnPanel ? 'border-teal500 text-teal700' : undefined}
        >
          <Columns3 className="h-4 w-4" />
          Columns
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reset} className="text-ink600">
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
      </div>

      {/* Column show/hide — session-only layout state, never persisted. */}
      {showColumnPanel && (
        <div className="rounded-lg border border-line bg-card p-4 shadow-ths animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
            <Columns3 className="h-4 w-4 text-teal500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-ink600">Columns</span>
            <span className="text-[11px] text-ink400">— show or hide (layout only)</span>
          </div>
          <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {PAYER_COLUMNS.map((c) => {
              const isHidden = hidden.has(c.key);
              return (
                <li key={c.key} className="rounded-md px-2 py-1.5 transition-colors hover:bg-teal50/70">
                  <button
                    type="button"
                    onClick={() => toggleColumn(c.key)}
                    aria-pressed={!isHidden}
                    className="flex min-w-0 items-center gap-2 text-sm"
                  >
                    {isHidden ? (
                      <EyeOff className="h-4 w-4 shrink-0 text-ink400" />
                    ) : (
                      <Eye className="h-4 w-4 shrink-0 text-teal500" />
                    )}
                    <span className={isHidden ? 'text-ink400 line-through' : 'text-ink900'}>
                      {c.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Table aria-label="Payer detail explorer">
        <TableHeader>
          <TableRow>
            {visibleColumns.map((c) => {
              const active = sort.key === c.key;
              return (
                <TableHead
                  key={c.key}
                  className={`${c.numeric ? 'text-right' : ''} ${active ? 'text-teal700' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-teal700 ${
                      c.numeric ? 'flex-row-reverse' : ''
                    }`}
                    aria-label={`Sort by ${c.label}`}
                  >
                    {c.label}
                    {active ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ChevronDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={Math.max(1, visibleColumns.length)}
                className="py-10 text-center text-sm text-muted-foreground"
              >
                No payers match your search.
              </TableCell>
            </TableRow>
          ) : (
            shown.map((r, i) => (
              <TableRow key={`${r.payer_name ?? 'null'}-${i}`}>
                {visibleColumns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={c.numeric ? 'text-right tabular-nums' : undefined}
                  >
                    <PayerCell r={r} col={c.key} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        {count(shown.length)} payers · {count(data.rows_analyzed)} claims analyzed
      </p>
    </div>
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

/**
 * Collections summary — latest month, by facility. Non-PHI: aggregates only
 * collections.daily_collections + facilities (never collections_raw /
 * payment_lines / source_group_code). A null facility renders as "(unassigned)".
 *
 * Exported but no longer rendered on the collections page (it was removed from
 * CollectionsSections in favor of the full-width KPI chart + CollectionsExplorer);
 * kept available in case another surface needs the latest-month summary.
 */
export function CollectionsSummaryWidget() {
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

/** A big-number KPI tile. `detail` renders a second, smaller value line. */
function Kpi({
  label,
  value,
  detail,
  sub,
}: {
  label: string;
  value: string;
  detail?: string;
  sub?: string;
}) {
  return (
    <Card className="border-t-2 border-t-teal500">
      <CardContent className="pb-4 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="ths-num mt-1 whitespace-nowrap text-lg font-semibold leading-tight tabular-nums text-teal700 lg:text-xl">
          {value}
        </div>
        {detail && (
          <div className="ths-num mt-0.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {detail}
          </div>
        )}
        {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Daily collections KPIs (Phase 7.1) — MTD/YTD anchored to the latest loaded
 * payment_date. Cards + per-facility table (MTD/YTD gross with the checks vs EFT
 * split). Non-PHI; reads only daily_collections + facilities. IP/OP + IP Billing
 * Amt are deferred (no IP/OP classification in the in-scope tables).
 */
function CollectionsKpisWidget({ compact = false }: { compact?: boolean }) {
  const state = useWidget<CollectionsKpis>(loadCollectionsKpis);
  return (
    <WidgetCard title="Collections — MTD / YTD by facility" state={state}>
      {state.status === 'ready' && <CollectionsKpisBody data={state.data} compact={compact} />}
    </WidgetCard>
  );
}

/** Top-N options for the collections KPI chart (0 = All), matching PayerChart. */
const KPI_TOP_N_OPTIONS = [5, 10, 0] as const;

interface CollectionsKpiChartRow {
  facility: string;
  blank: boolean;
  mtd_gross: number;
  ytd_remaining: number; // YTD gross minus MTD gross (floored at 0)
  ytd_checks: number;
  ytd_eft: number;
  ytd_gross: number;
}

function CollectionsKpiTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: CollectionsKpiChartRow }[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">MTD Gross</dt>
        <dd className="text-right text-teal700">{money(r.mtd_gross)}</dd>
        <dt className="text-muted-foreground">YTD Checks</dt>
        <dd className="text-right text-ink900">{money(r.ytd_checks)}</dd>
        <dt className="text-muted-foreground">YTD EFT</dt>
        <dd className="text-right text-ink900">{money(r.ytd_eft)}</dd>
        <dt className="text-muted-foreground">YTD Gross</dt>
        <dd className="text-right text-ink900">{money(r.ytd_gross)}</dd>
      </dl>
    </div>
  );
}

function CollectionsKpisBody({ data, compact }: { data: CollectionsKpis; compact?: boolean }) {
  const asOf = data.as_of ?? '—';
  const [topN, setTopN] = useState<number>(0); // 0 = All (default)

  const rows = useMemo<CollectionsKpiChartRow[]>(() => {
    const mapped = data.by_facility.map((r) => ({
      facility: facilityLabel(r),
      blank: r.facility_name === null,
      mtd_gross: r.mtd_gross,
      ytd_remaining: Math.max(0, r.ytd_gross - r.mtd_gross),
      ytd_checks: r.ytd_checks,
      ytd_eft: r.ytd_eft,
      ytd_gross: r.ytd_gross,
    }));
    mapped.sort((a, b) => b.ytd_gross - a.ytd_gross);
    return topN > 0 ? mapped.slice(0, topN) : mapped;
  }, [data.by_facility, topN]);

  const chartHeight = Math.max(180, rows.length * 38 + 24);

  return (
    <div className="space-y-4">
      <div className={`grid grid-cols-2 gap-3 ${compact ? '' : 'sm:grid-cols-4'}`}>
        <Kpi label="MTD Gross" value={money(data.mtd.gross)} sub={`as of ${asOf}`} />
        <Kpi label="YTD Gross" value={money(data.ytd.gross)} sub={`as of ${asOf}`} />
        <Kpi
          label="MTD Checks / EFT"
          value={money(data.mtd.checks)}
          detail={`EFT ${money(data.mtd.eft)}`}
        />
        <Kpi
          label="YTD Checks / EFT"
          value={money(data.ytd.checks)}
          detail={`EFT ${money(data.ytd.eft)}`}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          MTD vs. YTD gross by facility, sorted by YTD gross.
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Show
          <select
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
            aria-label="Number of facilities to show"
            className={dailySelectCls}
          >
            {KPI_TOP_N_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'All' : `Top ${n}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div role="img" aria-label="Collections MTD vs YTD by facility" style={{ width: '100%', height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
            barCategoryGap="28%"
          >
            <CartesianGrid horizontal={false} stroke="#E4E9E6" />
            <XAxis
              type="number"
              tickFormatter={moneyAxis}
              tick={{ fontSize: 11, fill: '#859794' }}
              stroke="#E4E9E6"
            />
            <YAxis
              type="category"
              dataKey="facility"
              width={160}
              tick={{ fontSize: 11, fill: '#4A5C5A' }}
              stroke="#E4E9E6"
              interval={0}
            />
            <Tooltip content={<CollectionsKpiTooltip />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            <Bar dataKey="mtd_gross" stackId="ytd" name="MTD Gross" fill="#135E5A" radius={[2, 0, 0, 2]}>
              {rows.map((r) => (
                <Cell key={`mtd-${r.facility}`} />
              ))}
            </Bar>
            <Bar
              dataKey="ytd_remaining"
              stackId="ytd"
              name="YTD Remaining"
              fill="#E2674F"
              radius={[0, 2, 2, 0]}
            >
              {rows.map((r) => (
                <Cell key={`rem-${r.facility}`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal700" /> MTD Gross
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-coral600" /> YTD Remaining
        </span>
        <span className="ml-auto">Bar length = YTD gross.</span>
      </div>

      <p className="text-xs text-muted-foreground">
        MTD/YTD anchored to the latest loaded day ({asOf}). IP vs OP and IP Billing Amt are deferred
        (no IP/OP classification in the daily collections data).
      </p>
    </div>
  );
}

const DAILY_PAGE_SIZE = 50;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const dailySelectCls =
  'h-8 rounded-md border border-input bg-background px-2 text-xs ring-offset-background ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

interface YearMonth {
  year: number;
  month: number; // 1-12
}

/** Today's local date as 'YYYY-MM-DD' (en-CA renders ISO order). */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Derive the latest {year, month} present in a set of daily rows, else null. */
function latestYearMonth(rows: CollectionsDailyResult['rows']): YearMonth | null {
  let max: string | null = null;
  for (const r of rows) if (max === null || r.payment_date > max) max = r.payment_date;
  if (max === null) return null;
  return { year: Number(max.slice(0, 4)), month: Number(max.slice(5, 7)) };
}

// ---------------------------------------------------------------------------
// Collections Explorer column model — layout-only (order + visibility), held in
// React for the session and never persisted (no localStorage). Mirrors the Claims
// Explorer pattern; here reorder uses the native HTML5 Drag and Drop API (no
// external DnD library).
// ---------------------------------------------------------------------------
type DailyColKey = 'payment_date' | 'facility' | 'checks' | 'eft' | 'gross';
type DailyRow = CollectionsDailyResult['rows'][number];

const DAILY_COLUMNS: Record<DailyColKey, { label: string; numeric: boolean; sortable: boolean }> = {
  payment_date: { label: 'Date', numeric: false, sortable: true },
  facility: { label: 'Facility', numeric: false, sortable: true },
  checks: { label: 'Checks', numeric: true, sortable: false },
  eft: { label: 'EFT', numeric: true, sortable: false },
  gross: { label: 'Gross', numeric: true, sortable: true },
};

const DAILY_COLUMN_DEFAULT_ORDER: readonly DailyColKey[] = [
  'payment_date',
  'facility',
  'checks',
  'eft',
  'gross',
];

interface DailySort {
  column: DailyColKey;
  direction: 'asc' | 'desc';
}

/** Comparable value for a daily row under a column (string for date/facility). */
function dailySortValue(r: DailyRow, key: DailyColKey): string | number {
  switch (key) {
    case 'payment_date':
      return r.payment_date;
    case 'facility':
      return facilityLabel(r).toLowerCase();
    case 'checks':
      return r.checks_amount;
    case 'eft':
      return r.eft_amount;
    case 'gross':
      return r.gross_amount;
  }
}

/** Render a single daily-row cell for a column. */
function DailyCell({ r, col }: { r: DailyRow; col: DailyColKey }) {
  switch (col) {
    case 'payment_date':
      return <span className="tabular-nums">{r.payment_date}</span>;
    case 'facility':
      return r.facility_name === null ? (
        <span className="text-muted-foreground">{facilityLabel(r)}</span>
      ) : (
        <>{facilityLabel(r)}</>
      );
    case 'checks':
      return <span className="tabular-nums">{money(r.checks_amount)}</span>;
    case 'eft':
      return <span className="tabular-nums">{money(r.eft_amount)}</span>;
    case 'gross':
      return <span className="tabular-nums">{money(r.gross_amount)}</span>;
  }
}

/**
 * Collections Explorer (Phase 8.x; was CollectionsDailyWidget) — defaults to the
 * latest month, but the user can browse any month/year (server-fetched, non-PHI,
 * NOT cached) and filter by facility (client-side). Paginated at 50 rows/page. The
 * "hide zero rows" toggle only appears when the shown month extends past today
 * (future all-zero rows); for fully-past months every row is shown.
 *
 * UX upgraded to match the Claims Explorer: a filter panel, a column show/hide
 * panel with native drag-to-reorder, and sortable Date/Facility/Gross headers.
 * Column order + visibility and sort are session-only React state. The
 * data-fetching logic (loadCollectionsDaily / loadCollectionsDailyRange) is
 * unchanged.
 */
function CollectionsExplorer() {
  const [data, setData] = useState<CollectionsDailyResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [selected, setSelected] = useState<YearMonth | null>(null);
  const [latest, setLatest] = useState<YearMonth | null>(null);

  const [facility, setFacility] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [page, setPage] = useState(0);

  // Layout-only view state (session; never persisted) + client-side sort.
  const [sort, setSort] = useState<DailySort | null>(null);
  const [columnOrder, setColumnOrder] = useState<DailyColKey[]>([...DAILY_COLUMN_DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<Set<DailyColKey>>(() => new Set());
  const [showColumnPanel, setShowColumnPanel] = useState(false);
  const [dragCol, setDragCol] = useState<DailyColKey | null>(null);

  // Mount: load the latest month (cached) and seed the selected month from it.
  useEffect(() => {
    let live = true;
    loadCollectionsDaily()
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setStatus('error');
          return;
        }
        const ym = latestYearMonth(r.data.rows) ?? {
          year: Number(todayIso().slice(0, 4)),
          month: Number(todayIso().slice(5, 7)),
        };
        setData(r.data);
        setLatest(ym);
        setSelected(ym);
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, []);

  // Fetch a specific month when the user changes the selection (skips the initial
  // seed, which reused the cached latest-month payload above).
  const pick = useCallback((ym: YearMonth) => {
    setSelected(ym);
    setPage(0);
    setStatus('loading');
    loadCollectionsDailyRange(ym)
      .then((r) => {
        if (r.ok) {
          setData(r.data);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      })
      .catch(() => setStatus('error'));
  }, []);

  const yearOptions = useMemo(() => {
    const base = latest?.year ?? Number(todayIso().slice(0, 4));
    const years = new Set<number>();
    for (let y = base; y > base - 4; y--) years.add(y);
    if (selected) years.add(selected.year);
    return [...years].sort((a, b) => b - a);
  }, [latest, selected]);

  const facilities = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.rows.map((r) => facilityLabel(r)))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Only show the hide-zero control when the month runs past today — otherwise
  // there are no future all-zero rows to hide.
  const showHideZero = useMemo(() => {
    if (!data || data.rows.length === 0) return false;
    const maxDate = data.rows.reduce<string>((m, r) => (r.payment_date > m ? r.payment_date : m), '');
    return maxDate > todayIso();
  }, [data]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (showHideZero && hideZero && r.gross_amount === 0 && r.checks_amount === 0 && r.eft_amount === 0)
        return false;
      if (facility && facilityLabel(r) !== facility) return false;
      return true;
    });
  }, [data, facility, hideZero, showHideZero]);

  // Sort the full filtered set (client-side over the loaded month) before paging,
  // so ordering is stable across pages rather than only within the visible 50.
  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const av = dailySortValue(a, sort.column);
      const bv = dailySortValue(b, sort.column);
      let cmp: number;
      if (typeof av === 'string' || typeof bv === 'string') cmp = String(av).localeCompare(String(bv));
      else cmp = av - bv;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filteredRows, sort]);

  const visibleColumns = columnOrder.filter((c) => !hidden.has(c));

  const pageRows = sortedRows.slice(page * DAILY_PAGE_SIZE, page * DAILY_PAGE_SIZE + DAILY_PAGE_SIZE);
  const hasNext = sortedRows.length > (page + 1) * DAILY_PAGE_SIZE;
  const hasPrev = page > 0;

  function toggleSort(col: DailyColKey) {
    if (!DAILY_COLUMNS[col].sortable) return;
    setPage(0);
    setSort((prev) =>
      prev && prev.column === col
        ? { column: col, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column: col, direction: col === 'gross' ? 'desc' : 'asc' },
    );
  }

  function toggleColumn(col: DailyColKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }

  /** Native HTML5 DnD: drop `dragCol` immediately before `target` in the order. */
  function onColumnDrop(target: DailyColKey) {
    setColumnOrder((order) => {
      if (!dragCol || dragCol === target) return order;
      const next = [...order];
      const from = next.indexOf(dragCol);
      const to = next.indexOf(target);
      if (from < 0 || to < 0) return order;
      next.splice(from, 1);
      next.splice(to, 0, dragCol);
      return next;
    });
    setDragCol(null);
  }

  function reset() {
    setFacility('');
    setHideZero(true);
    setPage(0);
    setSort(null);
    setColumnOrder([...DAILY_COLUMN_DEFAULT_ORDER]);
    setHidden(new Set());
    setShowColumnPanel(false);
    // Restore the month/year to the latest available (re-fetch only if it changed).
    if (latest && (!selected || selected.year !== latest.year || selected.month !== latest.month)) {
      pick(latest);
    }
  }

  return (
    <WidgetCard title="Collections Explorer" state={{ status }}>
      {status === 'ready' && data && (
        <div className="space-y-3">
          {/* Filter panel — month/year/facility + hide-zero, plus layout controls. */}
          <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selected?.month ?? ''}
                onChange={(e) => selected && pick({ ...selected, month: Number(e.target.value) })}
                className={dailySelectCls}
                aria-label="Month"
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={selected?.year ?? ''}
                onChange={(e) => selected && pick({ ...selected, year: Number(e.target.value) })}
                className={dailySelectCls}
                aria-label="Year"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <select
                value={facility}
                onChange={(e) => {
                  setFacility(e.target.value);
                  setPage(0);
                }}
                className={dailySelectCls}
                aria-label="Facility"
              >
                <option value="">All facilities</option>
                {facilities.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              {showHideZero && (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={hideZero}
                    onChange={(e) => {
                      setHideZero(e.target.checked);
                      setPage(0);
                    }}
                    className="rounded border-input accent-teal700"
                  />
                  Hide zero rows
                </label>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowColumnPanel((s) => !s)}
                  aria-expanded={showColumnPanel}
                  className={showColumnPanel ? 'border-teal500 text-teal700' : undefined}
                >
                  <Columns3 className="h-4 w-4" />
                  Columns
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={reset} className="text-ink600">
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </Button>
              </div>
            </div>
          </div>

          {/* Column show/hide + drag-to-reorder — layout-only, session, not persisted. */}
          {showColumnPanel && (
            <div className="rounded-lg border border-line bg-card p-4 shadow-ths animate-in fade-in-0 slide-in-from-top-1 duration-200">
              <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
                <Columns3 className="h-4 w-4 text-teal500" />
                <span className="text-xs font-semibold uppercase tracking-wide text-ink600">Columns</span>
                <span className="text-[11px] text-ink400">— show, hide, and drag to reorder (layout only)</span>
              </div>
              <ul className="space-y-0.5">
                {columnOrder.map((c) => {
                  const meta = DAILY_COLUMNS[c];
                  const isHidden = hidden.has(c);
                  return (
                    <li
                      key={c}
                      draggable
                      onDragStart={() => setDragCol(c)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        onColumnDrop(c);
                      }}
                      onDragEnd={() => setDragCol(null)}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-teal50/70 ${
                        dragCol === c ? 'opacity-50' : ''
                      }`}
                    >
                      <span
                        aria-label={`Drag to reorder ${meta.label}`}
                        className="cursor-grab text-ink400 active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" aria-hidden />
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleColumn(c)}
                        aria-pressed={!isHidden}
                        className="flex min-w-0 items-center gap-2 text-sm"
                      >
                        {isHidden ? (
                          <EyeOff className="h-4 w-4 shrink-0 text-ink400" />
                        ) : (
                          <Eye className="h-4 w-4 shrink-0 text-teal500" />
                        )}
                        <span className={isHidden ? 'text-ink400 line-through' : 'text-ink900'}>
                          {meta.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            {sortedRows.length.toLocaleString('en-US')} rows
          </div>

          {sortedRows.length === 0 || visibleColumns.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {visibleColumns.length === 0
                ? 'All columns are hidden — show at least one from the Columns panel.'
                : `No collections recorded for ${selected ? `${MONTH_NAMES[selected.month - 1]} ${selected.year}` : 'this period'}.`}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    {visibleColumns.map((c) => {
                      const meta = DAILY_COLUMNS[c];
                      const active = sort?.column === c;
                      return (
                        <TableHead
                          key={c}
                          className={`${meta.numeric ? 'text-right' : ''} ${active ? 'text-teal700' : ''}`}
                        >
                          {meta.sortable ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(c)}
                              className={`inline-flex items-center gap-1 transition-colors hover:text-teal700 ${
                                meta.numeric ? 'flex-row-reverse' : ''
                              }`}
                              aria-label={`Sort by ${meta.label}`}
                            >
                              {meta.label}
                              {active ? (
                                sort!.direction === 'asc' ? (
                                  <ArrowUp className="h-3 w-3" />
                                ) : (
                                  <ArrowDown className="h-3 w-3" />
                                )
                              ) : (
                                <ChevronDown className="h-3 w-3 opacity-40" />
                              )}
                            </button>
                          ) : (
                            meta.label
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((r, i) => (
                    <TableRow key={`${r.payment_date}-${r.facility_code ?? 'unassigned'}-${i}`}>
                      {visibleColumns.map((c) => (
                        <TableCell
                          key={c}
                          className={DAILY_COLUMNS[c].numeric ? 'text-right tabular-nums' : undefined}
                        >
                          <DailyCell r={r} col={c} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {(hasPrev || hasNext) && (
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasPrev}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    ← Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page + 1}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasNext}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next →
                  </Button>
                </div>
              )}
            </>
          )}
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
 * Full collections detail: the Collections Explorer (paginated, filterable,
 * configurable) full-width. Aggregate, non-PHI. The MTD/YTD KPI widget is
 * intentionally NOT shown here — it lives on the Overview, and duplicating it on
 * this sub-route was redundant. (CollectionsSummaryWidget remains exported for
 * reuse elsewhere but is not rendered here.)
 */
export function CollectionsSections() {
  return (
    <div className="space-y-4">
      <CollectionsExplorer />
    </div>
  );
}

/**
 * The /dashboard overview: headline collections KPIs, the payer chart (paid vs.
 * collection gap, Top 5 by default), and claim distributions. Full collections
 * detail lives on its own sub-route. Aggregate, non-PHI; no patient data loaded.
 */
export function Dashboard() {
  return (
    <section className="space-y-4">
      <CollectionsKpisWidget />
      <PayerChartWidget defaultTopN={10} />
      <ClaimsDistributions />
    </section>
  );
}
