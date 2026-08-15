/**
 * A REAL DOM FOR FOCUS TESTS — the narrow, deliberate exception to this repo's
 * `renderToStaticMarkup`-only test posture.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Every other test in `app/test/` renders to a STRING. That is the right default: it is fast, it has
 * no dependencies, and for markup contracts (does this element carry `role="dialog"`, is this
 * `<th>` present, is a dollar field absent from the DOM) a string is a complete proof.
 *
 * It is NOT a proof of BEHAVIOUR, and the 2026-08-12 accessibility audit is mostly behaviour:
 *   - "focus moves into the dialog on open, and returns to the opener on close"  (SC 2.4.3)
 *   - "Escape closes it"                                                          (SC 2.1.1)
 *   - "Tab cycles inside the modal instead of escaping to the page behind it"     (SC 2.1.1)
 * A string render cannot observe any of these, because `useDialog`'s effect never runs under
 * `renderToStaticMarkup` — the hook's own docblock says so. So a WCAG conformance claim backed only
 * by markup tests is asserting that the LABEL is present, not that the BEHAVIOUR works. For a
 * compliance PR on the one screen an `admissions_seat` persona has, that gap is not acceptable.
 *
 * ── WHAT THIS DOES NOT BUY, WHICH MATTERS AS MUCH ────────────────────────────────────────────────
 * jsdom has NO layout engine and NO paint. Do not reach for it to test:
 *   - contrast or colour of any kind — that is the token layer's contrast test, and ultimately a
 *     browser pass;
 *   - target size (SC 2.5.8) or anything reading `getBoundingClientRect()`, which returns ZEROS here;
 *   - `scroll-margin-top` / sticky-header overlap (SC 2.4.11);
 *   - what a screen reader ACTUALLY announces — jsdom does not compute an accessibility tree, so
 *     "NVDA flattens `role="button"` and drops the nested control" stays a browser/AT question.
 * It also does NOT implement native Tab traversal: pressing Tab moves nothing on its own. That is
 * fine for `useDialog`, whose trap is JS that intercepts Tab and calls `.focus()` itself — we are
 * testing OUR code, not the browser's. But it means "is the background still tabbable" can only be
 * asserted through `inert` / `aria-hidden` attributes, i.e. back to a markup claim.
 *
 * ── HOW TO USE IT ────────────────────────────────────────────────────────────────────────────────
 * Node's test runner executes each test FILE in its own child process, so the globals installed here
 * cannot leak into the string-render suites. Call `installDom()` at the TOP of the file, THEN
 * `await import(...)` the component — static imports are hoisted and would run before the DOM
 * exists.
 *
 * ⚠️ Test files must live directly in `app/test/*.test.tsx` — the runner's glob is single-level, so a
 * `test/dom/` subdirectory would silently never run. Helpers like this one are fine here because
 * they are imported, not collected.
 */
import { JSDOM } from 'jsdom';

/** The globals React 18's DOM renderer and our components touch. Assigned onto `globalThis` because
 *  that is what `react-dom/client` reads; jsdom's own window object is returned for direct use. */
export function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    // Gives us rAF + a visual-ish environment; React logs warnings without it.
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const w = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  // ⚠ `defineProperty`, NOT plain assignment. Node 22 ships its OWN `navigator` global declared as a
  // getter with no setter, so `globalThis.navigator = …` throws
  // "Cannot set property navigator of #<Object> which has only a getter" and takes the whole file
  // down at import. Defining the property replaces the descriptor outright, which works for both the
  // getter-only built-ins and the plain-undefined ones.
  const put = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'PointerEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'MutationObserver',
  ]) {
    if (w[key] !== undefined) put(key, w[key]);
  }
  void g; // `g` is retained only for the IS_REACT_ACT_ENVIRONMENT assignment below.
  // React 18 refuses to run `act()` without this and prints a console error instead of failing,
  // which would let an effect-dependent assertion pass vacuously.
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/** The currently-focused element, as the thing tests actually want to assert on. */
export function activeEl(): Element | null {
  return document.activeElement;
}

/** Dispatch a real keydown on the focused element (or an explicit target), the way a user would.
 *  `bubbles` matters: `useDialog` listens on the dialog node, so a key pressed on a child has to
 *  bubble to reach it — a non-bubbling event would make the trap look broken when it is not. */
export function pressKey(key: string, opts: { shiftKey?: boolean; target?: Element | null } = {}): void {
  const target = opts.target ?? document.activeElement ?? document.body;
  target.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, shiftKey: opts.shiftKey ?? false, bubbles: true, cancelable: true }),
  );
}
