/**
 * Source-level guards for the POST-SEARCH SCROLL (item 5, reading iii — ruled 2026-09-03, shipped
 * 2026-09-04): when a search settles, the yield card is scrolled into view — once, and only when the
 * user is not already somewhere on purpose.
 *
 * Same constraint as every other cmd-explorer suite: the component cannot be imported under node:test
 * (its graph reaches the RSC cache()), and jsdom has no layout or scrolling anyway, so `scrollIntoView`
 * would be a no-op even if the import worked. These pin the RULES at the source; whether the page
 * actually lands where the harness measured is the browser pass.
 *
 * Every rule below was a ruling, and each one guards a specific bad experience:
 *   · settle-only                    — scrolling on every debounced keystroke is motion sickness
 *   · once per aiKey                 — a refetch of the same search must not re-scroll
 *   · never for the mount identity   — a page load / saved-view restore is not a user search
 *   · never against scrollY drift    — the user already went somewhere; leave them there
 *   · never while typing in the hero — the hero is ABOVE the target; the field would scroll away
 *   · …but ONLY text entry skips     — a tag chip / button / listbox is the primary flow and fires
 *   · no focusout deferral           — an unattributable scroll is worse than none
 *   · reduced motion → 'auto'        — a scripted smooth scroll ignores the stylesheet override
 *   · targets the yield card         — scrolling the GRID to the top pushes the answer off-screen
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../components/dashboard/cmd-explorer.tsx'), 'utf8');
// Comment-stripped: the block's own comment names every banned pattern to explain the ban.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The scroll block: from the refs it declares to the end of the settle effect. */
const blockSrc = (() => {
  const from = code.indexOf('const heroRef = useRef<HTMLDivElement>(null);');
  const to = code.indexOf('}, [summary.kind, aiKey, hasAnySearch]);', from);
  assert.ok(from > 0 && to > from, 'scroll-to-results block located');
  return code.slice(from, to + '}, [summary.kind, aiKey, hasAnySearch]);'.length);
})();
const helperSrc = (() => {
  const from = code.indexOf('function isTextEntry(el: HTMLElement): boolean {');
  const to = code.indexOf('function refinementLabel(', from);
  assert.ok(from > 0 && to > from, 'isTextEntry located');
  return code.slice(from, to);
})();

test('fires on the SETTLE transition only — loading|refreshing → ready, never on a bare ready', () => {
  assert.match(blockSrc, /const prevSummaryKindRef = useRef\(summary\.kind\);/, 'previous kind is tracked');
  assert.match(
    blockSrc,
    /if \(summary\.kind !== 'ready' \|\| \(prev !== 'loading' && prev !== 'refreshing'\)\) return;/,
    'only the transition into ready fires — the aiKey-change render still holds the old ready data',
  );
  assert.match(blockSrc, /prevSummaryKindRef\.current = summary\.kind;/, 'prev kind updated every run');
});

test('once per search identity — and a skipped settle consumes the identity too', () => {
  assert.match(blockSrc, /if \(lastSettledKeyRef\.current === aiKey\) return;/, 'once per aiKey');
  // The claim happens BEFORE the drift / typing skips, so a skipped identity never fires later.
  const claim = blockSrc.indexOf('lastSettledKeyRef.current = aiKey;');
  const drift = blockSrc.indexOf('scrollYAtFireRef.current) > 1) return;');
  const typing = blockSrc.indexOf('isTextEntry(active)) return;');
  assert.ok(claim > 0 && drift > claim && typing > claim, 'identity is consumed before the skips are evaluated');
});

test('never for the identity present at mount (page load / saved-view restore)', () => {
  assert.match(blockSrc, /const mountSearchKeyRef = useRef\(aiKey\);/, 'mount identity captured once');
  assert.match(blockSrc, /if \(aiKey === mountSearchKeyRef\.current\) return;/, 'mount identity never scrolls');
  assert.match(blockSrc, /if \(!hasAnySearch\) return;/, 'no search, no scroll');
});

test('never against the user: scrollY drift since the search FIRED skips the scroll', () => {
  assert.match(blockSrc, /useEffect\(\(\) => \{\s*scrollYAtFireRef\.current = window\.scrollY;\s*\}, \[aiKey\]\);/, 'fire position recorded when aiKey changes');
  assert.match(blockSrc, /if \(Math\.abs\(window\.scrollY - scrollYAtFireRef\.current\) > 1\) return;/, 'drift since fire skips');
});

test('skips ONLY while typing in the hero — chips, buttons, listbox and checkboxes still fire', () => {
  assert.match(
    blockSrc,
    /if \(active instanceof HTMLElement && heroRef\.current\?\.contains\(active\) && isTextEntry\(active\)\) return;/,
    'the skip requires hero containment AND text entry — not any hero focus',
  );
  assert.doesNotMatch(blockSrc, /heroRef\.current\?\.contains\(active\)\) return;/, 'never a blanket "focus is in the hero" skip');
  // The helper's boundary: text entry is textarea / contentEditable / non-button inputs.
  assert.match(helperSrc, /el instanceof HTMLTextAreaElement \|\| el\.isContentEditable\) return true;/);
  assert.match(helperSrc, /if \(!\(el instanceof HTMLInputElement\)\) return false;/, 'buttons, chips, listbox options are not text entry');
  for (const t of ['button', 'checkbox', 'radio', 'submit']) assert.match(helperSrc, new RegExp(`'${t}'`), `input[type=${t}] is not text entry`);
  // And the hero ref really is on the hero.
  assert.match(code, /<div ref=\{heroRef\} className="shrink-0 rounded-xl border border-line bg-card px-4 py-3 shadow-ths">/, 'heroRef on the search hero');
});

test('no focusout deferral, no focus stealing', () => {
  assert.doesNotMatch(blockSrc, /focusout|onBlur|blur\(/, 'no deferral to leaving a field');
  assert.doesNotMatch(blockSrc, /\.focus\(/, 'scrollIntoView never moves focus and neither does this block');
  assert.doesNotMatch(code, /addEventListener\('focusout'/, 'no focusout listener anywhere');
});

test('targets the yield card wrapper, honours reduced motion, lands with a 16px margin', () => {
  assert.match(blockSrc, /const el = resultsRef\.current;/, 'target is the results wrapper');
  assert.match(blockSrc, /el\.scrollIntoView\(\{ block: 'start', behavior: reduced \? 'auto' : 'smooth' \}\);/, 'block start; auto under reduced motion');
  assert.match(blockSrc, /prefers-reduced-motion: reduce/, 'reduced motion is checked');
  // The ref lands on the yield card's wrapper inside the keyed group — NOT on the grid.
  const group = code.slice(code.indexOf('function SearchResultPanels({'), code.indexOf('function SelectionYieldPanel({'));
  assert.match(group, /<div ref=\{resultsRef\} className="scroll-mt-4 shrink-0">\s*<SelectionYieldPanel/, 'ref on the yield wrapper');
  assert.doesNotMatch(code.slice(code.indexOf('---- Detail grid')), /ref=\{resultsRef\}/, 'the grid is not the target');
  // Exactly one document scroll in the file.
  assert.equal((code.match(/\.scrollIntoView\(/g) ?? []).length, 1, 'one document-level scroll');
});
