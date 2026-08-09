'use client';

/**
 * "Facility Momentum" — the auto-scrolling trend ticker. SHARED by both Qualify surfaces.
 *
 * RENAMED FROM "Facilities Heating Up" 2026-08-09, in the same change that removed the top-15 cut
 * (`QUALIFY_TREND_TOP_N`). The strip now carries every facility that clears the sample gates, in
 * rank order by rating delta — risers at the head, decliners at the tail — so the old one-directional
 * name would have been contradicted by its own cards. See the title's comment for the argument.
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
  openAs = 'facility_payer',
  onOpen,
  onExplain,
  explainingKey = null,
}: {
  trends: readonly QualifyFacilityTrend[];
  window: QualifyWindow;
  /** Design B ticker scope: a payer name → the ticker is that payer's improvers; null → book-wide.
   *  Labeled next to the title so the scope is legible (the ticker is book-wide-within-payer). */
  scopePayer?: string | null;
  /** facilityKeys of the cards that should render pressed, meaning something different per surface:
   *  · v2's compose bar (`openAs: 'facility_payer'`) — the cards currently IN the compose selection.
   *  · v3's answer stage (`openAs: 'area'`, resolution-flow-client.tsx `tickerActiveKeys`) — the cards
   *    whose OWN `state` matches the answer-stage AREA facet that is currently active, i.e. every
   *    trend row in the same bucket a click on this strip would seed. Book-wide trends, member-scoped
   *    ranking: a pressed card here is a claim about the FACET, not about this member's history at
   *    that facility.
   *  A SET either way — several cards can share a bucket (or, on v2, be multi-selected). */
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
  /**
   * WHAT A CLICK MEANS — the two surfaces read the same card differently, and the card must say
   * which, because a title that promises the wrong narrow is worse than an inert card.
   *
   * · 'facility_payer' (default, v2's tab) — the container replaces the whole filter set with
   *   {this facility, its dominant payer}. A card with NO dominant payer cannot express that, so it
   *   renders inert.
   * · 'area' (v3's answer stage) — the click seeds the answer-stage AREA facet from the card's
   *   `state`. `dominantPayer` is irrelevant to that, and an unmapped card is not a dead card
   *   either: it seeds the 'Other' bucket, which the ranked grid honours. So EVERY card is openable
   *   in this mode.
   *
   * A string union rather than a callback, deliberately: this component is `memo`'d, and a function
   * prop would have to be `useCallback`'d at every mount to keep that memo from being decorative.
   */
  openAs?: 'facility_payer' | 'area';
  /** Ticker-card click. `openAs` says what the container does with it. Optional for tests. */
  onOpen?: (trend: QualifyFacilityTrend) => void;
  /**
   * ASK THE MODEL WHY THIS CARD READS AS IT DOES (Alec, 2026-08-09: *"If a user clicks on any one of
   * the tickers, they should be able to receive an AI response that explains the meaning behind why
   * the ticker has the rating that it has"*).
   *
   * ⚠ WHEN PRESENT IT **OVERRIDES** `onOpen` AND `readOnly` — every card becomes a live explain
   * target. That is a deliberate supersede, not an oversight, and it costs v3's answer stage its
   * area-seeding shortcut: a click there used to narrow the ranked grid to the card's state. Nothing
   * is lost that the operator cannot reach — AREA is a first-class control sitting beside the grid it
   * narrows (`AreaLine`), which is where that ruling put its real home; the ticker was a shortcut to
   * it. Alec's newer instruction assigns the click ONE meaning across every strip and every stage,
   * and two different meanings for the same gesture depending on which stage you were on is the
   * ambiguity worth trading the shortcut away for.
   *
   * v2's tab and the mobile surface pass nothing here, so their `onOpen` behaviour is byte-unchanged.
   */
  onExplain?: (trend: QualifyFacilityTrend) => void;
  /** facilityKey of the card whose explanation is open — renders it pressed. */
  explainingKey?: string | null;
}) {
  // Hook BEFORE the early return (rules of hooks — the call must run on every render).
  const { ref: scrollRef, isOverflowing } = useMarquee<HTMLDivElement>(
    serializeQualifyWindow(window),
    trends.length,
    // Force-paused while an explanation is open too: the strip must not scroll the card the reader
    // is being told about out from under them.
    pinned || explainingKey !== null,
  );
  if (trends.length === 0) return null;
  const range = qualifyWindowLabel(window);

  const card = (t: QualifyFacilityTrend, i: number, dup: boolean) => {
    const bucket = ratingBucket(t.currentRating);
    const hex = RATING_HEX[bucket];
    const explains = onExplain !== undefined;
    const active = explains ? explainingKey === t.facilityKey : activeFacilityKeys.has(t.facilityKey);
    const loc = [t.city, t.state].filter(Boolean).join(', ');
    // A card that can't drive anything renders inert (no hover-lift, default cursor, disabled)
    // rather than as a button whose click silently no-ops. readOnly kills the whole strip; past
    // that, what makes a card drivable depends on what the click MEANS — see `openAs`. In 'area'
    // mode an unmapped card is still drivable (it seeds 'Other'), which is why this is not simply
    // `!!t.dominantPayer` any more.
    // ⚠ `explains` short-circuits all of it: with an explain handler EVERY card is live, including
    // the ones `readOnly` would have made inert — that is the whole point of the 2026-08-09 ruling
    // (see `onExplain`). The dead-target rule is still honoured; the target simply exists now.
    const openable = explains || (!readOnly && (openAs === 'area' || !!t.dominantPayer));
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
        onClick={() => (explains ? onExplain(t) : onOpen?.(t))}
        // The duplicate half is decorative: hide it from AT + the tab order (each facility appears once).
        {...(dup ? ({ 'aria-hidden': true, tabIndex: -1, 'data-dup': 'true' } as const) : {})}
        title={
          explains
            ? `Why is ${t.name} rated this way?`
            : readOnly
            ? `${t.name} — trend for orientation`
            : openAs === 'area'
              ? // `t.state`, NOT `loc`: a card with a city but no state is an UNMAPPED-area card,
                // and `loc` would be truthy for it and print "…to null".
                t.state
                ? `Narrow the ranked list to ${t.state}`
                : 'Narrow the ranked list to facilities with no mapped area'
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
          <span className="text-xs font-bold text-ink400">#{i + 1}</span>
          <span aria-hidden className="q-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: hex }} />
          {t.careSetting ? (
            // The v3 flow's house category pill (resolution-flow.tsx:921-924) rather than a bespoke
            // one: same fill token, same padding, same weight. `uppercase`/`extrabold`/`tracking-wide`
            // were 9px legibility compensation and are not needed at 13px — the precedent pill
            // carries none of them.
            <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-status-info/10 px-2 py-0.5 text-xs font-semibold text-status-info">
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
        {/* 10px → 13px on a 188px content row: the left span previously had no truncation
            discipline, so at the larger size it would win the flex fight and starve the City, ST
            span on the right to nothing — the location would silently VANISH rather than shrink.
            `min-w-0 truncate` on both is what makes the size change safe; it is not tidying. */}
        <div className="flex items-center justify-between gap-2 text-xs text-ink400">
          {/* Change A: "n" is DEFINED — claim lines backing the rating, never a bare n=. */}
          <span className="min-w-0 truncate">
            {t.lineCount.toLocaleString('en-US')} claim lines · {range}
          </span>
          <span className="min-w-0 truncate text-right">{loc}</span>
        </div>
      </button>
    );
  };

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        {/* ── THE TITLE IS "MOMENTUM", NOT "HEATING UP" (Alec, 2026-08-09) ──────────────────────────
            The old name was accurate only because the strip was structurally incapable of showing a
            decline: it took the top 15 of an ORDER BY `delta desc`, so a falling facility could never
            reach the screen. With the cut removed (`QUALIFY_TREND_TOP_N`) the strip now carries the
            whole book in rank order — biggest riser first, biggest faller last — and "Heating Up"
            over a card reading ▼ -7 pts would be the title contradicting the data beneath it.
            "Momentum" is signed: it covers both directions and still means movement, which is what
            the ranking is. The eyebrow says the direction out loud rather than leaving it to be
            inferred from the arrows. ── */}
        <h2 className="font-head text-[15px] font-semibold tracking-tight">Facility Momentum</h2>
        {/* The v3 flow's house eyebrow (resolution-flow.tsx:587, :1128 and 9 more): text-xs /
            font-medium / tracking-wide. `extrabold` + `tracking-widest` existed only to make 10px
            readable. Must stay in lockstep with the skeleton's eyebrow below — see the CLS note. */}
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink400">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok" />
          Rising and falling · {range} · {scopePayer ?? 'across the book'}
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
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink400">Facility Momentum</h2>
        {/* IDENTICAL to the real header's eyebrow above, and not merely for tidiness: the shell
            swaps this exact node for that one when trends resolve (resolution-flow-client.tsx:403-411),
            so a size mismatch here is a layout shift on every load. Move the two together — the title
            included: the 2026-08-09 rename had to land in BOTH or the strip would change its own name
            the moment its data arrived. */}
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">Loading trends…</span>
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
