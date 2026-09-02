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
  assert.match(scrollportCode, /<table className="w-full caption-bottom text-xs">/, 'grid uses the 13px house size');
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

test('the grid keeps a min-height floor so it cannot collapse at 200% zoom', () => {
  // flex-1 with no floor + a tall filter panel = a few pixels of table on a short viewport.
  // The floor makes the column overflow and the DOCUMENT scroll instead, which is the
  // intended fallback rather than a failure.
  assert.match(explorerSrc, /min-h-\[20rem\]/, 'the grid has a min-height floor');
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
    /<table className="w-full caption-bottom text-(xs|sm)">/,
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

test('the refinement scroll reset targets the scrollport, not the document', () => {
  // It used to be gridRef.scrollIntoView() — a DOCUMENT scroll, which is meaningless now that the
  // grid is always on screen, and which would fight overscroll-contain.
  assert.doesNotMatch(explorerCode, /scrollIntoView/, 'no document-level scroll remains');
  assert.match(explorerCode, /scrollportRef\.current[\s\S]{0,200}scrollTo/, 'reset targets the scrollport');
  // A scripted smooth scroll ignores the stylesheet's reduced-motion override, so it must check.
  assert.match(explorerCode, /prefers-reduced-motion: reduce/, 'reduced motion is honoured');
});
