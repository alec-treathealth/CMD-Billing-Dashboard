/**
 * Change F — the URL-state allowlist (PHI never in URLs). These tests are the ENFORCEMENT of the
 * hard constraint, not documentation of it: the builder can only emit the four allowlisted keys
 * (payer/facility/window/loc — all resolved, non-PHI), and the parser ignores/fails-closed on
 * everything else. A shared link re-resolves by payer label; no search term ever rides a URL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQualifySearchParams, parseQualifySearchParams } from '../app/lib/qualify/urlState.js';
import { trailingWindow } from '../app/lib/qualify/contract.js';

test('builder — emits ONLY the four allowlisted keys; nothing else can appear', () => {
  const qs = buildQualifySearchParams({
    payer: 'AETNA',
    facility: '405 recovery',
    window: { kind: 'month', year: 2026, month: 7 },
    loc: 'IP',
  });
  const params = new URLSearchParams(qs);
  assert.deepEqual([...params.keys()].sort(), ['facility', 'loc', 'payer', 'window'], 'exactly the allowlist');
  assert.equal(params.get('payer'), 'AETNA');
  assert.equal(params.get('facility'), '405 recovery');
  assert.equal(params.get('window'), '2026-07');
  assert.equal(params.get('loc'), 'ip');
});

test('builder — the TYPE admits no query/member/name field: unresolved state emits an EMPTY string', () => {
  // Structural proof: QualifyUrlState has no slot for a search term — and a null payer (nothing
  // resolved) emits NOTHING, so a mid-typing state can never leak partial input into the URL.
  const qs = buildQualifySearchParams({ payer: null, facility: 'x', window: trailingWindow(30), loc: 'IP' });
  assert.equal(qs, '', 'no resolved payer → no URL state at all');
});

test('builder — omits empties and bounds label length', () => {
  const qs = buildQualifySearchParams({ payer: 'AETNA', facility: null, window: trailingWindow(60), loc: null });
  const params = new URLSearchParams(qs);
  assert.deepEqual([...params.keys()].sort(), ['payer', 'window'], 'facility/loc omitted when unset');
  const long = buildQualifySearchParams({ payer: 'P'.repeat(500), facility: null, window: trailingWindow(30), loc: null });
  assert.ok(new URLSearchParams(long).get('payer')!.length <= 200, 'payer label is length-bounded');
});

test('parser — round-trips the builder output', () => {
  const state = {
    payer: 'CIGNA',
    facility: 'harbor light',
    window: { kind: 'year' as const, year: 2025 },
    loc: 'OP' as const,
  };
  const parsed = parseQualifySearchParams(new URLSearchParams(buildQualifySearchParams(state)));
  assert.deepEqual(parsed, state);
});

test('parser — fails CLOSED: junk window/loc collapse to defaults; facility without payer is dropped; extras ignored', () => {
  const parsed = parseQualifySearchParams(
    new URLSearchParams('payer=AETNA&window=999d&loc=zebra&member_id=SHOULD_NEVER_MATTER&q=raw+term'),
  );
  assert.equal(parsed.payer, 'AETNA');
  assert.deepEqual(parsed.window, trailingWindow(30), 'unparseable window → the default');
  assert.equal(parsed.loc, null, 'unknown loc token → no lens');
  const orphan = parseQualifySearchParams(new URLSearchParams('facility=somewhere&window=30d'));
  assert.equal(orphan.payer, null);
  assert.equal(orphan.facility, null, 'a facility without a payer is meaningless — dropped');
  const oversized = parseQualifySearchParams(new URLSearchParams(`payer=${'x'.repeat(600)}`));
  assert.equal(oversized.payer, null, 'an over-long payer label is rejected, not truncated-and-trusted');
});
