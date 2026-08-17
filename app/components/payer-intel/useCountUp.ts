'use client';

/**
 * Count-up number animation — the repo's FIRST (verified 2026-08-17: no count-up/FLIP exists
 * anywhere to reuse), so it extends the house motion vocabulary rather than importing a lib:
 * rAF-driven, ease-out, 500ms (the Payer Intel motion spec's number), and a HARD
 * prefers-reduced-motion bail to an instant jump — the global CSS reset cannot reach a rAF loop,
 * so this hook must check matchMedia itself (the useMarquee discipline).
 *
 * Change-aware, not mount-only: a facet-chip dismissal re-runs the query and the affected numbers
 * COUNT to their new values rather than snapping (spec 5.4) — the animation always starts from
 * the previously displayed value.
 *
 * ⚠ HYDRATION: only mount this on client-fetched surfaces (the RESULT state, which never SSRs).
 * On an SSR'd surface the initial 0 would mismatch the server's final value.
 *
 * Render with `tabular-nums` (the .ths-num idiom) so the layout does not shift mid-count.
 */
import { useEffect, useRef, useState } from 'react';

const COUNT_UP_MS = 500;

export function useCountUp(target: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(target === null ? null : 0);
  const fromRef = useRef<number>(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === null) {
      setDisplay(null);
      fromRef.current = 0;
      return;
    }
    if (
      typeof window === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) {
      setDisplay(target);
      return;
    }
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const t = Math.min((now - start) / COUNT_UP_MS, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad — the house 'power2.out' shape
      const value = from + (target - from) * eased;
      setDisplay(t >= 1 ? target : value);
      if (t < 1) rafRef.current = window.requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, [target]);

  return display;
}
