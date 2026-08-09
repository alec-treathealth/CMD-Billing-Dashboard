/**
 * <Markdown /> — RENDERED-HTML tests. The reported defect is the first case: model answers arrived
 * with literal `**` and `##` on screen, so every assertion here checks BOTH that the markup appeared
 * AND that the delimiter did not survive as text.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, inlineMarkdown, markdownBlocks } from '../components/ui/markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test('THE REPORTED BUG: **bold** becomes <strong> and the asterisks do NOT reach the screen', () => {
  const out = html('**AETNA** is the outlier.');
  assert.match(out, /<strong[^>]*>AETNA<\/strong>/);
  assert.doesNotMatch(out, /\*\*/, 'the literal asterisks must be gone, not merely wrapped');
});

test('THE REPORTED BUG: ## headings render as markup, not as hashes', () => {
  const out = html('### Why this moved\nBecause the sample doubled.');
  assert.match(out, />Why this moved</);
  assert.doesNotMatch(out, /#{2,}/, 'no hash characters may survive into the DOM');
});

test('bullets become a real list — one <li> per item, markers stripped', () => {
  const out = html('- first point\n- second point\n- third point');
  assert.match(out, /<ul[^>]*>/);
  assert.equal(out.split('<li').length - 1, 3);
  assert.match(out, />first point</);
  // The leading "- " must not survive inside the item text.
  assert.doesNotMatch(out, />-\s/);
});

test('a numbered list renders <ol>, and a bulleted block after it stays a SEPARATE list', () => {
  const out = html('1. alpha\n2. beta\n\n- gamma');
  assert.match(out, /<ol[^>]*>/);
  assert.match(out, /<ul[^>]*>/);
  assert.equal(out.split('<ol').length - 1, 1);
  assert.equal(out.split('<ul').length - 1, 1);
});

test('italics and inline code render, and their delimiters are consumed', () => {
  const out = html('read `pct_allowed` and _verify_ it');
  assert.match(out, /<code[^>]*>pct_allowed<\/code>/);
  assert.match(out, /<em>verify<\/em>/);
  assert.doesNotMatch(out, /`/);
});

test('MID-STREAM SAFETY: an unclosed ** renders as text and never swallows the rest', () => {
  // This is the state on almost every frame of a streamed answer.
  const out = html('AETNA is **stron');
  assert.match(out, /AETNA is \*\*stron/);
  assert.doesNotMatch(out, /<strong/, 'an opener with no closer must not open a bold run');
});

test('empty / whitespace text renders NOTHING — a caller may mount it before the stream starts', () => {
  assert.equal(renderToStaticMarkup(<Markdown text="" />), '');
  // ⚠ EXPRESSION CONTAINER, not a quoted attribute: a JSX string attribute is LITERAL, so
  // `text="a\nb"` passes a backslash and an "n" — not a newline. Written as an attribute this case
  // asserted the wrong thing and failed for the right reason.
  assert.equal(renderToStaticMarkup(<Markdown text={'   \n  \n'} />), '');
});

test('NO RAW-HTML SINK: markup in the model text is escaped, never parsed', () => {
  const out = html('<img src=x onerror="alert(1)"> and **bold**');
  assert.doesNotMatch(out, /<img/, 'model-supplied tags must never become real elements');
  assert.match(out, /&lt;img/, 'they render as visible, escaped text instead');
  assert.match(out, /<strong[^>]*>bold<\/strong>/, 'and real markdown still works beside them');
});

test('paragraph lines JOIN with a space; a blank line starts a new paragraph', () => {
  const blocks = markdownBlocks('one\ntwo\n\nthree');
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'para' ? b.text : b.kind)),
    ['one two', 'three'],
  );
});

test('bold nested inside a bullet works — the two scanners compose', () => {
  const out = html('- **AETNA** pays 62%');
  assert.match(out, /<li>.*<strong[^>]*>AETNA<\/strong>.*<\/li>/s);
});

test('plain text with no markers returns plain strings (no needless element churn)', () => {
  assert.deepEqual(inlineMarkdown('nothing to see here'), ['nothing to see here']);
});
