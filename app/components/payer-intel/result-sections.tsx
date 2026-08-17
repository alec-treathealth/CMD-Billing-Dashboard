'use client';

/**
 * RESULT-state sections: the hero band (stats · rating · Watch · ON FILE chips), the percentage
 * band, the placement table, and the charge-lines table.
 *
 * DOLLAR POSTURE: every dollar field arrives ALREADY NULL for amounts-blind viewers (the core's
 * choke point) and renders '—'; column headers stay so the layout is stable and honest. Ratios and
 * counts render for everyone. Count-ups run only here (RESULT never SSRs — no hydration risk) and
 * bail under prefers-reduced-motion inside useCountUp.
 */
import { useMemo, useState } from 'react';
import type {
  PayerIntelComboItem,
  PayerIntelFacetKey,
  PayerIntelGridPage,
  PayerIntelGroupItem,
  PayerIntelPlacementItem,
  PayerIntelResult,
} from '../../lib/payer-intel/contract';
import { TAPE_PALETTE } from '../qualify/tokens';
import { EM_DASH, fmtInt, fmtMoney, fmtPct, fmtPstTime } from './format';
import { useCountUp } from './useCountUp';

// ── Hero ─────────────────────────────────────────────────────────────────────────────────────────

function HeroStat({ value, label, money }: { value: number | null; label: string; money?: boolean }) {
  const animated = useCountUp(value);
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-display text-[34px] font-medium leading-none text-white tabular-nums">
        {animated === null ? EM_DASH : money ? fmtMoney(animated) : fmtInt(animated)}
      </span>
      <span className="text-xs leading-tight text-white/60">{label}</span>
    </div>
  );
}

export function PayerIntelHero({
  result,
  watchState,
  onWatch,
  onDismissFacet,
  onClearAll,
}: {
  result: PayerIntelResult;
  watchState: 'idle' | 'saving' | 'saved' | 'failed';
  onWatch: () => void;
  onDismissFacet: (key: PayerIntelFacetKey, value: string | null) => void;
  onClearAll: () => void;
}) {
  const { facets, totals, rating } = result;
  const band = rating.band ?? '0';
  const chips: { key: PayerIntelFacetKey; k: string; label: string; value: string | null }[] = [
    ...(facets.payer !== null ? [{ key: 'payer' as const, k: 'Payer', label: facets.payer, value: facets.payer }] : []),
    ...(facets.prefix !== null ? [{ key: 'prefix' as const, k: 'Prefix', label: facets.prefix, value: facets.prefix }] : []),
    ...facets.employerNames.map((e) => ({ key: 'employer' as const, k: 'Employer', label: e, value: e })),
    ...facets.funding.map((f) => ({ key: 'funding' as const, k: 'Funding', label: f, value: f })),
    ...(facets.groupNumberMasked !== null
      ? [{ key: 'group' as const, k: 'Group #', label: facets.groupNumberMasked, value: null }]
      : []),
    // Facility facet VALUES are the rollup's display text — value IS the label.
    ...facets.facilities.map((f) => ({ key: 'facility' as const, k: 'Facility', label: f, value: f })),
    ...(facets.cpt !== null || facets.revenue !== null
      ? [
          {
            key: 'cpt_rev' as const,
            k: 'CPT × Rev',
            label: `${facets.cpt ?? '·'} × ${facets.revenue ?? '·'}`,
            value: null,
          },
        ]
      : []),
  ];
  return (
    <section aria-label="Search result summary" data-pi-section="hero" className="rounded-2xl bg-teal900 p-6 shadow-ths-lg">
      <div className="flex flex-wrap items-start gap-6">
        <HeroStat value={totals.lineCount} label={'charge lines\nmatch your filters'} />
        <div className="hidden w-px self-stretch bg-white/[0.13] sm:block" />
        <HeroStat value={totals.distinctMembers} label={'clients\nin the cohort'} />
        <div className="hidden w-px self-stretch bg-white/[0.13] sm:block" />
        <HeroStat value={totals.billed} label={'billed\nin window'} money />
        <div className="ml-auto flex items-center gap-3.5">
          <div className="text-right">
            <div className="text-[10px] font-bold uppercase tracking-widest text-white/55">Policy rating</div>
            <div className="mt-0.5 text-xs text-white/70">
              {rating.subject === 'pair' && facets.payer !== null && facets.prefix !== null
                ? `${facets.payer} · prefix ${facets.prefix}`
                : rating.subject === 'payer' && facets.payer !== null
                  ? `${facets.payer} · book-wide`
                  : 'not rated for this search'}
              {rating.asOf !== null ? ` · as of ${rating.asOf}` : ''}
            </div>
          </div>
          <span
            className="font-display text-[52px] font-medium leading-[0.9] tabular-nums"
            style={{ color: rating.value !== null ? TAPE_PALETTE.band[band] : '#FFFFFF8A' }}
          >
            {rating.value ?? EM_DASH}
          </span>
          {rating.value !== null && facets.payer !== null ? (
            <button
              type="button"
              onClick={onWatch}
              disabled={watchState === 'saving' || watchState === 'saved'}
              className="rounded-full border px-3.5 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70 disabled:opacity-70"
              style={{ color: '#E0B05C', borderColor: 'rgba(224,176,92,0.3)', background: 'rgba(224,176,92,0.16)' }}
            >
              {watchState === 'saved' ? 'Watching ✓' : watchState === 'saving' ? 'Saving…' : watchState === 'failed' ? 'Retry watch' : 'Watch'}
            </button>
          ) : null}
        </div>
      </div>
      {/* The "how far back" disclosure — a required piece of chrome, not decoration: every number
          on this screen is scoped to this payment-received window. */}
      <p className="mt-3 font-mono text-[11px] text-white/55">
        payments received {result.window.from} → {result.window.to} · past {result.window.days} days
      </p>
      {chips.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          <span className="mr-0.5 text-[10px] font-bold uppercase tracking-widest text-white/40">On file</span>
          {chips.map((c) => (
            <span
              key={`${c.key}-${c.label}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1 text-xs text-white"
            >
              <span className="text-[9.5px] font-bold uppercase tracking-wider text-white/45">{c.k}</span>
              {c.label}
              <button
                type="button"
                aria-label={`Remove ${c.k} ${c.label}`}
                onClick={() => onDismissFacet(c.key, c.value)}
                className="ml-0.5 min-h-6 min-w-6 text-[13px] leading-none text-white/40 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70"
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="ml-1 p-1 text-xs font-medium text-white/50 underline underline-offset-[3px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70"
          >
            Clear all
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ── Percentage band ──────────────────────────────────────────────────────────────────────────────

function PctCard({
  title,
  formula,
  value,
  caption,
  mid,
}: {
  title: string;
  formula: string;
  value: number | null;
  caption: string;
  mid?: boolean;
}) {
  const animated = useCountUp(value);
  return (
    <div className={['rounded-md p-4.5 px-5 py-4', mid ? 'bg-[#D3E9DF]' : 'bg-[#E5F2ED]'].join(' ')} data-pi-pct-card>
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-bold uppercase tracking-wide text-ink600">{title}</span>
        <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-ink600">
          {formula}
        </span>
      </div>
      <div className="mt-2 font-display text-[31px] font-medium text-ink900 tabular-nums">
        {animated === null ? EM_DASH : `${animated.toFixed(2)}%`}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink600">{caption}</div>
    </div>
  );
}

export function PayerIntelPctBand({ result }: { result: PayerIntelResult }) {
  const y = result.yieldPct;
  return (
    <section aria-label="Payer behavior percentages" data-pi-section="pctband">
      {/* Order mirrors the math: allowed → paid → collected (the IDLE→RESULT stagger follows it). */}
      <div className="grid grid-cols-1 gap-3 min-[1080px]:grid-cols-[1fr_1.25fr_1fr]">
        <PctCard title="% allowed of billed" formula="allowed ÷ billed" value={y.pct_allowed} caption="what the payer agreed to" />
        <PctCard title="% paid by payer" formula="paid ÷ allowed" value={y.pct_paid} caption="of what was allowed" mid />
        <PctCard title="% collected of billed" formula="paid ÷ billed" value={y.pct_collected} caption="net yield end to end" />
      </div>
      <p className="mt-2.5 px-0.5 text-[11.5px] leading-relaxed text-ink600">
        {y.pct_allowed !== null && y.pct_paid !== null && y.pct_collected !== null
          ? `${Math.round(y.pct_allowed)}% × ${Math.round(y.pct_paid)}% ≈ ${Math.round(y.pct_collected)}% — `
          : ''}
        <b className="font-semibold text-ink900">most of the gap is expected contractual write-off, not lost revenue.</b>{' '}
        Compare across payers and facilities rather than against a target.
      </p>
    </section>
  );
}

// ── Drill-down group cards (Top payers / Top facilities — the Collections summary lists) ─────────

function GroupCard({
  title,
  items,
  drillLabel,
  onDrill,
}: {
  title: string;
  items: readonly PayerIntelGroupItem[];
  drillLabel: (label: string) => string;
  onDrill: (label: string) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-4 shadow-ths-sm">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-ink600">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-ink400">{EM_DASH}</p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {items.map((g) =>
            g.label !== null ? (
              <li key={g.label}>
                <button
                  type="button"
                  aria-label={drillLabel(g.label)}
                  onClick={() => onDrill(g.label!)}
                  className="flex w-full items-baseline gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-teal50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink900">{g.label}</span>
                  <span className="whitespace-nowrap font-mono text-xs text-ink600 tabular-nums">
                    {fmtInt(g.count)}
                    {g.charge !== null ? ` · ${fmtMoney(g.charge)}` : ''}
                  </span>
                </button>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

/** Top Payers + Top Facilities, side by side — each row DRILLS DOWN (adds the facet and re-runs),
 *  the Collections summary interaction Alec's review asked for. */
export function PayerIntelTopGroups({
  byPayer,
  byFacility,
  onDrillPayer,
  onDrillFacility,
}: {
  byPayer: readonly PayerIntelGroupItem[];
  byFacility: readonly PayerIntelGroupItem[];
  onDrillPayer: (label: string) => void;
  onDrillFacility: (label: string) => void;
}) {
  if (byPayer.length === 0 && byFacility.length === 0) return null;
  return (
    <section aria-label="Top payers and facilities" data-pi-section="groups">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <GroupCard
          title="Top payers"
          items={byPayer}
          drillLabel={(l) => `Narrow this search to payer ${l}`}
          onDrill={onDrillPayer}
        />
        <GroupCard
          title="Top facilities"
          items={byFacility}
          drillLabel={(l) => `Narrow this search to facility ${l}`}
          onDrill={onDrillFacility}
        />
      </div>
    </section>
  );
}

// ── Placement table ──────────────────────────────────────────────────────────────────────────────

export function PayerIntelPlacementTable({
  items,
  window,
  censusSyncedAt,
  cohortLabel,
}: {
  items: readonly PayerIntelPlacementItem[];
  window: { from: string; to: string };
  censusSyncedAt: string | null;
  cohortLabel: string;
}) {
  const asOfLive = `live · ${fmtPstTime(censusSyncedAt)}`;
  const asOfTrailing = `${'90d thru'} ${window.to}`;
  return (
    <section aria-label="Where this policy places" data-pi-section="placement">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Where this policy places</h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
          capacity × collectability
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink400">
          No facility carries charges for this search.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-ths-sm">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                <th className="px-4 py-2">Facility</th>
                <th className="px-4 py-2 text-right">
                  Open beds
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfLive}
                  </span>
                </th>
                <th
                  className="px-4 py-2 text-right"
                  title="Pending admits are not stored by the census sync yet"
                >
                  Pending
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfLive}
                  </span>
                </th>
                <th className="px-4 py-2 text-right">
                  % collected — {cohortLabel}
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfTrailing}
                  </span>
                </th>
                <th className="px-4 py-2 text-right">
                  $ paid / patient
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfTrailing}
                  </span>
                </th>
                <th className="px-4 py-2 text-right">Lines</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.facility}
                  className={p.flag !== null ? 'border-t border-line bg-[#FFFCF5] hover:bg-[#FDF6E7]' : 'border-t border-line hover:bg-teal50'}
                >
                  <td className="px-4 py-2.5 font-semibold text-ink900">
                    {p.facility}
                    {p.flag === 'best_yield_full' ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[#EFF1F0] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#5F6D6C]">
                        Full
                      </span>
                    ) : null}
                    {p.flag === 'open_beds_worst_yield' ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[#FBF1DE] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#936316]">
                        Beds, weak yield
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.openBeds !== null ? fmtInt(p.openBeds) : EM_DASH}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink400">
                    {p.pendingAdmits !== null ? fmtInt(p.pendingAdmits) : EM_DASH}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmtPct(p.pctCollected)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmtMoney(p.paidPerPatient)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{fmtInt(p.lineCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.some((p) => p.flag !== null) ? (
        <div className="mt-2.5 rounded-r-md border-l-[3px] border-coral600 bg-coral50 px-4 py-3 text-[12.5px] leading-relaxed text-ink900">
          <b className="font-semibold">The flagged rows are the point of this table</b> — where this policy collects
          best against where beds are actually open.
        </div>
      ) : null}
    </section>
  );
}

// ── Charge lines table ───────────────────────────────────────────────────────────────────────────

function combosToCsv(combos: readonly PayerIntelComboItem[]): string {
  const header = 'cpt,revenue,lines,charged,pct_allowed,pct_paid,pct_zero_paid';
  const rows = combos.map((c) =>
    [
      c.cpt ?? '',
      c.revenue ?? '',
      c.count,
      c.charge ?? '',
      c.pctAllowed ?? '',
      c.pctPaid ?? '',
      c.pctZeroPaid,
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function PayerIntelChargeLines({
  combos,
  totalLines,
  onDrillCombo,
}: {
  combos: readonly PayerIntelComboItem[];
  totalLines: number;
  /** Drill into one CPT×revenue pairing — adds the facet and re-runs (a row IS a filter). */
  onDrillCombo?: (cpt: string | null, revenue: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const csv = useMemo(() => combosToCsv(combos), [combos]);
  return (
    <section aria-label="CPT by revenue-code combinations" data-pi-section="chargelines">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">
          Top CPT × revenue-code combinations
        </h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
          {fmtInt(totalLines)} lines matched
        </span>
        <span className="flex-1" />
        {combos.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              // Non-PHI aggregate rows only — the same numbers already on screen.
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'payer-intel-charge-lines.csv';
              a.click();
              URL.revokeObjectURL(url);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="text-xs font-semibold text-teal700 hover:text-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
          >
            {copied ? 'Exported ✓' : 'Export'}
          </button>
        ) : null}
      </div>
      {combos.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink400">No charge lines match.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-ths-sm">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                <th className="px-4 py-2">CPT</th>
                <th className="px-4 py-2">Revenue</th>
                <th className="px-4 py-2 text-right">Lines</th>
                <th className="px-4 py-2 text-right">Charged</th>
                <th className="px-4 py-2 text-right">% allowed</th>
                <th className="px-4 py-2 text-right">% paid</th>
                <th className="px-4 py-2 text-right">Zero-paid</th>
              </tr>
            </thead>
            <tbody>
              {combos.map((c) => (
                <tr key={`${c.cpt ?? '·'}-${c.revenue ?? '·'}`} className="border-t border-line hover:bg-teal50">
                  <td className="px-4 py-2 font-mono">
                    {onDrillCombo ? (
                      <button
                        type="button"
                        aria-label={`Narrow this search to ${c.cpt ?? 'no CPT'} with revenue code ${c.revenue ?? 'none'}`}
                        onClick={() => onDrillCombo(c.cpt, c.revenue)}
                        className="rounded font-mono underline decoration-teal200 underline-offset-2 hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
                      >
                        {c.cpt ?? EM_DASH}
                      </button>
                    ) : (
                      (c.cpt ?? EM_DASH)
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono">{c.revenue ?? EM_DASH}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtInt(c.count)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMoney(c.charge)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctAllowed)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctPaid)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctZeroPaid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Charge-line grid (row-level detail — the Collections grid behind this tab's gate) ────────────

function fmtMoneyStr(v: string | null): string {
  if (v === null) return EM_DASH;
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : EM_DASH;
}

function fmtPctStr(v: string | null): string {
  if (v === null) return EM_DASH;
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : EM_DASH;
}

/** Row-level charge lines, keyset-paged, newest payment first — the Collections grid experience.
 *  No identifier columns (PHI reveal is a follow-up); dollar cells arrive already stripped for
 *  amounts-blind viewers and render em dashes. */
export function PayerIntelGridTable({
  page,
  loading,
  onLoadMore,
}: {
  page: PayerIntelGridPage | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section aria-label="Charge lines" data-pi-section="grid">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Charge lines</h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
          row-level detail · newest payment first
        </span>
      </div>
      {page === null ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink400" role="status">
          {loading ? 'Loading charge lines…' : 'Charge lines will load with the search.'}
        </p>
      ) : page.rows.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink400">
          No charge lines match this search.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-ths-sm">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                  <th className="px-3 py-2">Charge From</th>
                  <th className="px-3 py-2">Payment Received</th>
                  <th className="px-3 py-2">CPT</th>
                  <th className="px-3 py-2">Revenue</th>
                  <th className="px-3 py-2">Primary Payer</th>
                  <th className="px-3 py-2">Facility</th>
                  <th className="px-3 py-2">Employer</th>
                  <th className="px-3 py-2 text-right">Charged</th>
                  <th className="px-3 py-2 text-right">Allowed</th>
                  <th className="px-3 py-2 text-right">% Allowed</th>
                  <th className="px-3 py-2 text-right">Ins. Paid</th>
                  <th className="px-3 py-2 text-right">% Paid</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line hover:bg-teal50">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">{r.chargeDate}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">{r.paymentReceived ?? EM_DASH}</td>
                    <td className="px-3 py-1.5 font-mono">{r.cpt ?? EM_DASH}</td>
                    <td className="px-3 py-1.5 font-mono">{r.revenue ?? EM_DASH}</td>
                    <td className="max-w-[180px] truncate px-3 py-1.5">{r.payer ?? EM_DASH}</td>
                    <td className="max-w-[180px] truncate px-3 py-1.5">{r.facility}</td>
                    <td className="max-w-[160px] truncate px-3 py-1.5">{r.employerName ?? EM_DASH}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{fmtMoneyStr(r.chargeAmount)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{fmtMoneyStr(r.allowedAmount)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{fmtPctStr(r.pctAllowed)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{fmtMoneyStr(r.insurancePayments)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{fmtPctStr(r.pctPaid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.nextCursor !== null ? (
            <div className="mt-2.5 flex justify-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loading}
                className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink900 transition-colors hover:bg-teal50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
              >
                {loading ? 'Loading…' : 'Load more charge lines'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
