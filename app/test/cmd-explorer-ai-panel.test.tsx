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
  // Invalidation: the AI state is KEYED on the search signature so a filter/search change remounts
  // it to idle. Since 2026-09-03 the state lives in `useCollectionsAi`, owned by SearchResultPanels
  // (the trigger is in the yield card's header, the output is its own card) — so the key sits on
  // THAT mount, and the hook must be called inside it and nowhere else.
  assert.match(explorerSrc, /<SearchResultPanels\s+key=\{aiKey\}/, 'AI state keyed on the search signature');
  const resultPanels = explorerSrc.slice(
    explorerSrc.indexOf('function SearchResultPanels({'),
    explorerSrc.indexOf('function SelectionYieldPanel({'),
  );
  assert.match(resultPanels, /const ai = useCollectionsAi\(aiInput, view\);/, 'the keyed mount owns the AI state');
  assert.equal(explorerSrc.split('useCollectionsAi(').length - 1, 2, 'the hook is defined once and called once');
  assert.match(explorerSrc, /const aiKey = \[/, 'aiKey derived from the filter/search tuple');
});

test('AI generate button is disabled when the selection is insufficient', () => {
  assert.match(explorerSrc, /disabled=\{!sufficient \|\| busy\}/, 'button gated on sufficiency + not-busy');
});

test('a clipped answer is CUT SHORT, never silently complete and never the generic error', () => {
  // The server marks a max_tokens stop with AI_TRUNCATED_MARK (root suite covers the pure split). The
  // client's job: strip it on EVERY render path so it never paints and never reaches parseAiSections,
  // carry `truncated` on the ready state, and say so under whatever arrived.
  const hook = explorerSrc.slice(explorerSrc.indexOf('function useCollectionsAi('), explorerSrc.indexOf('type CollectionsAi ='));
  assert.match(hook, /setState\(\{ kind: 'streaming', text: splitAiStream\(acc\)\.text \}\);/, 'mid-stream renders are split');
  assert.match(hook, /const \{ text, truncated \} = splitAiStream\(acc\);/, 'the final accumulation is split');
  assert.match(hook, /setState\(truncated \|\| text\.trim\(\) \? \{ kind: 'ready', text, truncated \} : \{ kind: 'error' \}\);/, 'truncated → ready, even with no text — never error');
  assert.doesNotMatch(hook, /text: acc \}/, 'raw accumulation never lands in state');
  // The parser only ever sees state text (already split) — never `acc`.
  const panel = explorerSrc.slice(explorerSrc.indexOf('function CollectionsAiPanel('), explorerSrc.indexOf('function DrillList('));
  assert.match(panel, /const sections = text \? parseAiSections\(text\) : null;/, 'parser reads state-derived text');
  assert.doesNotMatch(panel, /parseAiSections\(acc/, 'parser never sees the raw stream');
  // The sentence: its own status region, OUTSIDE `{sections && …}` so it shows even when nothing arrived.
  const sentence = panel.indexOf('This read was cut short at the length limit');
  const sectionsBlock = panel.indexOf('{sections && (');
  // The streaming caret is the LAST child of the sections block; the sentence must come after the
  // block closes (`)}` following the caret), i.e. it is a sibling of the block, not a child.
  const caret = panel.indexOf("{state.kind === 'streaming' && <span", sectionsBlock);
  const blockClose = panel.indexOf(')}', caret);
  assert.ok(sectionsBlock > 0 && caret > sectionsBlock && blockClose > caret, 'sections block located');
  assert.ok(sentence > blockClose, 'sentence renders after — and outside — the sections block');
  assert.match(panel, /\{state\.kind === 'ready' && state\.truncated && \(\s*<p role="status"/, 'gated on truncated, announced as status');
  assert.match(explorerSrc, /\| \{ kind: 'ready'; text: string; truncated: boolean \}/, 'AiState.ready carries truncated');
});
