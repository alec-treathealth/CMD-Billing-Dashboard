'use client';

import { useEffect, useRef } from 'react';

/**
 * useMarquee — a CONTINUOUS, MANUALLY-SCROLLABLE ticker for the "Facilities Heating Up" strip. Unlike a
 * CSS-transform marquee (which can't be hand-scrolled), this drives `el.scrollLeft` on a real overflow-x
 * container, so the user can drag / wheel it left↔right AND it keeps auto-scrolling:
 *  - loops seamlessly: the card set is rendered TWICE; when scrollLeft passes one set (the first
 *    duplicate card's offsetLeft), we subtract that width — no visible jump.
 *  - pauses while the pointer is over the strip or it has keyboard focus (so a card can be clicked),
 *    and while the user is actively wheel/touch-scrolling; resumes RESUME_AFTER_MS after they stop.
 *  - snaps back to the start whenever `resetKey` changes (the window filter) — a fresh window, a fresh
 *    read from the left.
 *  - honors prefers-reduced-motion (no auto-motion; the strip stays manually scrollable).
 *
 * `itemsPerSet` is the count of cards in ONE set (the duplicate begins at that child index). Effects
 * never run under renderToStaticMarkup, so this is inert in the hermetic render tests.
 */
const SPEED_PX_PER_SEC = 32; // calm ticker speed
const RESUME_AFTER_MS = 2_500; // resume shortly after the user stops interacting

export function useMarquee<T extends HTMLElement>(resetKey: unknown, itemsPerSet: number) {
  const ref = useRef<T | null>(null);
  const resetKeyRef = useRef(resetKey);

  // Snap to the start when the window filter changes (skip the initial mount — same key).
  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      if (ref.current) ref.current.scrollLeft = 0;
    }
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
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
  }, [itemsPerSet]);

  return ref;
}
