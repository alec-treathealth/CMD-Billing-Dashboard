'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * useMarquee — a CONTINUOUS, MANUALLY-SCROLLABLE ticker for the "Facilities Heating Up" strip. Unlike a
 * CSS-transform marquee (which can't be hand-scrolled), this drives `el.scrollLeft` on a real overflow-x
 * container, so the user can drag / wheel it left↔right AND it keeps auto-scrolling:
 *  - loops seamlessly: the card set is rendered TWICE (ONLY when it actually overflows — see
 *    `isOverflowing`); when scrollLeft passes one set (the first duplicate card's offsetLeft), we
 *    subtract that width — no visible jump.
 *  - pauses while the pointer is over the strip or it has keyboard focus (so a card can be clicked),
 *    and while the user is actively wheel/touch-scrolling; resumes RESUME_AFTER_MS after they stop.
 *  - is FORCE-PAUSED while `pinned` (a facility is the scoped subject): pointer/focus/scroll can't
 *    resume it — only unpinning does. Keeps the pressed/active card from sliding away under the user.
 *  - snaps back to the start whenever `resetKey` changes (the window filter) — a fresh window, a fresh
 *    read from the left.
 *  - honors prefers-reduced-motion (no auto-motion; the strip stays manually scrollable).
 *
 * `itemsPerSet` is the count of cards in ONE set (the duplicate begins at that child index). Returns the
 * scroll-container ref plus `isOverflowing` — false until measured, so the caller renders exactly ONE set
 * (no phantom duplicate) unless the real set genuinely overflows the visible strip. Effects never run
 * under renderToStaticMarkup, so `isOverflowing` stays false and this is inert in the hermetic render
 * tests.
 */
const SPEED_PX_PER_SEC = 32; // calm ticker speed
const RESUME_AFTER_MS = 2_500; // resume shortly after the user stops interacting

export function useMarquee<T extends HTMLElement>(resetKey: unknown, itemsPerSet: number, pinned = false) {
  const ref = useRef<T | null>(null);
  const resetKeyRef = useRef(resetKey);
  // False until measured: the caller must NOT render the duplicate set (nor auto-scroll) unless the real
  // set overflows the strip — otherwise a filtered-down list that fits shows every facility twice.
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Snap to the start when the window filter changes (skip the initial mount — same key).
  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      if (ref.current) ref.current.scrollLeft = 0;
    }
  }, [resetKey]);

  // Measure whether ONE set overflows the visible strip. Reads only the real set's children
  // (0..itemsPerSet-1) so it's correct whether or not the duplicate is currently rendered. Re-measures on
  // container resize (ResizeObserver) and whenever the set size / window changes (deps) — LOC toggle and
  // search-resolution changes both flow through itemsPerSet / resetKey.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const measure = () => {
      const last = el.children[itemsPerSet - 1] as HTMLElement | undefined;
      if (!last) {
        setIsOverflowing(false);
        return;
      }
      const realWidth = last.offsetLeft + last.offsetWidth; // right edge of the real (first) set
      setIsOverflowing(realWidth > el.clientWidth + 1); // +1px epsilon for sub-pixel rounding
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [itemsPerSet, resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // Nothing to auto-scroll when the real set fits, and a hard stop while pinned: skip the rAF loop and
    // its listeners entirely (no useless spin, and `pinned` bypasses the resume timer completely).
    if (!isOverflowing || pinned) return;
    el.style.scrollBehavior = 'auto'; // our rAF owns the position — never smooth-animate against it

    let raf = 0;
    let last = 0; // 0 = re-seed dt on the next frame (prevents a jump after any pause)
    let paused = false;
    let inside = false; // pointer over the strip → hold paused (no auto-resume while reading)
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    // Seamless loop distance = where the first DUPLICATE card starts (== one set + its trailing gap).
    const loopWidth = () => {
      const dup = el.children[itemsPerSet] as HTMLElement | undefined;
      return dup ? dup.offsetLeft : el.scrollWidth / 2;
    };

    const step = (ts: number) => {
      if (!paused) {
        if (last === 0) last = ts;
        const dt = ts - last;
        last = ts;
        const lw = loopWidth();
        if (lw > 0) {
          let next = el.scrollLeft + (SPEED_PX_PER_SEC * dt) / 1000;
          if (next >= lw) next -= lw; // wrap seamlessly back into the first set
          el.scrollLeft = next;
        }
      } else {
        last = 0;
      }
      raf = requestAnimationFrame(step);
    };

    const clearResume = () => {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = null;
    };
    const doResume = () => {
      resumeTimer = null;
      if (!inside) {
        paused = false;
        last = 0;
      }
    };
    const scheduleResume = () => {
      clearResume();
      resumeTimer = setTimeout(doResume, RESUME_AFTER_MS);
    };
    const pauseHold = () => {
      paused = true;
      clearResume(); // stay paused while the pointer/focus is inside
    };
    const pauseDefer = () => {
      paused = true;
      scheduleResume(); // an explicit scroll gesture defers resumption by the idle window
    };
    const onEnter = () => {
      inside = true;
      pauseHold();
    };
    const onLeave = () => {
      inside = false;
      scheduleResume();
    };

    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('focusin', pauseHold);
    el.addEventListener('focusout', scheduleResume);
    el.addEventListener('wheel', pauseDefer, { passive: true });
    el.addEventListener('touchstart', pauseDefer, { passive: true });
    el.addEventListener('touchmove', pauseDefer, { passive: true });
    el.addEventListener('keydown', pauseDefer);

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      clearResume();
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('focusin', pauseHold);
      el.removeEventListener('focusout', scheduleResume);
      el.removeEventListener('wheel', pauseDefer);
      el.removeEventListener('touchstart', pauseDefer);
      el.removeEventListener('touchmove', pauseDefer);
      el.removeEventListener('keydown', pauseDefer);
    };
  }, [itemsPerSet, isOverflowing, pinned]);

  return { ref, isOverflowing };
}
