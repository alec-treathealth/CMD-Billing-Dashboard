/**
 * Code Performance — PRESENTATIONAL pieces (no Server Action import, so tests can render them with
 * react-dom/server without dragging React's server-only `cache` into node:test): the maturity banner,
 * notices, the tenant toggle, the window selector and the KPI grid. The view composes them.
 *
 * ── THE LAYOUT THIS REPLACES, AND WHY (2026-09-09) ───────────────────────────────────────────────
 * Twelve equal-weight `Kpi` cards in a `lg:grid-cols-6`, each carrying its caveat as `sub` prose.
 * Two things went wrong and they compounded:
 *   1. A grid row takes the height of its TALLEST item, and `Card` has no `h-full`, so ONE four-line
 *      caveat ("reliable allowed ÷ billed; coverage is the share of charges with a reliable allowed")
 *      stretched its five neighbours into tall, almost-empty boxes. The suppressed write-off reason
 *      is 240 characters and did the same to the second row — measured on screen as roughly 230px of
 *      card holding one number.
 *   2. Every one of those caveats is ALSO in the table header below and in the definitions panel, so
 *      the page paid for the same sentence three times in vertical space it did not have.
 * Now: six PRIMARY tiles carry the money line, the other six are a dense strip, and every caveat
 * moved into `MetricHint` — present in the DOM, one hover or Tab away, costing no height. Twelve
 * numbers still ship; none of them is missing and none is truncated.
 *
 * ⚠️ DO NOT REINTRODUCE `truncate` ANYWHERE IN THIS FILE. A KPI that clips its own dollar value is
 * worse than one that wraps, and the render suite asserts the absence of that class alongside the
 * presence of `whitespace-nowrap` on the value. The fix for a number that does not fit is width
 * (the route is `max-w-[1800px]`), never an ellipsis.
 */
'use client';

import { useRef } from 'react';
import { Info, TriangleAlert } from 'lucide-react';

import {
  CODE_PERF_TENANT_LABEL,
  type CodePerfBoard,
  type CodePerfTenant,
  type CodePerfWindow,
  type GatedMetric,
} from '@/lib/code-performance/contract';
import { CODE_PERF_WINDOW_KEYS } from '../../../src/collections/codePerformanceQuery.js';

import { fmtDays, fmtInt, fmtMoney, fmtPct } from './format';
import { MetricHint } from './metric-hint';

const WINDOW_LABEL: Record<CodePerfWindow, string> = { '30d': '30d', '60d': '60d', '90d': '90d', '6mo': '6mo' };

export function MaturityBanner({ maturedShare }: { maturedShare: number | null }) {
  return (
    <div
      role="status"
      className="flex shrink-0 gap-2.5 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm text-ink900 shadow-ths-sm"
      data-maturity="immature"
    >
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
      <p className="leading-snug">
        <span className="font-semibold">This window measures velocity and volume, not yield.</span>{' '}
        <span className="text-ink600">
          Only {fmtPct(maturedShare, 1)} of charges are 45+ days old, so most have not had time to be paid — the yield figures read low for
          mechanical reasons and are de-emphasised. Widen the window for yield.
        </span>
      </p>
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

/* ── Tiles ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A PRIMARY tile. Local rather than the shared dashboard `Kpi` because the caveat has to sit beside
 * the LABEL as a hint control, and that widget's `label` is typed `string`. `Kpi` has other
 * consumers and is not edited for this surface's needs.
 */
function CpKpi({
  label,
  value,
  detail,
  hint,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line border-t-2 border-t-[var(--brand-accent)] bg-card p-3 shadow-ths">
      <div className="flex items-start justify-between gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {hint ? <MetricHint label={label} align="right">{hint}</MetricHint> : null}
      </div>
      <div className="ths-num mt-0.5 whitespace-nowrap text-lg font-semibold leading-tight tabular-nums text-[var(--brand-ink)] xl:text-xl">
        {value}
      </div>
      {detail ? <div className="ths-num mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

/** The first sentence of a suppression reason — a short honest tag; the hint carries all of it. */
function shortReason(reason: string): string {
  const [first] = reason.split('. ');
  return first ?? reason;
}

/** One entry in the dense secondary strip: label, number, hint. No card, no border, no wasted box. */
function StatItem({ label, value, hint, dim = false }: { label: string; value: React.ReactNode; hint: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`px-3 py-2 ${dim ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <MetricHint label={label} align="right">{hint}</MetricHint>
      </div>
      <div className="ths-num mt-0.5 text-sm font-semibold leading-tight tabular-nums text-ink900">{value}</div>
    </div>
  );
}

/** A gated metric in the strip: the state is the value, the first sentence is the tag, all of it is in the hint. */
function GatedStat({ label, metric, hint, dim }: { label: string; metric: GatedMetric; hint: React.ReactNode; dim?: boolean }) {
  if (metric.state === 'suppressed') {
    return (
      <StatItem
        label={label}
        dim={dim}
        value={
          <>
            <span data-state="suppressed" className="text-status-warn">
              Suppressed
            </span>
            <span className="mt-0.5 block text-[10px] font-normal leading-snug text-ink600">{shortReason(metric.reason)}</span>
          </>
        }
        hint={metric.reason}
      />
    );
  }
  return <StatItem label={label} value={fmtPct(metric.value, 2)} hint={hint} dim={dim} />;
}

export function KpiGrid({ board }: { board: CodePerfBoard }) {
  const s = board.summary;
  const dim = board.immatureWindow;
  return (
    <div className="shrink-0 space-y-2">
      {/* THE MONEY LINE. `items-start` is load-bearing: without it a grid item stretches to the row
          height and a short tile becomes a tall empty box, which is the defect this layout fixes. */}
      <div className={`grid grid-cols-2 items-start gap-2 sm:grid-cols-3 xl:grid-cols-6 ${dim ? '[&_[data-yield]]:opacity-60' : ''}`}>
        <CpKpi label="Charges" value={fmtInt(s.charges)} detail={`${fmtInt(s.pairings)} pairings`} />
        <CpKpi
          label="Billed"
          value={fmtMoney(s.billed)}
          detail={`${fmtInt(s.facilities)} facilities · ${fmtInt(s.payers)} payers`}
        />
        <CpKpi label="Collected" value={fmtMoney(s.collected)} hint="Cash posted against charges dated in this window. Not the same as cash received in the window." />
        <div data-yield>
          <CpKpi
            label="Allowed rate"
            value={fmtPct(s.allowed_rate, 2)}
            detail={`coverage ${fmtPct(s.allowed_coverage, 1)}`}
            hint="Reliable allowed ÷ billed. Coverage is the share of charges that carry a reliable allowed amount — below 60% the rate is noise, so read the two together."
          />
        </div>
        <div data-yield>
          <CpKpi
            label="Paid of allowed"
            value={fmtPct(s.paid_of_allowed, 2)}
            hint="Not clamped. Over 100% is real and is overpayment or clawback exposure, not a rounding artifact."
          />
        </div>
        <div data-yield>
          <CpKpi label="Underpaid" value={fmtMoney(s.underpaid_dollars)} hint="Allowed − paid, on posted charges with a reliable allowed amount only." />
        </div>
      </div>

      {/* VELOCITY AND DATA QUALITY — six more numbers in the height one card used to take. */}
      {/* No `divide-x`: Tailwind's divide utilities select `> * + *`, i.e. DOM order, so in a grid
          that wraps they put a left border on the first cell of every row after the first. The card
          border plus each cell's own label is enough separation, and it is wrap-safe at every
          breakpoint. (`gap-px` + a `bg-line` container is the usual trick, but it needs
          `overflow-hidden` for the corners, which would clip the MetricHint popovers.) */}
      <div className="grid grid-cols-2 rounded-xl border border-line bg-card shadow-ths sm:grid-cols-3 xl:grid-cols-6">
        <StatItem label="Days to money" value={`${fmtDays(s.days_p50)} · p90 ${fmtDays(s.days_p90)}`} hint="Charge → LAST posting, not first dollar. p50 and p90 across charges with any payment." />
        <StatItem label="Zero-paid share" value={fmtPct(s.pct_zero_paid, 1)} hint="A signal, not a denial rate — it mixes denials, patient-responsibility-only charges, timely-filing losses and charges still in flight." />
        <StatItem label="Matured share" value={fmtPct(s.matured_share, 1)} hint="Charges 45+ days old at window end. Below roughly 70% the yield columns are measuring immaturity rather than payer behaviour." />
        <div data-yield>
          <GatedStat label="Write-off rate" metric={s.write_off_rate} hint="Adjustments ÷ billed." dim={dim} />
        </div>
        <StatItem
          label="No procedure code"
          value={`${fmtInt(s.no_procedure_code_charges)} · ${fmtInt(s.no_revenue_code_charges)} no rev`}
          hint="Charges the feed carries with no HCPCS/CPT, and separately with no revenue code. A data-quality count, not a billing error count."
        />
        <div data-yield>
          <GatedStat
            label="Patient balance"
            metric={s.patient_balance_rate}
            hint="Outstanding patient balance as of today, as a share of billed, on charges billed in this window. This is AR aging and decays as patients pay — it is not comparable to allowed rate."
            dim={dim}
          />
        </div>
      </div>
    </div>
  );
}
