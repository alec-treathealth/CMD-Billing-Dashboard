/**
 * Qualify guard predicates (Stage 3a) — deterministic unit proof of the mobile shell's async-landing
 * decision logic. The container can't be mounted under the test runner (it pulls the 'use server' action
 * chain), so these pure predicates ARE the testable surface of the four DoD behaviors:
 *   1) chip-then-search drops the stale chip resolution (resolveSeq recency),
 *   2) a payer-change resolution closes the open drill sheet; a same-payer window change keeps it,
 *   3) a drill for a still-open sheet is NOT dropped by a same-payer background resolution (identity holds),
 *   4) a wrong-cohort / superseded drill landing IS dropped (recency OR identity fails).
 * Full async-integration (mounting the container) is the logged Option-B follow-up (needs jsdom infra).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLandingWins, drillLandingWins, isPayerChange } from '../app/lib/qualify/qualifyGuards.js';
import { cohortKey, cohortReducer, INITIAL_COHORT } from '../app/lib/qualify/qualifyCohort.js';

// ── Resolution stream (resolveSeq recency) ──────────────────────────────────────────────────────────

test('resolveLandingWins: chip-then-search drops the stale chip resolution', () => {
  // A chip tap captures seq=1; a search bumps the shared counter to 2 before the chip response lands.
  const chipSeq = 1;
  const searchSeq = 2; // ++resolveSeq at search entry
  assert.equal(resolveLandingWins(chipSeq, searchSeq), false, 'the stale chip resolution is discarded');
  assert.equal(resolveLandingWins(searchSeq, searchSeq), true, 'the newest (search) resolution commits');
});

test('resolveLandingWins: an un-superseded resolution commits', () => {
  assert.equal(resolveLandingWins(5, 5), true);
});

// ── Sheet-close discriminator (payer-change vs same-payer window) ────────────────────────────────────

test('isPayerChange: a different resolved payer closes the sheet; same payer keeps it', () => {
  assert.equal(isPayerChange('AETNA', 'CIGNA'), true, 'payer change → close the open drill sheet');
  assert.equal(isPayerChange('AETNA', 'AETNA'), false, 'same-payer window change → keep the sheet open');
});

test('isPayerChange: unresolved→unresolved is NOT a change; resolve/unresolve transitions ARE', () => {
  assert.equal(isPayerChange(null, null), false, 'nothing resolved either side → no sheet churn');
  assert.equal(isPayerChange(null, 'AETNA'), true, 'first resolution');
  assert.equal(isPayerChange('AETNA', null), true, 'search went unresolved → drop the stale cohort');
});

// ── Drill stream (facilitySeq recency AND cohortKey identity) ────────────────────────────────────────

// A live drill cohort: payer resolved (RESOLVE_PAYER), then a facility tapped (SWITCH_FACILITY).
const RESOLVED = cohortReducer(INITIAL_COHORT, { type: 'RESOLVE_PAYER', payer: 'AETNA', facility: null, window: 30 });
const DRILL = cohortReducer(RESOLVED, { type: 'SWITCH_FACILITY', facility: 'fac-a' });

test('drillLandingWins: a same-payer background resolution does NOT drop the open sheet drill', () => {
  // The drill fetch captured (seq, key) at open. A same-payer background re-resolve does NOT bump
  // facilitySeq and does NOT change the drill cohort's identity → the landing still wins.
  const seq = 7;
  const key = cohortKey(DRILL);
  assert.equal(drillLandingWins(seq, seq, key, key), true, 'still-open sheet drill commits — no stuck-loading');
});

test('drillLandingWins: a superseded drill (close→reopen bumped facilitySeq) is dropped by recency', () => {
  const key = cohortKey(DRILL);
  assert.equal(drillLandingWins(7, 8, key, key), false, 'recency guard drops the stale in-flight drill');
});

test('drillLandingWins: a wrong-cohort landing is dropped by identity even when seq matches', () => {
  const captured = cohortKey(DRILL);
  // Facility switched underneath to a different card (same payer) → cohortKey differs → drop.
  const switched = cohortKey(cohortReducer(DRILL, { type: 'SWITCH_FACILITY', facility: 'fac-b' }));
  assert.notEqual(captured, switched, 'the cohort key changed with the facility');
  assert.equal(drillLandingWins(7, 7, captured, switched), false, 'identity guard drops the wrong-cohort landing');
});

test('drillLandingWins: a window change underneath also flips identity (cohortKey includes window)', () => {
  const captured = cohortKey(DRILL);
  const windowed = cohortKey(cohortReducer(DRILL, { type: 'CHANGE_WINDOW', window: 90 }));
  assert.notEqual(captured, windowed, 'window is part of the cohort key');
  assert.equal(drillLandingWins(7, 7, captured, windowed), false, 'stale-window drill landing is dropped');
});
