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

test('Explorer first-load recency default is 90d (index-path window), not 0 (all-time scan)', () => {
  assert.match(
    explorerSrc,
    /const\s+\[recencyDays,\s*setRecencyDays\]\s*=\s*useState\(\s*90\s*\)/,
    'recencyDays must default to useState(90) — reverting to useState(0) restores the all-time first-load scan',
  );
});

test('90 is an offered recency chip on the client', () => {
  assert.match(
    explorerSrc,
    /const\s+RECENCY_OPTIONS\s*=\s*\[\s*7,\s*14,\s*30,\s*90\s*\]/,
    'RECENCY_OPTIONS must include 90 so the default chip renders + is toggleable',
  );
});

test('90 is in the server-side recency allowlist (client/server symmetry)', () => {
  assert.match(
    actionsSrc,
    /const\s+CMD_RECENCY_DAYS\s*=\s*new\s+Set\(\s*\[\s*7,\s*14,\s*30,\s*90\s*\]\s*\)/,
    'CMD_RECENCY_DAYS must admit 90, else the default client window is rejected server-side and falls back to all-time',
  );
});
