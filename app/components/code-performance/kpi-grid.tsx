/**
 * Code Performance — PRESENTATIONAL pieces (no Server Action import, so tests can render them with
 * react-dom/server without dragging React's server-only `cache` into node:test): the maturity banner,
 * notices, the tenant toggle, the window selector and the KPI grid. The view composes them.
 */
'use client';

import { useRef } from 'react';
import { Info, TriangleAlert } from 'lucide-react';

import { Kpi } from '@/components/dashboard/widgets';
import { CODE_PERF_TENANT_LABEL, type CodePerfBoard, type CodePerfTenant, type CodePerfWindow, type GatedMetric } from '@/lib/code-performance/contract';
import { CODE_PERF_WINDOW_KEYS } from '../../../src/collections/codePerformanceQuery.js';

import { fmtDays, fmtInt, fmtMoney, fmtPct } from './format';

const WINDOW_LABEL: Record<CodePerfWindow, string> = { '30d': '30d', '60d': '60d', '90d': '90d', '6mo': '6mo' };

export function MaturityBanner({ maturedShare }: { maturedShare: number | null }) {
  return (
    <div
      role="status"
      className="flex gap-3 rounded-lg border border-status-warn/40 bg-status-warn/10 p-4 text-sm text-ink900 shadow-ths-sm"
      data-maturity="immature"
    >
      <TriangleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-status-warn" />
      <div>
        <p className="font-semibold">This window measures velocity and volume, not yield.</p>
        <p className="mt-1 text-ink600">
          Only {fmtPct(maturedShare, 1)} of charges are 45+ days old. Median days-to-money runs about 27–44 days and Indigo&apos;s charge feed
          lags roughly two weeks, so most of these charges have not had time to be paid. Allowed rate, paid-of-allowed, underpaid dollars and
          the rate columns read low for mechanical reasons and are de-emphasised below. Widen the window for yield.
        </p>
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'muted' | 'warn'; children: React.ReactNode }) {
  const cls = tone === 'warn' ? 'border-status-warn/40 bg-status-warn/10 text-ink900' : 'border-teal200 bg-teal50 text-teal900';
  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${cls}`}>
      <Info aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${tone === 'warn' ? 'text-status-warn' : 'text-teal700'}`} />
      <div>{children}</div>
    </div>
  );
}

export function TenantToggle({
  tenants,
  value,
  onChange,
}: {
  tenants: CodePerfTenant[];
  value: CodePerfTenant;
  onChange: (t: CodePerfTenant) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  if (tenants.length <= 1) return null;
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const last = tenants.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    const t = tenants[next];
    if (t) onChange(t);
  };
  return (
    <div role="tablist" aria-label="Tenant" className="flex flex-wrap items-center gap-2">
      {tenants.map((t, i) => {
        const active = t === value;
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-view={t}
            onClick={() => onChange(t)}
            onKeyDown={(e) => onKey(e, i)}
            className={[
              'inline-flex min-h-[44px] items-center rounded-full px-4 text-sm font-semibold transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]',
              active ? 'bg-[var(--brand-ink)] text-white shadow-ths-sm' : 'bg-surface text-ink600 hover:bg-[var(--brand-soft)]',
            ].join(' ')}
          >
            {CODE_PERF_TENANT_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}

export function WindowSelector({ value, onChange }: { value: CodePerfWindow; onChange: (w: CodePerfWindow) => void }) {
  return (
    <div role="group" aria-label="Window" className="inline-flex overflow-hidden rounded-md border border-line bg-surface">
      {CODE_PERF_WINDOW_KEYS.map((w) => {
        const active = w === value;
        return (
          <button
            key={w}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(w)}
            className={[
              'min-h-[44px] px-3.5 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal500',
              active ? 'bg-teal700 text-white' : 'text-ink600 hover:bg-teal50',
            ].join(' ')}
          >
            {WINDOW_LABEL[w]}
          </button>
        );
      })}
    </div>
  );
}

function GatedKpi({ label, metric, sub }: { label: string; metric: GatedMetric; sub: string }) {
  return metric.state === 'suppressed' ? (
    <Kpi label={label} value="Suppressed" sub={metric.reason} />
  ) : (
    <Kpi label={label} value={fmtPct(metric.value, 2)} sub={sub} />
  );
}

export function KpiGrid({ board }: { board: CodePerfBoard }) {
  const s = board.summary;
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 ${board.immatureWindow ? '[&_[data-yield]]:opacity-60' : ''}`}>
      <Kpi label="Charges" value={fmtInt(s.charges)} detail={`${fmtInt(s.pairings)} pairings`} />
      <Kpi label="Billed" value={fmtMoney(s.billed)} detail={`${fmtInt(s.facilities)} facilities · ${fmtInt(s.payers)} payers`} />
      <Kpi label="Collected" value={fmtMoney(s.collected)} />
      <div data-yield>
        <Kpi
          label="Allowed rate"
          value={fmtPct(s.allowed_rate, 2)}
          detail={`coverage ${fmtPct(s.allowed_coverage, 1)}`}
          sub="reliable allowed ÷ billed; coverage is the share of charges with a reliable allowed"
        />
      </div>
      <div data-yield>
        <Kpi label="Paid of allowed" value={fmtPct(s.paid_of_allowed, 2)} sub="not clamped — over 100% is overpayment / clawback exposure" />
      </div>
      <div data-yield>
        <Kpi label="Underpaid" value={fmtMoney(s.underpaid_dollars)} sub="allowed − paid on posted, reliable charges" />
      </div>
      <Kpi label="Days to money" value={fmtDays(s.days_p50)} detail={`p90 ${fmtDays(s.days_p90)}`} sub="charge → LAST posting, not first dollar" />
      <Kpi label="Zero-paid share" value={fmtPct(s.pct_zero_paid, 1)} sub="a signal — mixes denials, patient-only, timely filing and in-flight" />
      <Kpi label="Matured share" value={fmtPct(s.matured_share, 1)} sub="charges 45+ days old at window end" />
      <div data-yield>
        <GatedKpi label="Write-off rate" metric={s.write_off_rate} sub="adjustments ÷ billed" />
      </div>
      <Kpi label="No procedure code" value={fmtInt(s.no_procedure_code_charges)} detail={`${fmtInt(s.no_revenue_code_charges)} without a revenue code`} />
      <div data-yield>
        <GatedKpi
          label="Patient balance outstanding"
          metric={s.patient_balance_rate}
          sub="as of today, share of billed, on charges billed in this window — AR aging, decays as patients pay"
        />
      </div>
    </div>
  );
}
