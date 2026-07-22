import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cohortReducer,
  cohortKey,
  INITIAL_COHORT,
  type QualifyCohort,
  type QualifyCohortAction,
} from '../app/lib/qualify/qualifyCohort.js';
import type { QualifyCasesCursor } from '../app/lib/qualify/contract.js';

// RULING (settled): cohort identity is (payer, facility, window) — NOTHING ELSE. The former in-panel
// prefix + group narrows (and their CHANGE_PREFIX / CHANGE_GROUP actions) are GONE: the main top-bar
// search is the one identifier entry point, and the claims panel is a pure display of the landed
// facility. These tests pin the slimmer identity + the structural page-reset invariant.

const C1: QualifyCasesCursor = { lastDos: '2026-07-10', id: 500 };
const C2: QualifyCasesCursor = { lastDos: '2026-07-05', id: 480 };

// A fully-populated, mid-walk cohort — so each action can be proven to touch ONLY its own field(s).
const RESOLVED: QualifyCohort = {
  payer: 'AETNA', facility: 'fac-a', window: 60, page: 2, cursors: [null, C1, C2],
};

test('RESOLVE_PAYER — sets payer/facility/window (a brand-new cohort), resets paging', () => {
  const next = cohortReducer(RESOLVED, { type: 'RESOLVE_PAYER', payer: 'CIGNA', facility: 'fac-x', window: 30 });
  assert.equal(next.payer, 'CIGNA');
  assert.equal(next.facility, 'fac-x');
  assert.equal(next.window, 30);
  assert.equal(next.page, 0);
  assert.deepEqual(next.cursors, [null]);
});

test('RESOLVE_PAYER — an unresolved search (null payer/facility) still resets to a fresh cohort', () => {
  const next = cohortReducer(RESOLVED, { type: 'RESOLVE_PAYER', payer: null, facility: null, window: 90 });
  assert.equal(next.payer, null);
  assert.equal(next.facility, null);
  assert.equal(next.window, 90);
  assert.equal(next.page, 0);
  assert.deepEqual(next.cursors, [null]);
});

test('SWITCH_FACILITY — sets facility, PRESERVES payer+window, resets paging', () => {
  const next = cohortReducer(RESOLVED, { type: 'SWITCH_FACILITY', facility: 'fac-b' });
  assert.equal(next.facility, 'fac-b');
  assert.equal(next.payer, 'AETNA');
  assert.equal(next.window, 60);
  assert.equal(next.page, 0);
  assert.deepEqual(next.cursors, [null]);
});

test('CHANGE_WINDOW — sets window, PRESERVES facility (no rank-1 teleport), resets paging', () => {
  const next = cohortReducer(RESOLVED, { type: 'CHANGE_WINDOW', window: 180 });
  assert.equal(next.window, 180);
  assert.equal(next.facility, 'fac-a', 'the facility PERSISTS across a window change — the fix');
  assert.equal(next.payer, 'AETNA');
  assert.equal(next.page, 0);
  assert.deepEqual(next.cursors, [null]);
});

test('the reset invariant: EVERY cohort-change action returns page:0 / cursors:[null]', () => {
  const actions: QualifyCohortAction[] = [
    { type: 'RESOLVE_PAYER', payer: 'X', facility: 'y', window: 30 },
    { type: 'SWITCH_FACILITY', facility: 'z' },
    { type: 'CHANGE_WINDOW', window: 90 },
  ];
  for (const a of actions) {
    const next = cohortReducer(RESOLVED, a);
    assert.equal(next.page, 0, `${a.type} resets page`);
    assert.deepEqual(next.cursors, [null], `${a.type} resets the cursor stack`);
  }
});

test('PAGE_NEXT — increments page and PUSHES the next cursor onto the stack', () => {
  const start: QualifyCohort = { ...INITIAL_COHORT, payer: 'AETNA', facility: 'fac-a' };
  const p1 = cohortReducer(start, { type: 'PAGE_NEXT', nextCursor: C1 });
  assert.equal(p1.page, 1);
  assert.deepEqual(p1.cursors, [null, C1]);
  const p2 = cohortReducer(p1, { type: 'PAGE_NEXT', nextCursor: C2 });
  assert.equal(p2.page, 2);
  assert.deepEqual(p2.cursors, [null, C1, C2]);
});

test('PAGE_PREV — steps back a page WITHOUT dropping the stack (forward re-uses stored cursors)', () => {
  const p2: QualifyCohort = { ...INITIAL_COHORT, payer: 'AETNA', facility: 'fac-a', page: 2, cursors: [null, C1, C2] };
  const p1 = cohortReducer(p2, { type: 'PAGE_PREV' });
  assert.equal(p1.page, 1);
  assert.deepEqual(p1.cursors, [null, C1, C2], 'the stack is preserved on back-nav');
  const p0 = cohortReducer(p1, { type: 'PAGE_PREV' });
  assert.equal(p0.page, 0);
  const floor = cohortReducer(p0, { type: 'PAGE_PREV' });
  assert.equal(floor.page, 0, 'never steps below page 0');
});

test('a cohort change AFTER paging blows the stack away (page:0 / cursors:[null])', () => {
  const deep: QualifyCohort = { ...INITIAL_COHORT, payer: 'AETNA', facility: 'fac-a', page: 3, cursors: [null, C1, C2, C1] };
  const changes: QualifyCohortAction[] = [
    { type: 'SWITCH_FACILITY', facility: 'fac-b' },
    { type: 'CHANGE_WINDOW', window: 90 },
    { type: 'RESOLVE_PAYER', payer: 'CIGNA', facility: 'fac-c', window: 30 },
  ];
  for (const a of changes) {
    const next = cohortReducer(deep, a);
    assert.equal(next.page, 0, `${a.type} after paging resets page`);
    assert.deepEqual(next.cursors, [null], `${a.type} after paging drops the deep stack`);
  }
});

test('purity — the reducer never mutates the input state or its cursor array', () => {
  const start: QualifyCohort = { ...INITIAL_COHORT, payer: 'AETNA', facility: 'fac-a', page: 1, cursors: [null, C1] };
  const snapshot = JSON.parse(JSON.stringify(start));
  cohortReducer(start, { type: 'PAGE_NEXT', nextCursor: C2 });
  cohortReducer(start, { type: 'CHANGE_WINDOW', window: 180 });
  cohortReducer(start, { type: 'RESOLVE_PAYER', payer: 'X', facility: 'y', window: 90 });
  assert.deepEqual(start, snapshot, 'input state is untouched by any action');
});

test('cohortKey — identity is EXACTLY (payer, facility, window); page/cursors ignored (genRef guards races)', () => {
  const base: QualifyCohort = { payer: 'AETNA', facility: 'fac-a', window: 60, page: 0, cursors: [null] };
  assert.equal(cohortKey(base), cohortKey({ ...base, page: 5, cursors: [null, C1] }), 'page/cursors do NOT change the key');
  assert.notEqual(cohortKey(base), cohortKey({ ...base, facility: 'fac-b' }), 'facility changes the key');
  assert.notEqual(cohortKey(base), cohortKey({ ...base, window: 30 }), 'window changes the key');
  assert.notEqual(cohortKey(base), cohortKey({ ...base, payer: 'CIGNA' }), 'payer changes the key');
});

test('cohortKey — no collision when a label contains the naive delimiter (space/pipe)', () => {
  // "A B" + "C" must NOT key-collide with "A" + "B C" — the JSON encoding keeps them distinct.
  const left: QualifyCohort = { payer: 'A B', facility: 'C', window: 60, page: 0, cursors: [null] };
  const right: QualifyCohort = { payer: 'A', facility: 'B C', window: 60, page: 0, cursors: [null] };
  assert.notEqual(cohortKey(left), cohortKey(right));
});
