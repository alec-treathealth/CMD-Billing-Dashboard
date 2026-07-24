'use client';

/**
 * Qualify OVERVIEW strip (redesign) — the "book at a glance" above the resolved payer:
 *
 *   1. BookKpiTiles — the three book-wide KPI gradient tiles (% allowed of billed · % paid of
 *      allowed · % paid of billed). PERCENTAGES ONLY (the contract never carries the dollar sums, so
 *      the tiles are identical for every role). Book-wide by design: the LOC lens does NOT re-scope
 *      them (ruled view-only v1) — a caption says so whenever the lens is active. A null ratio
 *      renders "—" (a collapsed denominator is never a fabricated 0%).
 *
 *   2. HeatingUpCards — "Facilities Heating Up": the top facilities by RATING DELTA (current window
 *      vs the previous equivalent period), each with its sparkline (draw-in), Δpts ticker, LOC tag,
 *      entity label, and the DEFINED "n" (Change A: "{n} claim lines" — never a bare n=). Click →
 *      the Change-E hybrid (resolve the facility's dominant payer + scope to the facility) — wired
 *      by the container via onOpen(trend).
 *
 * Pure/presentational (no hooks) so both render hermetically under renderToStaticMarkup. Imports are
 * relative so the render test runs under tsx without `@/` resolution.
 */
import { ratingBucket } from '../../lib/qualify/rating';
import { qualifyWindowLabel } from '../../lib/qualify/contract';
import type { QualifyBookKpis, QualifyFacilityTrend, QualifyWindow } from '../../lib/qualify/contract';
import { RATING_HEX, staggerDelayMs } from './tokens';
import { Spark } from './spark';

const LOC_LABEL: Record<'IP' | 'OP' | 'BOTH', string> = { IP: 'IP', OP: 'OP', BOTH: 'Both' };

function pctText(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}`;
}

export function BookKpiTiles({ kpis, locActive }: { kpis: QualifyBookKpis | null; locActive: boolean }) {
  const tiles: { key: string; tone: 'g' | 'a'; label: string; value: number | null; caption: string }[] = [
    {
      key: 'allowed',
      tone: 'g',
      label: '% allowed of billed',
      value: kpis?.pctAllowedOfBilled ?? null,
      caption: 'book-wide · reliable allowed ÷ billed',
    },
    {
      key: 'paid-of-allowed',
      tone: 'a',
      label: '% paid of allowed',
      value: kpis?.pctPaidOfAllowed ?? null,
      caption: 'book-wide · payer paid ÷ allowed',
    },
    {
      key: 'paid-of-billed',
      tone: 'a',
      label: '% paid of billed',
      value: kpis?.pctPaidOfBilled ?? null,
      caption: 'book-wide · net realization',
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-3">
      {tiles.map((t, i) => (
        <div
          key={t.key}
          className={[
            t.tone === 'g' ? 'q-kpi-g' : 'q-kpi-a',
            'animate-ths-reveal relative overflow-hidden rounded-2xl border border-line px-5 py-4 shadow-ths-sm',
          ].join(' ')}
          style={{ animationDelay: `${staggerDelayMs(i)}ms` }}
        >
          <div className="text-[12.5px] font-semibold text-ink600">{t.label}</div>
          <div
            className={[
              'mt-2 flex items-baseline font-mono text-4xl font-semibold leading-none tabular-nums',
              t.tone === 'g' ? 'text-status-ok' : 'text-status-warn',
            ].join(' ')}
          >
            {pctText(t.value)}
            {t.value !== null ? <span className="ml-0.5 text-lg">%</span> : null}
          </div>
          <div className="mt-2 text-[11px] text-ink400">
            {t.caption}
            {locActive ? ' · not LOC-scoped' : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Δpts ticker: ▲ green / ▼ red / ◆ flat, or "NEW" when there is no prior-window evidence. */
function DeltaTicker({ deltaPts }: { deltaPts: number | null }) {
  if (deltaPts === null) {
    return <span className="text-xs font-bold text-status-info">NEW</span>;
  }
  const up = deltaPts > 0.2;
  const down = deltaPts < -0.2;
  const cls = up ? 'text-status-ok' : down ? 'text-status-danger' : 'text-ink400';
  const arrow = up ? '▲' : down ? '▼' : '◆';
  return (
    <span className={`text-xs font-bold ${cls}`}>
      {arrow} {deltaPts > 0 ? '+' : ''}
      {deltaPts.toFixed(1)} pts
    </span>
  );
}

export function HeatingUpCards({
  trends,
  window,
  activeKey = null,
  onOpen,
}: {
  trends: readonly QualifyFacilityTrend[];
  window: QualifyWindow;
  /** facilityKey of the card whose facility is the current Change-E scope (marked pressed). */
  activeKey?: string | null;
  /** The Change-E hybrid: resolve trend.dominantPayer AND scope to trend.facilityKey. Optional for tests. */
  onOpen?: (trend: QualifyFacilityTrend) => void;
}) {
  if (trends.length === 0) return null;
  const range = qualifyWindowLabel(window);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-semibold tracking-tight">Facilities Heating Up</h2>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink400">
          Trending · {range}
        </span>
      </div>
      {/* Plain scroll row (no role=list): native <button> semantics + aria-pressed must survive for AT. */}
      <div className="flex gap-3 overflow-x-auto pb-2.5 pl-0.5 pr-0.5 pt-0.5">
        {trends.map((t, i) => {
          const bucket = ratingBucket(t.currentRating);
          const hex = RATING_HEX[bucket];
          const active = activeKey !== null && t.facilityKey === activeKey;
          const loc = [t.city, t.state].filter(Boolean).join(', ');
          // A card with no resolvable dominant payer can't drive the hybrid — render it inert (no
          // hover-lift, default cursor, disabled) rather than a button whose click silently no-ops.
          const openable = !!t.dominantPayer;
          return (
            <button
              key={t.facilityKey}
              type="button"
              aria-pressed={active}
              disabled={!openable}
              onClick={() => onOpen?.(t)}
              title={
                openable
                  ? `Open ${t.name} — resolves ${t.dominantPayer} and scopes the cases to this facility`
                  : `${t.name} — no dominant payer to resolve this window`
              }
              className={[
                'animate-ths-reveal w-[272px] flex-none rounded-2xl border bg-card px-4 py-3.5 text-left',
                'transition-[box-shadow,transform] duration-150 ease-out',
                active
                  ? 'border-teal500 shadow-ths ring-2 ring-teal500/40'
                  : openable
                    ? 'border-line shadow-ths-sm hover:-translate-y-0.5 hover:shadow-ths'
                    : 'border-line shadow-ths-sm cursor-default',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
              ].join(' ')}
              style={{ animationDelay: `${staggerDelayMs(i)}ms` }}
            >
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink900">
                <span className="text-[10.5px] font-bold text-ink400">#{i + 1}</span>
                <span aria-hidden className="q-dot inline-block h-2 w-2 rounded-full" style={{ background: hex }} />
                <span className="truncate">{t.name}</span>
                {t.careSetting ? (
                  <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[#eef4f6] px-2 py-px text-[9px] font-extrabold uppercase tracking-wide text-status-info">
                    {LOC_LABEL[t.careSetting]}
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex items-baseline gap-2 font-mono text-[30px] font-semibold leading-none text-ink900 tabular-nums">
                {t.currentRating === null ? '—' : Math.round(t.currentRating)}
                <span className="text-[15px] text-ink400">%</span>
                <DeltaTicker deltaPts={t.deltaPts} />
              </div>
              <div className="my-2">
                <Spark points={t.points} hex={hex} width={232} height={32} />
              </div>
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink400">
                {/* Change A: "n" is DEFINED — claim lines backing the rating, never a bare n=. */}
                <span>
                  {t.lineCount.toLocaleString('en-US')} claim lines · {range}
                </span>
                <span className="truncate text-right">
                  {loc}
                  {t.entity ? `${loc ? ' · ' : ''}${t.entity}` : ''}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
