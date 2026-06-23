'use client';

/**
 * Master BXR Chart — the merged Overview bar chart. Replaces the two former
 * standalone widgets (Collections MTD/YTD by facility + Payers paid vs. collection
 * gap) with one widget driven by two dropdowns:
 *
 *  • View  — "By Facility" (MTD/YTD facility bars) or "By Payer" (paid vs. gap bars).
 *  • Month — "June (MTD)" (the current 2026 month) plus every prior 2026 month
 *            with data (May…January), reverse-chron. 2026 only.
 *
 * The chart rendering itself reuses the exact recharts bodies, tooltips, legends,
 * and color tokens from the originals (FacilityKpiBars / PayerGapBars), so there
 * is no visual regression. Data scoping per selection:
 *
 *  • Facility · MTD  → cached loadCollectionsKpis() (stacked MTD + YTD bars).
 *  • Facility · past → loadCollectionsDailyRange({year,month}) aggregated to a
 *                      single gross bar per facility (tooltip: Gross/Checks/EFT).
 *  • Payer · MTD     → cached loadPayerGap() (all-time, the working default).
 *  • Payer · past    → loadPayerGapRange({from:'2026-MM-01', to:'2026-MM-DD'}).
 *
 * Aggregate, non-PHI: reads only collections (daily_collections + facilities) and
 * the payer_gap summary. No patient data, no rows.
 */
import { useEffect, useMemo, useState } from 'react';
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

import { Download, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect } from '@/components/data-grid';
import { PayerGapBars, payerChartRows } from '@/components/payer-chart';
import { money, moneyAxis } from '@/lib/format';
import {
  loadCollectionsDaily,
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadPayerGap,
  loadPayerGapRange,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type PayerGapSummary,
} from '@/lib/actions';
import { facilityLabel } from '../../../src/collections/summaryTypes';
import { FacilityKpiBars, kpiChartRows } from './collections';
import { useWidget, WidgetCard } from './widgets';

type DailyRow = CollectionsDailyResult['rows'][number];

const YEAR = 2026;
const PAYER_TOP_N = 10; // matches the former PayerChartWidget defaultTopN={10}
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

type View = 'facility' | 'payer';

/** A single-month gross row per facility (past-month facility view). */
interface FacilityGrossRow {
  facility: string;
  blank: boolean;
  gross: number;
  checks: number;
  eft: number;
}

/** Aggregate a month's daily rows into one gross/checks/eft total per facility. */
function aggregateGrossByFacility(rows: CollectionsDailyResult['rows']): FacilityGrossRow[] {
  const byFacility = new Map<string, FacilityGrossRow>();
  for (const r of rows) {
    const key = r.facility_code ?? '__unassigned__';
    const existing = byFacility.get(key);
    if (existing) {
      existing.gross += r.gross_amount;
      existing.checks += r.checks_amount;
      existing.eft += r.eft_amount;
    } else {
      byFacility.set(key, {
        facility: facilityLabel(r),
        blank: r.facility_name === null,
        gross: r.gross_amount,
        checks: r.checks_amount,
        eft: r.eft_amount,
      });
    }
  }
  return [...byFacility.values()].sort((a, b) => b.gross - a.gross);
}

function FacilityGrossTooltip({
  active,
  payload,
  monthLabel = '',
}: {
  active?: boolean;
  payload?: { payload: FacilityGrossRow }[];
  /** Prefix for the row labels (the selected month name, e.g. 'May'). */
  monthLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  const prefix = monthLabel ? `${monthLabel} ` : '';
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">{prefix}Gross</dt>
        <dd className="text-right text-teal700">{money(r.gross)}</dd>
        <dt className="text-muted-foreground">{prefix}Checks</dt>
        <dd className="text-right text-ink900">{money(r.checks)}</dd>
        <dt className="text-muted-foreground">{prefix}EFT</dt>
        <dd className="text-right text-ink900">{money(r.eft)}</dd>
      </dl>
    </div>
  );
}

/**
 * Single gross bar per facility (past-month facility view). Reuses the same axes,
 * color token (#135E5A), and money formatters as the MTD/YTD chart — only the
 * stacked split is dropped, since a past month has no MTD/YTD distinction.
 */
function FacilityGrossBars({
  rows,
  monthLabel,
  onBarClick,
}: {
  rows: FacilityGrossRow[];
  /** Selected month name (e.g. 'May'), used as the tooltip label prefix. */
  monthLabel: string;
  /** Optional: invoked with the facility label when a bar is clicked. */
  onBarClick?: (facility: string) => void;
}) {
  const chartHeight = Math.max(180, rows.length * 38 + 24);
  return (
    <>
      <div
        role="img"
        aria-label="Collections gross by facility"
        style={{ width: '100%', height: chartHeight, cursor: onBarClick ? 'pointer' : undefined }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
            barCategoryGap="28%"
            onClick={(state) => {
              if (onBarClick && state && typeof state.activeLabel === 'string') onBarClick(state.activeLabel);
            }}
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
            <Tooltip content={<FacilityGrossTooltip monthLabel={monthLabel} />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            <Bar dataKey="gross" name="Gross" fill="#135E5A" radius={[2, 2, 2, 2]}>
              {rows.map((r) => (
                <Cell key={`gross-${r.facility}`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal700" /> Gross
        </span>
        <span className="ml-auto">Bar length = month gross.</span>
      </div>
    </>
  );
}

/** Async state for the past-month fetch (skipped entirely for the MTD option). */
type PastState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'facility'; rows: FacilityGrossRow[]; daily: DailyRow[] }
  | { kind: 'payer'; summary: PayerGapSummary };

/** 'YYYY-MM-DD' → 'MM/DD/YYYY' for the drill-down table (matches the source grid). */
function formatMmDdYyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** CSV-escape a field (quote when it contains a comma, quote, or newline). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Trigger a client-side CSV download (no server round-trip). BOM-prefixed so
 * Excel reads it as UTF-8; href is a data: URI built from encodeURIComponent.
 */
function downloadCsv(filename: string, table: string[][]): void {
  const BOM = '\uFEFF'; // UTF-8 byte-order mark so Excel detects UTF-8
  const csv = table.map((cols) => cols.map(csvField).join(',')).join('\r\n');
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(BOM + csv)}`;
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Drill-down: the daily distribution for one facility in the selected month.
 * Renders an inline panel (card) below the chart with a Date/Checks/EFT/Gross
 * table + a bold totals row. `rows` are the already-in-memory daily rows for the
 * month; we filter them to `facilityLabel` client-side (no new fetch). Aggregate,
 * non-PHI (daily_collections only).
 */
function FacilityDailyPanel({
  facility,
  monthLabel,
  rows,
  onClose,
}: {
  facility: string;
  monthLabel: string;
  rows: DailyRow[];
  onClose: () => void;
}) {
  const facilityRows = useMemo(
    () =>
      rows
        .filter((r) => facilityLabel(r) === facility)
        .filter((r) => r.gross_amount !== 0 || r.checks_amount !== 0 || r.eft_amount !== 0)
        .sort((a, b) => a.payment_date.localeCompare(b.payment_date)),
    [rows, facility],
  );

  const totals = useMemo(
    () =>
      facilityRows.reduce(
        (acc, r) => ({
          checks: acc.checks + r.checks_amount,
          eft: acc.eft + r.eft_amount,
          gross: acc.gross + r.gross_amount,
        }),
        { checks: 0, eft: 0, gross: 0 },
      ),
    [facilityRows],
  );

  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink900">
          {facility} — {monthLabel}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close daily distribution"
          className="text-ink600"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {facilityRows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No data for this facility in {monthLabel}.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Checks</TableHead>
              <TableHead className="text-right">EFT</TableHead>
              <TableHead className="text-right">Gross</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {facilityRows.map((r) => (
              <TableRow key={r.payment_date}>
                <TableCell className="tabular-nums">{formatMmDdYyyy(r.payment_date)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.checks_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.eft_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.gross_amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>TOTALS</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.checks)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.eft)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.gross)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ChartLoading() {
  return <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>;
}

function ChartError() {
  return (
    <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
      That selection could not be loaded.
    </div>
  );
}

function ChartEmpty({ label }: { label: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{label}</div>;
}

export function OverviewBarChart() {
  // MTD data is the already-cached aggregate read for whichever view is active.
  const kpisState = useWidget<CollectionsKpis>(loadCollectionsKpis);
  const payerState = useWidget<PayerGapSummary>(loadPayerGap);
  // Latest-month daily rows (cached) — backs the MTD facility drill-down panel.
  const dailyMtdState = useWidget<CollectionsDailyResult>(loadCollectionsDaily);

  // Month options: current 2026 month (MTD) + every prior 2026 month, reverse-chron.
  const { currentMonth, monthOptions } = useMemo(() => {
    const now = new Date();
    const cm = now.getFullYear() === YEAR ? now.getMonth() + 1 : 12;
    return { currentMonth: cm, monthOptions: Array.from({ length: cm }, (_, i) => cm - i) };
  }, []);

  const [view, setView] = useState<View>('facility');
  const [month, setMonth] = useState<number>(currentMonth);
  const isMtd = month === currentMonth;

  // Drill-down: the facility whose daily distribution panel is open (null = none).
  const [selectedFacility, setSelectedFacility] = useState<string | null>(null);

  // Past-month scoping: facility → daily range (aggregated), payer → gap range.
  // MTD reads the cached aggregates above, so no fetch is issued for it.
  const [past, setPast] = useState<PastState>({ kind: 'idle' });
  useEffect(() => {
    if (isMtd) {
      setPast({ kind: 'idle' });
      return;
    }
    let live = true;
    setPast({ kind: 'loading' });
    if (view === 'facility') {
      loadCollectionsDailyRange({ year: YEAR, month })
        .then((r) => {
          if (!live) return;
          setPast(
            r.ok
              ? { kind: 'facility', rows: aggregateGrossByFacility(r.data.rows), daily: r.data.rows }
              : { kind: 'error' },
          );
        })
        .catch(() => {
          if (live) setPast({ kind: 'error' });
        });
    } else {
      const from = `${YEAR}-${pad2(month)}-01`;
      const to = `${YEAR}-${pad2(month)}-${pad2(lastDayOfMonth(YEAR, month))}`;
      loadPayerGapRange({ from, to })
        .then((r) => {
          if (!live) return;
          setPast(r.ok ? { kind: 'payer', summary: r.data } : { kind: 'error' });
        })
        .catch(() => {
          if (live) setPast({ kind: 'error' });
        });
    }
    return () => {
      live = false;
    };
  }, [view, month, isMtd]);

  const monthName = MONTH_NAMES[month - 1]!;
  const monthLabel = `${monthName} ${YEAR}`;
  const description =
    view === 'facility'
      ? isMtd
        ? 'MTD vs. YTD gross by facility, sorted by YTD gross.'
        : `${monthLabel} gross by facility, sorted by gross.`
      : isMtd
        ? `Top ${PAYER_TOP_N} payers by total charged — paid vs. collection gap.`
        : `Top ${PAYER_TOP_N} payers by total charged (${monthLabel}) — paid vs. collection gap.`;

  // Daily rows for the selected month (drill-down): cached latest-month rows for
  // MTD, the already-fetched range rows for a past month. No new fetch is issued.
  const monthDailyRows: DailyRow[] = isMtd
    ? dailyMtdState.status === 'ready'
      ? dailyMtdState.data.rows
      : []
    : past.kind === 'facility'
      ? past.daily
      : [];
  const dailyReady = isMtd ? dailyMtdState.status === 'ready' : past.kind === 'facility';

  // Export CSV is facility-only; enabled once the displayed data is ready.
  const canExport =
    view === 'facility' && (isMtd ? kpisState.status === 'ready' : past.kind === 'facility');

  function handleExport() {
    const fileMonth = isMtd ? `mtd-${monthName.toLowerCase()}` : monthName.toLowerCase();
    const filename = `collections-by-facility-${fileMonth}-${YEAR}.csv`;
    let table: string[][];
    if (isMtd) {
      if (kpisState.status !== 'ready') return;
      const facilities = [...kpisState.data.by_facility].sort((a, b) => b.ytd_gross - a.ytd_gross);
      table = [
        ['Facility', 'Checks', 'EFT', 'Gross', 'YTD Gross'],
        ...facilities.map((r) => [
          facilityLabel(r),
          r.mtd_checks.toFixed(2),
          r.mtd_eft.toFixed(2),
          r.mtd_gross.toFixed(2),
          r.ytd_gross.toFixed(2),
        ]),
      ];
    } else {
      if (past.kind !== 'facility') return;
      table = [
        ['Facility', 'Checks', 'EFT', 'Gross'],
        ...past.rows.map((r) => [r.facility, r.checks.toFixed(2), r.eft.toFixed(2), r.gross.toFixed(2)]),
      ];
    }
    downloadCsv(filename, table);
  }

  function chartArea() {
    if (view === 'facility') {
      if (isMtd) {
        if (kpisState.status === 'loading') return <ChartLoading />;
        if (kpisState.status === 'error') return <ChartError />;
        const rows = kpiChartRows(kpisState.data);
        if (rows.length === 0) return <ChartEmpty label="No collections to show." />;
        return <FacilityKpiBars rows={rows} monthLabel="MTD" onBarClick={setSelectedFacility} />;
      }
      if (past.kind === 'facility') {
        if (past.rows.length === 0) return <ChartEmpty label={`No collections recorded for ${monthLabel}.`} />;
        return <FacilityGrossBars rows={past.rows} monthLabel={monthName} onBarClick={setSelectedFacility} />;
      }
      if (past.kind === 'error') return <ChartError />;
      return <ChartLoading />;
    }

    // By Payer
    if (isMtd) {
      if (payerState.status === 'loading') return <ChartLoading />;
      if (payerState.status === 'error') return <ChartError />;
      const rows = payerChartRows(payerState.data, PAYER_TOP_N);
      if (rows.length === 0) return <ChartEmpty label="No payer activity to show." />;
      return <PayerGapBars rows={rows} />;
    }
    if (past.kind === 'payer') {
      const rows = payerChartRows(past.summary, PAYER_TOP_N);
      if (rows.length === 0) return <ChartEmpty label={`No payer activity in ${monthLabel}.`} />;
      return <PayerGapBars rows={rows} />;
    }
    if (past.kind === 'error') return <ChartError />;
    return <ChartLoading />;
  }

  return (
    <WidgetCard title="Master BXR Chart" state={{ status: 'ready' }}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <ControlSelect
            label="View"
            value={view}
            ariaLabel="Chart view"
            onChange={(v) => setView(v as View)}
          >
            <option value="facility">By Facility</option>
            <option value="payer">By Payer</option>
          </ControlSelect>
          <ControlSelect
            label="Month"
            value={month}
            ariaLabel="Month (2026)"
            onChange={(v) => setMonth(Number(v))}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {m === currentMonth ? `${MONTH_NAMES[m - 1]} (MTD)` : MONTH_NAMES[m - 1]}
              </option>
            ))}
          </ControlSelect>
          {view === 'facility' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={!canExport}
              className="ml-auto"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          )}
        </div>

        <div className="text-sm text-muted-foreground">{description}</div>

        {chartArea()}

        {view === 'facility' && selectedFacility && (
          dailyReady ? (
            <FacilityDailyPanel
              facility={selectedFacility}
              monthLabel={monthLabel}
              rows={monthDailyRows}
              onClose={() => setSelectedFacility(null)}
            />
          ) : (
            <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
              <div className="py-6 text-center text-sm text-muted-foreground">
                Loading daily distribution…
              </div>
            </div>
          )
        )}
      </div>
    </WidgetCard>
  );
}
