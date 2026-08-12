'use client';

/**
 * THE LANE RAIL — the Smoke shell's left pane (mock: `.rail`, docs/mockups/qualify-smoke.html).
 *
 * "One search = one guardrailed swimlane." The rail holds the SESSION: the head (what lane you are
 * in + Start over), the LOCK STRIP (the guardrail, stated), the staged flow itself (the existing
 * ResolutionStages, passed as children — this component adds chrome, never flow logic), and the
 * slots-only composer at the bottom.
 *
 * PHI: the strip renders `echo` (prefix-safe by construction — '' for a full member ID) and
 * `readAs` (a sentence ABOUT the identifier that never embeds it, contract.ts's own rule). The raw
 * term never reaches this component; Start over only signals the owner, which clears its own ref.
 */
import type { ReactNode } from 'react';

export function LaneRail({
  echo,
  readAs,
  hasResolution,
  onReset,
  composer,
  children,
}: {
  /** The ≤3-char prefix echo ('' for a full-member-ID search — still a lane, echoed as masked). */
  echo: string;
  /** contract.ts's handle sentence, e.g. "read as a 3-character member-ID prefix". Null pre-search. */
  readAs: string | null;
  hasResolution: boolean;
  onReset: () => void;
  composer: ReactNode;
  children: ReactNode;
}) {
  return (
    // ── THE STICKY RAIL (Alec, 2026-08-12) ────────────────────────────────────────────────────────
    // "The scroll should only happen on the right, the left panel is always sticky and never scrolls,
    // unless the search extends — it should be a separate scroll."
    //
    // ⚠ THE `overflow-y-auto` BELOW HAS BEEN INERT SINCE THE SHELL SHIPPED. This root carried no
    // height and its grid cell is `items-start`, so `flex-1` resolved to CONTENT height and the inner
    // div could never produce a scrollbar. Bounding the root is what turns it on; the head, the lock
    // strip and the composer all gained `shrink-0` in the same change so they pin rather than squash.
    //
    // ⚠ THE MAX-HEIGHT IS 6rem, NOT 2rem, AND THE 4rem DIFFERENCE IS THE HEADER. The global header is
    // `h-14` (3.5rem) and NOT sticky, and <main> adds `sm:p-6` — so at scrollTop 0 this box starts
    // ~80px down the viewport. Capping at `100dvh-2rem` overhangs by ~64px there and pushes the
    // pinned composer (the whole point of the rail) below the fold on first paint, permanently on a
    // short page with nothing to scroll. `100dvh-6rem` fits at every scroll position; the cost is
    // ~64px of unused height once scrolled past the header, which is the cheap half of the trade.
    // The precise fix is a `--ths-header-h` custom property declared in app/layout.tsx and consumed
    // here — deliberately NOT taken, because this file does not own the header.
    //
    // ⚠ `xl:` ON EVERY CLASS IS MANDATORY. Below 1280px the shell grid is `grid-cols-1` and this rail
    // PRECEDES the board in source order, so an unguarded sticky full-height rail buries it.
    <div
      className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface shadow-ths-sm xl:sticky xl:top-4 xl:max-h-[calc(100dvh-6rem)]"
      data-testid="qualify-lane-rail"
    >
      {/* head — the session crumb + the reset. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-teal700 text-[12px] text-white">▤</span>
        <span className="min-w-0 flex-1 truncate font-head text-[13.5px] font-semibold tracking-tight text-ink900">
          {hasResolution ? `Lane · ${echo !== '' ? echo : 'member ID'}` : 'New session'}
        </span>
        <button
          type="button"
          onClick={onReset}
          // aria-disabled, not disabled: a disabled control drops keyboard focus to <body> the
          // moment it lands (the refresh control's lesson, flow-state.ts) — the handler no-ops
          // instead, and the treatment says why it is inert.
          aria-disabled={!hasResolution}
          className={[
            'rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
            hasResolution
              ? 'border-teal200 text-teal700 hover:bg-teal50'
              : 'cursor-default border-line text-ink400',
          ].join(' ')}
        >
          ⟲ Start over
        </button>
      </div>

      {/* the lock strip — the guardrail, stated where the operator works. */}
      <p className="shrink-0 border-b border-line bg-teal50/60 px-4 py-2 font-mono text-[10.5px] leading-relaxed text-teal700">
        {hasResolution ? (
          <>
            <span aria-hidden>🔒 </span>
            Locked to {echo !== '' ? <b>{echo}</b> : 'this member ID'}
            {readAs ? ` — ${readAs}` : ''}. Answers come only from this lane&rsquo;s matched lines — nothing outside it.
          </>
        ) : (
          <>No lane yet — identify a client below to open one. One search, one lane.</>
        )}
      </p>

      {/* the staged flow — the existing v3 machinery, untouched, at rail width. */}
      {/* ⚠ THIS IS THE PAGE'S ONE INNER SCROLLER AS OF 2026-08-12, and GSAP has to be told. Any
          ScrollTrigger over a node inside here needs `scroller: [data-v3-rail-scroll]` — `scroll`
          does not bubble from an overflow div to window, and tiles here start at `autoAlpha: 0`
          (visibility:hidden, unclickable, out of the a11y tree). See resolution-flow-client.tsx. */}
      <div data-v3-rail-scroll className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {/* the composer — slots only, pinned to the rail's foot like the mock. */}
      {composer}
    </div>
  );
}
