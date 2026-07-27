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

  // Interaction state lives in REFS so it survives every rAF-effect re-run (pin toggle, window change,
  // overflow re-measure). If it were closure-local, a re-run WHILE the pointer is over the strip would
  // forget that fact — pointerenter won't re-fire without a boundary crossing — and the ticker would
  // auto-scroll out from under a stationary cursor. Refs + a stable listener effect keep hover authoritative.
  const hoveringRef = useRef(false);
  const focusedRef = useRef(false);
  const gestureUntilRef = useRef(0); // rAF-clock timestamp: an explicit scroll gesture holds until here

  // Snap to the start when the window filter changes (skip the initial mount — same key).
  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      if (ref.current) ref.current.scrollLeft = 0;
    }
  }, [resetKey]);

  // Hover / focus / gesture tracking — attached ONCE while the strip is scrollable, independent of the rAF
  // lifecycle so a pin/window change never drops the "pointer is inside" fact. Uses pointerOVER/pointerMOVE
  // (not just boundary pointerenter): those fire even when the cursor is ALREADY over the strip at init and
  // re-fire as cards scroll beneath a stationary cursor, so hover pausing is reliable no matter where the
  // cursor happened to be when the ticker mounted. pointerleave (a true exit) clears it.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined' || !isOverflowing) return;
    const markHover = () => {
      hoveringRef.current = true;
    };
    const clearHover = () => {
      hoveringRef.current = false;
    };
    const focusIn = () => {
      focusedRef.current = true;
    };
    const focusOut = () => {
      focusedRef.current = false;
    };
    const gesture = () => {
      gestureUntilRef.current = performance.now() + RESUME_AFTER_MS;
    };
    el.addEventListener('pointerover', markHover);
    el.addEventListener('pointermove', markHover);
    el.addEventListener('pointerleave', clearHover);
    el.addEventListener('pointercancel', clearHover);
    el.addEventListener('focusin', focusIn);
    el.addEventListener('focusout', focusOut);
    el.addEventListener('wheel', gesture, { passive: true });
    el.addEventListener('touchstart', gesture, { passive: true });
    el.addEventListener('touchmove', gesture, { passive: true });
    el.addEventListener('keydown', gesture);
    return () => {
      el.removeEventListener('pointerover', markHover);
      el.removeEventListener('pointermove', markHover);
      el.removeEventListener('pointerleave', clearHover);
      el.removeEventListener('pointercancel', clearHover);
      el.removeEventListener('focusin', focusIn);
      el.removeEventListener('focusout', focusOut);
      el.removeEventListener('wheel', gesture);
      el.removeEventListener('touchstart', gesture);
      el.removeEventListener('touchmove', gesture);
      el.removeEventListener('keydown', gesture);
    };
  }, [isOverflowing]);

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
    // Nothing to auto-scroll when the real set fits, and a hard stop while pinned: skip the rAF loop
    // entirely (no useless spin, and `pinned` can never be overridden by hover/gesture).
    if (!isOverflowing || pinned) return;
    el.style.scrollBehavior = 'auto'; // our rAF owns the position — never smooth-animate against it

    let raf = 0;
    let last = 0; // 0 = re-seed dt + position on the next frame (prevents a jump after any hold)
    // Position is tracked in JS and only WRITTEN to el.scrollLeft each frame — never read back — so the
    // hot loop forces ZERO synchronous layouts per frame (reading scrollLeft/offsetLeft every frame was a
    // double reflow that stuttered once the cards grew heavier). We re-sync `pos` from the real scrollLeft
    // only when resuming from a hold (last === 0), so a manual hand-scroll while paused is respected.
    let pos = el.scrollLeft;
    // Seamless loop distance = where the first DUPLICATE card starts (one set + its trailing gap). Cards
    // are fixed-width, so this is effectively static per set — measure once (lazily until non-zero, since
    // the dup may not be laid out on the very first frame); itemsPerSet changes re-run this whole effect.
    let loopW = 0;
    const measureLoop = () => {
      const dup = el.children[itemsPerSet] as HTMLElement | undefined;
      loopW = dup ? dup.offsetLeft : el.scrollWidth / 2;
    };

    const step = (ts: number) => {
      // Hold (don't advance) while the pointer is over the strip, it has focus, or a recent scroll gesture
      // is still within its idle window. All three read from refs the stable listener effect maintains, so
      // this survives rAF re-runs and never resumes under a stationary cursor.
      const holding = hoveringRef.current || focusedRef.current || ts < gestureUntilRef.current;
      if (!holding) {
        if (last === 0) {
          last = ts;
          pos = el.scrollLeft; // one read, only on (re)start — sync to wherever the user left it
        }
        const dt = ts - last;
        last = ts;
        if (loopW <= 0) measureLoop(); // measure until we have a real distance, then never read again
        if (loopW > 0) {
          pos += (SPEED_PX_PER_SEC * dt) / 1000;
          if (pos >= loopW) pos -= loopW; // wrap seamlessly back into the first set
          el.scrollLeft = pos; // write-only
        }
      } else {
        last = 0;
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // `resetKey` IS a dep: the snap-back effect zeroes el.scrollLeft on a window change, but since we now
    // track position in JS (write-only) rather than reading scrollLeft each frame, a window swap with the
    // SAME item count wouldn't otherwise re-run this effect — the stale `pos` would clobber the reset on
    // the next frame. Re-running here tears down + re-seeds `pos` from the freshly-zeroed scrollLeft. React
    // runs the earlier-declared snap-back effect's body before this one on the same commit, so we re-seed
    // from 0, not the old position.
  }, [itemsPerSet, isOverflowing, pinned, resetKey]);

  return { ref, isOverflowing };
}
