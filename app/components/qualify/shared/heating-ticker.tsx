'use client';

/**
 * "Facilities Heating Up" — the auto-scrolling trend ticker. SHARED by both Qualify surfaces.
 *
 * WHY IT LIVES HERE (moved out of `overview.tsx` 2026-08-06). It was one of four exports in a
 * 417-line module whose other three are the book KPI tiles and the evidence gauge. The v3 staged
 * flow wants the ticker and NOT the tiles — the tiles are book-wide numbers that outrank a client's
 * answer visually, which is why v3 moves them behind a disclosure — so importing `overview.tsx`
 * would have dragged them into the v3 bundle and invited a future edit to render them "since they're
 * already imported". One component per concern; both surfaces mount the identical strip.
 *
 * Behaviour (unchanged by the move — this is a lift, not a rewrite): a real horizontal scroll
 * container the user can drag/wheel, auto-scrolling and looping seamlessly via `useMarquee`. The set
 * renders TWICE only when it overflows; the duplicate is aria-hidden + tabIndex -1 so AT and the
 * keyboard see each facility once. Pauses on hover/focus/scroll, force-paused while `pinned`, snaps
 * back when the window changes. Reduced-motion drops the auto-motion and stays hand-scrollable
 * (`.q-marquee` in globals.css).
 *
 * NON-PHI: facility names, ratings, deltas, line counts and cities. No member, patient or employer
 * identity, and no dollar figure — so the strip is byte-identical for an `admissions_seat`.
 */
import { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { ratingBucket } from '../../../lib/qualify/rating';
import { qualifyWindowLabel, serializeQualifyWindow } from '../../../lib/qualify/contract';
import type { QualifyFacilityTrend, QualifyWindow } from '../../../lib/qualify/contract';
import { RATING_HEX } from '../tokens';
import { Spark } from '../spark';
import { useMarquee } from '../useMarquee';

const LOC_LABEL: Record<'IP' | 'OP' | 'BOTH', string> = { IP: 'IP', OP: 'OP', BOTH: 'Both' };

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
  scopePayer = null,
  activeFacilityKeys = EMPTY_KEYS,
  pinned = false,
  readOnly = false,
  onOpen,
}: {
  trends: readonly QualifyFacilityTrend[];
  window: QualifyWindow;
  /** Design B ticker scope: a payer name → the ticker is that payer's improvers; null → book-wide.
   *  Labeled next to the title so the scope is legible (the ticker is book-wide-within-payer). */
  scopePayer?: string | null;
  /** facilityKeys of the cards whose facility is currently in the compose selection (marked pressed).
   *  A SET — the compose bar can select several facilities, so more than one card can read pressed. */
  activeFacilityKeys?: ReadonlySet<string>;
  /** tickerPinned — force-pause the marquee (a card click set it). A DISTINCT flag owned by the
   *  container, NOT derived from the facility selection; pointer/focus/scroll can't resume it, only the
   *  container's clear actions clear it. */
  pinned?: boolean;
  /**
   * INFORMATIONAL mode — every card renders inert regardless of its dominant payer.
   *
   * For the v3 staged flow, where the strip is orientation ("the book is alive, here is what is
   * moving") and there is no facility-first resolve path to click into: v3 resolves a member, not a
   * facility. Without this the cards would look and tab like buttons and no-op on click, which is
   * exactly the dead-target failure the `openable` branch below already refuses to ship.
   */
  readOnly?: boolean;
  /** Ticker-card click — the container REPLACES the whole filter set with {this facility, its dominant
   *  payer}. Optional for tests. */
  onOpen?: (trend: QualifyFacilityTrend) => void;
}) {
  // Hook BEFORE the early return (rules of hooks — the call must run on every render).
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
    // A card with no resolvable dominant payer — or the whole strip in readOnly mode — can't drive
    // anything, so render it inert (no hover-lift, default cursor, disabled) rather than a button
    // whose click silently no-ops.
    const openable = !!t.dominantPayer && !readOnly;
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
          readOnly
            ? `${t.name} — trend for orientation`
            : openable
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
          Trending · {range} · {scopePayer ?? 'across the book'}
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
 * Loading placeholder for the ticker. Because the strip sits ABOVE the finder, its (book-wide,
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
