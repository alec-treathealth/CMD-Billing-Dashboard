/**
 * The settled-zero predicate. Every case here is a sentence the surface either may or may not print.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledNoMatches } from '../lib/qualify/matchState';

const SETTLED = { loading: false, error: false };

test('zero, settled, is sayable', () => {
  assert.equal(settledNoMatches({ ...SETTLED, count: 0 }), true);
});

test('THE REGRESSION: a stale zero must not speak while a new count is in flight', () => {
  // The compose effect keeps the previous `summary` during a refetch (it marks the readout "updating…"
  // rather than blanking it), so mid-fetch this count belongs to the PREVIOUS search. A banner off it
  // asserted "no charge lines match this search" about a search with no answer yet — and since the copy
  // prints the window label, which updates synchronously, a window change showed the old window's zero
  // under the new window's name.
  assert.equal(settledNoMatches({ loading: true, error: false, count: 0 }), false);
});

test('a FAILED count is not a zero — opposite instructions to the rep', () => {
  assert.equal(settledNoMatches({ loading: false, error: true, count: 0 }), false);
  // Even with a stale positive count on screen, an error is never a "nothing matches".
  assert.equal(settledNoMatches({ loading: false, error: true, count: 412 }), false);
});

test('nothing counted yet is not nothing found', () => {
  assert.equal(settledNoMatches({ ...SETTLED, count: null }), false);
  assert.equal(settledNoMatches({ loading: true, error: false, count: null }), false);
});

test('any positive count is not a zero', () => {
  for (const count of [1, 412, 1358]) {
    assert.equal(settledNoMatches({ ...SETTLED, count }), false);
  }
});

test('loading wins over error — both mean "do not state a count"', () => {
  assert.equal(settledNoMatches({ loading: true, error: true, count: 0 }), false);
});
