/**
 * The Collections page header — the ONE row that carried the tenant tabs and still carries the
 * freshness line, and the chrome reclaim that row exists for (2026-09-04).
 *
 * ⚠ THE TABS LEFT THIS ROW 2026-09-08. Alec reversed his 2026-08-18 on-page-tabs ruling; the tenant
 * selector is the nav <TenantScope> pill in app/layout.tsx and `TenantTabs` is deleted. Two of this
 * file's tests had the tabs as their SUBJECT — the direct-child / no-wrapper guard and the "share
 * one row" guard — and that subject is genuinely gone, so they are replaced below by a pin that the
 * in-body row does not come back. The 1.4.10 overflow they guarded was a defect of the tabs INSIDE
 * this row; with no tabs in the row there is nothing here to overflow. (The NAV's own reflow at
 * narrow widths is a separate, pre-existing, unguarded matter recorded in the PR — not this file's.)
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
 *   (Measured WITH the tabs in the row. Without them the row is the freshness line alone, so the
 *   chrome is shorter still; the reclaim floor below is therefore conservative, not stale.)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, '../app/dashboard/collections/page.tsx'), 'utf8');
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

test('the freshness line lives INSIDE the header row', () => {
  // Two stacked blocks with a gap-6 between them was the shape this replaced. The Suspense boundary
  // must be INSIDE the <header>, or the gap comes back. (This test used to also pin the tabs into
  // the same row; that half of its subject moved to the nav on 2026-09-08 — see the header note.)
  assert.match(headerSrc, /flex shrink-0 flex-wrap items-center/, 'the header is a wrapping, centred flex row');
  assert.match(headerSrc, /<Suspense fallback=\{<FreshnessLinePlaceholder inline \/>\}>/, 'the freshness line is in the row');
  // flex-wrap + a row gap is the 200%-zoom escape, kept so the row can still wrap if a second item
  // ever returns to it rather than squashing what is there.
  assert.match(headerSrc, /gap-y-1/, 'the row must be allowed to wrap to two lines');
});

/*
 * THE WRAPPER REGRESSION, BOTH HALVES (Qodo #323) — kept as HISTORY, its subject is gone.
 * The first draft of this row wrapped TenantTabs in a `<div className="shrink-0">`, carried over
 * from the old column layout. That one element caused two separate defects:
 *
 *   1. `shrink-0` in a ROW means "do not shrink horizontally". The tablist's own `flex-wrap` can
 *      only wrap when its containing block is constrained, so the wrapper took its max-content
 *      width and the DOCUMENT overflowed sideways — measured at 111px past a 390px viewport and
 *      181px past a 320px one, with the tabs stuck on one line. WCAG 1.4.10 (Reflow).
 *   2. When a single-entitled-view user made TenantTabs return null, the EMPTY wrapper was still
 *      a zero-width flex item holding `space-between`'s first slot, shoving the freshness line to
 *      the far right of an 1800px container.
 *
 * Both were defects of the tabs INSIDE this row. On 2026-09-08 the tabs left the row for the nav,
 * so there is no tablist here to wrap, squash, or wrap around. What replaces the two guards is the
 * pin below that the row does not re-grow one.
 */
test('the in-body tenant row is GONE — its subject moved to the nav (2026-09-08)', () => {
  assert.doesNotMatch(pageCode, /<TenantTabs/, 'no tenant tabs rendered on this page');
  assert.doesNotMatch(pageSrc, /from\s+['"][^'"]*tenant-tabs['"]/, 'and none imported');
  assert.doesNotMatch(pageCode, /<TenantScope/, 'nor the nav control mounted here — it lives in app/layout.tsx, once');
  // The successor control exists where the ruling put it.
  const layout = readFileSync(join(here, '../app/layout.tsx'), 'utf8');
  assert.match(layout, /<TenantScope allowedViews=\{allowedViews\} \/>/, 'the nav mounts the scope pill');
  assert.equal(existsSync(join(here, '../components/dashboard/tenant-tabs.tsx')), false, 'TenantTabs is deleted, not orphaned');
});

test('justify-between is UNCONDITIONAL — a lone item goes flush left on its own', () => {
  // The header now holds ONE item for every reader (the freshness line), so this is the shape it
  // always renders: `space-between` with a lone child puts it flush with main-start (measured x=40,
  // exactly the sm:px-10 inset). One static class list, no ternary, no visibility predicate.
  assert.match(
    headerSrc,
    /<header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1">/,
    'one static class list, no ternary',
  );
  // ⚠ AND THE PAGE MUST NOT REACH FOR A VISIBILITY PREDICATE TO DECIDE THIS. The first draft
  // exported `tenantTabsVisible` from a client module and called it here — see the client-boundary
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
 *
 * ⚠ THE GUARD IS DORMANT AS OF 2026-09-08, AND SAYS SO. TenantTabs was this page's ONLY client
 * import (data-freshness and unprovisioned-notice are server modules; @/components/dashboard is a
 * barrel with no directive — which is also a LIMIT of this scan: a client component re-exported
 * through a directive-less barrel is never checked, because the test looks for `'use client'` on the
 * file the import resolves to, not on what that file re-exports). With it gone the scan below finds
 * nothing to check. The old
 * `checked.length > 0` sentinel — "the guard is worthless if it silently matched nothing" — would
 * now fail for the wrong reason, so it is replaced by an explicit statement of the current count:
 * the loop still runs, and the moment a client import is added here it is live again. Do not
 * "fix" the dormancy by adding a client import to satisfy a test.
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
  // A REAL RATCHET, not a tautology (the first draft asserted `Array.isArray(checked)`, which cannot
  // fail — the code review of 2026-09-08 caught it). This FAILS exactly when the dormancy ends, which
  // is the moment someone needs to look: confirm the loop above is live for the new import, then
  // update this list to name it.
  assert.deepEqual(checked, [], `this page has no client imports today — you added one; confirm the guard above is live and update this list: ${checked.join(', ')}`);
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
