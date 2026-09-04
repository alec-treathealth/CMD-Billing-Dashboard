/**
 * DataFreshness — pure-leaf render invariants (renderToStaticMarkup, no jsdom, no database).
 *
 * THE BUG THIS GUARDS: before 2026-08-12 this line rendered a value served stale by a FAILED
 * background revalidation in exactly the same words as a freshly-read one. Users read old numbers
 * as live, and there was no signal anywhere — the page still returned 200 in 93ms.
 *
 * So the invariant is: a stale render must be textually distinguishable from a current one, and
 * neither state may ever invent a timestamp.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FreshnessLine, FreshnessLinePlaceholder } from '../components/dashboard/data-freshness';
import type { FreshnessState } from '../lib/dataFreshness';

const UPDATED = '2026-08-12T19:10:00.000Z';
const NOW = Date.parse('2026-08-12T20:30:00.000Z');

const current: FreshnessState = { status: 'current', updatedAt: UPDATED, measuredAt: UPDATED };
const stale: FreshnessState = {
  status: 'stale',
  updatedAt: UPDATED,
  measuredAt: '2026-08-12T19:10:00.000Z',
};

test('a current read renders the plain last-updated line', () => {
  const html = renderToStaticMarkup(<FreshnessLine state={current} now={NOW} />);
  // Renamed 2026-09-03: the source of this data is CollaborateMD, and saying so is the point of
  // the line — "Collections data" restated the tab's own name.
  assert.match(html, /CollaborateMD collections data last updated at/);
  assert.doesNotMatch(html, /not refreshed/);
  assert.doesNotMatch(html, /unavailable/);
});

test('a STALE read is textually distinguishable from a current one', () => {
  // The whole point: the two states must not read identically.
  const currentHtml = renderToStaticMarkup(<FreshnessLine state={current} now={NOW} />);
  const staleHtml = renderToStaticMarkup(<FreshnessLine state={stale} now={NOW} />);
  assert.notEqual(currentHtml, staleHtml);
  assert.match(staleHtml, /not refreshed since/);
});

test('the stale render still shows the REAL last-updated time, unmodified', () => {
  const html = renderToStaticMarkup(<FreshnessLine state={stale} now={NOW} />);
  // Marking a value stale must not alter what it reports, and must not advance it to look fresher.
  assert.match(html, new RegExp(UPDATED));
});

test('the stale qualifier reports elapsed time since the READ, not since the data', () => {
  const html = renderToStaticMarkup(
    <FreshnessLine
      state={{ status: 'stale', updatedAt: UPDATED, measuredAt: '2026-08-12T18:30:00.000Z' }}
      now={NOW}
    />,
  );
  // 20:30 − 18:30 = 2 hours since the last successful read.
  assert.match(html, /not refreshed since 2 hr ago/);
});

test('an unavailable state says so and invents NO timestamp', () => {
  const html = renderToStaticMarkup(<FreshnessLine state={{ status: 'unavailable' }} now={NOW} />);
  assert.match(html, /unavailable/i);
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}/, 'must not render any date');
  assert.doesNotMatch(html, /last updated/i, 'must not imply a known update time');
});

test('a genuine null updatedAt renders "not yet loaded", distinct from unavailable', () => {
  const html = renderToStaticMarkup(
    <FreshnessLine state={{ status: 'current', updatedAt: null, measuredAt: UPDATED }} now={NOW} />,
  );
  // "nothing ingested yet" and "we could not read it" are different facts and must read differently.
  assert.match(html, /not yet loaded/);
  const unavailable = renderToStaticMarkup(
    <FreshnessLine state={{ status: 'unavailable' }} now={NOW} />,
  );
  assert.notEqual(html, unavailable);
});

test('no state renders a fabricated "just now"-style current timestamp', () => {
  for (const state of [current, stale, { status: 'unavailable' } as FreshnessState]) {
    const html = renderToStaticMarkup(<FreshnessLine state={state} now={NOW} />);
    assert.doesNotMatch(html, /just now/i);
  }
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * FreshnessLinePlaceholder — the Suspense fallback (added with the boundary on both dashboard
 * render sites). DataFreshness is the last child of the <header>, so this fallback's only job is
 * to hold the header's height while the probe resolves and to claim NOTHING while it does.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

const classAttr = (html: string): string => {
  const m = html.match(/class="([^"]*)"/);
  assert.ok(m, `expected a class attribute in: ${html}`);
  return m[1]!;
};

test('the placeholder reserves a box with the SAME classes as the real line', () => {
  // Derived from a real FreshnessLine render, not hardcoded: if someone restyles the wrapper <p>
  // and forgets the fallback, the reserved box stops matching and THIS is what catches it.
  const real = classAttr(renderToStaticMarkup(<FreshnessLine state={current} now={NOW} />));
  const placeholder = classAttr(renderToStaticMarkup(<FreshnessLinePlaceholder />));
  assert.equal(placeholder, real, 'fallback and real line must share one class list (no shift)');
});

/*
 * BOTH PLACEMENTS, because the parity above is only half the contract since 2026-09-04.
 * /dashboard renders the line stacked under an <h1>; /dashboard/collections renders it `inline`,
 * as a flex-row sibling of the tenant tabs. Passing `inline` to the real line and not to its
 * fallback (or the reverse) reserves 8px of margin the other one does not have — a shift on cold
 * load, and exactly the mistake a single shared prop makes easy.
 */
test('the placeholder tracks the real line in BOTH placements, and the two placements differ', () => {
  for (const inline of [false, true]) {
    const real = classAttr(renderToStaticMarkup(<FreshnessLine state={current} now={NOW} inline={inline} />));
    const placeholder = classAttr(renderToStaticMarkup(<FreshnessLinePlaceholder inline={inline} />));
    assert.equal(placeholder, real, `inline=${inline}: fallback and real line must share one class list`);
  }
  // EVERY state, not just the happy one: 'stale' and 'unavailable' are separate returns and were
  // each a separate copy of the class string before lineClass existed.
  for (const state of [current, stale, { status: 'unavailable' } as FreshnessState]) {
    const stacked = classAttr(renderToStaticMarkup(<FreshnessLine state={state} now={NOW} />));
    const inline = classAttr(renderToStaticMarkup(<FreshnessLine state={state} now={NOW} inline />));
    assert.match(stacked, /(^| )mt-2( |$)/, 'the stacked placement keeps its gap to the heading');
    assert.doesNotMatch(inline, /(^| )mt-2( |$)/, 'the inline placement must not offset itself in a centred row');
    // The margin is the ONLY difference — the type scale and colour are the same line either way.
    assert.equal(inline, stacked.replace(/(^| )mt-2( |$)/, '$1').trim(), 'only the top margin differs');
  }
});

test('the placeholder reserves a NON-COLLAPSING line box', () => {
  const html = renderToStaticMarkup(<FreshnessLinePlaceholder />);
  // U+00A0, not a plain space. HTML collapses ordinary whitespace, so ' ' would give the <p> no
  // line box at all and reserve zero height — silently defeating the entire point of the fallback.
  assert.match(html, /\u00A0|&nbsp;/, 'must contain a non-breaking space, not a collapsible one');
  assert.doesNotMatch(html, /<p[^>]*><\/p>/, 'must not render an empty paragraph');
});

test('the placeholder is hidden from assistive tech', () => {
  assert.match(renderToStaticMarkup(<FreshnessLinePlaceholder />), /aria-hidden="true"/);
});

test('the placeholder asserts NO data fact — no FreshnessState wording leaks into it', () => {
  const html = renderToStaticMarkup(<FreshnessLinePlaceholder />);
  // Every one of these is an EARNED outcome of a completed read. Showing any of them mid-flight
  // would state something we do not know yet — see the component's own docblock.
  for (const forbidden of [
    /last updated/i,
    /not yet loaded/i,
    /unavailable/i,
    /not refreshed/i,
    /loading/i,
    /just now/i,
    /collections data/i,
  ]) {
    assert.doesNotMatch(html, forbidden, `fallback must not claim: ${forbidden}`);
  }
  // And no timestamp of any shape.
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}/, 'must not render any date');
  assert.doesNotMatch(html, /<time/, 'must not render a <time> element');
});

test('the placeholder is textually distinguishable from every real state', () => {
  const placeholder = renderToStaticMarkup(<FreshnessLinePlaceholder />);
  for (const state of [
    current,
    stale,
    { status: 'unavailable' } as FreshnessState,
    { status: 'current', updatedAt: null, measuredAt: UPDATED } as FreshnessState,
  ]) {
    const real = renderToStaticMarkup(<FreshnessLine state={state} now={NOW} />);
    assert.notEqual(placeholder, real, 'fallback must never be mistakable for a resolved read');
  }
});
