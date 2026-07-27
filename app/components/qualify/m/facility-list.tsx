'use client';

/**
 * Qualify mobile Phase-4b — the ranked-list CONTAINER. Owns the horizontal PAGE gesture (REPLACES the
 * per-row deck swipe that used to live in swipe-row.tsx): the 5-up column slides as ONE unit —
 *   left-swipe  → the NEXT page of 5   (onPageNext)
 *   right-swipe → the PREVIOUS page    (onPagePrev — NOT "why"; why is now an on-card control)
 * Bounds clamp with NO wrap: a right-swipe on page 0 / left-swipe on the last page rubber-band (damped
 * travel) and settle back — the pure pagination helper makes the page a no-op. An 8px axis-lock preserves
 * vertical scroll (a vertical drag is released to the browser). The pagination MATH (page count, slice,
 * next/prev, label) is the pure pagination.ts helper, root-unit-tested; THIS pointer wiring is the
 * documented-untestable seam (the same harness limit qualifyGuards.ts calls out — the container can't be
 * mounted under the test runner, but this component's RENDER output can, so the card-count + indicator are
 * covered by qualify-mobile-render).
 *
 * `scoped` = an identifier search landed on ONE facility (Part A): that single card renders with NO gesture,
 * NO page indicator, NO hint — there is nothing to page.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { SwipeRow } from './swipe-row';
import { pageCount, clampPage, pageSlice, pageLabel } from '../../../lib/qualify/pagination';
import type { QualifyFacility } from '../../../lib/qualify/contract';

const TEAL900 = '#0E3A3A';
const INK400 = '#63756E';
const DIST_THRESHOLD = 85;
const VELOCITY_THRESHOLD = 0.5;
const BOUND_DAMP = 0.35; // rubber-band: travel past a bound moves at 0.35× so the column visibly resists.

export function MobileFacilityList({
  facilities,
  page,
  scoped,
  dimmed = false,
  onPageNext,
  onPagePrev,
  onWhy,
  onOpen,
}: {
  /** The list to page over: the FULL filtered ranked set (browse) OR the single scoped facility (identifier). */
  facilities: QualifyFacility[];
  page: number;
  scoped: boolean;
  /** In-flight resolution dim (the app's useTransition) — visual only. */
  dimmed?: boolean;
  onPageNext: () => void;
  onPagePrev: () => void;
  onWhy: (f: QualifyFacility) => void;
  onOpen: (f: QualifyFacility) => void;
}) {
  const total = facilities.length;
  const totalPages = pageCount(total);
  const safePage = clampPage(page, total);
  const visible = scoped ? facilities : pageSlice(facilities, safePage);
  const canPage = !scoped && totalPages > 1;

  const colRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startY: 0, dx: 0, locked: false, history: [] as { x: number; t: number }[], ac: null as AbortController | null });

  useEffect(() => () => drag.current.ac?.abort(), []);

  function setTx(x: number) {
    if (colRef.current) colRef.current.style.transform = `translateX(${x}px)`;
  }
  function velocity(): number {
    const h = drag.current.history;
    if (h.length < 2) return 0;
    const recent = h[h.length - 1]!;
    const prior = h[Math.max(0, h.length - 4)]!;
    const dt = recent.t - prior.t;
    if (dt <= 0) return 0;
    return (recent.x - prior.x) / dt;
  }
  function cleanup() {
    drag.current.ac?.abort();
    drag.current.ac = null;
  }
  function springBack() {
    const c = colRef.current;
    if (c) {
      c.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
      c.style.transform = 'translateX(0px)';
    }
  }
  // right-swipe (dx>0) → PREVIOUS page: no-op at page 0. left-swipe (dx<0) → NEXT page: no-op at the last.
  const atStart = safePage <= 0;
  const atEnd = safePage >= totalPages - 1;

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d.active) return;
    const rawDx = e.clientX - d.startX;
    const rawDy = e.clientY - d.startY;
    if (!d.locked) {
      if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
      d.locked = Math.abs(rawDx) > Math.abs(rawDy);
      if (!d.locked) {
        // vertical intent → release the gesture so the page scrolls natively
        d.active = false;
        cleanup();
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    d.dx = rawDx;
    d.history.push({ x: e.clientX, t: e.timeStamp });
    if (d.history.length > 6) d.history.shift();
    // damp travel when swiping past a bound so it rubber-bands instead of sliding into emptiness
    const pastBound = (rawDx > 0 && atStart) || (rawDx < 0 && atEnd);
    setTx(pastBound ? rawDx * BOUND_DAMP : rawDx);
  }

  function onUp() {
    const d = drag.current;
    if (!d.active) {
      cleanup();
      return;
    }
    d.active = false;
    cleanup();
    // A tap never locked the axis → do NOT consume it; the card's own onClick opens the facility.
    if (!d.locked) return;
    const v = velocity();
    const resolve = Math.abs(d.dx) > DIST_THRESHOLD || Math.abs(v) > VELOCITY_THRESHOLD;
    springBack();
    if (!resolve) return;
    const goingRight = d.dx > 0 || (d.dx === 0 && v > 0);
    // Both directions clamp in the pure helper — a bound swipe is a settled no-op.
    if (goingRight) onPagePrev();
    else onPageNext();
  }

  function onCancel() {
    // OS gesture takeover mid-drag: abort. If we had locked + translated, spring the column back so it
    // never sticks offset. A cancel is NEVER a tap, so nothing opens.
    const d = drag.current;
    d.active = false;
    cleanup();
    if (d.locked) springBack();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canPage) return; // scoped single facility / single page → no gesture (taps still open via onClick)
    const d = drag.current;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.dx = 0;
    d.active = true;
    d.locked = false;
    d.history = [{ x: e.clientX, t: e.timeStamp }];
    if (colRef.current) colRef.current.style.transition = 'none';
    const ac = new AbortController();
    d.ac = ac;
    window.addEventListener('pointermove', onMove, { passive: false, signal: ac.signal });
    window.addEventListener('pointerup', onUp, { signal: ac.signal });
    window.addEventListener('pointercancel', onCancel, { signal: ac.signal });
  }

  return (
    <>
      <div
        onPointerDown={onPointerDown}
        style={{ padding: '12px 16px 24px', touchAction: 'pan-y', opacity: dimmed ? 0.6 : 1, transition: 'opacity 0.15s' }}
      >
        <div ref={colRef} style={{ display: 'flex', flexDirection: 'column', gap: 10, willChange: 'transform' }}>
          {visible.map((f) => (
            <SwipeRow key={f.rank} facility={f} onWhy={onWhy} onOpen={onOpen} sampleGated={!scoped} />
          ))}
        </div>
      </div>

      {!scoped && totalPages > 0 ? (
        <div style={{ textAlign: 'center', padding: '0 16px 8px' }} aria-label={`Page ${safePage + 1} of ${totalPages}`}>
          <div style={{ fontSize: 12, fontWeight: 600, color: INK400 }} className="ths-num">
            {pageLabel(safePage, total)}
          </div>
          {totalPages > 1 && totalPages <= 10 ? (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginTop: 6 }} aria-hidden>
              {Array.from({ length: totalPages }, (_, i) => (
                <span
                  key={i}
                  style={{ width: 6, height: 6, borderRadius: 999, background: i === safePage ? TEAL900 : '#D8DFDC' }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {canPage ? (
        <div style={{ textAlign: 'center', fontSize: 12, color: INK400, padding: '0 16px 24px' }}>
          Swipe left or right to page · tap a card to open
        </div>
      ) : null}
    </>
  );
}
