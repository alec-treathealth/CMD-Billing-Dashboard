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
  facilityNameOf,
  watchState,
  onWatch,
  onDismissFacet,
  onClearAll,
}: {
  result: PayerIntelResult;
  facilityNameOf: (code: string) => string;
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
    ...facets.facilityCodes.map((c) => ({ key: 'facility' as const, k: 'Facility', label: facilityNameOf(c), value: c })),
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
      {chips.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
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
}: {
  combos: readonly PayerIntelComboItem[];
  totalLines: number;
}) {
  const [copied, setCopied] = useState(false);
  const csv = useMemo(() => combosToCsv(combos), [combos]);
  return (
    <section aria-label="Charge lines" data-pi-section="chargelines">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Charge lines</h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
          {fmtInt(totalLines)} lines · CPT × revenue code
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
                  <td className="px-4 py-2 font-mono">{c.cpt ?? EM_DASH}</td>
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
