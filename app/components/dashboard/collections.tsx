'use client';

/**
 * Dashboard — collections surfaces: the latest-month summary (parked, exported
 * for reuse), the MTD/YTD KPI widget + chart, and the Collections Explorer
 * (filterable / sortable / configurable daily table). Split out of the former
 * dashboard.tsx; data-fetching is unchanged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect, Pager, useColumnDnD, type ColumnDnD } from '@/components/data-grid';
import { count, money, moneyAxis, percent } from '@/lib/format';
import {
  loadCollectionsDaily,
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadCollectionsSummary,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type CollectionsMonthlySummary,
} from '@/lib/actions';
import { facilityLabel } from '../../../src/collections/summaryTypes';
import { Kpi, MiniBar, useWidget, WidgetCard } from './widgets';

/**
 * Shared segment colors for the facility bar charts (MTD stacked + past-month
 * stacked). Kept in one place so the bars and their legends never drift apart.
 * Gross = teal (the project primary), EFT = blue, Checks = purple, and the MTD
 * chart's YTD-remaining tail = amber.
 */
export const CHART_COLORS = {
  gross: '#135E5A',
  eft: '#2563EB',
  checks: '#7C3AED',
  ytdRemaining: '#F59E0B',
} as const;

/** A single legend entry: a color swatch (exact hex, matching its bar) + label. */
export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/**
 * Collections summary — latest month, by facility. Non-PHI: aggregates only
 * collections.daily_collections + facilities (never collections_raw /
 * payment_lines / source_group_code). A null facility renders as "(unassigned)".
 *
 * Exported but not rendered on the collections page (superseded by the unified
 * CollectionsView); kept available in case another surface needs the latest-month summary.
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

/**
 * Daily collections KPIs (Phase 7.1) — MTD/YTD anchored to the latest loaded
 * payment_date. Cards + per-facility table (MTD/YTD gross with the checks vs EFT
 * split). Non-PHI; reads only daily_collections + facilities. IP/OP + IP Billing
 * Amt are deferred (no IP/OP classification in the in-scope tables).
 */
export function CollectionsKpisWidget({
  compact = false,
  kpiOnly = false,
}: {
  compact?: boolean;
  /** KPI-only mode: render the four KPI cards and hide the by-facility chart. */
  kpiOnly?: boolean;
}) {
  const state = useWidget<CollectionsKpis>(loadCollectionsKpis);
  return (
    <WidgetCard
      title={kpiOnly ? 'Collections — MTD / YTD' : 'Collections — MTD / YTD by facility'}
      state={state}
    >
      {state.status === 'ready' && (
        <CollectionsKpisBody data={state.data} compact={compact} kpiOnly={kpiOnly} />
      )}
    </WidgetCard>
  );
}

/** Top-N options for the collections KPI chart (0 = All), matching PayerChart. */
const KPI_TOP_N_OPTIONS = [5, 10, 0] as const;

export interface CollectionsKpiChartRow {
  facility: string;
  /** Real facility code (drill-down key + IP/OP dimension join), or null if unassigned. */
  facility_code: string | null;
  blank: boolean;
  mtd_gross: number;
  mtd_checks: number;
  mtd_eft: number;
  ytd_remaining: number; // YTD gross minus MTD gross (floored at 0)
  ytd_checks: number;
  ytd_eft: number;
  ytd_gross: number;
}

/** Map collections KPIs to facility chart rows, sorted by YTD gross (desc). */
export function kpiChartRows(data: CollectionsKpis): CollectionsKpiChartRow[] {
  const mapped = data.by_facility.map((r) => ({
    facility: facilityLabel(r),
    facility_code: r.facility_code,
    blank: r.facility_name === null,
    mtd_gross: r.mtd_gross,
    mtd_checks: r.mtd_checks,
    mtd_eft: r.mtd_eft,
    ytd_remaining: Math.max(0, r.ytd_gross - r.mtd_gross),
    ytd_checks: r.ytd_checks,
    ytd_eft: r.ytd_eft,
    ytd_gross: r.ytd_gross,
  }));
  mapped.sort((a, b) => b.ytd_gross - a.ytd_gross);
  return mapped;
}

export function CollectionsKpiTooltip({
  active,
  payload,
  monthLabel = 'MTD',
}: {
  active?: boolean;
  payload?: { payload: CollectionsKpiChartRow }[];
  /** Prefix for the gross row label (e.g. 'MTD'). */
  monthLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  // gross = checks + eft (verified: 0 mismatches across all daily rows), so the
  // bar splits MTD gross into Checks + EFT — no separate "MTD Gross" row here, as
  // it would double-count. YTD Gross is the cumulative total (the bar's length).
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">{monthLabel} Checks</dt>
        <dd className="text-right text-ink900">{money(r.mtd_checks)}</dd>
        <dt className="text-muted-foreground">{monthLabel} EFT</dt>
        <dd className="text-right text-ink900">{money(r.mtd_eft)}</dd>
        <dt className="text-muted-foreground">YTD Gross</dt>
        <dd className="text-right text-[var(--brand-ink)]">{money(r.ytd_gross)}</dd>
      </dl>
    </div>
  );
}

/**
 * Presentational facility KPI bar chart. MTD gross is split into its two payment
 * types — Checks + EFT (verified identity: gross = checks + eft) — then topped
 * with YTD Remaining (= YTD gross − MTD gross), so the three non-overlapping
 * segments sum to exactly YTD gross (the bar length). Pure over its `rows`; shared
 * by CollectionsKpisBody and the merged "Master BXR Chart" so both render alike.
 */
export function FacilityKpiBars({
  rows,
  monthLabel = 'MTD',
  onBarClick,
}: {
  rows: CollectionsKpiChartRow[];
  /** Prefix for the tooltip gross row label (e.g. 'MTD'). */
  monthLabel?: string;
  /** Optional: invoked with the clicked bar's facility_code (drill-down key). */
  onBarClick?: (facilityCode: string) => void;
}) {
  return (
    <>
      {/* Vertical bars (facility on X, money on Y), spread to the full container width. */}
      <div
        role="img"
        aria-label="Collections MTD vs YTD by facility"
        style={{ width: '100%', height: 380, cursor: onBarClick ? 'pointer' : undefined }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 64, left: 8 }}
            barCategoryGap="18%"
            onClick={(state) => {
              const code = (state?.activePayload?.[0]?.payload as CollectionsKpiChartRow | undefined)?.facility_code;
              if (onBarClick && typeof code === 'string') onBarClick(code);
            }}
          >
            <CartesianGrid vertical={false} stroke="#E4E9E6" />
            <XAxis
              type="category"
              dataKey="facility"
              interval={0}
              angle={-35}
              textAnchor="end"
              height={64}
              tick={{ fontSize: 10, fill: '#4A5C5A' }}
              stroke="#E4E9E6"
            />
            <YAxis
              type="number"
              tickFormatter={moneyAxis}
              width={64}
              tick={{ fontSize: 11, fill: '#859794' }}
              stroke="#E4E9E6"
            />
            <Tooltip content={<CollectionsKpiTooltip monthLabel={monthLabel} />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            {/* Stacked bottom→top: Checks → EFT → YTD Remaining.
                Checks + EFT = MTD gross; + YTD Remaining = YTD gross (the bar height). */}
            <Bar dataKey="mtd_checks" stackId="gross" name={`${monthLabel} Checks`} fill={CHART_COLORS.checks} radius={[0, 0, 0, 0]} />
            <Bar dataKey="mtd_eft" stackId="gross" name={`${monthLabel} EFT`} fill={CHART_COLORS.eft} radius={[0, 0, 0, 0]} />
            <Bar dataKey="ytd_remaining" stackId="gross" name="YTD Remaining" fill={CHART_COLORS.ytdRemaining} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <LegendSwatch color={CHART_COLORS.checks} label={`${monthLabel} Checks`} />
        <LegendSwatch color={CHART_COLORS.eft} label={`${monthLabel} EFT`} />
        <LegendSwatch color={CHART_COLORS.ytdRemaining} label="YTD Remaining" />
        <span className="ml-auto">Bar height = YTD gross.</span>
      </div>
    </>
  );
}

function CollectionsKpisBody({
  data,
  compact,
  kpiOnly = false,
}: {
  data: CollectionsKpis;
  compact?: boolean;
  kpiOnly?: boolean;
}) {
  const asOf = data.as_of ?? '—';
  const [topN, setTopN] = useState<number>(0); // 0 = All (default)

  const allRows = useMemo<CollectionsKpiChartRow[]>(() => kpiChartRows(data), [data]);
  const rows = useMemo<CollectionsKpiChartRow[]>(
    () => (topN > 0 ? allRows.slice(0, topN) : allRows),
    [allRows, topN],
  );

  const kpiCards = (
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
  );

  // KPI-only mode (Overview): the four cards sit above the merged Master BXR
  // Chart, which renders the by-facility bars, so the chart is omitted here.
  if (kpiOnly) {
    return <div className="space-y-4">{kpiCards}</div>;
  }

  return (
    <div className="space-y-4">
      {kpiCards}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          MTD vs. YTD gross by facility, sorted by YTD gross.
        </div>
        <ControlSelect
          label="Show"
          value={topN}
          ariaLabel="Number of facilities to show"
          onChange={(v) => setTopN(Number(v))}
        >
          {KPI_TOP_N_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'All' : `Top ${n}`}
            </option>
          ))}
        </ControlSelect>
      </div>

      <FacilityKpiBars rows={rows} />

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
 * A daily-table header cell: draggable to reorder (drag the cell), with an inline sort
 * toggle for sortable columns and a grip affordance. Replaces the separate Columns panel —
 * columns are reordered by hand directly on the header. Keyboard reorder (ArrowLeft/Right)
 * lives on the grip for accessibility.
 */
function DailyHeader({
  col,
  sort,
  onToggleSort,
  onMove,
  dnd,
}: {
  col: DailyColKey;
  sort: DailySort | null;
  onToggleSort: (col: DailyColKey) => void;
  onMove: (col: DailyColKey, dir: 'up' | 'down') => void;
  dnd: ColumnDnD;
}) {
  const meta = DAILY_COLUMNS[col];
  const active = sort?.column === col;
  const dir = sort?.direction ?? 'asc';
  const dragging = dnd.draggingKey === col;
  const isTarget = dnd.dropTargetKey === col && dnd.draggingKey !== col;
  return (
    <TableHead
      {...dnd.itemProps(col)}
      aria-grabbed={dragging}
      title="Drag to reorder"
      className={[
        'cursor-grab select-none border-l-2 active:cursor-grabbing',
        meta.numeric ? 'text-right' : '',
        active ? 'text-[var(--brand-ink)]' : '',
        isTarget ? 'border-l-[var(--brand-accent)]' : 'border-l-transparent',
        dragging ? 'opacity-50' : '',
      ].join(' ')}
    >
      <span className={`inline-flex items-center gap-1 ${meta.numeric ? 'flex-row-reverse' : ''}`}>
        <button
          type="button"
          aria-label={`Reorder ${meta.label}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onMove(col, 'up');
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              onMove(col, 'down');
            }
          }}
          className="shrink-0 cursor-grab text-ink400 active:cursor-grabbing"
        >
          <GripVertical className="h-3 w-3" aria-hidden />
        </button>
        {meta.sortable ? (
          <button
            type="button"
            onClick={() => onToggleSort(col)}
            className="inline-flex items-center gap-1 transition-colors hover:text-[var(--brand-ink)]"
            aria-label={`Sort by ${meta.label}`}
          >
            {meta.label}
            {active ? (
              dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3 opacity-40" />
            )}
          </button>
        ) : (
          meta.label
        )}
      </span>
    </TableHead>
  );
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
export function CollectionsExplorer() {
  const [data, setData] = useState<CollectionsDailyResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [selected, setSelected] = useState<YearMonth | null>(null);
  const [latest, setLatest] = useState<YearMonth | null>(null);

  const [facility, setFacility] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [page, setPage] = useState(0);

  // Layout-only view state (session; never persisted): column order (drag-reorder) + sort.
  const [sort, setSort] = useState<DailySort | null>(null);
  const [columnOrder, setColumnOrder] = useState<DailyColKey[]>([...DAILY_COLUMN_DEFAULT_ORDER]);
  const dnd = useColumnDnD(columnOrder, (next) => setColumnOrder(next as DailyColKey[]));

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

  /** Keyboard-fallback reorder (ArrowLeft/ArrowRight on the header grip → prev/next). */
  function moveColumn(key: DailyColKey, dir: 'up' | 'down') {
    setColumnOrder((order) => {
      const next = [...order];
      const i = next.indexOf(key);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= next.length) return order;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function reset() {
    setFacility('');
    setHideZero(true);
    setPage(0);
    setSort(null);
    setColumnOrder([...DAILY_COLUMN_DEFAULT_ORDER]);
    // Restore the month/year to the latest available (re-fetch only if it changed).
    if (latest && (!selected || selected.year !== latest.year || selected.month !== latest.month)) {
      pick(latest);
    }
  }

  if (status === 'loading' && !data) {
    return <p className="text-sm text-muted-foreground">Loading collections…</p>;
  }
  if (status === 'error' && !data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        The collections could not be loaded. Reload and try again.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter panel — month/year/facility + hide-zero (+ Reset). Reorder columns by
          dragging the table headers directly (no separate Columns panel). */}
      <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
        <div className="flex flex-wrap items-center gap-2">
          <ControlSelect
            label="Month"
            value={selected?.month ?? ''}
            ariaLabel="Month"
            onChange={(v) => selected && pick({ ...selected, month: Number(v) })}
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </ControlSelect>
          <ControlSelect
            label="Year"
            value={selected?.year ?? ''}
            ariaLabel="Year"
            onChange={(v) => selected && pick({ ...selected, year: Number(v) })}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </ControlSelect>
          <ControlSelect
            label="Facility"
            value={facility}
            ariaLabel="Facility"
            onChange={(v) => {
              setFacility(v);
              setPage(0);
            }}
          >
            <option value="">All facilities</option>
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </ControlSelect>
          {showHideZero && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideZero}
                onChange={(e) => {
                  setHideZero(e.target.checked);
                  setPage(0);
                }}
                className="rounded border-input accent-[var(--brand-ink)]"
              />
              Hide zero rows
            </label>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={reset} className="ml-auto text-ink600">
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      {status === 'error' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          That selection could not be loaded.
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        {sortedRows.length.toLocaleString('en-US')} rows
      </div>

      {sortedRows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No collections recorded for{' '}
          {selected ? `${MONTH_NAMES[selected.month - 1]} ${selected.year}` : 'this period'}.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {columnOrder.map((c) => (
                    <DailyHeader
                      key={c}
                      col={c}
                      sort={sort}
                      onToggleSort={toggleSort}
                      onMove={moveColumn}
                      dnd={dnd}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r, i) => (
                  <TableRow key={`${r.payment_date}-${r.facility_code ?? 'unassigned'}-${i}`}>
                    {columnOrder.map((c) => (
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
          </div>

          {(hasPrev || hasNext) && (
            <Pager
              page={page + 1}
              hasPrev={hasPrev}
              hasNext={hasNext}
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
