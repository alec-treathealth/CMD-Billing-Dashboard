/**
 * Source-level guards for the Collections dual-mode green cards + streaming AI analysis panel.
 *
 * A true render/import test of cmd-explorer.tsx isn't possible under node:test — its import graph
 * pulls @/lib/actions → @/lib/access, which calls the RSC `cache()` and crashes the runtime (see
 * cmd-recency-default.test.tsx for the same constraint + rationale). So these pin the DoD-critical
 * wiring at the SOURCE so a future refactor can't silently undo it; the five VISUAL states are
 * verified in the human browser pass (this env has no browser driver). The pure logic behind the
 * panel — the PHI firewall, the sufficiency gate incl. the zero-allowed scalar, the section parser,
 * and the shared yield derivation — is unit-tested hermetically in the ROOT suite (aiAnalysis.test.ts
 * + cmdExplorerQuery.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const explorerSrc = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');

test('the two recharts line charts are gone (curves deleted from the UI)', () => {
  assert.doesNotMatch(explorerSrc, /from 'recharts'/, 'recharts import must be removed with the curves');
  assert.doesNotMatch(explorerSrc, /CohortMiniChart|CohortDollarMiniChart/, 'the curve components must be deleted');
  // The per-bucket TABLES + drilldown are KEPT (Alec: "curves only, keep tables + drilldown").
  assert.match(explorerSrc, /CohortBucketTable/, 'per-bucket tables stay');
  assert.match(explorerSrc, /CohortDrilldownPanel/, 'click-to-drilldown stays');
});

test('green cards render beneath the money tiles, dual-mode', () => {
  // Money tiles → then the dual-mode YieldCardsPanel, inside SearchSummaryPanel's body.
  assert.match(explorerSrc, /StatTile label="Patient Balance"[\s\S]{0,400}<YieldCardsPanel/, 'cards render below the tiles');
  assert.match(explorerSrc, /mode: 'cohort'[\s\S]{0,200}mode: 'selection'/, 'YieldCardsPanel is dual-mode');
});

test('AI panel is server-action-only, streamed, and invalidated on filter/search change', () => {
  // The generate path is a Server Action (no client fetch / no API key in the bundle).
  assert.match(explorerSrc, /generateCollectionsAiAnalysis/, 'uses the server action');
  assert.doesNotMatch(explorerSrc, /ANTHROPIC_API_KEY/, 'no API key referenced in the client component');
  // Streaming: the panel reads a ReadableStream reader.
  assert.match(explorerSrc, /\.getReader\(\)/, 'consumes the streamed response');
  // Invalidation: the panel is KEYED on the search signature so a filter/search change remounts it.
  assert.match(explorerSrc, /<CollectionsAiPanel key=\{aiKey\}/, 'AI panel keyed on the search signature');
  assert.match(explorerSrc, /const aiKey = \[/, 'aiKey derived from the filter/search tuple');
});

test('AI generate button is disabled when the selection is insufficient', () => {
  assert.match(explorerSrc, /disabled=\{!sufficient \|\| busy\}/, 'button gated on sufficiency + not-busy');
});
