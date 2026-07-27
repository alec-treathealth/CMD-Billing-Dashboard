/**
 * Compose-bar URL-state allowlist (PHI never in URLs). These tests ENFORCE the hard constraint, not
 * document it: the builder can only emit the NON-PHI compose selections (facility/payer/employer/funding
 * — repeated keys) + window + loc, and the parser ignores/fails-closed on everything else. The compose
 * bar's PHI terms (member id / alpha prefix / group # / client name) have NO field in QualifyUrlState by
 * type, so they structurally cannot leak into a shared link.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQualifySearchParams, parseQualifySearchParams, type QualifyUrlState } from '../app/lib/qualify/urlState.js';
import { trailingWindow } from '../app/lib/qualify/contract.js';

test('builder — emits ONLY the allowlisted keys; the arrays repeat, PHI has no slot', () => {
  const qs = buildQualifySearchParams({
    facilities: ['405 recovery', 'harbor light'],
    payers: ['AETNA'],
    employers: ['acme_norm'],
    funding: ['Self-Funded'],
    window: { kind: 'month', year: 2026, month: 7 },
    loc: 'IP',
  });
  const params = new URLSearchParams(qs);
  assert.deepEqual(
    [...new Set(params.keys())].sort(),
    ['employer', 'facility', 'funding', 'loc', 'payer', 'window'],
    'exactly the allowlist — no member/prefix/group/name key can appear',
  );
  assert.deepEqual(params.getAll('facility'), ['405 recovery', 'harbor light'], 'multi-select facility repeats');
  assert.equal(params.get('payer'), 'AETNA');
  assert.equal(params.get('employer'), 'acme_norm');
  assert.equal(params.get('funding'), 'Self-Funded');
  assert.equal(params.get('window'), '2026-07');
  assert.equal(params.get('loc'), 'ip');
});

test('builder — no selection AND no lens emits an EMPTY string (a bare window is not worth a URL)', () => {
  const qs = buildQualifySearchParams({
    facilities: [],
    payers: [],
    employers: [],
    funding: [],
    window: trailingWindow(30),
    loc: null,
  });
  assert.equal(qs, '', 'nothing shareable → clean URL');
  // But a lone LOC lens IS shareable (it changes the view) — window rides along then.
  const locOnly = buildQualifySearchParams({
    facilities: [],
    payers: [],
    employers: [],
    funding: [],
    window: trailingWindow(30),
    loc: 'OP',
  });
  assert.equal(new URLSearchParams(locOnly).get('loc'), 'op');
});

test('builder — trims blanks, dedupes, and REJECTS over-long labels (never truncate-and-trust)', () => {
  const qs = buildQualifySearchParams({
    facilities: ['  a  ', 'a', '', 'b'],
    payers: ['AETNA', 'P'.repeat(500)],
    employers: [],
    funding: [],
    window: trailingWindow(60),
    loc: null,
  });
  const params = new URLSearchParams(qs);
  assert.deepEqual(params.getAll('facility'), ['a', 'b'], 'trimmed + deduped + blanks dropped');
  assert.deepEqual(params.getAll('payer'), ['AETNA'], 'over-long label dropped, not truncated-and-trusted');
});

test('parser — round-trips the builder output', () => {
  const state: QualifyUrlState = {
    facilities: ['harbor light'],
    payers: ['CIGNA', 'AETNA'],
    employers: [],
    funding: ['Fully Insured'],
    window: { kind: 'year', year: 2025 },
    loc: 'OP',
  };
  const parsed = parseQualifySearchParams(new URLSearchParams(buildQualifySearchParams(state)));
  assert.deepEqual(parsed, state);
});

test('parser — fails CLOSED: junk window/loc → defaults; PHI-shaped params are IGNORED entirely', () => {
  const parsed = parseQualifySearchParams(
    new URLSearchParams('payer=AETNA&window=999d&loc=zebra&member_id=SHOULD_NEVER_MATTER&clientName=Jane+Doe&q=raw+term'),
  );
  assert.deepEqual(parsed.payers, ['AETNA']);
  assert.deepEqual(parsed.window, trailingWindow(30), 'unparseable window → the default');
  assert.equal(parsed.loc, null, 'unknown loc token → no lens');
  // Nothing PHI-shaped is even representable in the parsed state — the keys simply have no field.
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'memberId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'clientName'), false);
  const oversized = parseQualifySearchParams(new URLSearchParams(`payer=${'x'.repeat(600)}`));
  assert.deepEqual(oversized.payers, [], 'an over-long payer label is rejected, not truncated-and-trusted');
});
