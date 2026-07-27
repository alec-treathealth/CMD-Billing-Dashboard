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
import { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { ratingBucket } from '../../lib/qualify/rating';
import { qualifyWindowLabel, serializeQualifyWindow } from '../../lib/qualify/contract';
import type { QualifyBookKpis, QualifyFacilityTrend, QualifyMatchSummary, QualifyWindow } from '../../lib/qualify/contract';
import { RATING_HEX, staggerDelayMs } from './tokens';
import { Spark } from './spark';
import { useMarquee } from './useMarquee';

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

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export const HeatingUpCards = memo(function HeatingUpCards({
  trends,
  window,
  activeFacilityKeys = EMPTY_KEYS,
  pinned = false,
  onOpen,
}: {
  trends: readonly QualifyFacilityTrend[];
  window: QualifyWindow;
  /** facilityKeys of the cards whose facility is currently in the compose selection (marked pressed).
   *  A SET — the compose bar can select several facilities, so more than one card can read pressed. */
  activeFacilityKeys?: ReadonlySet<string>;
  /** tickerPinned — force-pause the marquee (a card click set it). A DISTINCT flag owned by the
   *  container, NOT derived from the facility selection; pointer/focus/scroll can't resume it, only the
   *  container's clear actions clear it. */
  pinned?: boolean;
  /** Ticker-card click — the container REPLACES the whole filter set with {this facility, its dominant
   *  payer}. Optional for tests. */
  onOpen?: (trend: QualifyFacilityTrend) => void;
}) {
  // Continuous, MANUALLY-SCROLLABLE marquee (useMarquee): a real scroll container the user can drag /
  // wheel left↔right, that keeps auto-scrolling and loops seamlessly. The set renders TWICE ONLY WHEN it
  // overflows the strip (`isOverflowing`) — the hook wraps scrollLeft at the first duplicate; when a
  // filtered list already fits, one static set renders (no phantom duplicate, no useless rAF). Pauses on
  // hover / focus / active scroll and resumes shortly after; FORCE-PAUSED while `pinned`; SNAPS BACK to
  // the start when the window filter changes (resetKey). The duplicate copy is aria-hidden + tabIndex -1
  // + data-dup so AT and keyboard see each facility ONCE. Reduced-motion → no auto-motion, still
  // hand-scrollable (globals.css `.q-marquee`). Hook BEFORE the early return (rules of hooks — the call
  // must run on every render).
  const { ref: scrollRef, isOverflowing } = useMarquee<HTMLDivElement>(
    serializeQualifyWindow(window),
    trends.length,
    pinned,
  );
  if (trends.length === 0) return null;
  const range = qualifyWindowLabel(window);

  const card = (t: QualifyFacilityTrend, i: number, dup: boolean) => {
    const bucket = ratingBucket(t.currentRating);
    const hex = RATING_HEX[bucket];
    const active = activeFacilityKeys.has(t.facilityKey);
    const loc = [t.city, t.state].filter(Boolean).join(', ');
    // A card with no resolvable dominant payer can't drive the hybrid — render it inert (no hover-lift,
    // default cursor, disabled) rather than a button whose click silently no-ops.
    const openable = !!t.dominantPayer;
    return (
      <button
        key={dup ? `dup-${t.facilityKey}` : t.facilityKey}
        type="button"
        // Only the REAL card carries interactive state; the aria-hidden marquee duplicate is
        // decorative (its pressed look comes from `active` in className below), so it must not
        // advertise aria-pressed to AT or the DOM — otherwise an active card exposes the pressed
        // state twice. `undefined` omits the attribute entirely on the duplicate.
        aria-pressed={dup ? undefined : active}
        disabled={!openable}
        onClick={() => onOpen?.(t)}
        // The duplicate half is decorative: hide it from AT + the tab order (each facility appears once).
        {...(dup ? ({ 'aria-hidden': true, tabIndex: -1, 'data-dup': 'true' } as const) : {})}
        title={
          openable
            ? `Filter to ${t.name} + ${t.dominantPayer}`
            : `${t.name} — no dominant payer to filter on this window`
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
        {/* Meta row: rank + rating dot + LOC pill, and — on OPENABLE cards only — an always-visible
            chevron in the top-right corner signalling the card is clickable (hover-lift + focus ring are
            secondary confirmation). Inert cards get no glyph. The name moves to its own row below so a
            2-line clamp never fights the pill. */}
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink900">
          <span className="text-[10px] font-bold text-ink400">#{i + 1}</span>
          <span aria-hidden className="q-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: hex }} />
          {t.careSetting ? (
            <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[#eef4f6] px-2 py-px text-[9px] font-extrabold uppercase tracking-wide text-status-info">
              {LOC_LABEL[t.careSetting]}
            </span>
          ) : null}
          {openable ? (
            <ChevronRight
              aria-hidden
              className={`h-3 w-3 shrink-0 text-teal500 ${t.careSetting ? '' : 'ml-auto'}`}
              strokeWidth={2.5}
            />
          ) : null}
        </div>
        <div className="mt-1 min-h-[2.25rem]">
          <span className="line-clamp-2 break-words text-[12.5px] font-semibold leading-[1.15] text-ink900">
            {t.name}
          </span>
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
          <span className="truncate text-right">{loc}</span>
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
      {/* Marquee = a real horizontal scroll container (useMarquee drives scrollLeft). role/list omitted
       *  so native <button> semantics + aria-pressed survive for AT; the aria-hidden duplicate half keeps
       *  that clean. Scrollbar hidden via `.q-marquee` (still fully scrollable). */}
      <div ref={scrollRef} className="q-marquee group relative flex gap-2.5 pb-2 pl-0.5 pr-0.5 pt-0.5">
        {trends.map((t, i) => card(t, i, false))}
        {/* The aria-hidden duplicate set exists ONLY to make the auto-scroll loop seamless — render it
            solely when the real set overflows the strip (useMarquee measured it). When the LOC lens /
            search shrinks the list enough to fit, one static set shows and each facility appears once. */}
        {isOverflowing ? trends.map((t, i) => card(t, i, true)) : null}
      </div>
    </section>
  );
});

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

/**
 * The compose-bar LIVE MATCH COUNT readout — "N charge lines match" + the two NON-DOLLAR percentages
 * (allowed÷billed · paid÷billed). Dollar totals appear ONLY for a viewer with the amounts capability;
 * an admissions_seat sees the count + percentages with ZERO dollars (the server already stripped them —
 * `summary.totalCharge` is null — and this gates on `hasAmounts` too, defense-in-depth). A null ratio
 * renders "—" (a collapsed denominator is never a fabricated 0%). Presentational leaf (hermetic).
 */
export function MatchCountReadout({
  summary,
  loading,
  hasAmounts,
}: {
  summary: QualifyMatchSummary | null;
  loading: boolean;
  hasAmounts: boolean;
}) {
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);
  const money = (v: number | null) =>
    v === null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-2xl border border-line bg-card px-5 py-3.5 shadow-ths-sm">
      <span className="font-mono text-[26px] font-semibold leading-none tabular-nums text-ink900">
        {loading && !summary ? '…' : (summary?.count ?? 0).toLocaleString('en-US')}
      </span>
      <span className="text-[13px] font-semibold text-ink600">charge lines match</span>
      {summary ? (
        <span className="ml-1 flex flex-wrap items-baseline gap-x-4 text-[12px] text-ink400">
          <span>
            allowed <b className="font-mono text-ink600">{pct(summary.pctAllowedOfBilled)}</b> of billed
          </span>
          <span>
            paid <b className="font-mono text-ink600">{pct(summary.pctPaidOfBilled)}</b> of billed
          </span>
          {hasAmounts ? (
            <span>
              billed <b className="font-mono text-ink600">{money(summary.totalCharge)}</b>
            </span>
          ) : null}
        </span>
      ) : null}
      {loading ? <span className="text-[11px] uppercase tracking-wide text-teal600">updating…</span> : null}
    </div>
  );
}
