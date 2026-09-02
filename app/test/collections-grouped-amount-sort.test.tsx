/**
 * Source-level guards for GROUPED-MODE ORDERING BY TOTAL, and its window cap (shipped 2026-09-03).
 *
 * cmd-explorer.tsx cannot be imported under node:test — its graph pulls @/lib/actions →
 * @/lib/access, which calls the RSC `cache()` and crashes the runtime (same constraint as
 * cmd-explorer-ai-panel.test.tsx and collections-grid-scrollport.test.tsx). So these pin the
 * invariants at the SOURCE. The RULE itself is unit-tested for real in test/groupedSort.test.ts,
 * and the keyset was paged against production before shipping (475 groups / 10 pages on BXR and
 * 1,471 / 30 on Consolidated, both directions: zero repeats, zero skips, order identical to the
 * unpaginated query, monotonic across every boundary).
 *
 * What these lock in, and why each would be a silent regression:
 *   · the sort column is part of the unstable_cache KEY — otherwise a totals-ordered page is
 *     served for a date-ordered request, wrong rows and wrong order, for 15 minutes
 *   · the client's enable rule is the SAME imported predicate the Server Action clamps with
 *   · the applied sort is DERIVED, not written back — an effect would let the header disagree
 *     with the request for a render, and would cost a second fetch
 *   · the blocked control stays rendered and focusable, per the 2026-08-30 ruling
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
const serverSrc = readFileSync(join(here, '../lib/server.ts'), 'utf8');
const actionsSrc = readFileSync(join(here, '../lib/actions.ts'), 'utf8');
const policySrc = readFileSync(join(here, '../../src/collections/groupedSort.ts'), 'utf8');

/** Comment-stripped copies — every ABSENCE assertion runs against code, never prose. The comments
 *  here legitimately name the things being banned (a WHERE prune, a corrective setSort), so a
 *  file-wide match would fail for the wrong reason and the obvious way to "fix" it is to delete the
 *  explanation. Same trap this repo's scrollport tests hit twice. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const explorerCode = strip(explorerSrc);
const serverCode = strip(serverSrc);
const actionsCode = strip(actionsSrc);

test('ONE definition of the rule, in a leaf module both sides can import', () => {
  // The predicate has to reach a CLIENT component. Its natural home was next to the SQL builder
  // that consumes it, but importing that file into the browser ships every SQL string with it —
  // hence a leaf module. If this collapses back into cmdExplorerQuery.ts, the client either
  // bundles the SQL or grows a second copy of the rule.
  assert.match(policySrc, /export function groupedSortAllowed/);
  assert.match(policySrc, /export function resolveGroupedSort/);
  assert.match(policySrc, /export const GROUPED_AGG_SORT_MAX_WINDOW_DAYS = 90;/);
  // A leaf: no imports at all, so it cannot drag anything into the browser bundle.
  assert.doesNotMatch(policySrc, /^import /m, 'the policy module must stay dependency-free');
  // Both sides import it rather than restating it.
  assert.match(explorerCode, /from '\.\.\/\.\.\/\.\.\/src\/collections\/groupedSort\.js'/);
  assert.match(actionsCode, /resolveGroupedSort/, 'the Server Action clamps with the shared rule');
});

test('⚠ the sort column is part of the unstable_cache KEY', () => {
  /*
   * unstable_cache keys on the ARGUMENT LIST. Carrying the sort column any other way — a module
   * constant, a field mutated onto `filter`, a closure — would let a totals-ordered page be served
   * for a date-ordered request at the same cursor: wrong rows, wrong order, no error, 15-minute
   * lifetime. This is the single highest-consequence line in the change.
   */
  const cached = serverCode.slice(
    serverCode.indexOf('export const loadCmdExplorerGroupedNonPhi'),
    serverCode.indexOf("['cmd-explorer-grouped']"),
  );
  assert.ok(cached.length > 0, 'the cached grouped loader is located');
  assert.match(cached, /sortColumn: GroupedSortColumn,/, 'sortColumn is a parameter, so it keys the entry');
  assert.match(cached, /loadCmdExplorerGroupedPage\(cursor, filter, direction, entityIds, sortColumn\)/);
});

test('the cursor scalar is taken from the column the page was ORDERED BY', () => {
  // A scalar read off a different column than the ordering produces a keyset comparing the wrong
  // quantity — the silent skip/repeat failure the builder's docblock warns about.
  assert.match(serverCode, /cmdExplorerGroupSortValue\(last, sortColumn\)/);
});

test('the Server Action clamps an untrusted column against the RESOLVED window', () => {
  const action = actionsCode.slice(
    actionsCode.indexOf('export async function loadCmdReportGrouped'),
    actionsCode.indexOf('export type { AuditCursor'),
  );
  assert.ok(action.length > 0, 'loadCmdReportGrouped is located');
  // Untyped on the way in: it crosses the Server Action boundary from the browser.
  assert.match(action, /sortColumn\?: string,/, 'the column arrives as an untrusted string');
  assert.match(action, /resolveGroupedSort\(sortColumn, safeDirection, windowDays\)/);
  assert.match(action, /safeSort\.column,/, 'only the clamped column reaches the loader');
  // The span comes from the function that RESOLVED the bounds, not from a second computation.
  assert.match(action, /const windowDays = applyDateWindow\(filter, readerFilter\);/);
});

test('applyDateWindow returns the SPAN, and every caller checks it explicitly', () => {
  // It used to return a boolean. The span is now needed for the cap, and deriving it again at the
  // call site would be a second definition of "how wide is this window" — free to drift from the
  // one that actually built the bounds.
  assert.match(actionsSrc, /\): number \| null \{/, 'applyDateWindow returns a span or null');
  const calls = actionsCode.match(/const windowDays = applyDateWindow\(filter, readerFilter\);/g) ?? [];
  assert.equal(calls.length, 3, `all three call sites take the span, found ${calls.length}`);
  // `=== null`, never falsy: a legitimate span of 0 must not read as a failure.
  const guards = actionsCode.match(/if \(windowDays === null\) return \{ ok: false, error: 'Invalid date window\.' \};/g) ?? [];
  assert.equal(guards.length, 3, `all three guards are explicit null checks, found ${guards.length}`);
  assert.doesNotMatch(actionsCode, /if \(!applyDateWindow\(/, 'no caller may treat the span as a boolean');
});

test('the client enable rule IS the shared predicate, evaluated on the resolved span', () => {
  assert.match(
    explorerCode,
    /sortable=\{grouped \? groupedSortAllowed\(c, windowDays\) : SORTABLE_KEYS\.has\(c\)\}/,
    'grouped mode asks the rule; row mode is unchanged',
  );
  // The old hardcoded rule must be gone, or grouped mode silently keeps its single ordering.
  assert.doesNotMatch(explorerCode, /grouped \? c === 'payment_received'/, 'the v1 fixed sort is retired');
  // The span is the window's own day count, NOT `to - from` — a preset is half-open (90d spans 91
  // days) and Include-scheduled pushes `to` a further 14 out, so `to - from` would switch sorting
  // off at the DEFAULT window and again whenever Include-scheduled was ticked.
  const memo = explorerCode.slice(
    explorerCode.indexOf('const windowDays = useMemo'),
    explorerCode.indexOf('const windowDays = useMemo') + 500,
  );
  assert.match(memo, /recencyDays > 0 \? recencyDays : null/, 'a preset contributes its own day count');
  assert.match(memo, /customWindowDays\(customFrom, customTo\)/, 'a custom range uses the pure helper');
  /*
   * ⚠ AND NOT THE OPS CALENDAR. businessWindowBounds reads a clock; #304's rule is that this
   * client never derives the ops day, and cmd-recency-default.test.tsx pins the import on the
   * reasoning that you cannot call what you do not import. Reaching for it here to measure a range
   * the USER typed would hand the client that ability as a side effect — which is exactly what the
   * first draft of this change did, and that pin caught it. customWindowDays is pure arithmetic,
   * and test/groupedSort.test.ts asserts the two agree so there is no drift to pay for it.
   */
  assert.doesNotMatch(explorerCode, /businessWindowBounds/, 'the ops calendar must not be imported or called');
});

test('⚠ the applied sort is DERIVED, never written back into state', () => {
  /*
   * `effectiveSort` is a useMemo, not an effect that corrects `sort`. Three reasons, and the first
   * is the one that bites: with an effect there is a render in which the header shows one column
   * and the request carried another. It would also fire the reload effect twice on a window change,
   * and it would destroy the reader's row-mode sort choice on every grouping.
   */
  assert.match(explorerCode, /const effectiveSort = useMemo<CmdExplorerSort>\(/);
  assert.match(explorerCode, /\[grouped, sort, windowDays\],/, 'derived from exactly those three');
  // No corrective write-back anywhere.
  assert.doesNotMatch(explorerCode, /setSort\(\{ column: 'payment_received'/, 'no clamp written into state');
  // Toggling grouping changes ONLY `grouped` now.
  const toggle = explorerCode.slice(
    explorerCode.indexOf('const toggleGrouped = useCallback('),
    explorerCode.indexOf('const [status, setStatus]'),
  );
  assert.ok(toggle.length > 0, 'toggleGrouped is located');
  assert.doesNotMatch(toggle, /setSort/, 'grouping must not rewrite the stored sort');
});

test('EVERY request site and the header both read effectiveSort', () => {
  // The header and the request must be the same value, or the arrow can point at a column the
  // server was not asked to order by.
  assert.match(explorerCode, /isSorted=\{effectiveSort\.column === c\}/);
  assert.match(explorerCode, /direction=\{effectiveSort\.direction\}/);
  // No loadPage call may still pass the raw `sort` — and this caught a real bug: one call site was
  // left on `sort` while its dependency array had already moved to `effectiveSort`.
  assert.doesNotMatch(explorerCode, /loadPage\([^)]*, filterArg, sort, grouped\)/, 'no request site on the raw sort');
  const sites = explorerCode.match(/loadPage\([^)]*filterArg, effectiveSort, grouped\)/g) ?? [];
  assert.ok(sites.length >= 4, `expected >=4 request sites on effectiveSort, found ${sites.length}`);
  // And the column is actually sent.
  assert.match(explorerCode, /loadCmdReportGrouped\(cursor, filter, sortArg\.direction, view, sortArg\.column\)/);
});

test('toggleSort compares the SHOWN ordering, not the stored one', () => {
  // In grouped mode the stored sort can hold a row-mode-only column while the header displays the
  // clamped payment-date ordering. Comparing the stored column treats a click on the shown column
  // as "a new column" and resets direction to desc — so clicking an already-desc arrow does
  // nothing, once per grouping.
  const fn = explorerCode.slice(
    explorerCode.indexOf('function toggleSort('),
    explorerCode.indexOf('function toggleSort(') + 600,
  );
  assert.match(fn, /const shown = grouped/);
  assert.match(fn, /resolveGroupedSort\(prev\.column, prev\.direction, windowDays\)/);
  assert.match(fn, /shown\.column === key/);
  assert.doesNotMatch(fn, /prev\.column === key/, 'must not compare the stored column');
});

test('a window-blocked header stays RENDERED and FOCUSABLE, with its reason', () => {
  /*
   * The 2026-08-30 Include-scheduled ruling, applied to a second control: "a control that appears
   * and disappears with the data is worse than an inert one — the reader cannot learn what it does,
   * and its absence looks like a bug rather than an empty set." The arrows were there at 90d and
   * would vanish on widening, with nothing on screen connecting the two.
   */
  assert.match(
    explorerCode,
    /windowBlocked=\{grouped && GROUPED_SORTABLE\.has\(c\) && !groupedSortAllowed\(c, windowDays\)\}/,
  );
  const blockedAt = explorerCode.indexOf(') : windowBlocked ? (');
  assert.ok(blockedAt > 0, 'the blocked branch exists');
  // Terminate the slice at the NEXT `) : (` after the branch — searching from 0 finds an earlier
  // unrelated ternary in the file and yields an empty slice that passes nothing.
  const branch = explorerCode.slice(blockedAt, explorerCode.indexOf(') : (', blockedAt));
  assert.ok(branch.length > 0, 'the blocked branch is located');
  // aria-disabled, NOT the disabled attribute: `disabled` drops the control out of the tab order,
  // hiding the explanation from exactly the users who cannot see the greyed styling.
  assert.match(branch, /aria-disabled="true"/);
  assert.doesNotMatch(branch, /\sdisabled(\s|=|\})/, 'must not use the disabled attribute');
  assert.doesNotMatch(branch, /onClick/, 'aria-disabled does not block activation, so attach no handler');
  // The reason is available to sighted and non-sighted readers alike, and names the actual limit.
  assert.match(branch, /aria-label=\{`Sort by \$\{label\} — unavailable: needs a window of \$\{GROUPED_AGG_SORT_MAX_WINDOW_DAYS\} days or less`\}/);
  assert.match(branch, /title=\{`Sorting grouped rows by \$\{label\} needs a window of \$\{GROUPED_AGG_SORT_MAX_WINDOW_DAYS\} days or less`\}/);
  // Hardcoding 90 in the copy would let the number drift from the rule it describes.
  assert.doesNotMatch(branch, /90 days/, 'the copy must interpolate the constant, not restate it');
});

test('Group by Payment itself is NOT window-gated', () => {
  // Ruled 2026-09-03 on measurement: grouped mode is never more expensive than the row grid it
  // replaces (Consolidated 120 ms vs 169 ms at 90d; 299 ms vs 338 ms at 1y; BXR flat at 24-27 ms
  // from 7d to 1y). Only ORDERING BY AN AGGREGATE is expensive, and that is what the cap covers.
  // Gating the toggle would remove a working feature and save nothing.
  const toggleBlock = explorerCode.slice(
    explorerCode.indexOf('aria-pressed={grouped}') - 900,
    explorerCode.indexOf('aria-pressed={grouped}') + 400,
  );
  assert.ok(toggleBlock.length > 0, 'the grouping toggle is located');
  assert.doesNotMatch(toggleBlock, /windowDays/, 'the grouping toggle must not consult the window');
  assert.doesNotMatch(toggleBlock, /groupedSortAllowed/, 'nor the sort rule');
  assert.doesNotMatch(toggleBlock, /disabled=\{/, 'and must never be disabled by window size');
});
