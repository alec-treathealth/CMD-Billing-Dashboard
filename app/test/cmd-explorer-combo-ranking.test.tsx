/**
 * Source-level guards for the (CPT × Revenue-code) combination list's S-ranking wiring (WP3,
 * 2026-08-31). Same constraint as cmd-explorer-ai-panel.test.tsx: a true render/import test of
 * cmd-explorer.tsx isn't possible under node:test (its import graph pulls @/lib/actions →
 * @/lib/access → RSC `cache()`), so these pin the DoD-critical wiring at the SOURCE. The scoring
 * math itself is unit-tested hermetically in the ROOT suite (test/comboRanking.test.ts, including
 * the reference-order fixture).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');

test('combo list renders S-ranked via the pure module — no inline math in JSX', () => {
  assert.match(
    explorerSrc,
    /import \{ COMBO_RANKING_EXPLAINER, rankCombos \} from '\.\.\/\.\.\/\.\.\/src\/collections\/comboRanking'/,
    'scoring comes from the pure module',
  );
  assert.match(explorerSrc, /const ranked = rankCombos\(groups, fallbackPctAllowed\);/, 'rows ranked before render');
  assert.match(explorerSrc, /ranked\.map\(\(\{ row: g \}, i\)/, 'render iterates the ranked rows');
  assert.match(
    explorerSrc,
    /fallbackPctAllowed=\{s\.yield_pct\.pct_allowed\}/,
    'prior fallback is the selection-wide %-allowed already in the payload — no new fetch',
  );
});

test('ranking explainer copy renders visibly (not hover-only)', () => {
  assert.match(explorerSrc, /\{COMBO_RANKING_EXPLAINER\}/, 'explainer rendered from the shared constant');
});

test('drill-down behavior is byte-identical — same handler, same values, same keyboard path', () => {
  // The row's activation still calls onDrill with the SERVER row's own codes.
  assert.match(explorerSrc, /onClick=\{drillable \? \(\) => onDrill\(g\.cpt as string, g\.revenue as string\) : undefined\}/);
  // Keyboard activation (Enter/Space) unchanged.
  assert.match(explorerSrc, /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{/);
  // The ranking is display-only: nothing about it reaches the drill/query layer.
  assert.doesNotMatch(explorerSrc, /rankCombos[\s\S]{0,200}applyComboRefinement/, 'ranking never feeds the drill path');
});
