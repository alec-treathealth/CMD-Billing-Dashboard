'use client';

import { useEffect, useRef } from 'react';

/**
 * useAutoScroll — gently auto-scrolls a horizontal container (the "Facilities Heating Up" ticker),
 * ping-ponging left↔right at a slow, ticker-like speed. It PAUSES the instant the user engages the
 * strip (hover, wheel, touch, or keyboard) and RESUMES 5s after the last interaction, once the
 * pointer has left. Honors prefers-reduced-motion (no auto-scroll at all) and only moves when the
 * content actually overflows. Returns a ref to attach to the scroll container.
 *
 * Why this shape:
 *  - We drive `el.scrollLeft` directly via requestAnimationFrame (NOT a CSS transform) so the strip
 *    stays a genuine, user-scrollable region — the whole point of "unless the user scrolls it".
 *  - We deliberately do NOT use the `scroll` event to detect user intent: our own rAF writes to
 *    scrollLeft, which itself fires `scroll`, so listening for it would pause ourselves. User intent
 *    is inferred from input events instead (pointer / wheel / touch / key).
 *  - Effects never run under renderToStaticMarkup, so this is inert in the hermetic render tests
 *    (useRef → {current:null}; the effect body — and every window/rAF access — is browser-only).
 */
const SPEED_PX_PER_SEC = 26; // slow; a calm ticker, never a scroller
const RESUME_AFTER_MS = 5_000; // resume 5s after the last interaction (per the request)

export function useAutoScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    el.style.scrollBehavior = 'auto'; // our rAF owns the position — never smooth-animate against it

    let raf = 0;
    let last = 0; // 0 = re-seed on the next frame (prevents a big dt jump after any pause)
    let dir: 1 | -1 = 1;
    let paused = false;
    let inside = false; // pointer currently over the strip → hold paused (no auto-resume while reading)
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    const overflow = () => el.scrollWidth - el.clientWidth;
    const canScroll = () => overflow() > 4;

    const step = (ts: number) => {
      if (!paused && canScroll()) {
        if (last === 0) last = ts;
        const dt = ts - last;
        last = ts;
        const max = overflow();
        let next = el.scrollLeft + (dir * SPEED_PX_PER_SEC * dt) / 1000;
        if (next >= max) {
          next = max;
          dir = -1;
        } else if (next <= 0) {
          next = 0;
          dir = 1;
        }
        el.scrollLeft = next;
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
      scheduleResume(); // an explicit gesture defers resumption by the full idle window
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
  }, []);
  return ref;
}
