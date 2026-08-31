'use client';

/**
 * Modal-dialog a11y. On open it moves focus into the dialog and remembers what previously had focus;
 * Escape closes it; on close it restores focus to the opener. When `trap` is true (the default — for
 * aria-modal dialogs) Tab / Shift+Tab cycle within the dialog; pass `trap: false` for a non-modal
 * slide-over (focus-in + Escape + restore, no trap).
 *
 * `active` drives the effect: these dialogs are ALWAYS mounted and early-return null when closed
 * (not mount-on-open), so the setup must key off the open flag, not mount. Attach the returned ref to
 * the dialog container and give it tabIndex={-1} so it can hold focus. `onClose` is read through a
 * ref, so it need not be memoized.
 *
 * Only 'react' is imported, so components using this stay loadable under the tsx render-test harness;
 * the effect never runs under renderToStaticMarkup (SSR-inert), so hermetic markup tests are unaffected.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement>(
  onClose: () => void,
  options?: { trap?: boolean; active?: boolean },
) {
  const trap = options?.trap ?? true;
  const active = options?.active ?? true;
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (!trap || e.key !== 'Tab' || !node) return;
      const els = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0]!;
      const last = els[els.length - 1]!;
      // Focus can sit on the CONTAINER itself — the hook focuses it on open, and FOCUSABLE
      // excludes [tabindex="-1"], so the boundary checks below never match it. Un-intercepted,
      // the first Shift+Tab after opening walks backwards OUT of the dialog into the page behind
      // the modal (review finding, PR #311). Route both directions to the proper end.
      if (document.activeElement === node) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return ref;
}
