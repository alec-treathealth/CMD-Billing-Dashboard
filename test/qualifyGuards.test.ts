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
import {
  resolveLandingWins,
  drillLandingWins,
  isPayerChange,
  isIdentifierResolution,
  isIdentifierEmpty,
  identifierEmptyTerm,
  scopeFacilitiesForList,
} from '../app/lib/qualify/qualifyGuards.js';
import { cohortKey, cohortReducer, INITIAL_COHORT } from '../app/lib/qualify/qualifyCohort.js';
import type { QualifyFacility, QualifyResolved } from '../app/lib/qualify/contract.js';

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

// ── Fix A — identifier-landing helpers (shared by desktop + mobile) ──────────────────────────────────
const resolved = (over: Partial<QualifyResolved>): QualifyResolved => ({
  payerName: 'AETNA', matchedOn: 'prefix', matchedValue: 'W29', totalCharges: 10, facilityCount: 3,
  windowStart: '2026-06-17', windowEnd: '2026-07-17', ...over,
});

test('isIdentifierResolution: true for a prefix/member search, false for the payer path / null', () => {
  assert.equal(isIdentifierResolution(resolved({ matchedOn: 'prefix' })), true);
  assert.equal(isIdentifierResolution(resolved({ matchedOn: 'member_id' })), true);
  assert.equal(isIdentifierResolution(resolved({ matchedOn: 'payer' })), false, 'resolve-by-payer is not an identifier');
  assert.equal(isIdentifierResolution(null), false);
});

test('isIdentifierEmpty: identifier resolved + null landing → honest-empty; a landing or the payer path → not', () => {
  assert.equal(isIdentifierEmpty(resolved({ matchedOn: 'prefix' }), null), true, 'prefix search, no ranked in-window claim → honest-empty');
  assert.equal(isIdentifierEmpty(resolved({ matchedOn: 'member_id' }), null), true, 'exact search, none in-window → honest-empty');
  assert.equal(isIdentifierEmpty(resolved({ matchedOn: 'prefix' }), '405 recovery'), false, 'a landing facility → NOT empty');
  assert.equal(isIdentifierEmpty(resolved({ matchedOn: 'payer' }), null), false, 'payer path is payer-wide, never honest-empty (ruling 3)');
  assert.equal(isIdentifierEmpty(null, null), false, 'unresolved (VOB) is a different state');
});

test('identifierEmptyTerm: the ≤3 echo for a prefix search; generic "this member" for exact (never the raw id)', () => {
  assert.equal(identifierEmptyTerm(resolved({ matchedOn: 'prefix', matchedValue: 'W29' })), 'W29');
  assert.equal(identifierEmptyTerm(resolved({ matchedOn: 'member_id', matchedValue: 'AET' })), 'this member', 'exact never echoes any member-id chars');
  assert.equal(identifierEmptyTerm(resolved({ matchedOn: 'payer' })), '');
  assert.equal(identifierEmptyTerm(null), '');
});

const fac = (key: string, rank: number): QualifyFacility => ({
  rank, name: key.toUpperCase(), facilityKey: key, city: null, state: null,
  pctAllowedOfBilled: 50, rating: 50, streakSignal: null, billedAmount: null, allowedAmount: null, lineCount: 10,
  confirmedClaims: 10, estimateClaims: 0, unknownClaims: 0, careSetting: null, entity: null,
});
const DECK = [fac('a', 1), fac('b', 2), fac('c', 3)];

// Part A — scopeFacilitiesForList (replaces leadFacilities: an identifier search now SCOPES to the landing
// facility rather than merely leading with it). Browse keeps the full ranked list.
test('scopeFacilitiesForList: an identifier search that LANDED shows ONLY the landing facility', () => {
  assert.deepEqual(
    scopeFacilitiesForList(DECK, resolved({ matchedOn: 'prefix' }), 'c').map((f) => f.facilityKey),
    ['c'],
    'prefix search + landing → the single landing card, not the full ranked set',
  );
  assert.deepEqual(
    scopeFacilitiesForList(DECK, resolved({ matchedOn: 'member_id' }), 'a').map((f) => f.facilityKey),
    ['a'],
    'exact member-id search scopes the same way',
  );
});

test('scopeFacilitiesForList: identifier honest-empty (null landing) → [] (caller shows the widen nudge, never a random card)', () => {
  assert.deepEqual(scopeFacilitiesForList(DECK, resolved({ matchedOn: 'prefix' }), null), []);
  assert.deepEqual(scopeFacilitiesForList(DECK, resolved({ matchedOn: 'member_id' }), null), []);
});

test('scopeFacilitiesForList: BROWSE (payer path / no resolution) → the FULL ranked list, order preserved', () => {
  assert.deepEqual(
    scopeFacilitiesForList(DECK, resolved({ matchedOn: 'payer' }), null).map((f) => f.facilityKey),
    ['a', 'b', 'c'],
    'resolve-by-payer keeps the full ranked set',
  );
  assert.deepEqual(
    scopeFacilitiesForList(DECK, null, null).map((f) => f.facilityKey),
    ['a', 'b', 'c'],
    'no resolution → full set (never scoped)',
  );
  assert.equal(
    scopeFacilitiesForList(DECK, resolved({ matchedOn: 'payer' }), 'c').length,
    3,
    'the payer path never scopes even if a landing key is somehow present',
  );
});

test('scopeFacilitiesForList: a landing key absent from the list → [] (never a wrong card); input untouched', () => {
  const frozen = DECK.map((f) => f.facilityKey);
  assert.deepEqual(scopeFacilitiesForList(DECK, resolved({ matchedOn: 'prefix' }), 'ghost'), []);
  assert.deepEqual(DECK.map((f) => f.facilityKey), frozen, 'input array untouched');
});
