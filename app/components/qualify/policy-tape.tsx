'use client';

/**
 * THE POLICY TAPE — trending prefixes/policies, as a stock ticker.
 *
 * The first surface to read collections.qualify_policy_rating_daily (mig 0093): each item is one
 * (member-ID prefix × payer) pair whose 90-day policy rating MOVED, newest closed snapshot vs the
 * same pair 90 days earlier. It answers "what is the book doing" before anyone has typed anything —
 * the orientation the facility ticker gives for places, given for policies.
 *
 * DELIBERATELY THE SAME MACHINE AS "Facilities Heating Up", not a second one: it drives `useMarquee`
 * over a real overflow-x container, so the strip is hand-scrollable, loops seamlessly, pauses on
 * hover/focus, and drops its auto-motion under prefers-reduced-motion while staying scrollable. The
 * mockup this came from used a CSS-transform marquee; that cannot be hand-scrolled, and shipping a
 * second scrolling idiom on one page would have been the drift, not the feature.
 *
 * READ-ONLY BY CONSTRUCTION. Every item is inert — a <li>, not a button. Clicking a policy would
 * mean seeding a search from it, and the search rewrite owns what a seeded search means; an
 * interactive-looking card whose click no-ops is the dead-target failure heating-ticker.tsx already
 * refuses to ship. When there is a seed path, this becomes buttons in one deliberate change.
 *
 * ── PHI ────────────────────────────────────────────────────────────────────────────────────────
 * Nothing here identifies a person. The pair's identity is the keyed-HMAC prefix TOKEN, and what
 * renders is either its last 6 hex characters (opaque by construction — the token is declared
 * not-PHI in blindIndex.ts) or, when the search path has recorded one, the ≤3-char alpha-prefix
 * ECHO the UI already displays elsewhere (core.ts `alphaEcho`, policy-strip.tsx). Payer labels,
 * ratings, deltas and counts are the same non-PHI aggregate vocabulary every Qualify strip ships,
 * and the read projects NO dollar column — so an `admissions_seat` receives identical bytes.
 *
 * ── A11Y ───────────────────────────────────────────────────────────────────────────────────────
 * Movement carries WORDS, never hue alone: every delta reads "▲ +16 pts" / "▼ −11 pts", and each
 * item has an accessible name naming the payer, the rating and the movement. Nothing meaning-
 * bearing is below 12px. The marquee duplicate is aria-hidden so AT reads each policy once.
 */
import { memo } from 'react';
import type { QualifyPolicyTapeItem } from '../../lib/qualify/board';
import { IQ_BAND_HEX } from './tokens';
import { useMarquee } from './useMarquee';

/**
 * Movement colours for the INVERSE (dark teal) ground this strip sits on. The status palette in
 * tailwind.config is tuned for the light card ground and reads muddy here — status-ok #2E8B6F is
 * 2.1:1 on teal900. These are the dark-set values from the merged token file, both >= 7:1 on
 * #0E3A3A. Colour is reinforcement only; the arrow and the "pts" wording carry the meaning.
 */
const TAPE_UP = '#46C4B8';
const TAPE_DOWN = '#F0917C';

/** Ratings move in whole points, so anything non-zero is real movement — no dead-band needed. */
function DeltaText({ deltaPts }: { deltaPts: number }) {
  const up = deltaPts > 0;
  return (
    <span
      className="font-mono text-xs font-medium"
      style={{ color: up ? TAPE_UP : deltaPts < 0 ? TAPE_DOWN : '#FFFFFF8A' }}
    >
      {up ? '▲ +' : deltaPts < 0 ? '▼ ' : '◆ '}
      {deltaPts}
      {' pts'}
    </span>
  );
}

/** What the operator reads as the policy's handle: the recorded echo, else the opaque token tail. */
function handleOf(item: QualifyPolicyTapeItem): string {
  return item.echo ?? `⋯${item.tokenTail.slice(-4)}`;
}

export const PolicyTapeStrip = memo(function PolicyTapeStrip({
  items,
  asOf,
  deltaDays,
}: {
  items: readonly QualifyPolicyTapeItem[];
  asOf: string | null;
  deltaDays: number;
}) {
  // Hook before any early return (rules of hooks). resetKey is the snapshot date: a new night's
  // data reads from the left.
  const { ref: scrollRef, isOverflowing } = useMarquee<HTMLUListElement>(asOf, items.length);
  if (items.length === 0) return null;

  const item = (p: QualifyPolicyTapeItem, dup: boolean) => {
    const band = p.bandNow ?? '0';
    return (
      <li
        key={dup ? `dup-${p.token}-${p.payer}` : `${p.token}-${p.payer}`}
        // The duplicate half is decorative — AT and the tab order see each policy exactly once.
        aria-hidden={dup || undefined}
        // `.q-marquee [data-dup='true']` is how reduced-motion hides the decorative half: the hook
        // stops the auto-scroll but the strip stays hand-scrollable, and without this attribute a
        // reduced-motion user would scroll past every policy twice. aria-hidden alone does not do it
        // — it hides the duplicate from AT, not from eyes.
        data-dup={dup ? 'true' : undefined}
        className="flex flex-none items-baseline gap-2.5 border-r border-white/10 px-5"
      >
        <span className="font-mono text-xs font-medium tracking-wide text-white">{handleOf(p)}</span>
        <span className="max-w-[168px] truncate text-xs text-white/60">{p.payer}</span>
        <span className="font-mono text-[15px] font-semibold" style={{ color: IQ_BAND_HEX[band] }}>
          {p.ratingNow}
        </span>
        <DeltaText deltaPts={p.deltaPts} />
      </li>
    );
  };

  return (
    <section aria-label="Policies on the move" className="mb-4">
      <div className="mb-2.5 flex items-baseline gap-2 px-0.5">
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink900">Policies on the Move</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">
          {deltaDays}-day rating change{asOf ? ` · as of ${asOf}` : ''}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl bg-teal900 shadow-ths-sm">
        {/* ⚠ THE SCROLL CONTAINER IS THE <ul> ITSELF, AND THAT IS A REQUIREMENT, NOT A STYLE CHOICE.
            `useMarquee` indexes `el.children` directly — `[itemsPerSet - 1]` to measure whether one
            set overflows the strip, `[itemsPerSet]` to find the seamless-loop distance. This shipped
            with the ref on a wrapper <div> holding a single <ul>, so `el.children` was `[ul]`: every
            index past 0 read `undefined`, `isOverflowing` latched false forever, and the tape
            therefore never auto-scrolled and never rendered its duplicate half. Nothing threw and
            nothing looked broken in the DOM — the strip just sat still (fixed 2026-08-09, Alec:
            "the scrolling for policies on the move does not work").
            The ref element's DIRECT children must be the items. `policy-tape-render.test.tsx` pins
            it, because this is invisible to every assertion about content. */}
        <ul ref={scrollRef} className="q-marquee flex items-center py-2.5">
          {items.map((p) => item(p, false))}
          {/* Only duplicated once the real set genuinely overflows — otherwise a short list
              would render every policy twice. `isOverflowing` is false until measured, and
              effects never run under renderToStaticMarkup, so the hermetic tests see ONE set. */}
          {isOverflowing && items.map((p) => item(p, true))}
        </ul>
      </div>
      {/* The scope claim, stated rather than implied: this is the whole book, not a search. */}
      <p className="mt-1.5 px-0.5 text-xs text-ink400">
        Across the book · {items.length} {items.length === 1 ? 'policy' : 'policies'} with enough
        history to compare
      </p>
    </section>
  );
});

export function PolicyTapeSkeleton() {
  return (
    <section aria-hidden className="mb-4">
      <div className="mb-2.5 flex items-baseline gap-2 px-0.5">
        {/* IDENTICAL to the real header above — the shell swaps one node for the other, so a size
            mismatch here is a layout shift on every load. Move the two together. */}
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink400">Policies on the Move</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">Loading movement…</span>
      </div>
      <div className="h-[46px] animate-pulse rounded-xl bg-teal900/10" />
    </section>
  );
}
