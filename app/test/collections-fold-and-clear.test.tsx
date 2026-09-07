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
  // ⚠ SCOPED TO THE CLICKED ROW (Qodo #325). window.getSelection() is document-global, and the
  // first draft vetoed the fold for a selection ANYWHERE on the page. The guard exists for a drag
  // that selected THIS header's text, so it must ask whether the selection touches the row.
  assert.match(handler, /e\.currentTarget\.contains\(selection\.anchorNode\)/, 'selection anchor must be in the row');
  assert.match(handler, /e\.currentTarget\.contains\(selection\.focusNode\)/, 'or its focus end must be');
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
  assert.match(card, /collapsed \? 'ths-fold ths-pump' : ''/, 'ring AND wash paint only while folded');
  assert.match(card, /rounded-xl border border-line bg-card p-4 shadow-ths/, 'the card itself is unchanged');
  // `relative` is what the ::after ring positions against.
  assert.match(card, /'relative rounded-xl/, 'the card stays a positioning context');
  // ⚠ THE HEIGHT BUDGET. Both panels are fixed blocks in a viewport-bounded column measured to the
  // pixel. `-m-1 p-1` cancels out, and the ring is an absolutely-positioned ::after, so neither
  // costs layout — measured: the collapsed Drill in card is 58px with and without `ths-fold`. The
  // wash is the card's own background-image, which is a paint, not a box.
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
 * ⚠ THE BAN ITSELF IS NOT HERE. The 17 pre-existing instances found alongside this change were
 * fixed rather than deferred, so the rule is enforced repo-wide in test/brand-token-alpha.test.tsx
 * — one copy, every file, no allowlist. What this test keeps is the part specific to the fold: that
 * the ring's colour comes from CSS rather than from a Tailwind class at all.
 */
test('the fold ring gets its translucent accent from color-mix, not from a Tailwind class', () => {
  // color-mix IS the working equivalent and was already the house pattern (--m3-rail-indicator).
  assert.match(globalsCss, /color-mix\(in srgb, var\(--brand-accent\)/, 'the translucent accent comes from color-mix');
  const card = explorerCode.slice(explorerCode.indexOf('const foldCardClass'), explorerCode.indexOf('function SearchDrillPanel'));
  // The card class list must carry no colour of its own for the collapsed state — `ths-fold` owns
  // it, so there is one place to change the highlight and one place that can get it wrong.
  assert.doesNotMatch(card, /\[var\(--brand-accent[^\]]*\)\]/, 'the collapsed styling is a class name, not inline colour');
});

/*
 * ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, AND THE REVERSAL IS THE RULING — NOT DRIFT. It read
 * "three iterations, not infinite" / "never infinite" until 2026-09-06, when Alec asked for a
 * *"pumping sort of effect"* on these two panels and on the Generate-AI-Analysis button. The WCAG
 * 2.2.2 reasoning behind the old assertion survives in globals.css as the reason the AMPLITUDE and
 * cadence are what they are (one crest per 2s, a long decay, 16% wash); it is no longer the reason
 * the animation stops, because it no longer does. Re-tightening it is a one-token change in two
 * places (`infinite` → `3`) if it reads as a distraction in use.
 */
test('the glow ring is a pseudo-element and it pumps; the wash rests off-canvas', () => {
  assert.match(globalsCss, /@keyframes ths-pump-glow/, 'the shared glow keyframes exist');
  assert.match(globalsCss, /@keyframes ths-pump-sweep/, 'the travelling-wash keyframes exist');
  assert.doesNotMatch(globalsCss, /ths-fold-glow/, 'the old single-consumer keyframe name is gone, not orphaned');
  const ruleFrom = globalsCss.indexOf('.ths-fold::after {');
  assert.ok(ruleFrom > 0, 'the ring is an ::after, not a class on the card');
  const rule = globalsCss.slice(ruleFrom, globalsCss.indexOf('}', ruleFrom));
  // ⚠ A box-shadow on the CARD would win over its composed --tw-shadow (shadow-ths) for the whole
  // animation, so the card would lose its elevation while pulsing and get it back at the end. A
  // pseudo-element has its own box-shadow to spend.
  assert.match(rule, /position: absolute/, 'absolutely positioned, so it costs no layout');
  assert.match(rule, /pointer-events: none/, 'and it must never intercept the header click');
  assert.match(rule, /animation: ths-pump-glow [\d.]+s ease-in-out infinite;/, 'the ring pumps, and off the SHARED keyframe');

  /*
   * ⚠ THE WASH IS THE ELEMENT'S OWN background-image, WHICH IS THE ONLY PLACE IT CAN GO. It must
   * paint ABOVE the card background and BELOW the header text. An absolutely-positioned ::before
   * paints in the positioned layer — on top of the text — and un-doing that costs `z-index: -1`
   * plus `isolation: isolate`, i.e. a stacking context on a card whose subtree we do not control.
   * `::after` is already spent on the ring. Also asserted: background-COLOR is untouched, so
   * `bg-card` and `bg-[var(--brand-soft-a50)]` keep their own property.
   */
  const pumpFrom = globalsCss.indexOf('.ths-pump {');
  assert.ok(pumpFrom > 0, 'the wash is a class of its own, shared with the button');
  const pump = globalsCss.slice(pumpFrom, globalsCss.indexOf('}', globalsCss.indexOf('background-position: -30%', pumpFrom)));
  assert.match(pump, /background-image: linear-gradient\(/, 'the wash is a background-image on the element');
  assert.doesNotMatch(pump, /background-color|z-index|isolation/, 'no background-color, no stacking-context games');
  assert.match(pump, /color-mix\(in srgb, var\(--brand-accent\) 16%, transparent\)/, 'translucent accent, from color-mix');
  assert.match(pump, /animation: ths-pump-sweep [\d.]+s ease-in-out infinite;/, 'and it travels');

  /*
   * ⚠ REDUCED MOTION MUST LEAVE THE WASH INVISIBLE, NOT FROZEN MID-CARD. The universal reset sets
   * iteration-count 1 + duration 0.01ms, so the animation lands on its LAST keyframe and then the
   * element falls back to its un-animated value. Both have to be the resting, off-canvas position
   * or a reader with reduce-motion on gets a permanent teal smear across two cards and a button.
   */
  assert.match(pump, /background-position: -30% 0;/, 'the un-animated base position is off-canvas');
  const sweep = globalsCss.slice(globalsCss.indexOf('@keyframes ths-pump-sweep'), globalsCss.indexOf('.ths-pump {'));
  assert.match(sweep, /100% \{\s*background-position: -30% 0;/, 'the sweep ENDS off-canvas too');
  assert.match(globalsCss, /animation-iteration-count: 1 !important/, 'the global reduced-motion reset still exists');

  /*
   * ⚠ THE BUTTON'S GLOW CARRIES NO RING, and that is an a11y constraint rather than a taste call:
   * a 2px accent ring just outside a button is visually the same object as
   * `focus-visible:ring-2 ring-ring` — the SAME colour under the default palette — so a permanent
   * one would make the keyboard focus indicator ambiguous on the one control here that takes focus.
   */
  const haloFrom = globalsCss.indexOf('.ths-pump-halo::after {');
  assert.ok(haloFrom > 0, 'the button glow is its own rule');
  const halo = globalsCss.slice(haloFrom, globalsCss.indexOf('}', haloFrom));
  assert.match(halo, /border: 0;/, 'glow only — never something that reads as a focus ring');
  assert.match(halo, /pointer-events: none/, 'and it never eats the click');
  assert.match(halo, /animation: ths-pump-glow [\d.]+s ease-in-out infinite;/, 'same keyframes as the ring, so the two cannot drift');

  /*
   * ⚠ ALL THREE DURATIONS MUST BE EQUAL OR THE EFFECT COMES APART. The glow crests at 30% of its
   * cycle because that is the midpoint of the wash's travel (which finishes at 60%) — the two are
   * phase-locked by nothing but sharing a duration. Tune the cadence by changing all three (Alec
   * asked for 2.8s → 2s on 2026-09-06); change one and the glow starts cresting on an empty card.
   */
  const durations = [...globalsCss.matchAll(/animation: ths-pump-(?:glow|sweep) ([\d.]+)s/g)].map((m) => m[1]);
  assert.equal(durations.length, 3, 'the wash, the ring and the halo — three declarations');
  assert.equal(new Set(durations).size, 1, `all three share one duration, got ${durations.join(', ')}`);
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
    // Qodo #325: a name search still in flight would RESURRECT the cleared search when it resolved
    // — nameMatch repopulates, hasAnySearch flips true, the panels and the AI remount, and the grid
    // re-applies the filter the reader just cleared. The generation bump is what de-fangs it, and
    // the spinner reset comes with it because the zombie's own finally no longer may touch it.
    'nameSearchGen.current += 1',
    'setNameSearching(false)',
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

/*
 * THE ZOMBIE NAME SEARCH (Qodo #325). runNameSearch awaits a Server Action; every state writer that
 * clears a name search must invalidate a response still in flight, or that response lands later and
 * un-clears it. Pinned as source because the async race is exactly what a jsdom render cannot
 * exercise honestly (no real Server Action, no real latency).
 */
test('a pending name search cannot outlive whatever cleared it', () => {
  const run = explorerSrc.slice(
    explorerSrc.indexOf('const runNameSearch = useCallback('),
    explorerSrc.indexOf('const nameMatchKey ='),
  );
  // The run claims the CURRENT generation before its await, and re-checks it after.
  assert.match(run, /const gen = \+\+nameSearchGen\.current;/, 'each run claims a fresh generation');
  assert.match(run, /await searchCollectionsPatientName[\s\S]{0,120}?if \(gen !== nameSearchGen\.current\) return;/, 'the response is dropped if the generation moved');
  // The finally is guarded too: a stale run resetting the spinner would wipe a NEWER run's spinner.
  assert.match(run, /if \(gen === nameSearchGen\.current\) setNameSearching\(false\);/, 'only the current run may retire the spinner');
  assert.match(run, /if \(gen === nameSearchGen\.current\) setNameNotice\('The name search could not be completed right now\.'\);/, 'even the failure notice is generation-guarded');

  // EVERY clearer bumps: Clear search, the per-facet Clear name filter, and the tenant switch.
  const bumps = (explorerCode.match(/nameSearchGen\.current \+= 1/g) ?? []).length;
  assert.equal(bumps, 3, 'Clear search + Clear name filter + the view-switch reset all invalidate');
  // And the ref must be a ref: bumping a generation must never itself cause a render.
  assert.match(explorerCode, /const nameSearchGen = useRef\(0\);/, 'generation lives in a ref, not state');
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
