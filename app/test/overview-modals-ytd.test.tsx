/**
 * Source-level guards for the Overview modal conversion + YTD wiring (WP4, 2026-08-31).
 *
 * Why source-level: OverviewKpis' import graph pulls @/lib/actions (Server Actions), which under
 * node:test reaches the RSC `cache()` and crashes the runtime — the same constraint documented in
 * cmd-explorer-ai-panel.test.tsx. The FOCUS/ESCAPE/TRAP behavior itself is executed (not asserted
 * as markup) by app/test/dialog-focus.test.tsx against the shared useDialog hook, which is the
 * exact hook these dialogs attach — so these guards pin the ATTACHMENT and the markup contract,
 * and the hook's own jsdom suite proves the behavior.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const kpisSrc = readFileSync(join(here, '../components/dashboard/overview-kpis.tsx'), 'utf8');
const chartSrc = readFileSync(join(here, '../components/dashboard/overview-bar-chart.tsx'), 'utf8');

test('both reveal panels are modal dialogs on the shared useDialog hook', () => {
  assert.match(kpisSrc, /import \{ useDialog \} from '\.\.\/qualify\/useDialog'/, 'reuses the existing primitive — no new dialog library');
  // Two dialogs, each: hook keyed off `open`, role=dialog, aria-modal, focus-holdable container.
  const hookUses = kpisSrc.match(/useDialog<HTMLDivElement>\(onClose, \{ active: open \}\)/g) ?? [];
  assert.equal(hookUses.length, 2, 'both panels attach the dialog contract');
  const dialogs = kpisSrc.match(/role="dialog"/g) ?? [];
  assert.equal(dialogs.length, 2, 'both panels render role="dialog"');
  assert.equal((kpisSrc.match(/aria-modal="true"/g) ?? []).length, 2);
  assert.equal((kpisSrc.match(/tabIndex=\{-1\}/g) ?? []).length >= 2, true, 'dialog containers can hold focus');
});

test('one modal at a time — each toggle closes the other panel', () => {
  assert.match(kpisSrc, /setFacilitiesOpen\(\(s\) => !s\);\s*\n\s*setEraOpen\(false\);/, 'opening facilities closes ERA');
  assert.match(kpisSrc, /setEraOpen\(\(s\) => !s\);\s*\n\s*setFacilitiesOpen\(false\);/, 'opening ERA closes facilities');
});

test('panels stay mounted while closed — the useDialog {active} contract', () => {
  // The render guards must remain `return null` (not conditional mounting at the call site),
  // both for the hook contract and for the ERA panel's documented mounted-while-closed state.
  const guards = kpisSrc.match(/if \(!open\) return null;/g) ?? [];
  assert.ok(guards.length >= 3, 'render guards survive the modal conversion');
});

test('YTD gross joined into the All Facilities table from the KPI rows — no fetch', () => {
  assert.match(kpisSrc, /const ytdByKey = new Map\(\s*\n?\s*kpis\.by_facility\.map/, 'client-side join on the loaded KPI rows');
  assert.match(kpisSrc, /<th className="num">YTD \{currentYear \?\? ''\} gross<\/th>/, 'YTD column present');
  assert.match(kpisSrc, /\{r\.ytd != null \? money\(r\.ytd\) : '—'\}/, 'missing YTD renders as —, never 0');
  // The TOTALS cell must go '—' the moment ANY visible row lacks YTD — a coerced partial sum
  // formatted as money is the silently-wrong-number class (review finding, PR #311).
  assert.match(kpisSrc, /acc\.ytd === null \|\| r\.ytd === null \? null : acc\.ytd \+ r\.ytd/, 'null poisons the YTD total');
  assert.match(kpisSrc, /\{totals\.ytd != null \? money\(totals\.ytd\) : '—'\}/, 'a partial YTD total renders —');
  // No new loader call was added to this file by the YTD work (the loaders it had are unchanged).
  assert.doesNotMatch(kpisSrc, /loadCollectionsYtd|loadYtd/, 'no new fetch for YTD');
});

test('month-chart tooltip carries YTD as context only — never a bar segment', () => {
  assert.match(chartSrc, /ytd: r\.ytd_gross,/, 'MTD reshape carries the KPI row YTD');
  assert.match(chartSrc, /\{r\.ytd != null && \(/, 'tooltip row is conditional on the field');
  assert.doesNotMatch(chartSrc, /dataKey="ytd"[^_]/, 'ytd is never charted as a series on the month chart');
});

test('YTD chart defaults to top-N with an expand control — STRUCTURAL wiring only', () => {
  assert.match(chartSrc, /const YTD_TOP_N = 12;/);
  assert.match(chartSrc, /rows\.slice\(0, YTD_TOP_N\)/, 'default view is the top-N ranking');
  // Structural assertions only: these prove the attributes are WIRED, deliberately not that
  // anything is ANNOUNCED — what a screen reader announces is browser-verified per the repo's
  // jsdom boundary (CLAUDE.md) and compliance rule 2726594, never claimed from source regexes.
  assert.match(chartSrc, /aria-expanded=\{showAll\}/, 'aria-expanded attribute is wired to the toggle state');
  assert.match(chartSrc, /top \$\{visible\.length\} facilities of \$\{rows\.length\}/, 'the role=img aria-label string includes the truncation');
});
