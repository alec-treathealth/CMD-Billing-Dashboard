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
import { useMemo, useState, type ReactNode } from 'react';
import {
  PAYER_INTEL_GRID_DEFAULT_SORT,
  type PayerIntelComboItem,
  type PayerIntelFacetKey,
  type PayerIntelGridPage,
  type PayerIntelGridSort,
  type PayerIntelGridSortColumn,
  type PayerIntelGroupItem,
  type PayerIntelPlacementItem,
  type PayerIntelResult,
} from '../../lib/payer-intel/contract';
import { TAPE_PALETTE } from '../qualify/tokens';
import { EM_DASH, fmtInt, fmtMoney, fmtPct, fmtPstTime } from './format';
import { useCountUp } from './useCountUp';

// ── One box, divided into sections ───────────────────────────────────────────────────────────────

/**
 * The RESULT screen's analysis sections live in ONE card split by dividers (Alec, 2026-08-17:
 * "all the other components should be together in 1 box divided up into little sections … just
 * like collections"). Each section therefore renders WITHOUT its own border/shadow — the box owns
 * the chrome, and a section that draws its own would read as a card inside a card.
 *
 * The charge-line grid stays OUTSIDE the box on purpose: it is row-level detail with its own
 * paging control and its own failure state, not a panel of the summary.
 */
export function PayerIntelSectionBox({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface shadow-ths-sm">
      {children}
    </div>
  );
}

function SectionHead({ title, meta, right }: { title: string; meta?: string; right?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-1">
      <h2 className="font-head text-[15px] font-medium tracking-tight text-ink900">{title}</h2>
      {meta !== undefined ? (
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">{meta}</span>
      ) : null}
      {right !== undefined ? (
        <>
          <span className="flex-1" />
          {right}
        </>
      ) : null}
    </div>
  );
}

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
    <div>
      <h3 className="px-1 text-[11px] font-bold uppercase tracking-wide text-ink600">{title}</h3>
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:divide-x md:divide-line">
        <GroupCard
          title="Top payers"
          items={byPayer}
          drillLabel={(l) => `Narrow this search to payer ${l}`}
          onDrill={onDrillPayer}
        />
        <div className="md:pl-4">
          {/* "Highest collected" (Alec, 2026-08-17) — the list is ordered by dollars collected,
              and "Top facilities" read as a volume ranking. */}
          <GroupCard
            title="Highest collected"
            items={byFacility}
            drillLabel={(l) => `Narrow this search to facility ${l}`}
            onDrill={onDrillFacility}
          />
        </div>
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
  onDrillFacility,
}: {
  items: readonly PayerIntelPlacementItem[];
  window: { from: string; to: string; days: number };
  censusSyncedAt: string | null;
  cohortLabel: string;
  /** A ROW IS A FILTER (Alec, 2026-08-17): clicking narrows the search to that facility, which
   *  re-runs it — and since page 1 of the charge lines rides the search, the grid below filters
   *  with it. The row carries `cursor-pointer` so the affordance is visible, and the first cell is
   *  a real <button> so the keyboard path is not a mouse-only feature. */
  onDrillFacility?: (facility: string) => void;
}) {
  const asOfLive = `live · ${fmtPstTime(censusSyncedAt)}`;
  const asOfTrailing = `${window.days}d thru ${window.to}`;
  return (
    <section aria-label="Where this policy places" data-pi-section="placement">
      <SectionHead title="Where this policy places" meta="capacity × collectability" />
      {items.length === 0 ? (
        <p className="px-1 text-sm text-ink400">No facility carries charges for this search.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                <th className="px-2 py-2">Facility</th>
                {/* PENDING ADMITS HAS NO COLUMN, deliberately. The Monday census sync drops every
                    non-admitted status before it writes, so the number does not exist anywhere in
                    the database — a column of em dashes read as "broken" twice in review. It comes
                    back when the aggregation stores pending and the census table gains the column,
                    not before. Open beds ARE joined (residential only; OP boards store 0 to mean
                    N/A — the 0078 contract). */}
                <th className="px-2 py-2 text-right">
                  Open beds
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfLive}
                  </span>
                </th>
                <th className="px-2 py-2 text-right">
                  % collected — {cohortLabel}
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfTrailing}
                  </span>
                </th>
                <th className="px-2 py-2 text-right">
                  $ paid / patient
                  <span className="mt-0.5 block font-mono text-[9px] font-normal normal-case tracking-normal text-ink400">
                    {asOfTrailing}
                  </span>
                </th>
                <th className="px-2 py-2 text-right">Lines</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.facility}
                  onClick={onDrillFacility ? () => onDrillFacility(p.facility) : undefined}
                  className={[
                    p.flag !== null
                      ? 'border-t border-line bg-[#FFFCF5] hover:bg-[#FDF6E7]'
                      : 'border-t border-line hover:bg-teal50',
                    onDrillFacility ? 'cursor-pointer' : '',
                  ].join(' ')}
                >
                  <td className="max-w-[240px] truncate px-2 py-2 font-semibold text-ink900">
                    {onDrillFacility ? (
                      <button
                        type="button"
                        aria-label={`Narrow this search to ${p.facility}`}
                        onClick={(e) => {
                          e.stopPropagation(); // the row handler would otherwise fire twice
                          onDrillFacility(p.facility);
                        }}
                        className="rounded text-left underline decoration-teal200 underline-offset-2 hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
                      >
                        {p.facility}
                      </button>
                    ) : (
                      p.facility
                    )}
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
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums">
                    {p.openBeds !== null ? (
                      <>
                        {fmtInt(p.openBeds)}
                        {p.bedCapacity !== null ? (
                          <span className="text-ink400"> / {fmtInt(p.bedCapacity)}</span>
                        ) : null}
                      </>
                    ) : (
                      EM_DASH
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtPct(p.pctCollected)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums">{fmtMoney(p.paidPerPatient)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtInt(p.lineCount)}</td>
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
      <SectionHead
        title="Top CPT × revenue-code combinations"
        meta={`${fmtInt(totalLines)} lines matched`}
        right={
          combos.length > 0 ? (
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
          ) : undefined
        }
      />
      {combos.length === 0 ? (
        <p className="px-1 text-sm text-ink400">No charge lines match.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                {/* CPT and revenue share ONE cell: the pair is the identity of the row, and two
                    columns cost ~70px this table does not have once it sits half-width. */}
                <th className="px-2 py-2">CPT · Rev</th>
                <th className="px-2 py-2 text-right">Lines</th>
                <th className="px-2 py-2 text-right">Charged</th>
                <th className="px-2 py-2 text-right">% alw</th>
                <th className="px-2 py-2 text-right">% paid</th>
                <th className="px-2 py-2 text-right">Zero</th>
              </tr>
            </thead>
            <tbody>
              {combos.map((c) => (
                /* THE WHOLE ROW IS THE FILTER (Alec, 2026-08-17), not just the CPT cell: clicking
                   narrows the search to this CPT × revenue pairing, which re-runs it — and since
                   page 1 of the charge lines rides the search, the grid below filters with it.
                   `cursor-pointer` makes the affordance visible; the CPT cell stays a real
                   <button> so keyboard users have the same path, and its click stops propagating
                   so the row handler cannot fire twice. */
                <tr
                  key={`${c.cpt ?? '·'}-${c.revenue ?? '·'}`}
                  onClick={onDrillCombo ? () => onDrillCombo(c.cpt, c.revenue) : undefined}
                  className={[
                    'border-t border-line hover:bg-teal50',
                    onDrillCombo ? 'cursor-pointer' : '',
                  ].join(' ')}
                >
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {onDrillCombo ? (
                      <button
                        type="button"
                        aria-label={`Narrow this search to ${c.cpt ?? 'no CPT'} with revenue code ${c.revenue ?? 'none'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDrillCombo(c.cpt, c.revenue);
                        }}
                        className="rounded font-mono underline decoration-teal200 underline-offset-2 hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
                      >
                        {c.cpt ?? EM_DASH}
                      </button>
                    ) : (
                      (c.cpt ?? EM_DASH)
                    )}
                    <span className="text-ink400"> · {c.revenue ?? EM_DASH}</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtInt(c.count)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums">{fmtMoney(c.charge)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctAllowed)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctPaid)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtPct(c.pctZeroPaid)}</td>
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
/** One sortable column header. `aria-sort` is on the <th> (where AT expects it) while the button
 *  inside carries the action and the accessible name — a <th> with an onClick would be a
 *  mouse-only control, which is the failure this pattern exists to avoid. */
function SortableTh({
  column,
  label,
  sort,
  onSort,
  align = 'left',
}: {
  column: PayerIntelGridSortColumn;
  label: string;
  sort: PayerIntelGridSort;
  onSort?: (next: PayerIntelGridSort) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.column === column;
  const dir = active ? sort.direction : null;
  const cls = align === 'right' ? 'px-3 py-2 text-right' : 'px-3 py-2';
  if (!onSort) return <th className={cls}>{label}</th>;
  return (
    <th className={cls} aria-sort={dir === null ? 'none' : dir === 'asc' ? 'ascending' : 'descending'}>
      <button
        type="button"
        // First click on a new column sorts DESC (biggest/newest first — what a reader wants from
        // money and dates); clicking the active column flips it.
        onClick={() => onSort({ column, direction: active && sort.direction === 'desc' ? 'asc' : 'desc' })}
        aria-label={`Sort by ${label}${dir === 'desc' ? ', ascending' : ', descending'}`}
        className={[
          'inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-teal700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500',
          active ? 'text-teal700' : '',
        ].join(' ')}
      >
        {label}
        <span aria-hidden className={active ? '' : 'opacity-30'}>
          {dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

/** Row-level charge lines, keyset-paged — the Collections grid experience behind this tab's gate.
 *  No identifier columns (PHI reveal is a follow-up); dollar cells arrive already stripped for
 *  amounts-blind viewers and render em dashes. */
export function PayerIntelGridTable({
  page,
  loading,
  failed = false,
  sort = PAYER_INTEL_GRID_DEFAULT_SORT,
  onSort,
  onRetry,
  onLoadMore,
}: {
  page: PayerIntelGridPage | null;
  loading: boolean;
  /** The page came back refusing, or the action rejected outright. NEVER conflated with "pending":
   *  the pre-fix section printed "Loading charge lines…" through both, so a dead request was
   *  indistinguishable from a slow one and the user had nothing to click. */
  failed?: boolean;
  sort?: PayerIntelGridSort;
  /** Absent = the headers render as plain text. Sorting refetches page 1 in the new order; the
   *  keyset cursor is rebuilt from it, so a stale cursor can never walk the previous ordering. */
  onSort?: (next: PayerIntelGridSort) => void;
  onRetry?: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section aria-label="Charge lines" data-pi-section="grid">
      <SectionHead
        title="Charge lines"
        meta={`row-level detail · ${page?.rows.length ?? 0} shown`}
      />
      {failed && !loading ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink600"
          role="status"
        >
          <span>Charge lines could not be loaded. The summary above is unaffected.</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink900 transition-colors hover:bg-teal50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : page === null ? (
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
                  <SortableTh column="charge_date" label="Charge From" sort={sort} onSort={onSort} />
                  <SortableTh column="payment_received" label="Payment Received" sort={sort} onSort={onSort} />
                  {/* CPT / Revenue / Payer / Facility / Employer are NOT sortable — the keyset
                      cursor is built from the sort column, and these have no index to walk. */}
                  <th className="px-3 py-2">CPT</th>
                  <th className="px-3 py-2">Revenue</th>
                  <th className="px-3 py-2">Primary Payer</th>
                  <th className="px-3 py-2">Facility</th>
                  <th className="px-3 py-2">Employer</th>
                  <SortableTh column="charge_amount" label="Charged" sort={sort} onSort={onSort} align="right" />
                  <SortableTh column="allowed_amount" label="Allowed" sort={sort} onSort={onSort} align="right" />
                  <SortableTh column="pct_allowed" label="% Allowed" sort={sort} onSort={onSort} align="right" />
                  <SortableTh column="insurance_payments" label="Ins. Paid" sort={sort} onSort={onSort} align="right" />
                  <SortableTh column="pct_paid" label="% Paid" sort={sort} onSort={onSort} align="right" />
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
