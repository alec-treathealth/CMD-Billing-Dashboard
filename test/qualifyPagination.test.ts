/** Phase 4 — the mobile 5-up pagination helper (pure; the render branches consume these outputs). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageCount, clampPage, pageSlice, pageLabel, nextPage, prevPage, QUALIFY_MOBILE_PAGE_SIZE } from '../app/lib/qualify/pagination.js';

test('pageCount / clampPage: exact multiples, remainders, empty, garbage input', () => {
  assert.equal(QUALIFY_MOBILE_PAGE_SIZE, 5);
  assert.equal(pageCount(23), 5);
  assert.equal(pageCount(25), 5);
  assert.equal(pageCount(0), 0);
  assert.equal(clampPage(0, 23), 0);
  assert.equal(clampPage(99, 23), 4, 'clamps at the last page — no wrap');
  assert.equal(clampPage(-3, 23), 0);
  assert.equal(clampPage(2, 0), 0, 'empty list clamps to 0');
  assert.equal(clampPage(Number.NaN, 23), 0);
});

test('pageSlice: walks 5-up windows; the last page carries the remainder', () => {
  const list = Array.from({ length: 23 }, (_, i) => i + 1);
  assert.deepEqual(pageSlice(list, 0), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageSlice(list, 4), [21, 22, 23], 'remainder page');
  assert.deepEqual(pageSlice(list, 99), [21, 22, 23], 'overshoot clamps to the last page');
  assert.deepEqual(pageSlice([], 0), []);
});

test('pageLabel: "from–to of total" with remainder + empty forms', () => {
  assert.equal(pageLabel(0, 23), '1–5 of 23');
  assert.equal(pageLabel(4, 23), '21–23 of 23');
  assert.equal(pageLabel(0, 3), '1–3 of 3');
  assert.equal(pageLabel(0, 0), '0 of 0');
});

// The container pager (Phase 4b): left-swipe → nextPage, right-swipe → prevPage. Both clamp, NO wrap.
test('nextPage: advances one page, clamps at the last (a left-swipe past the end is a no-op)', () => {
  assert.equal(nextPage(0, 23), 1);
  assert.equal(nextPage(3, 23), 4);
  assert.equal(nextPage(4, 23), 4, 'last page (index 4 of 5) does not advance — no wrap');
  assert.equal(nextPage(99, 23), 4, 'overshoot in clamps to the last page');
  assert.equal(nextPage(0, 0), 0, 'empty list stays at 0');
  assert.equal(nextPage(0, 3), 0, 'single page cannot advance');
});

test('prevPage: steps back one page, floors at 0 (a right-swipe on page 0 is a no-op)', () => {
  assert.equal(prevPage(4, 23), 3);
  assert.equal(prevPage(1, 23), 0);
  assert.equal(prevPage(0, 23), 0, 'page 0 does not go negative — no wrap');
  assert.equal(prevPage(-5, 23), 0, 'garbage clamps to 0');
  assert.equal(prevPage(99, 23), 3, 'an out-of-range page clamps in first, THEN steps back (4→3)');
  assert.equal(prevPage(0, 0), 0, 'empty list stays at 0');
});
