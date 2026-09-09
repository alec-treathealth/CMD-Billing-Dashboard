'use client';

/**
 * One pairing's drill-down — LAZY-LOADED by the view (BXR alone has 151 raw payer strings; payer detail
 * never rides in the board payload). Three panels: payers (RAW, unaliased CMD strings), facilities
 * with the 30-charge floor, and the monthly series with INCOMPLETE-month shading driven by that
 * tenant's freshness (BXR and Indigo lag differently — never a shared cutoff). recharts only.
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { displayCell } from '@/lib/phi';
import type {
  CodePerfFacilityRow,
  CodePerfFreshness,
  CodePerfMonthRow,
  CodePerfPairDetail,
  CodePerfPayerRow,
  CodePerfSummary,
} from '@/lib/code-performance/contract';

import { fmtDays, fmtInt, fmtIsoDate, fmtMoney, fmtMonth, fmtPct } from './format';
import { GatedValue, SuppressionReason } from './gated-metric';
import { LocalTable, LTd, LTh } from './local-table';

const cell = (column: string, v: unknown): string => displayCell(column, v, false);

// Functional chart colours (design-system: charts keep multi-series colours; brand vars stay on chrome).
const CHART = { billed: '#135E5A', allowedRate: '#E2674F', incomplete: '#E4E9E6', grid: '#E4E9E6' } as const;

function MetricHeaders({ summary, dim }: { summary: CodePerfSummary; dim: boolean }) {
  return (
    <>
      <LTh align="right">Charges</LTh>
      <LTh align="right">Billed</LTh>
      <LTh align="right">Collected</LTh>
      <LTh align="right" dim={dim} sub="reliable allowed ÷ billed · coverage">Allowed rate</LTh>
      <LTh align="right" dim={dim} sub="not clamped">Paid of allowed</LTh>
      <LTh align="right" sub="p50 / p90 to LAST posting">Days to money</LTh>
      <LTh align="right" sub="signal, not a denial rate">Zero-paid</LTh>
      <LTh
        align="right"
        dim={dim}
        sub={summary.write_off_rate.state === 'suppressed' ? <SuppressionReason metric={summary.write_off_rate} /> : 'adjustments ÷ billed'}
      >
        Write-off
      </LTh>
      <LTh
        align="right"
        dim={dim}
        sub={
          summary.patient_balance_rate.state === 'suppressed' ? (
            <SuppressionReason metric={summary.patient_balance_rate} />
          ) : (
            'outstanding today · AR aging'
          )
        }
      >
        Patient balance
      </LTh>
    </>
  );
}

function MetricCells({ r, dim }: { r: CodePerfPayerRow | CodePerfFacilityRow; dim: boolean }) {
  return (
    <>
      <LTd align="right" num>{cell('charges', fmtInt(r.charges))}</LTd>
      <LTd align="right" num>{cell('billed', fmtMoney(r.billed))}</LTd>
      <LTd align="right" num>{cell('collected', fmtMoney(r.collected))}</LTd>
      <LTd align="right" num dim={dim}>
        {fmtPct(r.allowed_rate, 2)}
        <span className="block text-xs text-ink600" data-coverage>coverage {fmtPct(r.allowed_coverage, 1)}</span>
      </LTd>
      <LTd align="right" num dim={dim} className={r.paid_of_allowed !== null && r.paid_of_allowed > 100 ? 'font-semibold text-status-danger' : ''}>
        {fmtPct(r.paid_of_allowed, 2)}
      </LTd>
      <LTd align="right" num>
        {fmtDays(r.days_p50)} <span className="text-ink400">/ {fmtDays(r.days_p90)}</span>
      </LTd>
      <LTd align="right" num>{fmtPct(r.pct_zero_paid, 1)}</LTd>
      <LTd align="right" num dim={dim}><GatedValue metric={r.write_off_rate} format={(v) => fmtPct(v, 2)} /></LTd>
      <LTd align="right" num dim={dim}><GatedValue metric={r.patient_balance_rate} format={(v) => fmtPct(v, 2)} /></LTd>
    </>
  );
}

export function PayerTable({ rows, summary, dim }: { rows: CodePerfPayerRow[]; summary: CodePerfSummary; dim: boolean }) {
  return (
    <LocalTable label="Payers for this pairing">
      <thead>
        <tr>
          <LTh sub="raw CMD string, unaliased">Payer</LTh>
          <LTh align="right" sub="of the pairing's billed">Share</LTh>
          <MetricHeaders summary={summary} dim={dim} />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.payer_raw ?? '(none)'}>
            <LTd>
              <span className="font-medium text-ink900">
                {r.payer_raw ?? <span className="italic text-ink600">No payer recorded</span>}
              </span>
            </LTd>
            <LTd align="right" num>{fmtPct(r.share_of_billed, 1)}</LTd>
            <MetricCells r={r} dim={dim} />
          </tr>
        ))}
      </tbody>
    </LocalTable>
  );
}

export function FacilityTable({
  rows,
  belowFloor,
  summary,
  dim,
}: {
  rows: CodePerfFacilityRow[];
  belowFloor: number;
  summary: CodePerfSummary;
  dim: boolean;
}) {
  return (
    <div className="space-y-2">
      <LocalTable label="Facilities for this pairing">
        <thead>
          <tr>
            <LTh sub="30+ charges in this pairing">Facility</LTh>
            <MetricHeaders summary={summary} dim={dim} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-6 text-center text-sm text-ink600">
                No facility reaches 30 charges in this pairing.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.facility ?? '(none)'}>
              <LTd>
                <span className="font-medium text-ink900">
                  {r.facility ?? <span className="italic text-ink600">No facility</span>}
                </span>
              </LTd>
              <MetricCells r={r} dim={dim} />
            </tr>
          ))}
        </tbody>
      </LocalTable>
      {belowFloor > 0 && (
        <p className="text-xs text-ink600">
          {belowFloor} {belowFloor === 1 ? 'facility' : 'facilities'} excluded for having fewer than 30 charges in this pairing.
        </p>
      )}
    </div>
  );
}

/** First incomplete month, or null — the left edge of the shaded band. */
export function firstIncompleteMonth(months: readonly CodePerfMonthRow[]): string | null {
  return months.find((m) => m.incomplete)?.month ?? null;
}

export function MonthlyChart({ months, freshness }: { months: CodePerfMonthRow[]; freshness: CodePerfFreshness }) {
  const data = months.map((m) => ({ ...m, label: fmtMonth(m.month) }));
  const firstIncomplete = firstIncompleteMonth(months);
  const last = months[months.length - 1];
  if (data.length === 0) return <p className="text-sm text-ink600">No months in this window for this pairing.</p>;
  return (
    <div className="space-y-2">
      <div className="h-64 w-full" role="img" aria-label="Monthly billed and allowed rate for this pairing">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="money" tick={{ fontSize: 12 }} tickFormatter={(v: number) => fmtMoney(v)} width={88} />
            <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 12 }} tickFormatter={(v: number) => `${v}%`} width={48} domain={[0, 'auto']} />
            <Tooltip
              formatter={(value: unknown, name: string) => {
                const v = typeof value === 'number' ? value : null;
                return name === 'Allowed rate' ? fmtPct(v, 2) : fmtMoney(v);
              }}
            />
            {firstIncomplete && last && (
              <ReferenceArea
                yAxisId="money"
                x1={fmtMonth(firstIncomplete)}
                x2={fmtMonth(last.month)}
                fill={CHART.incomplete}
                fillOpacity={0.6}
                label={{ value: 'incomplete', position: 'insideTop', fontSize: 11, fill: '#4A5C5A' }}
              />
            )}
            <Bar yAxisId="money" dataKey="billed" name="Billed" fill={CHART.billed} radius={[3, 3, 0, 0]} />
            <Line yAxisId="pct" type="monotone" dataKey="allowed_rate" name="Allowed rate" stroke={CHART.allowedRate} strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-ink600" data-incomplete-note>
        {firstIncomplete
          ? `Shaded from ${fmtMonth(firstIncomplete)}: this tenant's charge feed runs through ${fmtIsoDate(freshness.maxChargeDate)}, so those months are incomplete.`
          : `Every month shown is complete for this tenant (charge feed through ${fmtIsoDate(freshness.maxChargeDate)}).`}
        {' '}Allowed rate uses reliable tiers only.
      </p>
    </div>
  );
}

export function PairDrilldown({
  detail,
  summary,
  freshness,
  dim,
}: {
  detail: CodePerfPairDetail;
  summary: CodePerfSummary;
  freshness: CodePerfFreshness;
  dim: boolean;
}) {
  return (
    <div className="space-y-6 rounded-lg border border-teal200 bg-teal50/30 p-4">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink900">Payers</h3>
        <PayerTable rows={detail.payers} summary={summary} dim={dim} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink900">Facilities</h3>
        <FacilityTable rows={detail.facilities} belowFloor={detail.belowFloor} summary={summary} dim={dim} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink900">By month</h3>
        <MonthlyChart months={detail.monthly} freshness={freshness} />
      </section>
    </div>
  );
}
