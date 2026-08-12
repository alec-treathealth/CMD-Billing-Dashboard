/**
 * WHICH BOX SCROLLS — the shared predicate behind the AI panel's auto-follow bound AND the shell's
 * ScrollTrigger scroller, tested where neither of those files can be.
 *
 * ⚠ `.tsx`, NOT `.ts`, AND THAT IS NOT A STYLE CHOICE. `app/package.json` globs `test/*.test.tsx`
 * only, so a `.ts` file here never runs and silently "passes" — a test that cannot fail is worse
 * than no test, because it reads as coverage.
 *
 * The decision lives in `lib/qualify/scrollPort.ts` rather than inline in `qualify-ai-panel.tsx`
 * because that module reaches the `'use server'` chain (gate → cookies → DB) and no hermetic test
 * can import it. Same extraction, same reason, as bookPlacement.ts / aiPayload.ts / externalAsk.ts.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { followBoundOf, isLiveScrollPort, scrollPortOf, type ScrollProbe } from '../lib/qualify/scrollPort';

/** One ancestor: how it paints, and whether it actually overflows. */
interface Box extends ScrollProbe {
  parentElement: Box | null;
}

/** Build a parent chain, outermost first. Needs no DOM — the probe is injected. */
function chain(boxes: readonly Partial<ScrollProbe>[]): {
  leaf: Element;
  probeOf: (e: Element) => ScrollProbe;
  at: (i: number) => Element;
} {
  const nodes: Box[] = boxes.map((b) => ({
    overflowY: b.overflowY ?? 'visible',
    // Default to OVERFLOWING, so a test that forgets to say is testing the overflow-y rule, not
    // accidentally passing because nothing overflows.
    scrollHeight: b.scrollHeight ?? 1000,
    clientHeight: b.clientHeight ?? 400,
    parentElement: null,
  }));
  for (let i = 1; i < nodes.length; i += 1) nodes[i]!.parentElement = nodes[i - 1]!;
  const leaf = { parentElement: nodes.length === 0 ? null : nodes[nodes.length - 1] } as unknown as Element;
  const probeOf = (e: Element): ScrollProbe => {
    const b = e as unknown as Box;
    return { overflowY: b.overflowY, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight };
  };
  return { leaf, probeOf, at: (i) => nodes[i] as unknown as Element };
}

test('isLiveScrollPort needs BOTH halves — a scroll overflow that does not overflow is not a port', () => {
  // ⚠ THIS IS THE REVIEW FINDING THAT THIS MODULE'S SECOND DRAFT EXISTS FOR (2026-08-12). The lane
  // rail's height cap is `xl:`-gated (1280px); its `overflow-y-auto` is not. Below that breakpoint
  // the box is `overflow-y: auto` with no bound, so scrollHeight === clientHeight and it CANNOT
  // scroll — and a predicate that only read `overflow-y` handed that inert box to ScrollTrigger as
  // a scroller, stranding every tile past its fold at visibility:hidden.
  assert.equal(isLiveScrollPort({ overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(isLiveScrollPort({ overflowY: 'auto', scrollHeight: 400, clientHeight: 400 }), false, 'the below-xl rail');
  assert.equal(isLiveScrollPort({ overflowY: 'visible', scrollHeight: 1000, clientHeight: 400 }), false);
  assert.equal(isLiveScrollPort({ overflowY: 'hidden', scrollHeight: 1000, clientHeight: 400 }), false, 'hidden clips, it does not scroll');
  // `overlay` is a real computed value in WebKit and scrolls like `auto`; missing it would make the
  // guard viewport-relative on exactly one browser family.
  assert.equal(isLiveScrollPort({ overflowY: 'overlay', scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(isLiveScrollPort({ overflowY: 'scroll', scrollHeight: 1000, clientHeight: 400 }), true);
  // A sub-pixel difference is still an overflow; the comparison must not round or floor.
  assert.equal(isLiveScrollPort({ overflowY: 'auto', scrollHeight: 400.5, clientHeight: 400 }), true);
});

test('scrollPortOf walks to the NEAREST live port, and returns null when the document is the scroller', () => {
  // The shipped shape at xl: <main> (visible) > grid (visible) > rail root (hidden) > scroller (auto).
  const shipped = chain([{ overflowY: 'visible' }, { overflowY: 'visible' }, { overflowY: 'hidden' }, { overflowY: 'auto' }]);
  assert.equal(scrollPortOf(shipped.leaf, shipped.probeOf), shipped.at(3), 'the rail scroller must be found');

  // ⚠ THE SAME MARKUP BELOW xl. Only the cap changed, so the box no longer overflows — and the walk
  // must fall THROUGH it to `null` rather than returning an inert port.
  const belowXl = chain([
    { overflowY: 'visible' },
    { overflowY: 'visible' },
    { overflowY: 'hidden' },
    { overflowY: 'auto', scrollHeight: 400, clientHeight: 400 },
  ]);
  assert.equal(scrollPortOf(belowXl.leaf, belowXl.probeOf), null, 'an inert rail is not a scrollport');

  // NEAREST, not outermost — two live ports and the inner one wins. This is the case that would pick
  // the wrong bound if the walk collected instead of returning early.
  const nested = chain([{ overflowY: 'auto' }, { overflowY: 'visible' }, { overflowY: 'scroll' }]);
  assert.equal(scrollPortOf(nested.leaf, nested.probeOf), nested.at(2));

  // ...but an INERT inner port must not shadow a live outer one — the walk continues past it.
  const shadowed = chain([{ overflowY: 'auto' }, { overflowY: 'auto', scrollHeight: 300, clientHeight: 300 }]);
  assert.equal(scrollPortOf(shadowed.leaf, shadowed.probeOf), shadowed.at(0), 'an inert box does not stop the walk');

  // The single-column path: the document is the only scroller, so there is no element port at all.
  const none = chain([{ overflowY: 'visible' }, { overflowY: 'hidden' }, { overflowY: 'clip' }]);
  assert.equal(scrollPortOf(none.leaf, none.probeOf), null);
  assert.equal(scrollPortOf(null, none.probeOf), null, 'a null sentinel is not a crash');

  // ⚠ THE ELEMENT ITSELF IS NEVER ITS OWN PORT. The sentinel is a zero-height <div>; if it ever
  // gained an overflow it would answer with itself and the bound would collapse to its own box.
  const selfAuto = { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400, parentElement: null } as unknown as Element;
  assert.equal(scrollPortOf(selfAuto, (e) => e as unknown as ScrollProbe), null);
});

test('followBoundOf uses the scrollport bottom when there is one, the viewport height when there is not', () => {
  // ⚠ THIS IS THE WHOLE BUG THE MODULE EXISTS FOR. Inside a ~660px rail, `window.innerHeight` (900)
  // is above almost every sentinel, so `top <= bound + 200` is true even when the reader has
  // scrolled up — and the guard that exists to stop scroll-LOCKING them suppresses nothing.
  assert.equal(followBoundOf(660, 900), 660, 'the rail bounds the follow, not the window');
  assert.equal(followBoundOf(null, 900), 900, 'no port means the document scrolls, so the viewport bounds it');
  // A port scrolled partly off-screen still bounds by its own edge — the point is the SCROLLPORT,
  // never whichever box happens to be smaller.
  assert.equal(followBoundOf(1400, 900), 1400);
  assert.equal(followBoundOf(0, 900), 0, 'a collapsed port is still the port');
});
