/**
 * Source-level guards for the Collections consolidated header cards + streaming AI analysis panel.
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

test('consolidated header cards: dollars folded into the % cards, cohort card mode retired', () => {
  // The separate CHARGED / INSURANCE PAID / PATIENT BALANCE tile row is gone — each dollar total
  // now rides inside its percentage card (2026-08-31 consolidation), from the SAME tile aggregate.
  assert.doesNotMatch(explorerSrc, /StatTile label="Patient Balance"/, 'tile row folded into the cards');
  assert.match(
    explorerSrc,
    /<YieldCardsPanel[\s\S]{0,300}money=\{\{ charged: s\.total_charge, allowed: s\.total_allowed, paid: s\.total_paid, balance: s\.total_balance \}\}/,
    'cards carry the tile-aggregate dollars — no new query',
  );
  // The header cards no longer switch to cohort mode (the prop and its plumbing are deleted)…
  assert.doesNotMatch(explorerSrc, /cohortYield/, 'cohort card mode retired');
  // …but the AI read still analyzes the COHORT yield when a prefix cohort resolves — the AI
  // payload is deliberately untouched by the card consolidation (WP2 constraint, 2026-08-31).
  assert.match(explorerSrc, /mode: 'cohort',[\s\S]{0,60}yield_pct: c\.totals!/, 'AI payload cohort mode intact');
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
