'use client';

/**
 * Payer chart — top payers by total CHARGED, each bar split into PAID (blue) +
 * COLLECTION GAP (orange), mirroring the collections KPI chart's stacked style.
 * Hover shows charged, paid, pay gap, and the collection percentage.
 *
 * Default view (no range selected) reads the cached, all-time `data` prop. A
 * year/month range picker lets the user scope to a date_of_service window; when a
 * bound is set the chart re-fetches a date-filtered, non-PHI payer-gap summary
 * (loadPayerGapRange → live reader, no query_id, nothing persisted). Clearing the
 * range returns to the all-time default.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { SELECT_CLASS } from '@/components/data-grid';
import { count, money, moneyAxis, rate } from '@/lib/format';
import { loadPayerGapRange, type PayerGapSummary } from '@/lib/actions';

/** Default number of payers shown (kept small so the chart stays readable). */
const DEFAULT_TOP_N = 12;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const CURRENT_YEAR = new Date().getFullYear();
/** Selectable years: current and the previous 6 (covers the loaded claim history). */
const YEARS = Array.from({ length: 7 }, (_, i) => CURRENT_YEAR - i);

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

export interface ChartRow {
  payer: string;
  claim_count: number;
  total_charge: number;
  total_paid: number;
  total_collection_gap: number;
  avg_collection_rate: number | null;
}

/** Map a payer-gap summary to chart rows: top-N payers by total charged. */
export function payerChartRows(summary: PayerGapSummary, topN: number): ChartRow[] {
  return summary.by_payer
    .map((r) => ({
      payer: r.payer_name ?? '(blank)',
      claim_count: r.claim_count,
      total_charge: r.total_charge,
      total_paid: r.total_paid,
      total_collection_gap: r.total_collection_gap,
      avg_collection_rate: r.avg_collection_rate,
    }))
    .sort((a, b) => b.total_charge - a.total_charge)
    .slice(0, topN);
}

export function PayerTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.payer}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Charged</dt>
        <dd className="text-right text-ink900">{money(r.total_charge)}</dd>
        <dt className="text-muted-foreground">Paid</dt>
        <dd className="text-right text-teal700">{money(r.total_paid)}</dd>
        <dt className="text-muted-foreground">Pay gap</dt>
        <dd className="text-right text-coral600">{money(r.total_collection_gap)}</dd>
        <dt className="text-muted-foreground">Collected %</dt>
        <dd className="text-right text-ink900">{rate(r.avg_collection_rate)}</dd>
      </dl>
    </div>
  );
}

/**
 * Presentational payer bar chart — top payers by total CHARGED, each bar split
 * into PAID (teal) + COLLECTION GAP (coral), with hover tooltip + legend. Pure
 * over its `rows`; shared by PayerChart (with its range picker) and the merged
 * Overview "Master BXR Chart" widget so both render identically.
 */
export function PayerGapBars({
  rows,
  onBarClick,
}: {
  rows: ChartRow[];
  /** Optional: invoked with the payer label when a bar is clicked (drill-down). */
  onBarClick?: (payer: string) => void;
}) {
  return (
    <>
      {/* Vertical bars (category on X, money on Y), spread to the full container width. */}
      <div
        role="img"
        aria-label="Payers — paid vs. collection gap"
        style={{ width: '100%', height: 380, cursor: onBarClick ? 'pointer' : undefined }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 72, left: 8 }}
            barCategoryGap="18%"
            onClick={(state) => {
              if (onBarClick && state && typeof state.activeLabel === 'string') onBarClick(state.activeLabel);
            }}
          >
            <CartesianGrid vertical={false} stroke="#E4E9E6" />
            <XAxis
              type="category"
              dataKey="payer"
              interval={0}
              angle={-35}
              textAnchor="end"
              height={72}
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
            <Tooltip content={<PayerTooltip />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            {/* Stacked bottom→top: Paid → Collection gap = total charged (bar height). */}
            <Bar dataKey="total_paid" stackId="charge" name="Paid" fill="#135E5A" radius={[0, 0, 0, 0]} />
            <Bar dataKey="total_collection_gap" stackId="charge" name="Collection gap" fill="#E2674F" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal700" /> Paid
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-coral600" /> Collection gap
        </span>
        <span className="ml-auto">Bar height = total charged.</span>
      </div>
    </>
  );
}

type RangeState = { status: 'ready'; data?: PayerGapSummary } | { status: 'loading' } | { status: 'error' };

export function PayerChart({
  data,
  defaultTopN = DEFAULT_TOP_N,
}: {
  data: PayerGapSummary;
  defaultTopN?: number;
}) {
  const topN = defaultTopN > 0 ? defaultTopN : DEFAULT_TOP_N;

  // Year/month range picker — '' means "any" (open-ended on that side).
  const [fromYear, setFromYear] = useState('');
  const [fromMonth, setFromMonth] = useState('');
  const [toYear, setToYear] = useState('');
  const [toMonth, setToMonth] = useState('');
  const [range, setRange] = useState<RangeState>({ status: 'ready' });

  // A bound exists only when its YEAR is chosen; month defaults to Jan (from) / Dec (to).
  const dateFrom = fromYear
    ? `${fromYear}-${pad2(fromMonth ? Number(fromMonth) : 1)}-01`
    : undefined;
  const dateTo = toYear
    ? (() => {
        const m = toMonth ? Number(toMonth) : 12;
        return `${toYear}-${pad2(m)}-${pad2(lastDayOfMonth(Number(toYear), m))}`;
      })()
    : undefined;
  const hasRange = Boolean(dateFrom || dateTo);

  // Fetch the date-filtered summary when a bound is set; clear back to all-time otherwise.
  useEffect(() => {
    if (!hasRange) {
      setRange({ status: 'ready' });
      return;
    }
    let live = true;
    setRange({ status: 'loading' });
    loadPayerGapRange({ from: dateFrom, to: dateTo })
      .then((r) => {
        if (live) setRange(r.ok ? { status: 'ready', data: r.data } : { status: 'error' });
      })
      .catch(() => {
        if (live) setRange({ status: 'error' });
      });
    return () => {
      live = false;
    };
  }, [dateFrom, dateTo, hasRange]);

  const loading = hasRange && range.status === 'loading';
  const error = hasRange && range.status === 'error';
  // All-time prop by default; the fetched window when a range is active and ready.
  const summary = hasRange ? (range.status === 'ready' ? range.data : undefined) : data;

  const rows = useMemo<ChartRow[]>(
    () => (summary ? payerChartRows(summary, topN) : []),
    [summary, topN],
  );

  function clearRange() {
    setFromYear('');
    setFromMonth('');
    setToYear('');
    setToMonth('');
  }

  return (
    <div className="space-y-3">
      {/* Year/month range picker — scopes to a date_of_service window (client-side). */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>From</span>
        <select
          value={fromMonth}
          onChange={(e) => setFromMonth(e.target.value)}
          aria-label="From month"
          className={SELECT_CLASS}
        >
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={fromYear}
          onChange={(e) => setFromYear(e.target.value)}
          aria-label="From year"
          className={SELECT_CLASS}
        >
          <option value="">Any</option>
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span>to</span>
        <select
          value={toMonth}
          onChange={(e) => setToMonth(e.target.value)}
          aria-label="To month"
          className={SELECT_CLASS}
        >
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={toYear}
          onChange={(e) => setToYear(e.target.value)}
          aria-label="To year"
          className={SELECT_CLASS}
        >
          <option value="">Any</option>
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {hasRange && (
          <button
            type="button"
            onClick={clearRange}
            className="text-teal700 underline-offset-2 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      <div className="text-sm text-muted-foreground">
        Top {count(rows.length)} payers by total charged — paid vs. collection gap
        {hasRange ? ' (date-filtered)' : ''}.
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading payers…</div>
      ) : error ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
          That date range could not be loaded.
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No payer activity in the selected range.
        </div>
      ) : (
        <PayerGapBars rows={rows} />
      )}
    </div>
  );
}
