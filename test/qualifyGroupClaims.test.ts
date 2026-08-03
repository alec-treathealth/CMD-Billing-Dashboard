/**
 * Phase 2 — pure client-side patient grouping + LOC filtering (app/lib/qualify/groupClaims.ts).
 * Root-suite-tested directly (the qualifyGuards pattern): grouping is presentation-only over a server
 * page; patientKey is a per-response ordinal (contract.ts) — these tests prove the roll-up rules the
 * desktop claims panel renders from.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupClaimsByPatient, filterFacilitiesByLoc } from '../app/lib/qualify/groupClaims.js';
import type { QualifyClaim, QualifyFacility } from '../app/lib/qualify/contract.js';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture.js';

const claim = (over: Partial<QualifyClaim> & { id: number; patientKey: number }): QualifyClaim => ({
  memberIdMasked: '••••••',
  payerName: 'AETNA',
  facilityName: 'F',
  program: 'OP',
  dos: '2026-07-15',
  paymentDate: '2026-07-20',
  pctAllowedOfBilled: 50,
  billedAmount: 100,
  allowedAmount: 50,
  confidence: 'confirmed',
  ...over,
});

test('groupClaimsByPatient: same patientKey folds into one group (daily IP runs); order is first-seen', () => {
  const groups = groupClaimsByPatient([
    claim({ id: 1, patientKey: 7, dos: '2026-07-15' }),
    claim({ id: 2, patientKey: 7, dos: '2026-07-14' }),
    claim({ id: 3, patientKey: 9, dos: '2026-07-13' }),
    claim({ id: 4, patientKey: 7, dos: '2026-07-12' }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.patientKey, 7, 'first-seen patient leads (page is dos-desc)');
  assert.equal(groups[0]!.claimCount, 3, 'the daily run folds under one patient');
  assert.deepEqual(groups[0]!.claims.map((c) => c.id), [1, 2, 4], 'claims keep server order');
  assert.equal(groups[1]!.claimCount, 1);
});

test('groupClaimsByPatient: avgPct is the PLAIN MEAN of non-null pcts (role-identical; unknown contributes nothing)', () => {
  const [g] = groupClaimsByPatient([
    claim({ id: 1, patientKey: 1, pctAllowedOfBilled: 80 }),
    claim({ id: 2, patientKey: 1, pctAllowedOfBilled: 40 }),
    claim({ id: 3, patientKey: 1, pctAllowedOfBilled: null, confidence: 'unknown' }),
  ]);
  assert.equal(g!.avgPct, 60, 'mean of 80 and 40; the null-pct unknown claim is excluded');
});

test('groupClaimsByPatient: ANY estimate claim marks the whole group estimate (one reversal taints the roll-up)', () => {
  const [g] = groupClaimsByPatient([
    claim({ id: 1, patientKey: 1, pctAllowedOfBilled: 95 }),
    claim({ id: 2, patientKey: 1, pctAllowedOfBilled: 90, confidence: 'estimate' }),
  ]);
  assert.equal(g!.confidence, 'estimate', 'never lets a high roll-up read green over an unverified claim');
});

test('groupClaimsByPatient: all-unknown → unknown; otherwise confirmed; empty input → no groups', () => {
  const [u] = groupClaimsByPatient([
    claim({ id: 1, patientKey: 1, pctAllowedOfBilled: null, confidence: 'unknown' }),
    claim({ id: 2, patientKey: 1, pctAllowedOfBilled: null, confidence: 'unknown' }),
  ]);
  assert.equal(u!.confidence, 'unknown');
  assert.equal(u!.avgPct, null, 'no pct evidence → null roll-up, never 0');
  const [c] = groupClaimsByPatient([claim({ id: 3, patientKey: 2 })]);
  assert.equal(c!.confidence, 'confirmed');
  assert.deepEqual(groupClaimsByPatient([]), []);
});

const fac = (key: string, careSetting: QualifyFacility['careSetting']): QualifyFacility => ({
  ...QUALIFY_FACILITY_V2_NULLS,
  rank: 1, name: key.toUpperCase(), facilityKey: key, city: null, state: null,
  pctAllowedOfBilled: 50, rating: 50, streakSignal: null, billedAmount: null, allowedAmount: null,
  lineCount: 10, distinctPatients: 10, confirmedClaims: 10, estimateClaims: 0, unknownClaims: 0, careSetting, entity: null,
});

test('filterFacilitiesByLoc: INCLUSIVE chips — IP shows IP+BOTH; OP shows OP+BOTH; Both shows only BOTH', () => {
  const all = [fac('a', 'IP'), fac('b', 'OP'), fac('c', 'BOTH'), fac('d', null)];
  assert.deepEqual(filterFacilitiesByLoc(all, 'IP').map((f) => f.facilityKey), ['a', 'c']);
  assert.deepEqual(filterFacilitiesByLoc(all, 'OP').map((f) => f.facilityKey), ['b', 'c']);
  assert.deepEqual(filterFacilitiesByLoc(all, 'BOTH').map((f) => f.facilityKey), ['c']);
});

test('filterFacilitiesByLoc: no chip → everything INCLUDING unresolved-LOC facilities; a chip excludes them', () => {
  const all = [fac('a', 'IP'), fac('d', null)];
  assert.deepEqual(filterFacilitiesByLoc(all, null).map((f) => f.facilityKey), ['a', 'd']);
  assert.deepEqual(filterFacilitiesByLoc(all, 'IP').map((f) => f.facilityKey), ['a'], 'null careSetting cannot satisfy a positive chip');
});
