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

/**
 * THE HANDLE — what the operator reads as this policy's name, best available first.
 *
 * Alec, 2026-08-09: *"showing '⋯820b' but the user doesn't know what these characters mean."* He was
 * looking at the LAST fallback, because it was the only branch that could fire: the echo table is
 * empty and nothing else resolved a label. `prefix` (derived in-process from the token — see
 * prefixLabel.ts) now fills that gap for every prefix in [A-Z0-9].
 *
 * ORDER, and why: a RECORDED echo wins over a DERIVED prefix even though both hold the same kind of
 * string. They can only ever disagree if the recording is wrong, and if that day comes the operator
 * should see what the system actually recorded, not a value this process re-computed.
 */
function handleOf(item: QualifyPolicyTapeItem): string {
  return item.echo ?? item.prefix ?? `⋯${item.tokenTail.slice(-4)}`;
}

/**
 * THE KIND-AND-PLACE CLAUSE — "IP · Sacramento, CA", "OP · 3 facilities", or nothing at all.
 *
 * Answers the second half of Alec's ask ("another unique identifier that tells the user what kind of
 * policy it is, area would also help") from the dominant facility behind the pair.
 *
 * ⚠ THE AREA IS SUPPRESSED WHEN THE PAIR SPANS FACILITIES, and that is the honest reading rather than
 * a layout choice. `area` is ONE facility's city — the one carrying the most claim lines — so
 * printing it beside a policy whose members were treated in three places states a fact about the
 * facility as though it were a fact about the policy. The count replaces it and says the true thing:
 * this policy is treated in several places. Care setting survives the spread because it is the same
 * question ("what kind of care does this policy buy") at either width, and the dominant facility is a
 * fair answer to it.
 */
function kindAndPlaceOf(item: QualifyPolicyTapeItem): string | null {
  const parts: string[] = [];
  if (item.careSetting !== null) parts.push(item.careSetting === 'BOTH' ? 'IP+OP' : item.careSetting);
  if (item.facilityCount > 1) parts.push(`${item.facilityCount} facilities`);
  else if (item.area !== null) parts.push(item.area);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export const PolicyTapeStrip = memo(function PolicyTapeStrip({
  items,
  asOf,
  deltaDays,
  onExplain,
  explainingKey = null,
}: {
  items: readonly QualifyPolicyTapeItem[];
  asOf: string | null;
  deltaDays: number;
  /**
   * ASK THE MODEL WHY THIS MOVED (2026-08-09). Optional: without it every item renders inert, which
   * is the state this component's header describes as "READ-ONLY BY CONSTRUCTION" — that rule is not
   * being broken, it is being retired on the terms it set for itself ("When there is a seed path,
   * this becomes buttons in one deliberate change"). There is now somewhere for a click to go.
   */
  onExplain?: (item: QualifyPolicyTapeItem) => void;
  /** `${token}-${payer}` of the item whose explanation is open — renders that card pressed. */
  explainingKey?: string | null;
}) {
  // Hook before any early return (rules of hooks). resetKey is the snapshot date: a new night's
  // data reads from the left. `pinned` while an explanation is open: the strip must not scroll the
  // card the operator is reading about out from under them.
  const { ref: scrollRef, isOverflowing } = useMarquee<HTMLUListElement>(
    asOf,
    items.length,
    explainingKey !== null,
  );
  if (items.length === 0) return null;

  const item = (p: QualifyPolicyTapeItem, dup: boolean) => {
    const band = p.bandNow ?? '0';
    const key = `${p.token}-${p.payer}`;
    const clause = kindAndPlaceOf(p);
    const move = p.deltaPts > 0 ? `up ${p.deltaPts}` : p.deltaPts < 0 ? `down ${Math.abs(p.deltaPts)}` : 'flat';
    // ONE accessible name for the whole card, on the interactive element — otherwise AT reads five
    // adjacent spans as five unrelated fragments and the movement arrives detached from the policy.
    const label =
      `${handleOf(p)}, ${p.payer}${clause ? `, ${clause}` : ''}. ` +
      `Rating ${p.ratingNow}, ${move} points over ${deltaDays} days.` +
      (onExplain ? ' Explain this move.' : '');
    const body = (
      <>
        <span className="font-mono text-xs font-medium tracking-wide text-white">{handleOf(p)}</span>
        <span className="max-w-[168px] truncate text-xs text-white/60">{p.payer}</span>
        {/* The kind-and-place clause. Absent entirely when the context read gave nothing, rather than
            rendered as an em-dash placeholder — a strip of dashes teaches the eye to skip the slot. */}
        {clause ? <span className="whitespace-nowrap text-xs text-white/45">{clause}</span> : null}
        <span className="font-mono text-[15px] font-semibold" style={{ color: IQ_BAND_HEX[band] }}>
          {p.ratingNow}
        </span>
        <DeltaText deltaPts={p.deltaPts} />
      </>
    );
    return (
      <li
        key={dup ? `dup-${key}` : key}
        // The duplicate half is decorative — AT and the tab order see each policy exactly once.
        aria-hidden={dup || undefined}
        // `.q-marquee [data-dup='true']` is how reduced-motion hides the decorative half: the hook
        // stops the auto-scroll but the strip stays hand-scrollable, and without this attribute a
        // reduced-motion user would scroll past every policy twice. aria-hidden alone does not do it
        // — it hides the duplicate from AT, not from eyes.
        data-dup={dup ? 'true' : undefined}
        className="flex flex-none border-r border-white/10"
      >
        {onExplain ? (
          <button
            type="button"
            // Only the REAL card is interactive; the decorative duplicate must never advertise state
            // or take a tab stop (the heating-ticker's rule, applied here for the same reason).
            aria-pressed={dup ? undefined : explainingKey === key}
            tabIndex={dup ? -1 : undefined}
            aria-label={label}
            onClick={() => onExplain(p)}
            className={[
              'flex items-baseline gap-2.5 px-5 py-0.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70',
              explainingKey === key ? 'bg-white/15' : 'hover:bg-white/10',
            ].join(' ')}
          >
            {body}
          </button>
        ) : (
          // Inert: no aria-label here. A name on a plain <span> is ignored by most AT (it is only
          // honoured on interactive or role-bearing elements), so adding one would look like an
          // accessibility improvement and be nothing. The spans read in order, as they shipped.
          <span className="flex items-baseline gap-2.5 px-5">{body}</span>
        )}
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
