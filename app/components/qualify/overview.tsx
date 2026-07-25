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
 * Mostly pure/presentational; the ONLY hook is HeatingUpCards' useAutoScroll, whose effect never runs
 * under renderToStaticMarkup (effects don't fire there) — so every component still renders hermetically
 * in the tests. Imports are relative so the render test runs under tsx without `@/` resolution.
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

export function BookKpiTiles({
  kpis,
  locActive,
  scopeLabel = null,
}: {
  kpis: QualifyBookKpis | null;
  locActive: boolean;
  /** When set (a resolved payer), the tiles are scoped to that subject — the caption names it instead
   *  of "book-wide". Null = the fresh, unresolved landing (book-wide). */
  scopeLabel?: string | null;
}) {
  // The tiles either read book-wide (landing) or are scoped to the resolved payer (a click/search).
  const scope = scopeLabel ?? 'book-wide';
  const tiles: { key: string; tone: 'g' | 'a'; label: string; value: number | null; caption: string }[] = [
    {
      key: 'allowed',
      tone: 'g',
      label: '% allowed of billed',
      value: kpis?.pctAllowedOfBilled ?? null,
      caption: `${scope} · reliable allowed ÷ billed`,
    },
    {
      key: 'paid-of-allowed',
      tone: 'a',
      label: '% paid of allowed',
      value: kpis?.pctPaidOfAllowed ?? null,
      caption: `${scope} · payer paid ÷ allowed`,
    },
    {
      key: 'paid-of-billed',
      tone: 'a',
      label: '% paid of billed',
      value: kpis?.pctPaidOfBilled ?? null,
      caption: `${scope} · net realization`,
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
  // Continuous marquee (brand-scroller style): the set renders TWICE and the track loops translateX to
  // -50%, so it reads as one seamless, always-moving strip (never the old ping-pong that could sit still
  // when the strip barely overflowed). The duplicate copy is aria-hidden + tabIndex -1 + data-dup, so AT
  // and keyboard see each facility ONCE. Hover / keyboard-focus pauses the loop so a card can be clicked
  // while stationary; prefers-reduced-motion turns it into a plain, manually-scrollable row (globals.css
  // `.q-marquee`). Duration scales with the card count so the speed is steady whether 3 or 15 cards.
  const durationSec = Math.max(24, Math.round(trends.length * 4.2));

  const card = (t: QualifyFacilityTrend, i: number, dup: boolean) => {
    const bucket = ratingBucket(t.currentRating);
    const hex = RATING_HEX[bucket];
    const active = activeKey !== null && t.facilityKey === activeKey;
    const loc = [t.city, t.state].filter(Boolean).join(', ');
    // A card with no resolvable dominant payer can't drive the hybrid — render it inert (no hover-lift,
    // default cursor, disabled) rather than a button whose click silently no-ops.
    const openable = !!t.dominantPayer;
    return (
      <button
        key={dup ? `dup-${t.facilityKey}` : t.facilityKey}
        type="button"
        aria-pressed={active}
        disabled={!openable}
        onClick={() => onOpen?.(t)}
        // The duplicate half is decorative: hide it from AT + the tab order (each facility appears once).
        {...(dup ? ({ 'aria-hidden': true, tabIndex: -1, 'data-dup': 'true' } as const) : {})}
        title={
          openable
            ? `Open ${t.name} — resolves ${t.dominantPayer} and scopes the cases to this facility`
            : `${t.name} — no dominant payer to resolve this window`
        }
        className={[
          'w-[216px] flex-none rounded-xl border bg-card px-3.5 py-3 text-left',
          'transition-[box-shadow,transform] duration-150 ease-out',
          active
            ? 'border-teal500 shadow-ths ring-2 ring-teal500/40'
            : openable
              ? 'border-line shadow-ths-sm hover:-translate-y-0.5 hover:shadow-ths'
              : 'border-line shadow-ths-sm cursor-default',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink900">
          <span className="text-[10px] font-bold text-ink400">#{i + 1}</span>
          <span aria-hidden className="q-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: hex }} />
          <span className="truncate">{t.name}</span>
          {t.careSetting ? (
            <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[#eef4f6] px-2 py-px text-[9px] font-extrabold uppercase tracking-wide text-status-info">
              {LOC_LABEL[t.careSetting]}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5 font-mono text-[24px] font-semibold leading-none text-ink900 tabular-nums">
          {t.currentRating === null ? '—' : Math.round(t.currentRating)}
          <span className="text-[13px] text-ink400">%</span>
          <DeltaTicker deltaPts={t.deltaPts} />
        </div>
        <div className="my-1.5">
          <Spark points={t.points} hex={hex} width={184} height={26} />
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-ink400">
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
  };

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <h2 className="font-head text-[15px] font-semibold tracking-tight">Facilities Heating Up</h2>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-widest text-ink400">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok" />
          Trending · {range}
        </span>
      </div>
      {/* Marquee viewport — pauses on hover / keyboard focus (globals.css). role/list omitted so native
       *  <button> semantics + aria-pressed survive for AT; the aria-hidden duplicate keeps that clean. */}
      <div className="q-marquee group relative overflow-hidden pb-2">
        <div
          className="q-marquee-track flex w-max gap-2.5 pl-0.5 pr-0.5 pt-0.5"
          style={{ animationDuration: `${durationSec}s` }}
        >
          {trends.map((t, i) => card(t, i, false))}
          {trends.map((t, i) => card(t, i, true))}
        </div>
      </div>
    </section>
  );
}

/**
 * Loading placeholder for the ticker. Because the strip now sits ABOVE the finder, its (book-wide,
 * ~2.5–5s) trend query resolving must not shove the primary search control down the page — this holds
 * the strip's vertical space with the same header + card footprint until real cards replace it.
 * aria-hidden (ghost content is not announced); collapses to static under prefers-reduced-motion.
 */
export function HeatingUpSkeleton() {
  return (
    <section aria-hidden>
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink400">Facilities Heating Up</h2>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink400">Loading trends…</span>
      </div>
      <div className="flex gap-2.5 overflow-hidden pb-2 pl-0.5 pr-0.5 pt-0.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-[216px] flex-none rounded-xl border border-line bg-card px-3.5 py-3">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-6 animate-pulse rounded bg-line" />
              <div className="h-2.5 w-24 animate-pulse rounded bg-line" />
            </div>
            <div className="mt-2 h-6 w-20 animate-pulse rounded bg-line" />
            <div className="my-1.5 h-[26px] w-full animate-pulse rounded bg-line" />
            <div className="h-2.5 w-28 animate-pulse rounded bg-line" />
          </div>
        ))}
      </div>
    </section>
  );
}
