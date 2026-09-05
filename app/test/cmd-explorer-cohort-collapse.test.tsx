/**
 * Source-level guards for the COLLAPSED-BY-DEFAULT cohort payer-behavior panel (ruled 2026-08-31).
 *
 * A true render/import test of cmd-explorer.tsx isn't possible under node:test — its import graph
 * pulls @/lib/actions → @/lib/access, which calls the RSC `cache()` and crashes the runtime (see
 * cmd-explorer-ai-panel.test.tsx + cmd-recency-default.test.tsx for the same constraint). So these
 * pin the ruling's invariants at the SOURCE; the visual/keyboard behaviour is the human browser
 * pass (this env has no browser driver, and jsdom is sanctioned only where an effect can actually
 * be executed — this component cannot be imported at all).
 *
 * The load-bearing one is the FETCH pin: the panel is collapsed-but-LOADED. `aiInput` reads the
 * same `cohort` state the panel renders, so gating the fetch on expansion would silently empty the
 * AI read's cohort branch — a data regression with no visible symptom until someone reads an AI
 * answer that quietly dropped to selection mode.
 *
 * This file is ADDITIVE. cmd-explorer-ai-panel.test.tsx is deliberately untouched: its
 * `CohortBucketTable` / `CohortDrilldownPanel` assertions still hold, because nothing was deleted —
 * the tables and the drilldown moved BELOW A FOLD, they did not go away.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');

/**
 * cmd-explorer.tsx holds TWO independent disclosures with the same shape — SearchDrillPanel (née
 * SearchSummaryPanel) has its own `collapsed` / `bodyId` / aria-expanded trigger and is pinned by
 * cmd-explorer-summary-split.test.tsx, not here. Every assertion below is therefore scoped to the
 * CohortCurvePanel slice; a file-wide regex silently matches the wrong component (it did, on the
 * first run of this file).
 */
const cohortPanelSrc = (() => {
  const from = explorerSrc.indexOf('function CohortCurvePanel({');
  const to = explorerSrc.indexOf('function CohortDrilldownPanel({', from);
  assert.ok(from > 0 && to > from, 'CohortCurvePanel slice located');
  return explorerSrc.slice(from, to);
})();

test('cohort panel is collapsed by default', () => {
  assert.match(
    cohortPanelSrc,
    /const \[collapsed, setCollapsed\] = useState\(true\)/,
    'CohortCurvePanel must open FOLDED (ruled 2026-08-31)',
  );
});

test('EVERY cohort opens collapsed — the panel is keyed on (tenant, prefix)', () => {
  // Qodo #313: the initializer above is necessary but NOT sufficient, and asserting it alone is
  // what let this through. `useState(true)` runs only at MOUNT, and the panel does not unmount on a
  // prefix or tenant change — `cohortActive` stays true across "ABC" → "XYZ", so useDelayedUnmount
  // keeps it rendered and the fetch converts ready → refreshing to hold the prior curve on screen.
  // Without a key, expanding one cohort left the NEXT cohort expanded.
  //
  // This pins the MECHANISM (a key derived from view + prefix), which is the most a source-level
  // test can reach: the component cannot be imported under node:test at all, so the remount itself
  // is browser-verified, not asserted here.
  const live = explorerSrc.match(/<CohortCurvePanel\b[\s\S]*?state=\{cohort\}/);
  assert.ok(live, 'the live cohort panel element exists');
  assert.match(live[0], /key=\{`\$\{view\}\|\$\{dAlpha\}`\}/, 'live panel keyed on (tenant, prefix)');

  // The exit-fade snapshot deliberately reuses the SAME key so the instance survives the fade and
  // does not snap shut on its way off screen.
  const snap = explorerSrc.match(/<CohortCurvePanel\b[\s\S]*?state=\{\{ kind: 'ready', data: cohortSnapshotRef/);
  assert.ok(snap, 'the exit-snapshot cohort panel element exists');
  assert.match(
    snap[0],
    /key=\{`\$\{view\}\|\$\{cohortSnapshotRef\.current\.prefix\}`\}/,
    'snapshot panel keyed on the identity it snapshotted',
  );
});

test('collapse state is per-render only — never persisted', () => {
  // The ruling is explicit: no localStorage / sessionStorage for this default. Matches on member
  // ACCESS (the trailing dot) so the panel's own docblock naming the rule doesn't trip its own test.
  assert.doesNotMatch(cohortPanelSrc, /localStorage\./, 'collapse state must not be persisted');
  assert.doesNotMatch(cohortPanelSrc, /sessionStorage\./, 'collapse state must not be persisted');
});

test('disclosure trigger is a real button with complete ARIA wiring and a focus ring', () => {
  const trigger = cohortPanelSrc.match(
    /<button\s+type="button"\s+aria-expanded=\{!collapsed\}\s+aria-controls=\{bodyId\}[\s\S]{0,600}?<\/button>/,
  );
  assert.ok(trigger, 'trigger must be a <button type="button"> with aria-expanded + aria-controls');
  assert.match(trigger[0], /onClick=\{toggle\}/, 'trigger toggles the collapse state');
  assert.match(cohortPanelSrc, /const toggle = \(\) => setCollapsed\(/, 'and `toggle` is the one that flips it');
  assert.match(trigger[0], /focus-visible:ring-2/, 'trigger must show a visible focus ring');

  /*
   * ⚠ "NEVER A DIV+ONCLICK" NEEDED RESTATING, NOT JUST RE-PASSING (2026-09-04). The header row is
   * now a click target as well ("the user can click anywhere on them for the dropdown"), so this
   * file's old assertion — `doesNotMatch(/<div[^>]*onClick=\{\(\) => setCollapsed/)` — would still
   * have passed, purely because the row calls a shared handler instead of an inline setter. That is
   * passing on a technicality, which is worse than failing: the rule it was protecting would have
   * been quietly hollowed out.
   *
   * The rule was never "no div may carry a click". It was "a div must not STAND IN FOR a button",
   * because a div is unreachable by keyboard and invisible to assistive tech. So the real invariant,
   * asserted directly: the row's click exists ONLY alongside the real button above, and the row
   * contributes no disclosure semantics of its own — no aria-expanded, no aria-controls, no role,
   * no tabIndex. Two elements claiming to be the disclosure is its own bug.
   */
  const row = cohortPanelSrc.match(/<div className=\{FOLD_ROW_CLASS\}[^>]*>/);
  assert.ok(row, 'the header row is the shared fold row');
  assert.match(row[0], /onClick=\{foldRowClickHandler\(toggle\)\}/, 'it runs the same toggle as the button');
  assert.doesNotMatch(row[0], /aria-expanded|aria-controls|role=|tabIndex/, 'and claims no disclosure semantics');
  // An INLINE setter on a div is still banned — that is the shape that appears when someone drops
  // the real button and "simplifies" the row into being the control.
  assert.doesNotMatch(cohortPanelSrc, /<div[^>]*onClick=\{\(\) => setCollapsed/, 'never a div+inline setter');
});

test('aria-controls target is always mounted and hidden with the hidden attribute', () => {
  // aria-controls must resolve to an element that EXISTS. Conditional rendering (`{!collapsed && …}`)
  // would leave it dangling in the panel's new DEFAULT state, so the region is always in the DOM and
  // folded with `hidden` — which also removes it from the a11y tree and the tab order.
  assert.match(
    cohortPanelSrc,
    /<div id=\{bodyId\} hidden=\{collapsed\}/,
    'body region stays mounted, hidden via the hidden attribute',
  );
  assert.doesNotMatch(cohortPanelSrc, /\{!collapsed && \(/, 'body region must not be conditionally unmounted');
});

test('the tables and the drilldown are BELOW THE FOLD, not removed', () => {
  // Guards the ruling's "nothing is deleted" half from the outside: the fold must sit ABOVE the
  // per-bucket tables, so expanding reaches them.
  const foldAt = cohortPanelSrc.indexOf('<div id={bodyId} hidden={collapsed}');
  assert.ok(foldAt > 0, 'the fold exists');
  assert.ok(cohortPanelSrc.indexOf('<CohortBucketTable', foldAt) > foldAt, 'tables live inside the fold');
  assert.ok(cohortPanelSrc.indexOf('<CohortDrilldownPanel', foldAt) > foldAt, 'drilldown lives inside the fold');
});

test('header, prefix chip, patient count and degradation badge stay ABOVE the fold', () => {
  const foldAt = cohortPanelSrc.indexOf('<div id={bodyId} hidden={collapsed}');
  const headAt = cohortPanelSrc.indexOf('Cohort payer behavior — “{prefix}”', cohortPanelSrc.indexOf('aria-busy={refreshing}'));
  assert.ok(headAt > 0 && headAt < foldAt, 'panel heading is visible while collapsed');
  assert.ok(cohortPanelSrc.indexOf('prefix-wide · ignores Member ID', headAt) < foldAt, 'scope chip visible while collapsed');
  assert.ok(cohortPanelSrc.indexOf('{status.label}', headAt) < foldAt, 'degradation badge visible while collapsed');
  assert.ok(
    cohortPanelSrc.indexOf('patients · dollar-weighted · min 5/bucket', headAt) < foldAt,
    'patient count visible while collapsed',
  );
});

test('THE FETCH DOES NOT MOVE — cohort load is not gated on expansion', () => {
  // The cohort fetch effect keys on (cohortActive, dAlpha, view) and nothing else. If `collapsed`
  // or an `expanded` flag ever enters this effect, the panel stopped being collapsed-but-loaded and
  // the AI read's cohort branch goes quietly empty.
  const effect = explorerSrc.match(/loadCohortCurve\(dAlpha, view\)[\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(effect, 'the cohort fetch effect exists');
  assert.match(effect[0], /\}, \[cohortActive, dAlpha, view\]\);$/, 'fetch dep tuple is unchanged');
  assert.doesNotMatch(effect[0], /collapsed|expanded/, 'fetch must NOT be expansion-gated');
  // The gate itself is still PHI-entitlement + prefix length, not a UI state.
  assert.match(explorerSrc, /const cohortActive = canRevealPhi && dAlpha\.length >= 3;/, 'cohort gate unchanged');
});

test('AI payload is byte-identical — cohort branch still reads the cohort state', () => {
  // Duplicated deliberately from cmd-explorer-ai-panel.test.tsx: that file pins it against CARD
  // consolidation (#309), this one pins it against the COLLAPSE. Same assertion, two distinct
  // regressions, and neither test should be the only thing standing between them.
  assert.match(explorerSrc, /mode: 'cohort',[\s\S]{0,60}yield_pct: c\.totals!/, 'AI payload cohort mode intact');
  assert.match(
    explorerSrc,
    /series: \{ by_visit: c\.by_position\.slice\(0, 40\)\.map\(pt\), by_days: c\.by_days\.slice\(0, 40\)\.map\(pt\) \}/,
    'AI series still read off the cohort state, not off the rendered panel',
  );
  assert.match(explorerSrc, /\}, \[summaryData, cohortResolved, cohortData\]\);/, 'aiInput dep tuple unchanged');
});

test('AI analysis panel renders ABOVE the cohort panel', () => {
  // ANCHORED ON THE MOUNT THAT HOSTS THE AI PANEL, not on the panel tag itself. This used to look for
  // the literal `{hasAnySearch && <CollectionsAiPanel key={aiKey}`, which broke when the panel gained
  // a `shrink-0` wrapper (#314), and then anchored on `<CollectionsAiPanel`, which broke again when
  // the split (2026-09-03) moved the panel INSIDE SearchResultPanels — a component declared below the
  // main JSX, so its tag's source index no longer says anything about render order. The thing this
  // test protects is unchanged: the search-result group (yield card, AI output, drill panel) renders
  // above the prefix-wide cohort panel. So anchor on the group's mount.
  const group = explorerSrc.indexOf('<SearchResultPanels');
  const cohort = explorerSrc.indexOf('{cohortPresence.rendered && (');
  assert.ok(group > 0 && cohort > 0, 'both render');
  assert.ok(group < cohort, 'the search-result group must precede the cohort panel in the JSX');
  assert.match(
    explorerSrc,
    /hasAnySearch && \([\s\S]{0,80}<SearchResultPanels\s+key=\{aiKey\}/,
    'the group is still gated on hasAnySearch and keyed on aiKey',
  );
  // Exactly one AI output panel, and it is mounted inside the group — a MOVE, not a second mount.
  assert.equal(explorerSrc.split('<CollectionsAiPanel').length - 1, 1, 'AI panel mounted exactly once');
  const groupSrc = explorerSrc.slice(
    explorerSrc.indexOf('function SearchResultPanels({'),
    explorerSrc.indexOf('function SelectionYieldPanel({'),
  );
  assert.match(groupSrc, /<CollectionsAiPanel ai=\{ai\} \/>/, 'the AI panel is mounted by the group');
});
