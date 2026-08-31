/**
 * Regression guard for the Explorer 90d-default perf fix.
 *
 * The original latency bug was `useState(0)` for `recencyDays`: first load fired the five summary
 * aggregates with NO payment_received predicate, forcing a full-slice scan of the whole tenant
 * charge-rollup (~107ms warm) instead of the 90d index path (~20ms warm on the
 * cmd_charge_rollup_entity_payment composite). The fix is defaulting the first-load window to 90d.
 *
 * A true render/import test isn't possible here: cmd-explorer.tsx's import graph pulls @/lib/actions
 * → @/lib/access, which calls the React Server Component `cache()` and crashes under the node:test
 * runtime. So this pins the invariant at the SOURCE level instead — if a future refactor resets the
 * default back to 0 (or drops 90 from either the client options or the server allowlist), one of
 * these assertions fails LOUD rather than the perf fix silently regressing. A benign refactor of the
 * exact line (e.g. hoisting the literal into a named constant) will also trip it — that's intended:
 * it forces a deliberate re-affirmation of the default rather than an accidental change.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
const actionsSrc = readFileSync(join(here, '../lib/actions.ts'), 'utf8');
const querySrc = readFileSync(join(here, '../../src/collections/cmdExplorerQuery.ts'), 'utf8');

test('Explorer first-load recency default is 90d (index-path window), not 0 (all-time scan)', () => {
  assert.match(
    explorerSrc,
    /const\s+\[recencyDays,\s*setRecencyDays\]\s*=\s*useState\(\s*90\s*\)/,
    'recencyDays must default to useState(90) — reverting to useState(0) restores the all-time first-load scan',
  );
});

// ⚠ RE-AFFIRMED 2026-08-30, WHICH IS THIS FILE'S OWN DESIGN WORKING. The window control was
// rewired onto src/businessWindow.ts and the two identifiers these tests pinned were renamed:
// RECENCY_OPTIONS -> WINDOW_PRESETS (now objects, and 180/365 added), CMD_RECENCY_DAYS ->
// CMD_WINDOW_PRESETS. Both assertions failed, exactly as the docblock above says a rename should.
// The INVARIANT is unchanged — 90 is still the default and still admitted on both sides — so the
// tests are re-pointed rather than deleted, and the perf guard survives the refactor.
test('90 is an offered window preset on the client', () => {
  assert.match(
    explorerSrc,
    /\{\s*days:\s*90,/,
    'WINDOW_PRESETS must include 90 so the default chip renders + is selectable',
  );
});

test('90 is in the server-side preset allowlist (client/server symmetry)', () => {
  assert.match(
    actionsSrc,
    /const\s+CMD_WINDOW_PRESETS\s*=\s*new\s+Set\(\s*\[[^\]]*\b90\b[^\]]*\]\s*\)/,
    'CMD_WINDOW_PRESETS must admit 90, else the default client window is rejected server-side',
  );
});

test('there is no longer an unbounded window to fall back to', () => {
  // The original failure message here warned that a rejected window "falls back to all-time". That
  // fallback no longer exists (ruled 2026-08-30): every Collections window is closed at both ends,
  // and cmdExplorerBaseConds THROWS on a half-open one. Pinned so the escape hatch is not quietly
  // reintroduced — an unbounded scan is how the consolidated-scope spill becomes a timeout.
  // Target the CONSTRUCT, not the phrase: the control's own docblock legitimately mentions "All
  // months" while explaining that it was removed, and an earlier version of this assertion matched
  // that prose and failed on a correct tree. Assert the <option> and the state setter are gone.
  assert.doesNotMatch(explorerSrc, /<option value=\{0\}>/, 'the "All months" option element is gone');
  assert.doesNotMatch(explorerSrc, /RECENCY_OPTIONS|monthYearOpen/, 'the old control is fully removed');
  // The boundary always assigns BOTH bounds — `to` via applyScheduledBound, which returns the
  // window's own upper bound unless the scheduled override is on.
  assert.match(actionsSrc, /applyScheduledBound/, 'the boundary must always assign an upper bound');
  // The closed-window guard exists and is exercised; see test/collectionsWindow.test.ts.
  //
  // ⚠ THIS COMMENT BLAMED PAYER INTEL AND WAS WRONG (corrected 2026-08-31, #299). It said the
  // guard could not be switched on inside the shared builders because that "reached Payer Intel,
  // which is out of scope and calls buildCmdExplorerQuery with its own filter". Payer Intel sets
  // BOTH bounds unconditionally (app/lib/payer-intel/core.ts:432-454), so it would never have
  // thrown. The ~80 failing call sites that produced that diagnosis were TESTS passing windowless
  // filters — right symptom, wrong cause, asserted with more confidence than the check supported.
  //
  // The REAL reason the default stays off: QUALIFY passes deliberately windowless filters —
  // app/lib/qualify/core.ts's `{ primary_payers: [p] }`, whose own docblock says the
  // windowlessness IS the semantic ("a zero count means 'never billed, ever'"), and the
  // memberIdPrefixBidx cohort filter. The Qualify TAB was taken down 2026-08-17, but taken down is
  // not deleted: /qualify still renders by URL and those loaders are still wired.
  //
  // Since #299 the guard IS on for Collections — threaded from the three Collections-only
  // boundaries in app/lib/server.ts via CmdExplorerBuilderOptions, never defaulted in the builder.
  assert.match(querySrc, /requireWindow/, 'the closed-window guard exists');
  assert.match(
    querySrc,
    /export interface CmdExplorerBuilderOptions/,
    'the caller-threaded opts type must exist — defaulting requireWindow in the builder breaks Qualify',
  );
});

// ── THE SCHEDULED OVERRIDE IS PRESETS-ONLY ─────────────────────────────────────────────────────
// Fixed 2026-08-31 (Qodo review of PR #298). applyScheduledBound REPLACES the upper bound. That is
// correct for a trailing preset, whose `to` is always business-today + 1 so the substitute is
// always strictly later; it is wrong for a custom range, where the user named an end date. The
// shipped-then-fixed behaviour, measured: custom 2020-01-01..2020-01-02 (windowDays=2, cap already
// passed) became a 2,449-day span, and a future range 2027-01-01..2027-06-30 got an upper bound
// BEFORE its lower bound — an empty grid, silently. See test/collectionsWindow.test.ts for the
// arithmetic pinned as numbers.
//
// applyDateWindow cannot be imported: actions.ts is 'use server', where a non-async export breaks
// EVERY Server Action on the page. So the guard is at the source level, like the rest of this file.
test('the scheduled override is applied to the PRESET branch only, never to a custom range', () => {
  assert.equal(
    (actionsSrc.match(/applyScheduledBound\(filter,/g) ?? []).length,
    1,
    'exactly ONE call site — a second one means the custom branch took the override back',
  );
  assert.match(
    actionsSrc,
    /readerFilter\.to = bounds\.to;/,
    'the custom branch must assign the resolved upper bound verbatim',
  );
});

test('choosing a preset clears the custom-range DRAFTS, not just the applied values', () => {
  // Clearing only customFrom/customTo left the popover primed with the superseded range, so
  // re-opening Custom and pressing Apply resurrected it over the preset just chosen. Both exits
  // from a custom range must leave identical state.
  const selectRecency = actionsExplorerFn('selectRecency');
  for (const setter of ['setCustomFrom', 'setCustomTo', 'setDraftFrom', 'setDraftTo']) {
    assert.match(selectRecency, new RegExp(`${setter}\\(''\\)`), `selectRecency must call ${setter}('')`);
  }
});

/** Slice one `function name(...) { ... }` body out of the explorer source, brace-balanced. */
function actionsExplorerFn(name: string): string {
  const start = explorerSrc.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in cmd-explorer.tsx`);
  let depth = 0;
  let i = explorerSrc.indexOf('{', start);
  const open = i;
  for (; i < explorerSrc.length; i++) {
    if (explorerSrc[i] === '{') depth++;
    else if (explorerSrc[i] === '}' && --depth === 0) return explorerSrc.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces reading ${name}`);
}

// ── #304: THE ROLLOVER RELOAD IS SERVER-DRIVEN AND EDGE-TRIGGERED ─────────────────────────────
// The behavioural half needs a fake clock plus visibility events; the PURE half (the instant
// itself) is covered hermetically in test/businessWindow.test.ts. What is pinned here is the
// CONTRACT the client must not quietly break, at the source level like the rest of this file.
test('#304: the client never derives the ops day — it compares two integers', () => {
  // ⚠ ASSERT THE IMPORT, NOT THE WORD — and not the call either. This effect's own docblock says
  // "NO businessDayIso() HERE" while explaining why, so BOTH a bare-identifier regex and a
  // `businessDayIso\(` regex match the prose and fail on a correct tree. (Third time this file has
  // taught the lesson; the "All months" assertion above carries the same scar.) You cannot call
  // what you do not import, and `timeZone:` catches a hand-rolled Intl formatter.
  const imports = explorerSrc.slice(0, explorerSrc.indexOf('export function'));
  assert.doesNotMatch(imports, /businessDayIso|businessWindowBounds|BUSINESS_TZ/, 'no ops-calendar import');
  assert.doesNotMatch(explorerSrc, /timeZone:/, 'no hand-rolled Intl zone formatting in the client');
  assert.match(actionsSrc, /nextBusinessDayStart/, 'the server computes the instant');
  assert.match(
    actionsSrc,
    /nextRolloverAt: nextBusinessDayStart\(\)/,
    'and returns it on the RESULT envelope',
  );
});

test('#304: the instant rides the result, NOT the filter — it must not become a cache key', () => {
  // CmdReportFilter is an unstable_cache key. An absolute instant in it would mint a new entry
  // every single request and destroy the 15-minute cache.
  const filterType = actionsSrc.slice(
    actionsSrc.indexOf('export interface CmdReportFilter'),
    actionsSrc.indexOf('export interface CmdReportFilter') + 2500,
  );
  assert.doesNotMatch(filterType, /nextRolloverAt/, 'the rollover instant must never enter the filter');
});

test('#304: three wake sources, ONE guard — a reload, not a poll', () => {
  for (const src of ['visibilitychange', "window.addEventListener('focus'", 'setTimeout']) {
    assert.ok(explorerSrc.includes(src), `${src} must be a wake source (a throttled timer alone misses)`);
  }
  // Every source funnels through the same comparison, and the ref is consumed so two events
  // firing together reload once.
  assert.match(explorerSrc, /Date\.now\(\) < at\) return;/, 'the guard is an absolute comparison');
  assert.match(explorerSrc, /rolloverRef\.current = 0;/, 'the instant is CONSUMED, making it idempotent');
  assert.doesNotMatch(explorerSrc, /setInterval/, 'never a poll');
});
