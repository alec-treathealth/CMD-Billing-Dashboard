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
  // The closed-window guard exists and is exercised; see test/collectionsWindow.test.ts. It is
  // NOT switched on inside the shared builders — that reached Payer Intel, which is out of scope
  // and calls buildCmdExplorerQuery with its own filter. See the PR body.
  assert.match(querySrc, /requireWindow/, 'the closed-window guard exists');
});
