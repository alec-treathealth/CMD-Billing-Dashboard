/**
 * Two Collections affordances asked for on 2026-09-04, pinned at the source.
 *
 *   1. *"i want them to be highlighted/glowing with motion and the user can click anywhere on them
 *      for the dropdown"* — the two folded result panels (Drill in, Cohort payer behavior).
 *   2. *"There should also be a big accessible and visible 'new search' or 'clear search' button
 *      that allows the user to clear the search and the previous AI response"*.
 *
 * WHY SOURCE PINS, AGAIN. cmd-explorer.tsx cannot be imported under node:test — its graph reaches
 * @/lib/actions → @/lib/access and the RSC `cache()`, which crashes the runtime (the constraint
 * collections-grid-scrollport.test.tsx documents). And half of what matters here is paint: a glow,
 * a hover tint, an outline that grows. jsdom has no layout engine and no paint, so it could not
 * check any of it even if the import worked. The browser pass owns the look; these own the wiring.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
const globalsCss = readFileSync(join(here, '../app/globals.css'), 'utf8');
/** Comment-stripped, for every assertion about the ABSENCE of something — the comments in this file
 *  legitimately NAME what they ban, and a prose match would fail for the wrong reason. */
const explorerCode = explorerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The two collapsible panels, sliced so an assertion cannot pass on the other one's markup. */
const panelSrc = (fn: string, next: string) => {
  const from = explorerSrc.indexOf(`function ${fn}(`);
  const to = explorerSrc.indexOf(`function ${next}(`, from);
  assert.ok(from > 0 && to > from, `${fn} slice located`);
  return explorerSrc.slice(from, to);
};
const drillSrc = panelSrc('SearchDrillPanel', 'ComboDrillList');
const cohortSrc = panelSrc('CohortCurvePanel', 'CohortDrilldownPanel');

/* ── 1. The whole header is the trigger ──────────────────────────────────────────────────────── */

test('BOTH folded panels make the whole header row a click target, from ONE shared handler', () => {
  for (const [name, src] of [['drill', drillSrc], ['cohort', cohortSrc]] as const) {
    assert.match(
      src,
      /className=\{FOLD_ROW_CLASS\} onClick=\{foldRowClickHandler\(toggle\)\}/,
      `${name}: the header row carries the shared class list and the shared handler`,
    );
    // One `toggle`, used by BOTH the row and the button — two inline setters could drift into
    // toggling twice or into different behaviour per entry point.
    assert.match(src, /const toggle = \(\) => setCollapsed\(\(\w\) => !\w\);/, `${name}: one toggle`);
    assert.match(src, /onClick=\{toggle\}/, `${name}: the disclosure button uses it too`);
  }
  // Shared, not copied: a second copy is how the two affordances start behaving differently.
  assert.equal((explorerCode.match(/function foldRowClickHandler/g) ?? []).length, 1, 'one handler');
  assert.equal((explorerCode.match(/const FOLD_ROW_CLASS =/g) ?? []).length, 1, 'one row class list');
});

test('the row click is GUARDED — it never hijacks a control, and never ends a text selection', () => {
  const handler = explorerCode.slice(
    explorerCode.indexOf('function foldRowClickHandler'),
    explorerCode.indexOf('const FOLD_ROW_CLASS'),
  );
  // Without this the click on the disclosure button itself toggles twice and lands back where it
  // started — and any control added to either header later would silently fold the panel.
  assert.match(handler, /closest\(FOLD_ROW_INTERACTIVE\)/, 'interactive targets are left alone');
  for (const role of ['button', 'a', 'input', 'select', 'textarea', 'label', '\\[role="button"\\]']) {
    assert.match(explorerCode, new RegExp(`FOLD_ROW_INTERACTIVE = '[^']*${role}`), `${role} is in the guard`);
  }
  // A click that ends a drag is a selection, not a press. The cohort header carries the patient
  // count and the prefix — the two things a reader is most likely to be copying.
  assert.match(handler, /getSelection\(\)/, 'an active text selection suppresses the toggle');
  assert.match(handler, /!selection\.isCollapsed/, 'and it checks the selection is non-empty');
  // SSR-safe: this module is a client component but the guard must not assume a window exists.
  assert.match(handler, /typeof window === 'undefined' \? null :/, 'no bare window access');
});

test('the disclosure BUTTON keeps every semantic it had — the row click is additive only', () => {
  for (const [name, src] of [['drill', drillSrc], ['cohort', cohortSrc]] as const) {
    assert.match(src, /<button\s+type="button"\s+aria-expanded=\{!collapsed\}/, `${name}: real button`);
    assert.match(src, /aria-controls=\{bodyId\}/, `${name}: it still owns the region`);
    assert.match(src, /aria-label=\{collapsed \? 'Expand/, `${name}: it still has an accessible name`);
    // The body stays MOUNTED and `hidden` — an aria-controls target that does not exist is an ARIA
    // violation, and with these panels collapsed by default it would be the DEFAULT state.
    assert.match(src, /<div id=\{bodyId\} hidden=\{collapsed\}/, `${name}: body mounted + hidden`);
  }
  // The row must NOT have grown ARIA of its own — two things claiming aria-expanded for one
  // disclosure is worse than one, and the div deliberately contributes no semantics.
  assert.doesNotMatch(explorerCode, /FOLD_ROW_CLASS\} onClick=\{foldRowClickHandler\(toggle\)\} aria-/, 'the row stays semantically silent');
});

test('the glow is COLLAPSED-ONLY and layout-neutral', () => {
  const card = explorerCode.slice(explorerCode.indexOf('const foldCardClass'), explorerCode.indexOf('function SearchDrillPanel'));
  assert.match(card, /collapsed \? 'ths-fold' : ''/, 'the glow paints only while folded');
  assert.match(card, /rounded-xl border border-line bg-card p-4 shadow-ths/, 'the card itself is unchanged');
  // `relative` is what the ::after ring positions against.
  assert.match(card, /'relative rounded-xl/, 'the card stays a positioning context');
  // ⚠ THE HEIGHT BUDGET. Both panels are fixed blocks in a viewport-bounded column measured to the
  // pixel. `-m-1 p-1` cancels out, and the ring is an absolutely-positioned ::after, so neither
  // costs layout — measured: the collapsed Drill in card is 58px with and without `ths-fold`.
  assert.match(explorerCode, /FOLD_ROW_CLASS =[\s\S]{0,400}?-m-1 rounded-lg p-1/, 'padding is cancelled by a negative margin');
  assert.doesNotMatch(explorerCode, /FOLD_ROW_CLASS =[^;]*\bp-2\b/, 'no uncancelled padding on the row');
  // Both panels must go through the helper, or one of them keeps the old always-plain card.
  for (const [name, src] of [['drill', drillSrc], ['cohort', cohortSrc]] as const) {
    assert.match(src, /className=\{foldCardClass\(collapsed, refreshing\)\}/, `${name}: uses the shared card class`);
  }
});

/*
 * ⚠ THE BUG THIS TEST EXISTS FOR, because it cost this change a whole draft and it is INVISIBLE:
 * Tailwind SILENTLY EMITS NO RULE for an `/<alpha>` modifier on an arbitrary `var()` colour. It
 * cannot compute an alpha channel for an opaque var(), and it does not warn — the class just does
 * nothing. The first draft styled the ring with
 * `border-[var(--brand-accent)]/55 ring-1 ring-[var(--brand-accent)]/35`, which typechecked, built,
 * and painted absolutely nothing. Verified against the SHIPPED stylesheet: `.next/static/css/*.css`
 * carries 31 `brand-accent` rules and not one of them has an alpha modifier.
 *
 * Scoped to the code this change owns. 17 other occurrences already exist in the repo (5 files) and
 * are the same latent bug — hover and focus tints that have never rendered — but sweeping them is a
 * separate change with its own browser pass, and a repo-wide assertion here would just fail on them.
 */
test('the new styling uses NO alpha-on-var utility — Tailwind emits nothing for those', () => {
  const deadAlphaOnVar = /(?:bg|border|ring|text|fill|shadow|outline|from|to|via)-\[var\(--[a-z-]+\)\]\/\d+/;
  const card = explorerCode.slice(explorerCode.indexOf('const foldCardClass'), explorerCode.indexOf('function SearchDrillPanel'));
  assert.doesNotMatch(card, deadAlphaOnVar, 'the fold card class must not use one');
  assert.doesNotMatch(explorerCode.slice(explorerCode.indexOf('FOLD_ROW_CLASS ='), explorerCode.indexOf('const foldCardClass')), deadAlphaOnVar, 'nor the header row');
  const btn = explorerCode.slice(explorerCode.indexOf('{canClearSearch && ('), explorerCode.indexOf('Clear search'));
  assert.doesNotMatch(btn, deadAlphaOnVar, 'nor the Clear search button');
  // color-mix IS the working equivalent and is already the house pattern (--m3-rail-indicator).
  assert.match(globalsCss, /color-mix\(in srgb, var\(--brand-accent\)/, 'the translucent accent comes from color-mix');
});

test('the glow ring is a pseudo-element, and the pulse stops on its own', () => {
  assert.match(globalsCss, /@keyframes ths-fold-glow/, 'the keyframes exist');
  const ruleFrom = globalsCss.indexOf('.ths-fold::after {');
  assert.ok(ruleFrom > 0, 'the ring is an ::after, not a class on the card');
  const rule = globalsCss.slice(ruleFrom, globalsCss.indexOf('}', ruleFrom));
  // ⚠ A box-shadow on the CARD would win over its composed --tw-shadow (shadow-ths) for the whole
  // animation, so the card would lose its elevation while pulsing and get it back at the end. A
  // pseudo-element has its own box-shadow to spend.
  assert.match(rule, /position: absolute/, 'absolutely positioned, so it costs no layout');
  assert.match(rule, /pointer-events: none/, 'and it must never intercept the header click');
  // ⚠ FINITE. A permanent pulse on two cards is a distraction with no off switch (WCAG 2.2.2); a
  // finite one settles into the static ring the base rule leaves behind. It re-fires per search for
  // free, because SearchResultPanels is keyed on the search signature and a remount restarts a CSS
  // animation — no timer, no effect, no state.
  assert.match(rule, /animation: ths-fold-glow [\d.]+s ease-in-out 3;/, 'three iterations, not infinite');
  assert.doesNotMatch(rule, /animation:[^;]*infinite/, 'never infinite');
  // Reduced motion is inherited from the universal reset, so there must be no per-component opt-out
  // that could disagree with it.
  assert.match(globalsCss, /animation-iteration-count: 1 !important/, 'the global reduced-motion reset still exists');
});

/* ── 2. Clear search ─────────────────────────────────────────────────────────────────────────── */

const clearSrc = explorerSrc.slice(
  explorerSrc.indexOf('function clearSearch()'),
  explorerSrc.indexOf('function applyCustomRange()'),
);

test('Clear search is a real, big, named button that renders when there is something to clear', () => {
  assert.match(explorerCode, /\{canClearSearch && \(/, 'it renders only when it can act');
  assert.match(explorerCode, /const canClearSearch = hasAnySearch \|\| refinement !== null;/, 'a drill pill counts as a search');
  const btn = explorerCode.slice(explorerCode.indexOf('{canClearSearch && ('), explorerCode.indexOf('Clear search'));
  assert.match(btn, /<button\s+type="button"/, 'a real button, not a div');
  assert.match(btn, /onClick=\{clearSearch\}/, 'wired to the one handler');
  assert.match(btn, /\bh-9\b/, 'toolbar-sized (36px), comfortably over the 24x24 WCAG 2.5.8 floor');
  assert.match(btn, /\btext-sm\b/, 'and set at body size, not the row\'s text-xs');
  assert.match(btn, /focus-visible:ring-2/, 'keyboard focus is visible');
  assert.match(explorerCode, /<X className="h-4 w-4" aria-hidden \/>\s*\n\s*Clear search/, 'icon is decorative; the label carries the name');
});

test('clearSearch empties EVERY search facet — a missed one leaves the search half-applied', () => {
  for (const reset of [
    'setFacilitySelection([])',
    'setPayerSelection([])',
    'setEmployerSelection([])',
    "setPhiMemberId('')",
    "setPhiAlphaPrefix('')",
    "setPhiGroup('')",
    "setNameQuery('')",
    'setNameMatch(null)',
    'setNameNotice(null)',
    'setRefinement(null)',
  ]) {
    assert.ok(clearSrc.includes(reset), `clearSearch must call ${reset}`);
  }
  // ⚠ AND IT MUST LEAVE THE BROWSING STATE ALONE. The window, the scheduled-payments bound, the
  // sort and the column layout are how the reader browses, not what they searched for. Resetting
  // the window would silently change the rows they are left looking at.
  for (const untouched of ['setRecencyDays', 'setIncludeScheduled', 'setSort', 'setGrouped', 'setHiddenColumns', 'setCustomFrom']) {
    assert.ok(!clearSrc.includes(untouched), `clearSearch must NOT touch ${untouched}`);
  }
});

test('clearing the search is what clears the AI answer — the render gate it relies on is intact', () => {
  // clearSearch resets no AI state ON PURPOSE: the whole result group is gated on hasAnySearch, so
  // emptying the facets unmounts the yield card, the AI output and the drill panel together, and
  // the AI panel's unmount cleanup aborts an in-flight stream. THIS is the invariant that makes
  // that reasoning true, so it is pinned here rather than left in a comment.
  assert.match(explorerCode, /\{hasAnySearch && \(\s*<SearchResultPanels\s+key=\{aiKey\}/, 'the result group is gated on hasAnySearch and keyed on aiKey');
  assert.doesNotMatch(clearSrc, /setAi|abort|Abort/, 'clearSearch must not grow a second, weaker copy of that invalidation');
});

test('focus does not fall on the floor when the button unmounts (WCAG 2.4.3)', () => {
  // The button renders only while there is something to clear, so pressing it removes it. Focus
  // then drops to <body> unless it is moved — a keyboard user loses their place entirely.
  assert.match(clearSrc, /scrollportRef\.current\?\.focus\(\)/, 'focus moves to the results region');
  // The landing spot has to be a real, named, focusable thing — these are the scrollport's own pins
  // (see collections-grid-scrollport.test.tsx), asserted here because this focus move depends on them.
  assert.match(explorerCode, /ref=\{scrollportRef\}[\s\S]{0,400}?tabIndex=\{0\}/, 'the scrollport is focusable');
  assert.match(explorerCode, /aria-label="Collections results"/, 'and it is named');
});

test('the clear is ANNOUNCED, from a live region that exists before its message does', () => {
  assert.match(explorerCode, /<p role="status" className="sr-only">/, 'polite status, not an alert');
  // Rendered unconditionally with a conditional STRING — a live region that mounts together with
  // its text is frequently not announced at all.
  assert.match(
    explorerCode,
    /searchCleared && !hasAnySearch \? 'Search cleared\.[^']*' : ''/,
    'the region is always mounted; only its text is conditional',
  );
  // And the flag retires once a search is active, so a second clear is a genuine content change.
  assert.match(explorerCode, /if \(hasAnySearch\) setSearchCleared\(false\);/, 'the announcement resets');
});
