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
import { FreshnessLine } from '../components/dashboard/data-freshness';
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
  assert.match(html, /Collections data last updated/);
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
