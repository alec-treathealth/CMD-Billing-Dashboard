'use client';

/**
 * Payer chart — a horizontal bar chart over the per-payer non-PHI summary. Default
 * view: each payer's total CHARGED split into PAID (teal) + COLLECTION GAP (coral),
 * top 10 by charges. Two simple, reliable controls drive it: Metric (charged-vs-gap
 * stacked, or avg collection rate), Sort by, and Show (Top N). Hover reveals the
 * per-color amounts plus claims and avg collection rate.
 *
 * Fully client-side over the ALREADY-LOADED PayerGapSummary — no new API calls.
 * Aggregate, non-PHI (payer_name is an allowlisted dimension; no patient data).
 * Nothing is persisted (session-only React state).
 *
 * NOTE: by_payer has no year/location dimension, so a year/location breakdown isn't
 * offered here — it needs a separate, differently-keyed rollup (a future load).
 */
import { useMemo, useState } from 'react';
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
import { count, money, moneyAxis, rate } from '@/lib/format';
import type { PayerGapSummary } from '@/lib/actions';

const TOP_N_OPTIONS = [5, 10, 20, 30, 0] as const; // 0 = All

/**
 * Which measure to plot. `stacked` is the default single bar (charged = paid + gap);
 * `rate` is the avg-collection-rate single-series bar.
 */
export type ChartMetric = 'stacked' | 'rate';

type SortId = 'charged' | 'paid' | 'gap' | 'rate';

const METRIC_OPTIONS: readonly { id: ChartMetric; label: string }[] = [
  { id: 'stacked', label: 'Charged vs Paid & Gap' },
  { id: 'rate', label: 'Avg Collection Rate' },
];

const SORT_OPTIONS: readonly { id: SortId; label: string }[] = [
  { id: 'charged', label: 'Highest Charged' },
  { id: 'paid', label: 'Highest Paid' },
  { id: 'gap', label: 'Largest Gap' },
  { id: 'rate', label: 'Lowest Collection Rate' },
];

/** Single-series bar config for the (only) non-stacked metric. */
const SINGLE_SERIES: Record<Exclude<ChartMetric, 'stacked'>, { dataKey: keyof ChartRow; name: string; fill: string }> = {
  rate: { dataKey: 'avg_collection_rate', name: 'Avg collection rate', fill: '#1C8B82' },
};

interface ChartRow {
  payer: string;
  claim_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  total_collection_gap: number;
  avg_collection_rate: number | null;
}

/** Axis tick for a 0..1 rate rendered as a whole percent. */
function rateAxis(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** Comparator implementing each Sort by option (desc for amounts, asc for rate). */
function compareRows(a: ChartRow, b: ChartRow, sort: SortId): number {
  switch (sort) {
    case 'charged':
      return b.total_charge - a.total_charge;
    case 'paid':
      return b.total_paid - a.total_paid;
    case 'gap':
      return b.total_collection_gap - a.total_collection_gap;
    case 'rate':
      // Lowest collection rate first; unknown (null) rates sort to the end.
      return (a.avg_collection_rate ?? Infinity) - (b.avg_collection_rate ?? Infinity);
  }
}

function PayerTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  metric: ChartMetric;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;

  // Stacked: the full charged/paid/gap breakdown (per-color amounts) + avg rate.
  const lines: { label: string; value: string; cls?: string }[] =
    metric === 'stacked'
      ? [
          { label: 'Claims', value: count(r.claim_count) },
          { label: 'Charged', value: money(r.total_charge) },
          { label: 'Paid', value: money(r.total_paid), cls: 'text-teal700' },
          { label: 'Collection gap', value: money(r.total_collection_gap), cls: 'text-coral600' },
          { label: 'Avg collection rate', value: rate(r.avg_collection_rate) },
        ]
      : [
          { label: 'Claims', value: count(r.claim_count) },
          { label: 'Avg collection rate', value: rate(r.avg_collection_rate) },
        ];

  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.payer}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className={`text-right ${l.cls ?? 'text-ink900'}`}>{l.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function PayerChart({
  data,
  defaultTopN = 10,
}: {
  data: PayerGapSummary;
  defaultTopN?: number;
}) {
  const [metric, setMetric] = useState<ChartMetric>('stacked');
  const [sort, setSort] = useState<SortId>('charged');
  const [topN, setTopN] = useState<number>(defaultTopN);

  const rows = useMemo<ChartRow[]>(() => {
    const mapped = data.by_payer.map((r) => ({
      payer: r.payer_name ?? '(blank)',
      claim_count: r.claim_count,
      total_charge: r.total_charge,
      total_allowed: r.total_allowed,
      total_paid: r.total_paid,
      total_collection_gap: r.total_collection_gap,
      avg_collection_rate: r.avg_collection_rate,
    }));
    mapped.sort((a, b) => compareRows(a, b, sort));
    return topN > 0 ? mapped.slice(0, topN) : mapped;
  }, [data.by_payer, sort, topN]);

  const chartHeight = Math.max(180, rows.length * 38 + 24);
  const isStacked = metric === 'stacked';
  const single = isStacked ? null : SINGLE_SERIES[metric];
  const sortLabel = SORT_OPTIONS.find((s) => s.id === sort)?.label ?? '';

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        {count(data.rows_analyzed)} claims across {count(data.by_payer.length)} payers.
      </div>

      {/* Control bar — all client-side over the loaded summary. */}
      <div className="flex flex-wrap items-center gap-2">
        <ControlSelect
          label="Metric"
          value={metric}
          ariaLabel="Chart metric"
          onChange={(v) => setMetric(v as ChartMetric)}
        >
          {METRIC_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </ControlSelect>
        <ControlSelect
          label="Sort by"
          value={sort}
          ariaLabel="Sort chart by"
          onChange={(v) => setSort(v as SortId)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </ControlSelect>
        <ControlSelect
          label="Show"
          value={topN}
          ariaLabel="Number of payers to show"
          onChange={(v) => setTopN(Number(v))}
        >
          {TOP_N_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'All' : `Top ${n}`}
            </option>
          ))}
        </ControlSelect>
      </div>

      <div style={{ width: '100%', height: chartHeight }}>
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
              tickFormatter={metric === 'rate' ? rateAxis : moneyAxis}
              tick={{ fontSize: 11, fill: '#859794' }}
              stroke="#E4E9E6"
            />
            <YAxis
              type="category"
              dataKey="payer"
              width={150}
              tick={{ fontSize: 11, fill: '#4A5C5A' }}
              stroke="#E4E9E6"
              interval={0}
            />
            <Tooltip content={<PayerTooltip metric={metric} />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            {isStacked ? (
              <>
                <Bar dataKey="total_paid" stackId="charge" name="Paid" fill="#135E5A" radius={[2, 0, 0, 2]}>
                  {rows.map((r) => (
                    <Cell key={`paid-${r.payer}`} />
                  ))}
                </Bar>
                <Bar
                  dataKey="total_collection_gap"
                  stackId="charge"
                  name="Collection gap"
                  fill="#E2674F"
                  radius={[0, 2, 2, 0]}
                >
                  {rows.map((r) => (
                    <Cell key={`gap-${r.payer}`} />
                  ))}
                </Bar>
              </>
            ) : (
              <Bar dataKey={single!.dataKey} name={single!.name} fill={single!.fill} radius={[2, 2, 2, 2]}>
                {rows.map((r) => (
                  <Cell key={`val-${r.payer}`} />
                ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {isStacked ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal700" /> Paid
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-coral600" /> Collection gap
            </span>
            <span className="text-ink400">(bar length = total charged)</span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: single!.fill }} />
            {single!.name}
          </span>
        )}
        <span className="ml-auto">Sorted by {sortLabel.toLowerCase()}.</span>
      </div>
    </div>
  );
}
