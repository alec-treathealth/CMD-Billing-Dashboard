/**
 * THE SCOPE CLAIM, pinned at its two chokepoints (2026-08-07).
 *
 * `QualifyResolved.payerName` went nullable when the v3 Skip started ranking an identifier's WHOLE
 * footprint instead of its dominant billed-under label. That field is not a decoration — nine
 * surfaces interpolate it into a sentence asserting what the numbers beside it describe. The failure
 * mode this file exists to prevent is the one PRs #92 / #148 / #157 were each spent removing: a
 * consumer that keeps compiling, keeps rendering, and quietly claims a narrower scope than the data.
 *
 * Two helpers carry that weight, so both get their own tests here rather than being asserted
 * incidentally through a render:
 *   · `scopedPayerOf` — "give me THE label, or null" for consumers that genuinely need exactly one
 *     (the KPI tiles, the drill seed, the breadcrumb, the active chip).
 *   · `aiScopeLabel`  — what the explainer panel CALLS the scope it is answering over.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopedPayerOf, type QualifyResolved, type QualifySnapshot } from '../lib/qualify/contract';
import { aiScopeLabel } from '../lib/qualify/scopeLabel';

const resolved = (over: Partial<QualifyResolved>): QualifyResolved =>
  ({
    payerName: 'AETNA',
    payerScope: 'payer',
    matchedOn: 'prefix',
    matchedValue: 'XDP',
    totalCharges: 100,
    facilityCount: 4,
    windowStart: '2026-05-01',
    windowEnd: '2026-08-01',
    identifierScoped: true,
    ...over,
  }) as QualifyResolved;

test('scopedPayerOf returns the label only when there IS exactly one', () => {
  assert.equal(scopedPayerOf(resolved({})), 'AETNA');
  // The identifier-wide case. Null is the ANSWER, not a missing value — a consumer that needs one
  // label has to decide what it does here, at the call site, in the open.
  assert.equal(scopedPayerOf(resolved({ payerName: null, payerScope: 'all' })), null);
  // No resolution at all (comparable-cohort / VOB-only reads).
  assert.equal(scopedPayerOf(null), null);
  assert.equal(scopedPayerOf(undefined), null);
});

test('scopedPayerOf refuses a label that the SCOPE contradicts — the discriminator wins', () => {
  // A malformed pair should never happen (the core sets both from one variable, and a core test pins
  // the ⟺ invariant), but if it ever did, the safe reading is "no single label". Trusting payerName
  // over payerScope is precisely how a wider ranking gets captioned with one payer's name.
  assert.equal(scopedPayerOf(resolved({ payerName: 'AETNA', payerScope: 'all' })), null);
});

const snap = (r: QualifyResolved | null, carrier: string | null = 'Aetna'): QualifySnapshot =>
  ({ resolved: r, policy: carrier ? { found: true, carrier } : null }) as unknown as QualifySnapshot;

test('the AI panel names an all-payers scope instead of falling through to the VOB carrier', () => {
  // ⚠ THE MIDDLE RUNG OF THE OLD CHAIN IS THE TRAP. `payerName ?? policy.carrier ?? 'This search'`
  // labels a ranking that spans EVERY billed-under label with ONE carrier's name — narrower than the
  // data, and outright wrong whenever the member bills under carriers the VOB never names.
  assert.equal(aiScopeLabel(snap(resolved({ payerName: null, payerScope: 'all' }))), 'All payers on file');
  assert.equal(aiScopeLabel(snap(resolved({ payerName: null, payerScope: 'all' })), 'lower'), 'all payers on file');
  // The pre-existing rungs are untouched for every other shape.
  assert.equal(aiScopeLabel(snap(resolved({}))), 'AETNA');
  assert.equal(aiScopeLabel(snap(null)), 'Aetna', 'no resolution still falls back to the VOB carrier');
  assert.equal(aiScopeLabel(snap(null, null)), 'This search');
  assert.equal(aiScopeLabel(snap(null, null), 'lower'), 'this search');
});
