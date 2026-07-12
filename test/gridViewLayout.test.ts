import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveGridLayout } from '../src/collections/gridViewLayout.js';

// A small stand-in allowlist + PHI set (the real one has 16 keys / 3 PHI; the logic is key-agnostic).
const ORDER = ['a', 'b', 'c', 'd', 'pn', 'mid'] as const;
const PHI = new Set(['pn', 'mid']);

test('NEW format: explicit order + hidden are preserved as-is', () => {
  const { order, hidden } = deriveGridLayout(
    { columns: ['c', 'a', 'b', 'd', 'pn', 'mid'], hidden: ['b', 'd'] },
    ORDER,
    PHI,
  );
  assert.deepEqual(order, ['c', 'a', 'b', 'd', 'pn', 'mid']);
  assert.deepEqual([...hidden].sort(), ['b', 'd']);
});

test('LEGACY format (hidden === null): absent columns become hidden, appended in canonical order', () => {
  // 0046 stored ONLY the visible columns in order; a, c, pn were visible; b, d, mid were hidden.
  const { order, hidden } = deriveGridLayout({ columns: ['a', 'c', 'pn'], hidden: null }, ORDER, PHI);
  // Missing columns appended in ORDER; visible ones keep their saved order.
  assert.deepEqual(order, ['a', 'c', 'pn', 'b', 'd', 'mid']);
  // b, d are hidden (legacy: absent = hidden); mid is PHI so it is forced visible, not hidden.
  assert.deepEqual([...hidden].sort(), ['b', 'd']);
});

test('PHI columns are never hidden, even if a stored view marks them hidden', () => {
  const { hidden } = deriveGridLayout(
    { columns: [...ORDER], hidden: ['pn', 'mid', 'b'] },
    ORDER,
    PHI,
  );
  assert.deepEqual([...hidden].sort(), ['b']); // pn / mid stripped
});

test('allowlist repair: a view saved before a column existed gets it appended (visible)', () => {
  const { order, hidden } = deriveGridLayout({ columns: ['a', 'b'], hidden: [] }, ORDER, PHI);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'pn', 'mid']); // c, d, pn, mid backfilled
  assert.equal(hidden.size, 0); // backfilled columns are visible
});

test('unknown / non-allowlisted keys are dropped from order and hidden', () => {
  const { order, hidden } = deriveGridLayout(
    { columns: ['a', 'zzz', 'b'], hidden: ['zzz', 'b'] },
    ORDER,
    PHI,
  );
  assert.equal(order.includes('zzz'), false);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'pn', 'mid']);
  assert.deepEqual([...hidden], ['b']); // zzz dropped
});

test('duplicate keys in columns are de-duplicated (first occurrence wins)', () => {
  const { order } = deriveGridLayout({ columns: ['b', 'a', 'a', 'b'], hidden: [] }, ORDER, PHI);
  assert.deepEqual(order, ['b', 'a', 'c', 'd', 'pn', 'mid']);
});

test('at-least-one-visible guard: if every column would be hidden, none are', () => {
  // No PHI in this allowlist, and the view hides literally everything.
  const allOrder = ['x', 'y', 'z'] as const;
  const { order, hidden } = deriveGridLayout(
    { columns: [...allOrder], hidden: [...allOrder] },
    allOrder,
    new Set(),
  );
  assert.deepEqual(order, ['x', 'y', 'z']);
  assert.equal(hidden.size, 0);
});

test('empty / garbage view falls back to the full default order, nothing hidden', () => {
  const { order, hidden } = deriveGridLayout({ columns: [], hidden: null }, ORDER, PHI);
  assert.deepEqual(order, [...ORDER]);
  assert.equal(hidden.size, 0);
});
