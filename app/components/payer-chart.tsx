'use client';

/**
 * Payer chart (Phase 7.9) — replaces the static top-15 payer table with an
 * interactive horizontal bar chart. Each payer's total charge is split into the
 * amount PAID (teal) and the COLLECTION GAP (coral); together they read as "how
 * much of what we billed this payer did we actually collect". Hover reveals the
 * full non-PHI breakdown (claims, charged, allowed, paid, avg rate, gap).
 *
 * The user picks how many payers to show (Top N, default 5). Aggregate, non-PHI:
 * payer_name is an allowlisted dimension; no patient data is present in this shape.
 * Nothing is persisted.
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

import { count, money, moneyAxis, rate } from '@/lib/format';
import type { PayerGapSummary } from '@/lib/actions';

const TOP_N_OPTIONS = [5, 10, 15, 0] as const; // 0 = All

interface ChartRow {
  payer: string;
  claim_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  total_collection_gap: number;
  avg_collection_rate: number | null;
}

function PayerTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.payer}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Claims</dt>
        <dd className="text-right text-ink900">{count(r.claim_count)}</dd>
        <dt className="text-muted-foreground">Charged</dt>
        <dd className="text-right text-ink900">{money(r.total_charge)}</dd>
        <dt className="text-muted-foreground">Allowed</dt>
        <dd className="text-right text-ink900">{money(r.total_allowed)}</dd>
        <dt className="text-muted-foreground">Paid</dt>
        <dd className="text-right text-teal700">{money(r.total_paid)}</dd>
        <dt className="text-muted-foreground">Collection gap</dt>
        <dd className="text-right text-coral600">{money(r.total_collection_gap)}</dd>
        <dt className="text-muted-foreground">Avg rate</dt>
        <dd className="text-right text-ink900">{rate(r.avg_collection_rate)}</dd>
      </dl>
    </div>
  );
}

export function PayerChart({
  data,
  defaultTopN = 5,
}: {
  data: PayerGapSummary;
  defaultTopN?: number;
}) {
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
    mapped.sort((a, b) => b.total_charge - a.total_charge);
    return topN > 0 ? mapped.slice(0, topN) : mapped;
  }, [data.by_payer, topN]);

  const chartHeight = Math.max(180, rows.length * 38 + 24);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {count(data.rows_analyzed)} claims across {count(data.by_payer.length)} payers — paid vs.
          collection gap by total charges.
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Show
          <select
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
            aria-label="Number of payers to show"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {TOP_N_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'All' : `Top ${n}`}
              </option>
            ))}
          </select>
        </label>
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
              tickFormatter={moneyAxis}
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
            <Tooltip content={<PayerTooltip />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
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
        <span className="ml-auto">Bar length = total charges. Sorted by charges, descending.</span>
      </div>
    </div>
  );
}
