/**
 * Source-level guards for the SPLIT search summary (2026-09-03): the yield read is an always-visible
 * card directly under the search hero with the AI trigger in its header; the drill lists live in a
 * separate card beneath it that opens FOLDED on every search; the AI output is its own card that
 * exists only once the trigger has been clicked.
 *
 * A true render/import test of cmd-explorer.tsx isn't possible under node:test — its import graph
 * pulls @/lib/actions → @/lib/access, which calls the RSC `cache()` and crashes the runtime (see
 * cmd-explorer-ai-panel.test.tsx + cmd-explorer-cohort-collapse.test.tsx for the same constraint).
 * So these pin the wiring at the SOURCE; paint, tab order and what a screen reader announces are the
 * human browser pass on the branch preview.
 *
 * Every assertion is scoped to a component slice. The file holds two disclosures with the same shape
 * (this one and CohortCurvePanel), and a file-wide regex matches the wrong one — the cohort suite
 * learned that on its first run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
/**
 * Comment-stripped copy for ABSENCE checks. The comments in cmd-explorer.tsx legitimately NAME the
 * things being banned (the cut prose, the dropped prop, the old fold) to explain why they went — a
 * prose match would fail for the wrong reason, and the obvious fix would be to delete the explanation.
 * Same trap collections-grid-scrollport.test.tsx records hitting twice.
 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const slice = (from: string, to: string, text: string = src) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a > 0 && b > a, `slice "${from}" … "${to}" located`);
  return text.slice(a, b);
};
const groupSrc = slice('function SearchResultPanels({', 'function SelectionYieldPanel({');
const yieldSrc = slice('function SelectionYieldPanel({', 'function SearchDrillPanel({');
const drillSrc = slice('function SearchDrillPanel({', 'function ComboDrillList({');
// Comment-stripped: the cards' docblock names the cut prose to explain the cut.
const cardsSrc = slice('function YieldCardsPanel({', 'type AiState =', code);
const triggerSrc = slice('function AiTrigger({', 'function CollectionsAiPanel({');

test('the yield read is its own always-visible card; the drill panel no longer contains it', () => {
  assert.match(yieldSrc, /<YieldCardsPanel/, 'yield cards render in SelectionYieldPanel');
  assert.doesNotMatch(drillSrc, /<YieldCardsPanel/, 'the drill panel must not render the cards');
  assert.equal(src.split('<YieldCardsPanel').length - 1, 1, 'cards mounted exactly once');
  // No fold of any kind in the yield card — it "must appear on every search, with no expand action".
  const yieldCode = slice('function SelectionYieldPanel({', 'function SearchDrillPanel({', code);
  assert.doesNotMatch(yieldCode, /useState\(|aria-expanded|hidden=\{/, 'the yield card has no disclosure');
});

test('render order: hero → result group (yield, AI output, drill) → cohort → grid; group keyed on aiKey', () => {
  const hero = src.indexOf('---- Search hero');
  const group = src.indexOf('<SearchResultPanels');
  const cohort = src.indexOf('{cohortPresence.rendered && (');
  const grid = src.indexOf('---- Detail grid');
  assert.ok(hero > 0 && group > hero && cohort > group && grid > cohort, 'group sits directly under the hero');
  assert.match(src, /hasAnySearch && \(\s*<SearchResultPanels\s+key=\{aiKey\}/, 'gated on hasAnySearch, keyed on aiKey');
  assert.equal(src.split('<SearchResultPanels').length - 1, 1, 'one mount');
  // Inside the group: yield card, then AI output (only when not idle), then the drill panel — each
  // a `shrink-0` sibling so the height chain and `gap-4` see three fixed blocks, as before.
  const y = groupSrc.indexOf('<SelectionYieldPanel');
  const ai = groupSrc.indexOf('<CollectionsAiPanel');
  const d = groupSrc.indexOf('<SearchDrillPanel');
  assert.ok(y > 0 && ai > y && d > ai, 'yield → AI output → drill');
  assert.match(groupSrc, /ai\.state\.kind !== 'idle' && \(\s*<div className="shrink-0">\s*<CollectionsAiPanel/, 'AI output renders only once triggered');
  assert.equal((groupSrc.match(/<div className="shrink-0">/g) ?? []).length, 3, 'three shrink-0 siblings');
  assert.match(groupSrc, /return \(\s*<>/, 'a fragment — no wrapper DOM between the column and the cards');
});

test('yield card owns loading / error / zero-result; the drill panel yields to it (never an empty drill header)', () => {
  assert.match(yieldSrc, /state\.kind === 'loading'\) return <YieldPanelSkeleton \/>/);
  assert.match(yieldSrc, /The search summary could not be loaded\./);
  assert.match(yieldSrc, /No charge lines match \{label\}/);
  assert.match(drillSrc, /state\.kind === 'loading'\) return <DrillPanelSkeleton \/>/);
  assert.match(drillSrc, /state\.kind === 'error'\) return null/);
  assert.match(drillSrc, /s\.total_count === 0\) return null/, 'zero-result search paints NO drill header');
  assert.doesNotMatch(drillSrc, /could not be loaded|No charge lines match/, 'one notice, not two');
});

test('refresh treatment: both cards dim + aria-busy; ONE progress bar, on the yield card', () => {
  assert.match(yieldSrc, /aria-busy=\{refreshing\}/);
  assert.match(drillSrc, /aria-busy=\{refreshing\}/);
  assert.match(yieldSrc, /animate-pulse rounded-t-xl bg-\[var\(--brand-accent\)\]/, 'progress bar on the yield card');
  assert.doesNotMatch(drillSrc, /animate-pulse/, 'no second progress bar');
  // The yield card remounts per search (the group is keyed), so a mount animation would replay on
  // every debounced keystroke — it must not carry one.
  assert.doesNotMatch(yieldSrc, /animate-ths-reveal/, 'no reveal animation on a per-search remount');
});

test('the AI trigger lives in the yield card header; the insufficient sentence moved with it, visibly', () => {
  assert.match(yieldSrc, /<AiTrigger ai=\{ai\} \/>/, 'trigger rendered by the yield card');
  assert.equal(src.split('<AiTrigger').length - 1, 1, 'one trigger');
  assert.match(triggerSrc, /disabled=\{!sufficient \|\| busy\}/, 'button gated on sufficiency + not-busy');
  assert.match(triggerSrc, /onClick=\{ai\.generate\}/);
  // A disabled button with no explanation reads as broken (item 4, 2026-09-03): the gate's sentence
  // renders as visible text beside the button, not as a title attribute.
  assert.match(triggerSrc, /\{!sufficient && <span[^>]*>\{INSUFFICIENT_COPY\[mode\]\}<\/span>\}/, 'insufficient copy is visible text');
  assert.doesNotMatch(triggerSrc, /title=/, 'not a tooltip — invisible to keyboard and SR users');
  // The output card no longer carries a trigger of its own.
  const outputSrc = slice('function CollectionsAiPanel({', 'function DrillList({');
  assert.doesNotMatch(outputSrc, /<Button|onClick/, 'the output card is presentational');
  assert.match(outputSrc, /ai\.state\.kind|state\.kind === 'error'/, 'output card renders the streamed states');
});

test('PROSE CUT: sub-heading, chip and explainer are gone; the write-off footnote stays as ONE text-xs line', () => {
  assert.doesNotMatch(cardsSrc, /Selection payer behavior — all filtered charge lines/, 'sub-heading cut');
  assert.doesNotMatch(cardsSrc, /matches the \{[^}]*\} charge lines/, 'count chip cut — it only restated total_count');
  assert.doesNotMatch(cardsSrc, /Dollar-weighted across every charge line/, 'explainer cut');
  assert.doesNotMatch(code, /chargeLines/, 'the chip was the prop\'s only reader; it left with it');
  // The count the chip restated still renders — in the headline, directly above the cards.
  assert.match(yieldSrc, /\{s\.total_count\.toLocaleString\(\)\}<\/span> charge line/, 'headline count kept');
  // THE FOOTNOTE STAYS, SHORTENED (ruled 2026-09-03, option B): one always-visible line under the
  // cards carrying only the disambiguating clause, at the house text-xs — not a `title` (unreachable
  // by touch/keyboard), not sr-only (context sighted users don't get), not the arbitrary 10px it wore.
  const footnote = cardsSrc.match(/<p className="([^"]*)">\s*\{round\(pct\.pct_allowed\)\}% × [\s\S]*?<\/p>/);
  assert.ok(footnote, 'the write-off footnote renders under the cards');
  assert.match(footnote[0], /most of the gap is\s+expected contractual write-off, not lost revenue\./, 'first clause kept');
  assert.doesNotMatch(footnote[0], /Compare across payers/, 'the advice clause is cut');
  assert.doesNotMatch(footnote[0], /¹/, 'the orphaned superscript marker is gone');
  assert.match(footnote[1], /\btext-xs\b/, 'house 13px, not an arbitrary size');
  // TOKEN PIN. ink400 (#63756E) measured 4.88:1 on the white card surface — AA (4.5:1) with 0.38 of
  // headroom. This is the one sentence on the cards that has to be read, so a "tidy the greys" pass
  // may not demote it below this token; ink600 (`text-muted-foreground`, 7.07:1) is the only
  // acceptable move and only in the darker direction.
  assert.match(footnote[1], /\btext-ink400\b/, 'footnote token is ink400 (4.88:1 measured on the card)');
  assert.doesNotMatch(footnote[1], /text-ink300|text-ink200|text-line|text-muted\b/, 'never a lighter grey');
  assert.doesNotMatch(footnote[1], /text-\[\d+px\]/, 'never an arbitrary px size below the 12px floor');
  assert.doesNotMatch(cardsSrc, /title=|sr-only/, 'no tooltip, no sr-only twin');
});

test('drill panel is COLLAPSED by default and its body stays mounted + hidden (no dangling aria-controls)', () => {
  assert.match(drillSrc, /const \[collapsed, setCollapsed\] = useState\(true\)/, 'opens FOLDED (ruled 2026-09-03)');
  assert.match(drillSrc, /<div id=\{bodyId\} hidden=\{collapsed\}>/, 'aria-controls target always exists');
  assert.doesNotMatch(drillSrc, /\{!collapsed && \(/, 'no conditional unmount — it dangles aria-controls in the default state');
  const trigger = drillSrc.match(/<button\s+type="button"\s+aria-expanded=\{!collapsed\}\s+aria-controls=\{bodyId\}[\s\S]{0,700}?<\/button>/);
  assert.ok(trigger, 'trigger is a <button type="button"> with aria-expanded + aria-controls');
  assert.match(trigger[0], /onClick=\{\(\) => setCollapsed\(/, 'trigger toggles the fold');
  assert.match(trigger[0], /focus-visible:ring-2/, 'trigger shows a focus ring');
  assert.doesNotMatch(drillSrc, /localStorage\.|sessionStorage\./, 'fold state is never persisted');
});

test('EVERY search opens folded — the fold reinitialises because the group is keyed on aiKey', () => {
  // `useState(true)` runs only at mount; the drill panel's JSX position is stable across searches, so
  // without a remount an expanded panel would stay expanded for the NEXT search (#313's lesson for
  // the cohort panel). The key on SearchResultPanels is the mechanism — pinned above — and the drill
  // panel must be rendered INSIDE that keyed mount, not beside it.
  assert.match(groupSrc, /<SearchDrillPanel\s+state=\{summary\}/, 'drill panel is a child of the keyed group');
  assert.equal(src.split('<SearchDrillPanel').length - 1, 1, 'one drill panel');
});

test('aiKey carries EVERY input the summary-fetch effect refetches on (Qodo #318)', () => {
  // THE REGRESSION THIS PINS. aiKey's comment said it "mirrors the summary-fetch dep tuple", and it did
  // not: `employerKey` and `nameMatchKey` joined the fetch tuple on 2026-08-18 (#249) and never joined
  // the key. Everything keyed on aiKey — the AI state since 2026-08-09, the drill fold since this PR —
  // therefore survived an employer-filter or patient-name change and described the PREVIOUS selection.
  // A hand-maintained mirror rots; this parses BOTH tuples so the next new fetch input fails here.
  const ai = code.match(/const aiKey = \[([\s\S]*?)\]\.join\('\|'\)/);
  assert.ok(ai, 'aiKey tuple located');
  const aiInputs = new Set(ai[1].split(',').map((t) => t.trim()).filter(Boolean));
  const fetchAt = code.indexOf('loadCmdSearchSummary(f, view)');
  assert.ok(fetchAt > 0, 'summary fetch located');
  const deps = code.slice(fetchAt).match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, 'summary-fetch dep tuple located');
  const fetchInputs = deps[1].split(',').map((t) => t.trim()).filter(Boolean);
  assert.ok(fetchInputs.length >= 12, `fetch tuple looks truncated: ${fetchInputs.length} entries`);
  // The ONE fetch input allowed to be absent: derived from canRevealPhi (constant for a session) and
  // the three PHI fields, which are in the key themselves.
  const derived = new Set(['hasPhiSearch']);
  for (const dep of fetchInputs) {
    if (derived.has(dep)) continue;
    assert.ok(aiInputs.has(dep), `aiKey is missing summary-fetch input "${dep}" — a stale AI answer / drill fold would survive it`);
  }
  for (const k of ['employerKey', 'nameMatchKey']) assert.ok(aiInputs.has(k), `${k} must key the result group`);
});

test('the lists are BELOW the fold; header + hint ABOVE it', () => {
  const fold = drillSrc.indexOf('<div id={bodyId} hidden={collapsed}>');
  assert.ok(fold > 0, 'the fold exists');
  assert.ok(drillSrc.indexOf('Click a payer, CPT, or CPT×Rev combo to drill in.') < fold, 'hint visible while folded');
  assert.ok(drillSrc.indexOf('<DrillList', fold) > fold, 'drill lists live inside the fold');
  assert.ok(drillSrc.indexOf('<ComboDrillList', fold) > fold, 'combo list lives inside the fold');
  assert.equal((drillSrc.match(/<DrillList\b/g) ?? []).length, 2, 'payers + facilities');
});

test('skeletons match the new footprints — the stale 3-column drill skeleton is gone', () => {
  assert.doesNotMatch(src, /function SummaryPanelSkeleton\(/, 'the old combined skeleton is gone');
  const ys = slice('function YieldPanelSkeleton(', 'function DrillPanelSkeleton(');
  assert.match(ys, /lg:grid-cols-4/, 'yield skeleton keeps the 4-card row');
  assert.match(ys, /h-9 w-44 rounded-md/, 'yield skeleton reserves the trigger button');
  assert.doesNotMatch(ys, /lg:grid-cols-3|lg:grid-cols-2/, 'no drill-list columns inside the yield skeleton');
  const ds = slice('function DrillPanelSkeleton(', 'function CohortPanelSkeleton(');
  assert.doesNotMatch(ds, /grid-cols/, 'drill skeleton is the header row only (folded is the default)');
});

test('AI payload untouched: aiInput still reads summaryData from STATE, not from either card', () => {
  assert.match(src, /const summaryData = summary\.kind === 'ready' \|\| summary\.kind === 'refreshing' \? summary\.data : null;/);
  assert.match(src, /\}, \[summaryData, cohortResolved, cohortData\]\);/, 'aiInput dep tuple unchanged');
  assert.match(src, /return \{ mode: 'selection', yield_pct: s\.yield_pct, scope, top_payers, top_facilities, top_cpt_rev \};/);
  assert.match(src, /mode: 'cohort',[\s\S]{0,60}yield_pct: c\.totals!/, 'AI payload cohort mode intact');
});
