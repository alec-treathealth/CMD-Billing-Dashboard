/** Phase 4 — the mobile 5-up pagination helper (pure; the render branches consume these outputs). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageCount, clampPage, pageSlice, pageLabel, QUALIFY_MOBILE_PAGE_SIZE } from '../app/lib/qualify/pagination.js';

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
