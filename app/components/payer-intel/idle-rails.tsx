'use client';

/**
 * The IDLE-state rail — "Policies gaining ground" (dark teal, the tape silhouette).
 *
 * ⚠ "FACILITIES LOSING GROUND" WAS REMOVED 2026-09-10 (Alec) AND SHOULD NOT COME BACK AS IT WAS.
 * It was the single most expensive read on this tab by an order of magnitude: measured warm,
 * 167.8ms / 65,402 buffers against 17.3ms / 237 for the gainers rail and under 2ms for census,
 * facility names and saved searches — and 2,361ms on a cold cache. The five ambient reads run in
 * one Promise.all, so board latency was effectively THIS query's latency and nothing else's.
 * If a decliners signal is wanted again it needs a rollup or matview behind it, not a live
 * window-diff over the charge rollup at page load.
 *
 * MOVING, BY RULING (Alec, 2026-08-17 review: "there's just not movement, they are sitting
 * still") — this supersedes the build spec's static-rail line. Both rails run the SAME machine as
 * the Qualify tape: `useMarquee` over a real overflow-x container, hand-scrollable, pauses on
 * hover/focus/gesture, auto-motion drops under prefers-reduced-motion while staying scrollable.
 *
 * ⚠ THE useMarquee CONTRACT, learned the hard way on policy-tape.tsx: the ref element's DIRECT
 * children must be the items (the hook indexes `el.children`); the duplicate set renders only
 * when `isOverflowing`, marked `data-dup` + `aria-hidden` + tabIndex -1 (the `.q-marquee` CSS
 * hides duplicates under reduced motion — aria-hidden alone hides them from AT, not from eyes).
 *
 * WINDOW-AWARE: both rails render whatever window the board was loaded with — the recency toggle
 * refetches the board, so `windowDays`/`deltaDays` here always names the ACTIVE window.
 *
 * PHI/DOLLARS: gainers items are the tape's non-dollar shape verbatim — this rail carries no
 * dollars at all now that the decliner ticks (the only dollar-bearing ones) are gone.
 */
import type { QualifyPolicyTapeItem } from '../../lib/qualify/board';
import { TAPE_PALETTE } from '../qualify/tokens';
import { useMarquee } from '../qualify/useMarquee';
function gainerHandle(item: QualifyPolicyTapeItem): string {
  return item.echo ?? item.prefix ?? `⋯${item.tokenTail.slice(-4)}`;
}

function gainerClause(item: QualifyPolicyTapeItem): string | null {
  const parts: string[] = [];
  if (item.careSetting !== null) parts.push(item.careSetting === 'BOTH' ? 'IP+OP' : item.careSetting);
  if (item.facilityCount > 1) parts.push(`${item.facilityCount} facilities`);
  else if (item.area !== null) parts.push(item.area);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function PayerIntelGainersRail({
  items,
  asOf,
  deltaDays,
  onSeed,
}: {
  items: readonly QualifyPolicyTapeItem[];
  asOf: string | null;
  deltaDays: number;
  /** Seed a search from a tick (prefix + payer). */
  onSeed?: (item: QualifyPolicyTapeItem) => void;
}) {
  // Hook before any early return (rules of hooks). resetKey folds the window in so a recency
  // toggle re-reads from the left.
  const { ref: scrollRef, isOverflowing } = useMarquee<HTMLUListElement>(`${asOf}-${deltaDays}`, items.length);

  const item = (p: QualifyPolicyTapeItem, dup: boolean) => {
    const band = p.bandNow ?? '0';
    const key = `${p.token}-${p.payer}`;
    const clause = gainerClause(p);
    const label =
      `${gainerHandle(p)}, ${p.payer}${clause ? `, ${clause}` : ''}. ` +
      `Rating ${p.ratingNow}, up ${p.deltaPts} points over ${deltaDays} days.` +
      (onSeed ? ' Search this policy.' : '');
    const body = (
      <>
        <span className="font-mono text-xs font-medium tracking-wide text-white">{gainerHandle(p)}</span>
        <span className="max-w-[168px] truncate text-xs text-white/60">{p.payer}</span>
        {clause ? <span className="whitespace-nowrap text-xs text-white/60">{clause}</span> : null}
        {/* TAPE_PALETTE.band, never IQ_BAND_HEX — inverse-surface set (audit C-4). */}
        <span className="font-mono text-[15px] font-semibold" style={{ color: TAPE_PALETTE.band[band] }}>
          {p.ratingNow}
        </span>
        <span className="font-mono text-xs font-medium" style={{ color: TAPE_PALETTE.up }}>
          ▲ +{p.deltaPts} pts
        </span>
      </>
    );
    return (
      <li
        key={dup ? `dup-${key}` : key}
        aria-hidden={dup || undefined}
        data-dup={dup ? 'true' : undefined}
        className="flex flex-none border-r border-white/10"
      >
        {onSeed ? (
          <button
            type="button"
            tabIndex={dup ? -1 : undefined}
            aria-label={dup ? undefined : label}
            onClick={() => onSeed(p)}
            className="flex items-baseline gap-2.5 px-5 py-0.5 text-left transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal200/70"
          >
            {body}
          </button>
        ) : (
          <span className="flex items-baseline gap-2.5 px-5">{body}</span>
        )}
      </li>
    );
  };

  return (
    <section aria-label="Policies gaining ground" data-pi-section="gainers">
      <div className="mb-2 flex items-baseline gap-2 px-0.5">
        <h2 className="font-head text-[15px] font-semibold tracking-tight text-ink900">Policies gaining ground</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-ink400">
          {deltaDays}-day rating change{asOf ? ` · as of ${asOf}` : ''}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink400">
          No policy has gained ground over the last {deltaDays} days — nothing to lead with yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-teal900 shadow-ths-sm">
          {/* ⚠ THE SCROLL CONTAINER IS THE <ul> ITSELF — useMarquee indexes el.children directly;
              a wrapper div silently kills auto-scroll (the shipped policy-tape bug, 2026-08-09). */}
          <ul ref={scrollRef} className="q-marquee flex items-center py-2.5">
            {items.map((p) => item(p, false))}
            {isOverflowing && items.map((p) => item(p, true))}
          </ul>
        </div>
      )}
    </section>
  );
}

