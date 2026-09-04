/**
 * Source-level guards for the Collections results grid's OWN scroll container.
 *
 * A true render/import test of cmd-explorer.tsx isn't possible under node:test — its import graph
 * pulls @/lib/actions → @/lib/access, which calls the RSC `cache()` and crashes the runtime (see
 * cmd-explorer-ai-panel.test.tsx and cmd-explorer-cohort-collapse.test.tsx for the same
 * constraint). So these pin the invariants at the SOURCE.
 *
 * ⚠ AND SOURCE PINS ARE ALL THAT IS HONEST HERE EVEN IF THE IMPORT WORKED. jsdom implements no
 * layout and no scrolling: `getBoundingClientRect()` returns zeros, `scrollHeight === clientHeight`
 * always, and `position: sticky` does nothing. It could assert that `tabIndex`/`role`/`aria-label`
 * are PRESENT — which is exactly what the pins below do, without pretending a crashing import is
 * testable. Everything that actually matters about this change (one scrollbar per axis, the header
 * staying pinned and opaque through a column drag, keyboard scrolling, 320px and 200% zoom) is
 * layout and paint, and is verified in the human browser pass. See CLAUDE.md's jsdom boundary.
 *
 * What these lock in, and why each one would be a silent regression:
 *   · the scrollport is keyboard-reachable          — WCAG 2.1.1; a div with overflow and no
 *                                                     tabindex is unreachable without a mouse
 *   · it is a labelled landmark                     — role+label, so the region is announceable
 *   · the height chain keeps every `min-h-0`        — one missing link and the page scrolls again
 *   · the min-height floor survives                 — WCAG 1.4.4; without it the grid collapses to
 *                                                     nothing at 200% zoom
 *   · the sticky <th> never regains `relative`      — dnd-kit's drag state would unpin the header
 *   · the shadcn <Table> wrapper stays unused here  — re-adding it restores the second scrollport
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
const pageSrc = readFileSync(join(here, '../app/dashboard/collections/page.tsx'), 'utf8');
const tablePrimitiveSrc = readFileSync(join(here, '../components/ui/table.tsx'), 'utf8');
const globalsCss = readFileSync(join(here, '../app/globals.css'), 'utf8');

/**
 * Comment-stripped copy, used by every assertion that checks for the ABSENCE of a pattern.
 *
 * The comments in cmd-explorer.tsx legitimately NAME the things being banned — they exist to
 * explain why `<Table>` and `scrollIntoView` were removed and what breaks if they come back. A
 * prose match would fail for the wrong reason, and the obvious way to make it pass again is to
 * delete the explanation. Both of those happened on the first run of this file.
 */
const explorerCode = explorerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * cmd-explorer.tsx contains SIX other <table> elements (the cohort bucket tables, the drilldown,
 * the combo ranking table…). A file-wide regex would match the wrong one and pass for the wrong
 * reason, so every assertion below is scoped to the scrollport slice — the JSX between the
 * scrollport's ref and the close of the results table.
 */
const sliceScrollport = (src: string) => {
  const from = src.indexOf('ref={scrollportRef}');
  assert.ok(from > 0, 'scrollport located by its ref');
  const to = src.indexOf('</DndContext>', from);
  assert.ok(to > from, 'scrollport slice terminates at the DndContext close');
  return src.slice(from, to);
};
const scrollportSrc = sliceScrollport(explorerSrc);
/**
 * Comment-stripped scrollport slice. The ratified `<table>` carries a comment that NAMES `<Table>`
 * to stop a future reader "restoring" the wrapper — so the ban below has to be checked against
 * code, not prose. Same trap as `explorerCode` above; it caught this file twice.
 */
const scrollportCode = sliceScrollport(explorerCode);

/**
 * The four edge fades. They are SIBLINGS of the scrollport, not children — an absolutely
 * positioned child of a scroll container scrolls away with the content — so they fall OUTSIDE
 * `scrollportSrc`, whose slice ends at the DndContext close. Their own slice runs from the first
 * fade to the pager, which is the next thing rendered after the floor wrapper closes.
 */
const sliceFades = (src: string) => {
  const from = src.indexOf('{scrollEdges.top && (');
  assert.ok(from > 0, 'edge fades located');
  const to = src.indexOf('<Pager', from);
  assert.ok(to > from, 'fade slice terminates before the pager');
  return src.slice(from, to);
};
const fadesSrc = sliceFades(explorerSrc);

/**
 * The measurement + wiring block: `measureScrollEdges` through the effect that attaches the
 * listener and the observer, ending where loadPage begins.
 */
const edgeLogicSrc = (() => {
  const from = explorerCode.indexOf('const measureScrollEdges = useCallback(');
  assert.ok(from > 0, 'measureScrollEdges located');
  const to = explorerCode.indexOf('const loadPage = useCallback(', from);
  assert.ok(to > from, 'edge-logic slice terminates at loadPage');
  return explorerCode.slice(from, to);
})();

test('the scrollport is keyboard-reachable and announced (WCAG 2.1.1)', () => {
  // A scrollable div is a keyboard trap-in-reverse: reachable by mouse wheel, unreachable by Tab.
  assert.match(scrollportSrc, /tabIndex=\{0\}/, 'scrollport must be focusable');
  assert.match(scrollportSrc, /role="region"/, 'scrollport must be a region landmark');
  assert.match(scrollportSrc, /aria-label="Collections results"/, 'the region must be named');
});

test('the scrollport scrolls both axes and does not chain to the document', () => {
  assert.match(scrollportSrc, /overflow-auto/, 'both axes scroll inside the container');
  // Without this, hitting the last row hands the scroll to the document and the filter panel —
  // the thing this change exists to keep on screen — slides away.
  assert.match(scrollportSrc, /overscroll-contain/, 'scroll must not chain to the document');
  assert.match(scrollportSrc, /min-h-0/, 'a flex child needs min-h-0 or it refuses to shrink');
  assert.match(scrollportSrc, /flex-1/, 'the scrollport takes the leftover height');
});

test('the height chain is bounded at the route and unbroken through the grid', () => {
  // Viewport-RELATIVE, minus the h-14 global header. A px height here would break 200% zoom.
  assert.match(pageSrc, /h-\[calc\(100dvh-3\.5rem\)\]/, '<main> is bounded to the viewport');
  assert.match(pageSrc, /flex .*flex-col|flex-col/, '<main> is a flex column');
  assert.doesNotMatch(pageSrc, /h-\[\d+px\]/, 'never a fixed px height — WCAG 1.4.4');
  // Every link between <main> and the scrollport must carry min-h-0, or the chain silently
  // reverts to content height and the whole page scrolls again.
  const chainLinks = explorerSrc.match(/min-h-0 flex-1|flex-1 min-h-0|min-h-0 flex/g) ?? [];
  assert.ok(chainLinks.length >= 3, `expected >=3 min-h-0 flex links, found ${chainLinks.length}`);
});

test('grid density: house type scale, tight rows, and the header offset that tracks it', () => {
  // `text-xs` is 13px in this config — the smallest HOUSE size, above the design system's 12px
  // floor for meaning-bearing text. `text-sm` (15px) is a body size and cost ~12px per row.
  // The `ref` is part of the anchor deliberately: it is what the edge-fade ResizeObserver observes
  // to catch a column show/hide, so dropping it would silently stale the fades (see the fade tests).
  assert.match(
    scrollportCode,
    /<table ref=\{gridTableRef\} className="w-full caption-bottom text-xs">/,
    'grid uses the 13px house size and exposes its ref',
  );
  assert.doesNotMatch(scrollportCode, /text-\[\d+px\]/, 'never an arbitrary px size — the 12px floor is repo-wide');
  // Cell padding overrides the primitive's p-2; vertical padding is what sets row height.
  assert.match(explorerCode, /'px-2\.5 py-1'/, 'cells use tightened vertical padding');
  // THE PAIRED CONSTANT. scroll-margin-top on body rows must equal the sticky header height, or a
  // focused row scrolled to the top lands underneath it. h-8 (2rem) ↔ scroll-mt-8.
  assert.match(explorerCode, /sticky top-0 z-20 h-8 bg-ground/, 'header is h-8');
  assert.match(explorerCode, /scroll-mt-8/, 'row scroll-margin matches the h-8 header');
  assert.doesNotMatch(explorerCode, /scroll-mt-10/, 'stale offset for the old h-10 header must be gone');
  // Brand numeric face on the date/code columns (globals.css maps .ths-num to IBM Plex Mono
  // tabular). PHI columns stay OUT — they render as a mask until an audited reveal.
  assert.match(explorerCode, /const IS_MONO = new Set<string>\(\[[^\]]*'charge_date'/, 'date columns get the numeric face');
  for (const phiKey of ['patient_name', 'member_id_raw', 'group_number']) {
    const monoLine = explorerCode.slice(explorerCode.indexOf('const IS_MONO'), explorerCode.indexOf('const DEFAULT_ORDER'));
    assert.ok(!monoLine.includes(phiKey), `${phiKey} must not be in IS_MONO — it renders masked`);
  }
});

test('the grid keeps a min-height floor so it cannot collapse at 200% zoom — and the floor is MODE-DEPENDENT', () => {
  // flex-1 with no floor + a tall filter panel = a few pixels of table on a short viewport.
  // The floor makes the column overflow and the DOCUMENT scroll instead, which is the
  // intended fallback rather than a failure.
  //
  // TWO LITERALS + THE CONDITION (2026-09-03). The floor was a global 20rem; it is now
  //   · `min-h-[20rem]` with no search — byte-for-byte the old value. Measured: at 1440×900 the
  //     landing state sits ON that floor (flex share ~310px vs 320, the 10px absorbed by <main>'s
  //     bottom padding), so it is the one state that cannot spend height without pushing the pager
  //     below the fold on every page load. That is why the floor is conditional and not raised.
  //   · `min-h-[min(31rem,80dvh)]` with a search — that column already scrolls at 1440×900, so the
  //     floor is what caps rows-once-scrolled: 320 → 10 rows, 496 → 17.
  // ⚠ THE dvh CAP IS THE 200% GUARANTEE, not decoration. A bare 31rem is 496 CSS px inside the
  // 450px viewport a 1440×900 window has at 200% zoom: the scroll container outgrows the screen and
  // the sticky header scrolls off while the reader is inside the grid. min(31rem, 80dvh) resolves to
  // 360px there — 12 rows, container on screen, header still pinned. Never "simplify" to `31rem`.
  assert.match(
    explorerSrc,
    /hasAnySearch \? 'min-h-\[min\(31rem,80dvh\)\]' : 'min-h-\[20rem\]'/,
    'the floor is chosen by hasAnySearch: 20rem landing, min(31rem,80dvh) searched',
  );
  assert.equal((explorerCode.match(/min-h-\[20rem\]/g) ?? []).length, 1, 'exactly one landing floor');
  assert.doesNotMatch(explorerCode, /min-h-\[31rem\]/, 'never a bare 31rem — the dvh cap is the 200% guarantee');
  assert.doesNotMatch(explorerCode, /min-h-\[\d+px\]/, 'never a fixed px floor — WCAG 1.4.4');
});

test('the pinned header stays sticky, opaque, and above the body cells', () => {
  const headCellSrc = (() => {
    const from = explorerSrc.indexOf('function SortableHeadCell({');
    const to = explorerSrc.indexOf('function SortableColumnItem({', from);
    assert.ok(from > 0 && to > from, 'SortableHeadCell slice located');
    return explorerSrc.slice(from, to);
  })();
  assert.match(headCellSrc, /sticky top-0 z-20/, 'the <th> cells pin to the scrollport top');
  // Transparent would let body rows read through the header as they scroll under it.
  assert.match(headCellSrc, /bg-ground/, 'the pinned header must be opaque');
  // THE DND-KIT REGRESSION GUARD. `useSortable` sets a transform while dragging; the drag state
  // used to add `relative z-10`, and twMerge resolves the LAST position utility — so `relative`
  // would replace `sticky` and unpin the header mid-drag, with no error and no failing test.
  assert.doesNotMatch(headCellSrc, /isDragging \? 'relative/, 'drag state must not set position');
  assert.match(headCellSrc, /isDragging \? 'z-30/, 'drag state raises z-index only');
});

test('the shadcn Table wrapper is not used here — it would restore a second scrollport', () => {
  // components/ui/table.tsx wraps its <table> in its own overflow-auto div whose className is a
  // hardcoded literal (the className prop lands on the inner <table>), so a call site cannot
  // neutralize it. Two nested scrollports is what put the horizontal scrollbar below 50 rows.
  assert.match(
    tablePrimitiveSrc,
    /<div className="relative w-full overflow-auto">/,
    'the primitive still has its own non-overridable scroll wrapper (if this changes, revisit)',
  );
  // The primitive's own classes minus its size, which this grid sets for itself (see the density
  // test above). If <Table> were restored, `caption-bottom` would come back on the inner element
  // and the wrapper div with it.
  assert.match(
    scrollportSrc,
    /<table ref=\{gridTableRef\} className="w-full caption-bottom text-(xs|sm)">/,
    'the results grid renders a bare <table> carrying the primitive\'s own classes',
  );
  assert.doesNotMatch(scrollportCode, /<Table[ >]/, 'the wrapper component must not come back');
  // The import is the real backstop: without it `<Table>` is a TS error, not a silent regression.
  assert.doesNotMatch(explorerCode, /import \{ Table,/, 'Table must not be re-imported here');
});

test('pagination sits outside the scrollport so it stays on screen', () => {
  const pagerIndex = explorerSrc.indexOf('<Pager');
  const scrollportIndex = explorerSrc.indexOf('ref={scrollportRef}');
  assert.ok(pagerIndex > scrollportIndex, 'Pager renders after the scrollport');
  assert.doesNotMatch(scrollportSrc, /<Pager/, 'Pager must not be inside the scroll container');
});

test('the scroll reset targets the scrollport, not the document', () => {
  // It used to be gridRef.scrollIntoView() — a DOCUMENT scroll that fought overscroll-contain and was
  // meaningless while the grid was always on screen. The RESET must never do that again.
  //
  // ⚠ THIS PIN WAS FILE-WIDE UNTIL 2026-09-04 AND IS NOW SCOPED. With a search active the column
  // overflows the viewport at every common size (the searched grid floor is 31rem), so ONE deliberate
  // document scroll now exists: the post-search settle that brings the yield card into view
  // (collections-scroll-to-results.test.tsx pins its rules). That scroll is not the reset, does not
  // touch the scrollport, and is the only `scrollIntoView` allowed in this file.
  const resetSrc = explorerCode.slice(
    explorerCode.indexOf('const resetGridScroll = useCallback('),
    explorerCode.indexOf('const measureScrollEdges = useCallback('),
  );
  assert.ok(resetSrc.length > 0, 'resetGridScroll located');
  assert.doesNotMatch(resetSrc, /scrollIntoView/, 'the reset must not scroll the document');
  assert.equal((explorerCode.match(/\.scrollIntoView\(/g) ?? []).length, 1, 'exactly one document scroll: the post-search settle');
  assert.match(explorerCode, /resultsRef\.current;[\s\S]{0,200}\.scrollIntoView\(/, 'and it targets the results wrapper, not the grid');
  assert.match(explorerCode, /scrollportRef\.current[\s\S]{0,200}scrollTo/, 'reset targets the scrollport');
  // Both axes: a column offset is as stale as a vertical one once the row set changes.
  assert.match(explorerCode, /scrollTo\(\{ top: 0, left: 0/, 'both axes reset');
  // A scripted smooth scroll ignores the stylesheet's reduced-motion override, so it must check.
  assert.match(explorerCode, /prefers-reduced-motion: reduce/, 'reduced motion is honoured');
});

test('EVERY path that replaces rows resets the scroll — the reset lives in loadPage', () => {
  /*
   * THE REGRESSION THIS EXISTS FOR (Qodo, PR #314). The reset was wired to the two refinement
   * handlers only, leaving the pager, the filter/sort/group effect and the midnight-rollover reload
   * to swap the rows underneath a retained offset — so Next while scrolled to row 40 opened the
   * next page at row 40. Pinning "loadPage calls it" rather than "the handlers call it" is the
   * point: loadPage is the one function all four paths go through, so a new call site inherits the
   * reset instead of having to remember it.
   */
  const loadPageSrc = (() => {
    const from = explorerCode.indexOf('const loadPage = useCallback(');
    assert.ok(from > 0, 'loadPage located');
    const to = explorerCode.indexOf('[view, resetGridScroll],', from);
    assert.ok(to > from, 'loadPage dependency array located');
    return explorerCode.slice(from, to);
  })();
  assert.match(loadPageSrc, /resetGridScroll\(\)/, 'loadPage resets the scroll after a load');
  assert.match(loadPageSrc, /setStatus\('ready'\)[\s\S]{0,400}resetGridScroll\(\)/, 'reset runs on the success path');
  // Declared before loadPage, or its own dependency array is a TDZ crash at first render.
  assert.ok(
    explorerCode.indexOf('const resetGridScroll') < explorerCode.indexOf('const loadPage'),
    'resetGridScroll must be declared above loadPage (it is in its dep array)',
  );
  // And NOT duplicated back into the refinement handlers — two mechanisms for one job is what
  // allowed the gap. They reach loadPage through the filterArg reload effect.
  const handlers = explorerCode.slice(
    explorerCode.indexOf('function applyRefinement('),
    explorerCode.indexOf('function selectDrilldownPoint('),
  );
  assert.ok(handlers.length > 0, 'refinement handlers located');
  assert.doesNotMatch(handlers, /resetGridScroll\(\)/, 'handlers must not re-add their own reset');
});

/* ───────────────────────── EDGE FADES — the idle overflow affordance ─────────────────────────
 *
 * WHY THEY EXIST: a macOS overlay scrollbar is invisible at idle under the OS default ("Show
 * scroll bars: When scrolling"), so 11 of 17 columns sat off the right edge with no cue at all.
 * The fades are the affordance; they replaced nothing, because this surface never had scrollbar
 * CSS. Ruled 2026-09-02: all four edges, one mechanism only.
 *
 * As above, these are SOURCE pins because the component cannot be imported and jsdom has no
 * layout — `scrollHeight === clientHeight` always, so every boolean below would read `false`
 * there. Whether a fade actually appears at the right moment is browser-verified.
 */

test('four independent edge states, derived from scroll geometry alone', () => {
  assert.match(
    explorerCode,
    /useState\(\{ top: false, right: false, bottom: false, left: false \}\)/,
    'all four edges start clear and are one state object',
  );
  // Each boolean must come from the scrollport's own geometry — not from a row count, a page
  // number, or anything else that can disagree with what is actually on screen.
  assert.match(edgeLogicSrc, /top: scrollTop > slack/, 'top edge from scrollTop');
  assert.match(edgeLogicSrc, /left: scrollLeft > slack/, 'left edge from scrollLeft');
  assert.match(edgeLogicSrc, /bottom: scrollTop \+ clientHeight < scrollHeight - slack/, 'bottom edge from height');
  assert.match(edgeLogicSrc, /right: scrollLeft \+ clientWidth < scrollWidth - slack/, 'right edge from width');
  // The tolerance is load-bearing: fractional device pixels and zoom leave scrollTop at e.g. 0.5,
  // so an exact `> 0` paints a fade at a true extreme and chatters against it.
  assert.match(edgeLogicSrc, /const slack = 1;/, 'a 1px tolerance guards the extremes');
  // Bail out of the re-render when nothing flipped — scroll fires far more often than an edge
  // changes, and this is the one surface where a wasted render is expensive.
  assert.match(edgeLogicSrc, /\? prev\s*: next,/, 'unchanged measurements must return the previous object');
});

test('the scroll listener is PASSIVE and coalesced to one measurement per frame', () => {
  // Passive: this listener never calls preventDefault, and saying so lets the browser keep
  // scrolling off the main thread. Without it, every wheel tick blocks the compositor.
  assert.match(
    edgeLogicSrc,
    /addEventListener\('scroll', scheduleEdgeMeasure, \{ passive: true \}\)/,
    'scroll listener must be registered passive',
  );
  assert.doesNotMatch(edgeLogicSrc, /addEventListener\('scroll', [^,]+\);/, 'no scroll listener without options');
  // rAF-coalesced: the measurement reads six layout properties, so one per event would be a
  // forced synchronous layout per event.
  assert.match(edgeLogicSrc, /if \(edgeRafRef\.current\) return;/, 'a queued measurement is not queued twice');
  assert.match(edgeLogicSrc, /requestAnimationFrame\(\(\) => \{[\s\S]{0,120}measureScrollEdges\(\)/, 'measurement runs in a rAF');
});

test('the ResizeObserver watches BOTH the scrollport and the table', () => {
  assert.match(edgeLogicSrc, /new ResizeObserver\(scheduleEdgeMeasure\)/, 'a ResizeObserver is wired');
  assert.match(edgeLogicSrc, /ro\.observe\(el\)/, 'observes the scrollport — window resize and zoom');
  /*
   * THE SECOND TARGET IS NOT REDUNDANT, and this is the assertion most likely to be "simplified"
   * away. Hiding a column changes the TABLE's width, so `scrollWidth` moves while the scrollport's
   * own box does not (it is flex-1 against a fixed parent). An observer watching only the
   * scrollport structurally cannot fire for that — the right fade would keep painting over a grid
   * that no longer overflows, or fail to appear on one that now does.
   */
  assert.match(edgeLogicSrc, /ro\.observe\(gridTableRef\.current\)/, 'observes the table — column show/hide');
});

test('row replacement re-measures, and the effect cleans up after itself', () => {
  /*
   * `rows` in the dep array is the fourth trigger and the least obvious. Paging 1 → 2 swaps 50
   * rows for 50 rows: the table height is unchanged (no ResizeObserver fire) and resetGridScroll
   * may scroll to an offset that is already 0,0 (no scroll event) — yet a short final page has a
   * different scroll extent. Without this, a bottom fade keeps painting over content that has none.
   */
  assert.match(edgeLogicSrc, /\}, \[rows, measureScrollEdges, scheduleEdgeMeasure\]\);/, 'effect re-runs when rows change');
  // Measured synchronously in the effect body, which is also the FIRST measurement — the fades
  // must be correct on first paint, before any scroll or resize.
  assert.match(edgeLogicSrc, /if \(!el\) return;\s*measureScrollEdges\(\);/, 'effect measures on mount and on every re-run');
  // Full teardown, or a re-mount leaks a listener, an observer and a pending frame.
  assert.match(edgeLogicSrc, /removeEventListener\('scroll', scheduleEdgeMeasure\)/, 'listener removed');
  assert.match(edgeLogicSrc, /ro\.disconnect\(\)/, 'observer disconnected');
  assert.match(edgeLogicSrc, /cancelAnimationFrame\(edgeRafRef\.current\)/, 'pending frame cancelled');
});

test('the fades are decorative: hidden from AT, transparent to the pointer, and static', () => {
  const fades = fadesSrc.match(/<div\s+aria-hidden[\s\S]*?\/>/g) ?? [];
  assert.equal(fades.length, 4, `expected 4 fade overlays, found ${fades.length}`);
  for (const f of fades) {
    assert.match(f, /aria-hidden/, 'each fade is hidden from assistive tech');
    assert.match(f, /pointer-events-none/, 'each fade must never intercept a click');
    // STATIC PRESENCE (WCAG 2.3.3). Appearance is a mount, not an animation — so there is no
    // motion-reduce variant to get wrong, and no pulse or hint to suppress. The 1px slack in the
    // measurement is what keeps a mount from reading as a flicker at the extremes.
    assert.doesNotMatch(f, /transition|animate-|duration-/, 'fades must not animate');
    // Token, not a hex literal — and the SAME token the rows sit on, which is what makes the
    // 1px geometric overlap with the header invisible in paint (measured: 0 pixel delta).
    assert.match(f, /from-ground to-ground\/0/, 'gradient runs from the ground token to zero alpha');
    assert.doesNotMatch(f, /#[0-9a-fA-F]{3,8}/, 'no hex literals in the gradient');
  }
  // All four edges are covered, each in its own direction.
  for (const [edge, dir] of [['top', 'to-b'], ['bottom', 'to-t'], ['left', 'to-r'], ['right', 'to-l']]) {
    const one = fades.find((f) => fadesSrc.indexOf(f) > fadesSrc.indexOf(`{scrollEdges.${edge} && (`));
    assert.ok(one, `${edge} fade present`);
    assert.ok(fadesSrc.includes(`bg-gradient-${dir}`), `${edge} fade fades inward (bg-gradient-${dir})`);
  }
});

test('no fade paints over the sticky header — geometrically AND by z-index', () => {
  /*
   * TWO MECHANISMS ON PURPOSE, because the z-index alone is conditional. `opacity-60` during a
   * refetch makes the scrollport a stacking context, which pulls the header's own `z-20` inside it
   * — so a `z-10` sibling would paint over the header in exactly that state and no other. The
   * geometric offset is what actually guarantees it; the z-index makes the two agree.
   */
  /*
   * THE PAIRED CONSTANT, now with a third member: the header is `h-8`, body rows carry
   * `scroll-mt-8`, and the three fades that meet the header start at `calc(2rem + 1px)` — the
   * same 2rem plus the scrollport's own 1px border, which offsets the header's box downward.
   *
   * ⚠ THE +1px IS NOT ROUNDING SLOP. At a plain `top-8` the fade overlapped the header's last
   * pixel row, which is exactly where the sticky underline lives. That was invisible in the normal
   * state (the header's z-20 paints over the fade's z-10) and ERASED the underline during a
   * refetch, when `opacity-60` makes the scrollport a stacking context and the fade wins. Measured
   * both ways: 231 → 251 (ground) in the refetch state before, unchanged after. Do not "simplify"
   * this back to top-8.
   */
  for (const edge of ['top', 'left', 'right']) {
    const block = fadesSrc.slice(fadesSrc.indexOf(`{scrollEdges.${edge} && (`));
    assert.match(
      block.slice(0, 400),
      /top-\[calc\(2rem_\+_1px\)\]/,
      `${edge} fade must clear the header's full box, underline included`,
    );
    assert.doesNotMatch(block.slice(0, 400), /\btop-8\b/, `${edge} fade must not sit at the bare h-8 offset`);
  }
  assert.match(explorerCode, /sticky top-0 z-20 h-8 bg-ground/, 'header is h-8 and z-20');
  // Below the header (z-20), the drag branch (z-30) and the refetch progress bar (z-30).
  for (const f of fadesSrc.match(/<div\s+aria-hidden[\s\S]*?\/>/g) ?? []) {
    assert.match(f, /\bz-10\b/, 'fades sit at z-10, under the header and the drag state');
  }
  // 1px inset on every side that meets the frame, so an opaque gradient stop cannot erase the
  // scrollport's own border, plus rounded corners matching the scrollport's rounding.
  assert.ok(fadesSrc.includes('inset-x-px'), 'horizontal fades inset past the border');
  assert.ok(fadesSrc.includes('rounded-b-md') && fadesSrc.includes('rounded-bl-md') && fadesSrc.includes('rounded-br-md'),
    'fades clip to the scrollport rounding');
});

test('the sticky header draws its own underline, so it survives being pinned', () => {
  /*
   * THE BUG THIS PINS (introduced with the sticky header in #314, fixed here). `<table>` is
   * `border-collapse: collapse`, so a `border-b` on the header row belongs to the TABLE'S BORDER
   * GRID rather than to the cell — and the grid scrolls with the content while the cell stays
   * pinned. Measured on merged main: at rest the seam reads as a uniform dark row (stddev 0);
   * while stuck that row is gone and only text glyphs remain. An inset box-shadow is painted by
   * the CELL, so it pins with the cell.
   */
  const headCellSrc = explorerCode.slice(
    explorerCode.indexOf('function SortableHeadCell({'),
    explorerCode.indexOf('function SortableColumnItem({'),
  );
  assert.ok(headCellSrc.length > 0, 'SortableHeadCell located');
  assert.match(
    headCellSrc,
    /shadow-\[inset_0_-1px_0_hsl\(var\(--border\)\)\]/,
    'the pinned cell draws its own 1px underline',
  );
  // Same token the row border used — never a hex, same rule as the fades.
  assert.doesNotMatch(headCellSrc, /shadow-\[inset[^\]]*#[0-9a-fA-F]{3,8}/, 'no hex literal in the underline');

  /*
   * BOTH primitive sources of the collapsed border must be cancelled, or the two lines stack 1px
   * apart — 2px of underline at rest, 1px while stuck.
   *
   * ⚠ AND EACH OVERRIDE MUST SIT ON THE ELEMENT THAT CARRIES THE CLASS IT CANCELS. `[&_tr]:border-b`
   * on <TableHeader> compiles to `.\[\&_tr\]\:border-b tr`, specificity (0,1,1), which BEATS a
   * plain `.border-b-0` (0,1,0) on the row — so cancelling it from the row loses a silent cascade
   * race. On the same element twMerge deletes the class outright and specificity never enters into
   * it. Moving either override to the other element reintroduces the bug.
   */
  assert.match(scrollportCode, /<TableHeader className="\[&_tr\]:border-b-0">/, 'thead cancels its own descendant rule');
  assert.match(scrollportCode, /<TableRow className="border-b-0">/, 'the header row cancels its own border');
  // ui/table.tsx keeps both for its 10 other consumers — this is a call-site override, not an edit.
  assert.match(tablePrimitiveSrc, /\[&_tr\]:border-b/, 'the primitive still sets the row border for everyone else');
});

test('ONE affordance only — no scrollbar CSS on this surface', () => {
  /*
   * RULED 2026-09-02. Two overlapping mechanisms is how you get a styled bar under one macOS
   * "Show scroll bars" setting and a fade under the other, which is the exact inconsistency the
   * fades exist to remove. It is also a live trap: Chrome 121+ IGNORES ::-webkit-scrollbar
   * pseudo-elements once `scrollbar-color` or `scrollbar-width` is set on the same element, so a
   * belt-and-braces pair silently reduces to whichever half the engine prefers.
   */
  for (const prop of ['scrollbar-width', 'scrollbar-color', 'scrollbar-gutter', 'webkit-scrollbar']) {
    assert.ok(!explorerCode.includes(prop), `${prop} must not appear in the explorer`);
  }
  // globals.css may carry exactly ONE ::-webkit-scrollbar rule — .q-marquee, the Qualify /
  // Payer-Intel ticker, which HIDES its bar and is a different surface entirely.
  const webkitRules = globalsCss.match(/[^\s{}]+::-webkit-scrollbar/g) ?? [];
  assert.deepEqual(
    [...new Set(webkitRules)],
    ['.q-marquee::-webkit-scrollbar'],
    'the only ::-webkit-scrollbar rule in globals.css is the q-marquee ticker',
  );
});
