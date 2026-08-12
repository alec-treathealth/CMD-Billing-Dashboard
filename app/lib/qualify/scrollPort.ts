/**
 * WHICH BOX ACTUALLY SCROLLS — a pure walk, extracted so it is testable.
 *
 * ⚠ WRITTEN 2026-08-12 FOR THE STICKY RAIL. `qualify-ai-panel.tsx`'s auto-follow guard measured the
 * sentinel against `window.innerHeight`, which was correct while the DOCUMENT was the only scroller
 * on /qualify. Once LaneRail gained `xl:max-h-…` its inner `overflow-y-auto` became live, and a
 * viewport-relative predicate is true for essentially every sentinel inside a ~660px pane — so the
 * guard that exists to stop scroll-LOCKING a reader who scrolled up stopped suppressing anything.
 *
 * ⚠ AND AN `overflow-y: auto` BOX IS NOT NECESSARILY A SCROLLER — this is the review finding that
 * three independent lenses raised, and it is the whole reason the probe returns sizes rather than
 * just a style. The rail's cap is `xl:`-gated (1280px), while its `overflow-y-auto` is not: below
 * that breakpoint the box has `overflow-y: auto` and NO height bound, so `scrollHeight ===
 * clientHeight` and it cannot scroll at all. A walk that stopped at the first `auto` would hand back
 * an INERT port, and every consumer that trusts it — the follow bound here, the ScrollTrigger
 * scroller in resolution-flow-client.tsx — would compute against a scrollport that never moves.
 * So the predicate is "declares a scroll overflow AND actually overflows", never just the former.
 *
 * Lives here and not in the panel because the panel reaches the `'use server'` chain and is
 * unreachable from every hermetic test (see bookPlacement.ts's header for what that hole has
 * already shipped).
 */

/** What the walk needs to know about a candidate ancestor. Injected, so this module needs no DOM. */
export interface ScrollProbe {
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
}

/** `overflow-y` values that create a scroll container. `overlay` is real in WebKit and scrolls. */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/** Does this box both DECLARE a scroll overflow and actually overflow? Both halves are required. */
export function isLiveScrollPort(probe: ScrollProbe): boolean {
  return SCROLLABLE_OVERFLOW.has(probe.overflowY) && probe.scrollHeight > probe.clientHeight;
}

/**
 * The nearest ancestor that is a LIVE scroll port, or null when the document is the only scroller.
 *
 * Never returns `el` itself: the follow sentinel is a zero-height `<div>`, and an element that
 * answered with itself would collapse the bound to its own box.
 */
export function scrollPortOf(el: Element | null, probeOf: (e: Element) => ScrollProbe): Element | null {
  let node = el?.parentElement ?? null;
  while (node !== null) {
    if (isLiveScrollPort(probeOf(node))) return node;
    node = node.parentElement;
  }
  return null;
}

/** The bottom edge to measure a follow sentinel against: the scrollport's, or the viewport's. */
export function followBoundOf(portBottom: number | null, viewportHeight: number): number {
  return portBottom === null ? viewportHeight : portBottom;
}
