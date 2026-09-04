/**
 * The Collections page header — the ONE row that carries the tenant tabs and the freshness line,
 * and the chrome reclaim that row exists for (2026-09-04).
 *
 * WHY SOURCE PINS. The page is an async server component whose import graph reaches
 * @/lib/actions → @/lib/access and the RSC `cache()`, which crashes under node:test — the same
 * constraint collections-grid-scrollport.test.tsx documents. And the thing being protected here is
 * LAYOUT: 106px of reclaimed height, measured in a headless-Chromium replica of this column. jsdom
 * has no layout engine (`getBoundingClientRect()` returns zeros), so a render test could not check
 * a single px of it even if the import worked. What CAN be pinned is the markup that produced the
 * measurement, which is what fails if someone puts the old stack back.
 *
 * THE MEASUREMENT, for the record (headless Chromium, real class strings, app font scale):
 *   chrome above the grid   180.5px -> 74.5px at 1440x900 and 1920x1080; 180.5 -> 96.5 at 200%
 *                           zoom, where the row wraps to two lines
 *   landing rows visible    10 -> 12 at 1440x900 (and the type is 15px, not 13)
 *   contributions           h1 sr-only 32 + one fewer gap-6 and a gap-4 32 + sm:pt-4 16 +
 *                           tabs/freshness sharing one 42.5px row 26 = 106
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, '../app/dashboard/collections/page.tsx'), 'utf8');
const tabsSrc = readFileSync(join(here, '../components/dashboard/tenant-tabs.tsx'), 'utf8');
const overviewSrc = readFileSync(join(here, '../app/dashboard/page.tsx'), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pageCode = strip(pageSrc);

test('the h1 is SR-ONLY, not deleted — heading order survives the reclaim', () => {
  // The visible <h1 class="text-2xl"> was 32px of a 106px reclaim. Deleting it would have been
  // the cheaper edit and a WCAG 1.3.1 / 2.4.6 regression: the document would then open at <h2>.
  assert.match(pageCode, /<h1 className="sr-only">Collections<\/h1>/, 'the h1 stays, visually hidden');
  assert.doesNotMatch(pageCode, /<h1 className="text-2xl/, 'the visible heading must not come back');
  assert.equal((pageCode.match(/<h1/g) ?? []).length, 1, 'exactly one h1 on the page');
});

const headerSrc = (() => {
  const from = pageCode.indexOf('<header');
  const to = pageCode.indexOf('</header>');
  assert.ok(from > 0 && to > from, 'the header element is located');
  return pageCode.slice(from, to);
})();

test('the tabs and the freshness line share ONE row', () => {
  // Two stacked blocks with a gap-6 between them was the shape this replaced. The tabs and the
  // Suspense boundary must both be INSIDE the <header>, or the gap comes back.
  assert.match(headerSrc, /flex shrink-0 flex-wrap items-center/, 'the header is a wrapping, centred flex row');
  assert.match(headerSrc, /<TenantTabs allowedViews=\{access\.access\.allowedViews\}/, 'the tabs live in the row');
  assert.match(headerSrc, /<Suspense fallback=\{<FreshnessLinePlaceholder inline \/>\}>/, 'so does the freshness line');
  // flex-wrap + a row gap is the 200%-zoom escape: the two do not fit side by side in a 720px
  // viewport, and the alternative to wrapping is squashing the tablist.
  assert.match(headerSrc, /gap-y-1/, 'the row must be allowed to wrap to two lines');
});

/*
 * THE WRAPPER REGRESSION, BOTH HALVES (Qodo #323). The first draft of this row wrapped TenantTabs
 * in a `<div className="shrink-0">`, carried over from the old column layout. That one element
 * caused two separate defects, and removing it fixed both:
 *
 *   1. `shrink-0` in a ROW means "do not shrink horizontally". The tablist's own `flex-wrap` can
 *      only wrap when its containing block is constrained, so the wrapper took its max-content
 *      width and the DOCUMENT overflowed sideways — measured at 111px past a 390px viewport and
 *      181px past a 320px one, with the tabs stuck on one line. WCAG 1.4.10 (Reflow). As a direct
 *      child the tablist wraps to 2 lines at 390px and 3 at 320px, with zero overflow.
 *   2. When a single-entitled-view user makes TenantTabs return null, the EMPTY wrapper was still
 *      a zero-width flex item holding `space-between`'s first slot, shoving the freshness line to
 *      the far right of an 1800px container. With no wrapper there is no item, and `space-between`
 *      puts a lone item flush with main-start (measured x=40 — exactly the sm:px-10 inset).
 *
 * Both are layout, so these pin the markup that produced the measurements. jsdom cannot check a
 * pixel of it (no layout engine) and neither can `next build`.
 */
test('TenantTabs is a DIRECT child of the row — no shrink-0 wrapper', () => {
  assert.match(
    headerSrc,
    /<TenantTabs allowedViews=\{access\.access\.allowedViews\} \/>/,
    'TenantTabs renders unwrapped',
  );
  // The wrapper is what a future reader would "restore" to stop the tabs shrinking. It must not
  // come back in ANY form — the tablist needs to shrink so that it can wrap.
  assert.doesNotMatch(headerSrc, /<div className="shrink-0">\s*<TenantTabs/, 'no wrapper around the tabs');
  assert.doesNotMatch(headerSrc, /shrink-0[^"]*">\s*<TenantTabs/, 'and no shrink-0 on any wrapper of them');
  // `shrink-0` on the <header> ITSELF is correct and unrelated: that is the COLUMN axis, keeping
  // the row from being squashed by the grid below it.
  assert.match(headerSrc, /<header className="flex shrink-0/, 'the header keeps its own column-axis shrink-0');
});

test('justify-between is UNCONDITIONAL — a lone item goes flush left on its own', () => {
  assert.match(
    headerSrc,
    /<header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1">/,
    'one static class list, no ternary',
  );
  // ⚠ AND THE PAGE MUST NOT REACH FOR A VISIBILITY PREDICATE TO DECIDE THIS. The first draft
  // exported `tenantTabsVisible` from tenant-tabs.tsx and called it here — see the client-boundary
  // test below for why that was a 500 rather than a style choice.
  assert.doesNotMatch(pageCode, /tenantTabsVisible/, 'no visibility predicate is consulted');
  assert.doesNotMatch(pageCode, /allowedViews\.length > 1/, 'and none is re-derived inline either');
});

test('BOTH halves of the Suspense pair are inline, or the fallback shifts', () => {
  // lineClass drops `mt-2` for the inline placement. One `inline` without the other reserves 8px
  // the resolved line does not have — a visible jump on every cold load.
  assert.match(pageCode, /<FreshnessLinePlaceholder inline \/>/, 'the fallback is inline');
  assert.match(pageCode, /<DataFreshness view=\{view\} inline \/>/, 'and so is the real line');
});

test('the reclaimed padding and gap are exactly the measured ones', () => {
  assert.match(pageCode, /gap-4 p-6 sm:px-10 sm:pt-4 sm:pb-8/, 'gap-4, pt-4, pb-8 — the measured stack');
  // ⚠ pb-8 is the load-bearing half: it is what keeps the pager on screen AND the slack that
  // absorbs a small floor overflow without a document scrollbar. pt-4 was the free 16px.
  assert.doesNotMatch(pageCode, /sm:py-8/, 'symmetric vertical padding must not be restored');
  assert.doesNotMatch(pageCode, /sm:pb-4|sm:pb-6/, 'never shrink the BOTTOM padding to buy height');
  assert.match(pageCode, /flex-col gap-4/, 'one 16px gap between the header row and the view');
  assert.doesNotMatch(pageCode, /flex-col gap-6/, 'the 24px column gap is gone');
});

/*
 * THE CLIENT/SERVER BOUNDARY, as a general guard rather than a one-off (Qodo #323).
 *
 * This page is an async Server Component. An export from a `'use client'` module becomes a CLIENT
 * REFERENCE when a server module imports it — the compiled server chunk replaces the function body
 * with `throw Error("Attempted to call X() from the server but X is on the client…")`. Rendering
 * a COMPONENT through that reference is fine and is the whole point; CALLING it as a function is a
 * hard 500.
 *
 * ⚠ AND THE FIVE-COMMAND GATE DOES NOT CATCH IT. `tsc` sees a normal function and is happy;
 * `next build` compiled this page successfully with the broken call in it, because
 * /dashboard/collections is `ƒ (Dynamic)` and is therefore never prerendered — nothing executes
 * the page body at build time. The evidence was in the build OUTPUT, not the build's exit code.
 *
 * So: every value this page imports from a client module must be used as a JSX component and
 * never invoked. Sibling trap, opposite direction: a non-function export from a `'use server'`
 * file breaks every Server Action on the page, also silently.
 */
test('nothing imported from a client module is CALLED by this server page', () => {
  const importRe = /import\s+\{([^}]+)\}\s+from\s+'(@\/(?:components|lib)\/[^']+)'/g;
  const checked: string[] = [];
  for (const m of pageSrc.matchAll(importRe)) {
    const rel = m[2]!.replace('@/', '');
    const candidates = [`../${rel}.tsx`, `../${rel}.ts`, `../${rel}/index.tsx`, `../${rel}/index.ts`];
    const found = candidates.map((c) => join(here, c)).find((f) => existsSync(f));
    if (!found) continue;
    // Only the client modules matter — a plain module is server-callable.
    if (!/^\s*['"]use client['"]/.test(readFileSync(found, 'utf8'))) continue;
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (name === '') continue;
      checked.push(`${name} (${rel})`);
      // Used as a component: fine. Called: a 500 on every render of this route.
      assert.doesNotMatch(
        pageCode,
        new RegExp(`(?<!<)\\b${name}\\s*\\(`),
        `${name} comes from the client module ${rel} and must never be CALLED here — only rendered`,
      );
    }
  }
  // The guard is worthless if it silently matched nothing: this page imports at least TenantTabs
  // from a 'use client' module, so the scan must have found something to check.
  assert.ok(checked.length > 0, `expected >=1 client import to check, found: ${checked.join(', ')}`);
  // And the premise has to hold — if tenant-tabs.tsx ever loses its 'use client', the scan above
  // would skip it and pass for the wrong reason.
  assert.match(tabsSrc, /^'use client';/, 'tenant-tabs.tsx is a client module');
  // It must also not re-grow a non-component export for a server caller to reach for. Relocating
  // such a helper to a server-safe module is the correct fix WHEN one is needed; here the layout
  // fix removed the need, so the cleanest state is no helper at all.
  assert.doesNotMatch(tabsSrc, /export function tenantTabsVisible/, 'no callable export on the client module');
});

test('the compact header is COLLECTIONS-ONLY — Overview is untouched', () => {
  // Collections is the only viewport-BOUNDED route (`h-[calc(100dvh-3.5rem)]`); the others scroll
  // and have nothing to gain from a shorter header. The four route headers are hand-rolled and
  // already disagree on width, padding and h1 treatment — consolidating them is its own PR, with
  // its own browser pass. Do not let this reclaim leak into them as a drive-by.
  const overviewCode = strip(overviewSrc);
  assert.match(overviewCode, /<h1/, 'Overview keeps a VISIBLE heading');
  assert.doesNotMatch(overviewCode, /<h1 className="sr-only"/, 'Overview must not inherit the sr-only h1');
  assert.doesNotMatch(overviewCode, /FreshnessLinePlaceholder inline/, 'Overview keeps the stacked freshness line');
  assert.doesNotMatch(overviewCode, /h-\[calc\(100dvh/, 'and it is not viewport-bounded, so it has nothing to reclaim');
});
