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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tenantTabsVisible } from '../lib/tenant-tabs';
import type { DashboardView } from '@/lib/views';

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

test('the tabs and the freshness line share ONE row', () => {
  // Two stacked blocks with a gap-6 between them was the shape this replaced. The tabs wrapper and
  // the Suspense boundary must both be INSIDE the <header>, or the gap comes back.
  const header = pageCode.slice(pageCode.indexOf('<header'), pageCode.indexOf('</header>'));
  assert.ok(header.length > 0, 'the header element is located');
  assert.match(header, /flex shrink-0 flex-wrap items-center/, 'the header is a wrapping, centred flex row');
  assert.match(header, /<TenantTabs allowedViews=\{access\.access\.allowedViews\}/, 'the tabs live in the row');
  assert.match(header, /<Suspense fallback=\{<FreshnessLinePlaceholder inline \/>\}>/, 'so does the freshness line');
  // flex-wrap + a row gap is the 200%-zoom escape: the two do not fit side by side in a 720px
  // viewport, and the alternative to wrapping is squashing the tablist.
  assert.match(header, /gap-y-1/, 'the row must be allowed to wrap to two lines');
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

test('justify-between is read from TenantTabs, not re-derived', () => {
  // With one entitled view TenantTabs renders null and justify-between would strand the freshness
  // line against the right edge of an 1800px container. The page must not carry its own copy of
  // the "> 1 view" rule, because a second copy is free to drift from the component's.
  assert.match(pageCode, /tenantTabsVisible\(access\.access\.allowedViews\)/, 'the page asks the component');
  assert.doesNotMatch(pageCode, /allowedViews\.length > 1/, 'and does not re-derive the predicate');
  // The component itself must USE the exported predicate, or the two can still disagree.
  assert.match(strip(tabsSrc), /if \(!tenantTabsVisible\(allowedViews\)\) return null;/, 'one rule, one caller');

  const one: DashboardView[] = ['consolidated'];
  assert.equal(tenantTabsVisible(undefined), false, 'no entitlement, no tablist');
  assert.equal(tenantTabsVisible([]), false, 'no views, no tablist');
  assert.equal(tenantTabsVisible(one), false, 'one view is nothing to switch');
  assert.equal(tenantTabsVisible(['consolidated', 'bxr']), true, 'two views is a tablist');
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
