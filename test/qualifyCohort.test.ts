import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cohortReducer,
  cohortKey,
  INITIAL_COHORT,
  type QualifyCohort,
} from '../app/lib/qualify/qualifyCohort.js';

// RULING: cohort identity is (payer, facility, window) — NOTHING ELSE. The keyset PAGER (page + cursors[])
// is GONE: the facility drill now returns the WHOLE (facility, payer, window) window in one shot (capped at
// QUALIFY_CASES_MAX), grouped by patient — there is no page to track. These tests pin the identity
// transitions + the cohortKey the async-landing guard compares.

// A fully-resolved cohort so each action can be proven to touch ONLY its own field(s).
const RESOLVED: QualifyCohort = { payer: 'AETNA', facility: 'fac-a', window: 60 };

test('RESOLVE_PAYER — sets payer/facility/window (a brand-new cohort)', () => {
  const next = cohortReducer(RESOLVED, { type: 'RESOLVE_PAYER', payer: 'CIGNA', facility: 'fac-x', window: 30 });
  assert.deepEqual(next, { payer: 'CIGNA', facility: 'fac-x', window: 30 });
});

test('RESOLVE_PAYER — an unresolved search (null payer/facility) is a coherent cohort', () => {
  const next = cohortReducer(RESOLVED, { type: 'RESOLVE_PAYER', payer: null, facility: null, window: 90 });
  assert.deepEqual(next, { payer: null, facility: null, window: 90 });
});

test('SWITCH_FACILITY — sets facility, PRESERVES payer+window', () => {
  const next = cohortReducer(RESOLVED, { type: 'SWITCH_FACILITY', facility: 'fac-b' });
  assert.deepEqual(next, { payer: 'AETNA', facility: 'fac-b', window: 60 });
});

test('CHANGE_WINDOW — sets window, PRESERVES facility (no rank-1 teleport) + payer', () => {
  const next = cohortReducer(RESOLVED, { type: 'CHANGE_WINDOW', window: 180 });
  assert.deepEqual(next, { payer: 'AETNA', facility: 'fac-a', window: 180 }, 'the facility PERSISTS across a window change — the fix');
});

test('purity — the reducer never mutates the input state', () => {
  const start: QualifyCohort = { ...INITIAL_COHORT, payer: 'AETNA', facility: 'fac-a' };
  const snapshot = JSON.parse(JSON.stringify(start));
  cohortReducer(start, { type: 'SWITCH_FACILITY', facility: 'fac-b' });
  cohortReducer(start, { type: 'CHANGE_WINDOW', window: 180 });
  cohortReducer(start, { type: 'RESOLVE_PAYER', payer: 'X', facility: 'y', window: 90 });
  assert.deepEqual(start, snapshot, 'input state is untouched by any action');
});

test('cohortKey — identity is EXACTLY (payer, facility, window)', () => {
  const base: QualifyCohort = { payer: 'AETNA', facility: 'fac-a', window: 60 };
  assert.notEqual(cohortKey(base), cohortKey({ ...base, facility: 'fac-b' }), 'facility changes the key');
  assert.notEqual(cohortKey(base), cohortKey({ ...base, window: 30 }), 'window changes the key');
  assert.notEqual(cohortKey(base), cohortKey({ ...base, payer: 'CIGNA' }), 'payer changes the key');
  assert.equal(cohortKey(base), cohortKey({ ...base }), 'same identity → same key');
});

test('cohortKey — no collision when a label contains the naive delimiter (space/pipe)', () => {
  // "A B" + "C" must NOT key-collide with "A" + "B C" — the JSON encoding keeps them distinct.
  const left: QualifyCohort = { payer: 'A B', facility: 'C', window: 60 };
  const right: QualifyCohort = { payer: 'A', facility: 'B C', window: 60 };
  assert.notEqual(cohortKey(left), cohortKey(right));
});
