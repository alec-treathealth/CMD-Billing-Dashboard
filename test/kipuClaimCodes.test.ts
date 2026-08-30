/**
 * TMH CA claim-code legend — the seed, and what it deliberately REFUSES to answer.
 *
 * The load-bearing assertions here are the negative ones. A legend that resolves `I` to
 * something plausible would pass any "does it return a code" test and would put a guessed
 * HCPCS on a claim, so every unresolved case asserts the ABSENCE of a code value first and
 * treats the flag as secondary evidence — a flag beside a code is still a billable guess.
 *
 * Fixtures are synthetic and there are none to speak of: the seed is the unit under test. The
 * source workbook is PHI and is not in this repo in any form, so nothing here reads one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CA_CLAIM_CODES,
  claimCodeFor,
  resolvedClaimCodes,
  unresolvedClaimCodes,
  type ClaimCodeFlag,
} from '../src/kipu/claimCodes.js';

/** Reads the code off a resolution without narrowing, so a failure prints the real value. */
const codeOf = (r: ReturnType<typeof claimCodeFor>): string | null => r.code;

/* ─────────────────────────── the three that resolve ─────────────────────────── */

test('G, T and BPS resolve to the workbook’s single codes', () => {
  for (const [dayCode, expected] of [
    ['G', '90853'],
    ['T', '90837'],
    ['BPS', '90791'],
  ] as const) {
    const r = claimCodeFor('CA', dayCode);
    assert.equal(r.resolved, true, `${dayCode} did not resolve`);
    assert.equal(codeOf(r), expected);
  }
});

test('day codes are matched case- and whitespace-insensitively', () => {
  assert.equal(codeOf(claimCodeFor('CA', ' bps ')), '90791');
  assert.equal(codeOf(claimCodeFor('ca', 'g')), '90853');
});

/* ──────────────────── `I` — two alternates and no selection rule ──────────────────── */

test('I yields NO code — assert the absence, because a guessed HCPCS bills a claim', () => {
  const r = claimCodeFor('CA', 'I');
  // The absence is the claim. Every code the legend or the record offers must be absent from
  // the resolution, including the two the legend actually prints.
  assert.equal(codeOf(r), null, 'I resolved to a code');
  assert.equal(r.resolved, false);
  for (const guess of ['S9480', 'H0015', 'H2013', 'H2019', 'H2020']) {
    assert.notEqual(codeOf(r), guess, `I defaulted to ${guess}`);
  }
});

test('I raises the ambiguity flag rather than failing silently', () => {
  const r = claimCodeFor('CA', 'I');
  assert.equal(r.resolved, false);
  if (r.resolved) return;
  const flag: ClaimCodeFlag = r.flag;
  assert.equal(flag, 'claim-code-ambiguous');
});

test('I’s alternates are RECORDED but are not a candidate list a caller can index into', () => {
  const r = claimCodeFor('CA', 'I');
  assert.equal(r.resolved, false);
  if (r.resolved) return;
  // The record exists so a human can see the spread; it must never masquerade as a resolution.
  assert.ok(r.alternates && r.alternates.length > 1, 'the observed spread was dropped');
  assert.ok(r.alternates!.includes('H2020'), 'H2020 is absent from the legend and must be recorded');
  assert.equal(codeOf(r), null, 'recording alternates must not resolve the entry');
});

/* ────────────────────────── `CM` — named, with no code ────────────────────────── */

test('CM yields NO code and flags as absent — not omitted, not defaulted', () => {
  const r = claimCodeFor('CA', 'CM');
  assert.equal(codeOf(r), null, 'CM resolved to a code');
  assert.equal(r.resolved, false);
  if (r.resolved) return;
  assert.equal(r.flag, 'claim-code-absent');
  // Seeded rather than missing: the distinction between "no code exists" and "nobody looked".
  assert.ok(
    CA_CLAIM_CODES.some((e) => e.dayCode === 'CM'),
    'CM must be present in the legend as an explicit no-code entry',
  );
});

/* ───────────────── unknown codes and unseeded scopes both flag ───────────────── */

test('an unknown day code flags rather than defaulting, like an unmapped Kipu location', () => {
  for (const unknown of ['ZZZ', 'HRS', 'D/C', 'N/B', '']) {
    const r = claimCodeFor('CA', unknown);
    assert.equal(codeOf(r), null, `${unknown || '(empty)'} resolved to a code`);
    assert.equal(r.resolved, false);
    if (r.resolved) continue;
    assert.equal(r.flag, 'claim-code-unknown', `${unknown || '(empty)'} took the wrong branch`);
  }
});

test('a day code that resolves in CA does NOT resolve in an unseeded state', () => {
  // The legend may or may not be per-state — that is open with the biller — so every other
  // scope refuses instead of borrowing California's answer.
  for (const state of ['TX', 'WA', 'NV', 'CO', 'PA', 'TN']) {
    const r = claimCodeFor(state, 'G');
    assert.notEqual(codeOf(r), '90853', `${state} borrowed California's code`);
    assert.equal(codeOf(r), null);
    assert.equal(r.resolved, false);
    if (r.resolved) continue;
    assert.equal(r.flag, 'claim-code-scope-unseeded');
  }
});

/* ─────────────────────────── shape of the seed itself ─────────────────────────── */

test('exactly the three resolved entries carry a code, and every other entry is flagged', () => {
  assert.deepEqual(
    resolvedClaimCodes('CA').map((e) => e.dayCode),
    ['G', 'T', 'BPS'],
  );
  assert.deepEqual(
    unresolvedClaimCodes('CA').map((e) => e.dayCode),
    ['I', 'CM'],
  );
  for (const e of unresolvedClaimCodes('CA')) {
    assert.equal(e.code, null);
    assert.equal(e.ambiguous, true, `${e.dayCode} is unresolved but not marked ambiguous`);
    assert.ok(e.flag, `${e.dayCode} is unresolved with no named flag`);
  }
  for (const e of resolvedClaimCodes('CA')) {
    assert.equal(e.ambiguous, undefined, `${e.dayCode} is resolved but marked ambiguous`);
    assert.equal(e.flag, undefined, `${e.dayCode} is resolved but carries a flag`);
  }
});

test('an unseeded scope lists nothing at all, rather than California’s entries', () => {
  assert.deepEqual(resolvedClaimCodes('TX'), []);
  assert.deepEqual(unresolvedClaimCodes('TX'), []);
});

test('no payer name reaches the seed — the workbook’s payer column stays out of the repo', () => {
  // The per-payer split is what makes `I` unresolvable, and it is recorded as CODE counts in a
  // comment, never as data. Nothing associates a payer with a code or a patient here.
  const serialised = JSON.stringify(CA_CLAIM_CODES);
  for (const payerish of ['Aetna', 'BCBS', 'BlueCard', 'Anthem', 'UMR', 'UHC', 'Optum', 'BS CA']) {
    assert.equal(
      serialised.includes(payerish),
      false,
      `${payerish} reached the seeded data`,
    );
  }
});
