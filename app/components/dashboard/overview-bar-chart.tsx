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

import { ControlSelect } from '@/components/data-grid';
import { PayerGapBars, payerChartRows } from '@/components/payer-chart';
import { money, moneyAxis } from '@/lib/format';
import {
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
}: {
  active?: boolean;
  payload?: { payload: FacilityGrossRow }[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Gross</dt>
        <dd className="text-right text-teal700">{money(r.gross)}</dd>
        <dt className="text-muted-foreground">Checks</dt>
        <dd className="text-right text-ink900">{money(r.checks)}</dd>
        <dt className="text-muted-foreground">EFT</dt>
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
function FacilityGrossBars({ rows }: { rows: FacilityGrossRow[] }) {
  const chartHeight = Math.max(180, rows.length * 38 + 24);
  return (
    <>
      <div role="img" aria-label="Collections gross by facility" style={{ width: '100%', height: chartHeight }}>
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
            <Tooltip content={<FacilityGrossTooltip />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
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
  | { kind: 'facility'; rows: FacilityGrossRow[] }
  | { kind: 'payer'; summary: PayerGapSummary };

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

  // Month options: current 2026 month (MTD) + every prior 2026 month, reverse-chron.
  const { currentMonth, monthOptions } = useMemo(() => {
    const now = new Date();
    const cm = now.getFullYear() === YEAR ? now.getMonth() + 1 : 12;
    return { currentMonth: cm, monthOptions: Array.from({ length: cm }, (_, i) => cm - i) };
  }, []);

  const [view, setView] = useState<View>('facility');
  const [month, setMonth] = useState<number>(currentMonth);
  const isMtd = month === currentMonth;

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
          setPast(r.ok ? { kind: 'facility', rows: aggregateGrossByFacility(r.data.rows) } : { kind: 'error' });
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

  const monthLabel = `${MONTH_NAMES[month - 1]} ${YEAR}`;
  const description =
    view === 'facility'
      ? isMtd
        ? 'MTD vs. YTD gross by facility, sorted by YTD gross.'
        : `${monthLabel} gross by facility, sorted by gross.`
      : isMtd
        ? `Top ${PAYER_TOP_N} payers by total charged — paid vs. collection gap.`
        : `Top ${PAYER_TOP_N} payers by total charged (${monthLabel}) — paid vs. collection gap.`;

  function chartArea() {
    if (view === 'facility') {
      if (isMtd) {
        if (kpisState.status === 'loading') return <ChartLoading />;
        if (kpisState.status === 'error') return <ChartError />;
        const rows = kpiChartRows(kpisState.data);
        if (rows.length === 0) return <ChartEmpty label="No collections to show." />;
        return <FacilityKpiBars rows={rows} />;
      }
      if (past.kind === 'facility') {
        if (past.rows.length === 0) return <ChartEmpty label={`No collections recorded for ${monthLabel}.`} />;
        return <FacilityGrossBars rows={past.rows} />;
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
        </div>

        <div className="text-sm text-muted-foreground">{description}</div>

        {chartArea()}
      </div>
    </WidgetCard>
  );
}
