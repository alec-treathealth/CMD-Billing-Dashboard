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

test('the standalone YTD ranking chart is GONE, and nothing it owned is left behind', () => {
  // Removed 2026-08-31: YTD per facility lives in the All Facility Revenue Table column and on
  // the month chart's tooltip, so the ranking chart was a third copy of the same numbers.
  for (const sym of ['FacilityYtdBars', 'FacilityYtdTooltip', 'FacilityYtdRow', 'ytdRows', 'YTD_TOP_N', 'truncateLabel']) {
    assert.doesNotMatch(chartSrc, new RegExp(sym), `${sym} must be deleted with the chart`);
  }
  // The rendered heading, not the word — the explanatory note left in its place names it.
  assert.doesNotMatch(chartSrc, /<h3 className="ths-card-title">YTD gross by facility/, 'the chart heading is gone');
  // The dead color token went with it — YTD is not color-encoded anywhere now.
  assert.doesNotMatch(chartSrc, /ytd: 'var\(--chart/, 'the CHART.ytd token is removed');
  // ...and the reclaimed space went to the month chart the reader came for.
  assert.match(chartSrc, /height: 560/, 'month chart is taller now that the YTD chart is gone');
});

test('the two panel buttons open DIALOGS: no chevron, aria-haspopup, no aria-expanded', () => {
  // A down-chevron promises content unfolding in place below the button; these open modals.
  assert.match(kpisSrc, /kind\?: 'dialog' \| 'disclosure'/, 'the button distinguishes the two kinds');
  assert.match(kpisSrc, /aria-haspopup=\{isDialog \? 'dialog' : undefined\}/, 'dialog triggers announce a popup');
  assert.match(kpisSrc, /aria-expanded=\{isDialog \? undefined : open\}/, 'aria-expanded only for the real disclosure');
  assert.match(kpisSrc, /\{!isDialog && <ChevronDown/, 'the chevron renders only for the disclosure');
  // Both panel buttons opt in; the inline Add-expected-payment form stays a disclosure.
  assert.equal((kpisSrc.match(/kind="dialog"/g) ?? []).length, 2, 'exactly the two panel buttons are dialogs');
});

test('button + dialog names are renamed and share one source', () => {
  assert.match(kpisSrc, /const FACILITY_REVENUE_TITLE = 'All Facility Revenue Table';/);
  assert.doesNotMatch(kpisSrc, /All Facilities Table/, 'the old button label is gone');
  // "Incoming ... (ERA)" replaces "Future ...": the dominant half is ERA-confirmed, i.e. in
  // flight rather than predicted. The tenant is still named per view.
  assert.match(kpisSrc, /return 'Incoming BXR Payments \(ERA\)';/);
  assert.match(kpisSrc, /return 'Incoming Indigo Payments \(ERA\)';/);
  assert.match(kpisSrc, /return 'Incoming Payments \(ERA\)';/);
  assert.doesNotMatch(kpisSrc, /'Future (BXR |Indigo )?Payments'/, 'no "Future Payments" label survives');
});

test('modals are sized to the viewport, not to the inline 30rem content cap', () => {
  // Two dialogs, each a flex column bounded by the shell with a scrolling body.
  assert.equal((kpisSrc.match(/max-w-\[88rem\]/g) ?? []).length, 2, 'both dialogs use the wide shell');
  assert.equal((kpisSrc.match(/ths-card ths-elev-sm flex min-h-0 flex-1 flex-col/g) ?? []).length, 2);
  assert.equal(
    (kpisSrc.match(/ths-panel-scroll ths-dialog-scroll/g) ?? []).length,
    2,
    'both bodies lift the inline height cap (additive, so the sticky thead/total rules still apply)',
  );
});

test('YTD is shown on the CURRENT-month view only — a past month cannot print a partial total', () => {
  // Pre-merge review finding: on a past month the rows are only the facilities that had a
  // deposit that month, so summing their YTD renders a PARTIAL year-to-date as complete money
  // (and pairs two time bases in one row). Gating the column removes both, rather than
  // captioning around them.
  assert.match(kpisSrc, /const showYtd = isCurrent;/, 'YTD visibility is tied to the current month');
  assert.match(kpisSrc, /\{showYtd && <th className="num">YTD /, 'header gated');
  assert.match(kpisSrc, /\{showYtd && <td className="num">\{r\.ytd != null/, 'row cells gated');
  assert.match(kpisSrc, /\{showYtd && <td className="num">\{totals\.ytd != null/, 'totals cell gated');
});
