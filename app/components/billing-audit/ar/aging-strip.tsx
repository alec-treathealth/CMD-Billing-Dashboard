'use client';

/**
 * The AGING STRIP — the tab's headline instrument. A Fraunces hero of the open AR, six operating
 * KPIs beside it, and nine band tiles beneath: one per age band, painted with the age ramp, each
 * carrying its open dollars, claim count, and a bar proportional to its share of the book. Tiles
 * are FILTERS (aria-pressed toggles), so the strip is both the summary and the primary control.
 * "Aged 31+ only" is the one-click view the billing team works from.
 *
 * Renders from server-seeded data on first paint (no skeleton); a filter change dims it to
 * opacity-60 while the new summary loads (design-system Motion → refresh, never re-skeleton).
 */
import { AR_BANDS } from '../../../../src/billingAudit/arBuckets';
import type { ArBandKey, ArBandSummaryRow, ArKpiRow } from '@/lib/ar/contract';
import { staggerDelayMs } from '../../qualify/tokens';
import { BAND_COLOR, moneyCompact, moneyWhole } from './ar-leaves';

export interface AgingStripProps {
  bands: ArBandSummaryRow[];
  kpi: ArKpiRow;
  selected: ArBandKey[];
  onToggle: (key: ArBandKey) => void;
  agedOnly: boolean;
  onToggleAgedOnly: () => void;
  loading: boolean;
  /**
   * Set when the summary/KPI load FAILED. Without it the strip had no failure state at all: the
   * loader did `if (res.ok) setSummary(...)` and dropped the error, so a failed refetch left the
   * PREVIOUS filter's totals on screen at full opacity (an operator reads $52.5M as the 2yr+ band's
   * total), or — on a first load — a confident `Open AR · 0 claims / $0` above a grid of real rows.
   * A zeroed KPI must never double as the error sentinel.
   */
  error?: string | null;
}

function Kpi({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: 'warn' | 'danger'; title?: string }) {
  const color = tone === 'danger' ? 'text-status-danger' : tone === 'warn' ? 'text-status-warn' : 'text-ink900';
  return (
    <div className="min-w-[6.5rem]" title={title}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink400">{label}</div>
      <div className={`ths-num mt-0.5 text-lg font-semibold leading-none ${color}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-ink400">{sub}</div> : null}
    </div>
  );
}

export function AgingStrip({ bands, kpi, selected, onToggle, agedOnly, onToggleAgedOnly, loading, error }: AgingStripProps) {
  const byBand = new Map(bands.map((b) => [b.band, b]));
  // BAND-INDEPENDENT DENOMINATOR. `kpi.balance` is the FILTERED total, so as soon as the operator
  // pressed a tile — the strip's primary interaction — that tile became 100% and every other tile
  // 0%, making the shares arbitrary exactly when they are being read. The summary query is built
  // with includeBands=false (buildArSummaryQuery), i.e. `bands` always describes the whole un-banded
  // population, so the sum of the bands is the honest denominator and costs no extra query.
  const bandTotal = bands.reduce((sum, b) => sum + (Number(b.balance) || 0), 0);
  const total = Math.max(1, bandTotal);
  const maxShare = Math.max(0.0001, ...AR_BANDS.map((b) => (Number(byBand.get(b.key)?.balance) || 0) / total));
  const claimsWord = kpi.claims === 1 ? 'claim' : 'claims';
  const DASH = '—';
  const num = (v: number): string => (error ? DASH : v.toLocaleString('en-US'));
  const cash = (v: string): string => (error ? DASH : moneyCompact(v));
  return (
    <section aria-label="Open AR by age" className={`transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="animate-ths-reveal">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink400">
            Open AR{error ? '' : ` · ${kpi.claims.toLocaleString('en-US')} ${claimsWord}`}
          </div>
          <div className="font-display mt-1 text-[2.75rem] font-medium leading-none tracking-tight text-[var(--brand-ink)] sm:text-[3.25rem]">
            {error ? DASH : moneyWhole(kpi.balance)}
          </div>
          {error ? (
            <div role="alert" className="mt-2 text-sm text-status-danger">
              Totals unavailable — {error} The claim list below is unaffected.
            </div>
          ) : (
            <div className="mt-2 text-sm text-ink600">
              <span className="ths-num font-semibold text-ink900">{moneyCompact(kpi.aged_31_plus_balance)}</span> across{' '}
              <span className="ths-num font-semibold text-ink900">{kpi.aged_31_plus.toLocaleString('en-US')}</span> claims is past 30 days.
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3 animate-ths-reveal" style={{ animationDelay: `${staggerDelayMs(1)}ms` }}>
          <Kpi
            label="Denied"
            value={num(kpi.denied)}
            sub={cash(kpi.denied_balance)}
            tone={!error && kpi.denied > 0 ? 'danger' : undefined}
            title="Claims the payer denied (CMD denial flag). The dollars are the OPEN BALANCE those claims still carry — not the adjusted amount."
          />
          <Kpi label="Being worked" value={num(kpi.worked)} sub={!error && kpi.claims > 0 ? `${Math.round((kpi.worked / kpi.claims) * 100)}% of open` : undefined} />
          <Kpi label="Follow-up overdue" value={num(kpi.followup_overdue)} sub="CMD follow-up date passed" tone={!error && kpi.followup_overdue > 0 ? 'warn' : undefined} />
          <Kpi label="Never noted" value={num(kpi.never_noted)} sub="no CMD or app note" />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <h2 className="ths-h text-sm font-semibold text-ink900">Age of open balance</h2>
        <button
          type="button"
          aria-pressed={agedOnly}
          onClick={onToggleAgedOnly}
          className={[
            'rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            agedOnly ? 'border-[var(--brand-accent)] bg-[var(--brand-accent)] text-white' : 'border-line bg-card text-ink600 hover:border-teal700/50 hover:text-ink900',
          ].join(' ')}
        >
          Aged 31+ days only
        </button>
      </div>

      <div role="group" aria-label="Age bands (toggle to filter)" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">
        {AR_BANDS.map((b, i) => {
          const row = byBand.get(b.key);
          const balance = Number(row?.balance) || 0;
          const claims = row?.claims ?? 0;
          const share = balance / total;
          const width = Math.max(share > 0 ? 3 : 0, Math.round((share / maxShare) * 100));
          const on = selected.includes(b.key);
          const color = BAND_COLOR[b.key];
          const empty = claims === 0;
          return (
            <button
              key={b.key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(b.key)}
              style={{ animationDelay: `${staggerDelayMs(i)}ms`, borderTopColor: color }}
              className={[
                'animate-ths-reveal group relative flex min-h-[6.25rem] flex-col justify-between rounded-lg border border-line border-t-[3px] bg-card p-3 text-left transition-[box-shadow,transform] duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                on ? 'shadow-ths ring-2 ring-[var(--brand-accent)] ring-offset-1' : 'shadow-ths-sm hover:shadow-ths',
                empty && !on ? 'opacity-60' : '',
              ].join(' ')}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink400">{b.label}</span>
                {on ? <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} /> : null}
              </span>
              <span className="mt-2 block">
                <span className="font-display block text-xl font-medium leading-none text-ink900">{error ? DASH : moneyCompact(balance)}</span>
                <span className="ths-num mt-1 block text-xs text-ink400">
                  {error ? DASH : `${claims.toLocaleString('en-US')} ${claims === 1 ? 'claim' : 'claims'} · ${Math.round(share * 100)}%`}
                </span>
              </span>
              <span aria-hidden className="mt-3 block h-1 w-full overflow-hidden rounded-full bg-ground">
                <span className="block h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: error ? '0%' : `${width}%`, backgroundColor: color }} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
