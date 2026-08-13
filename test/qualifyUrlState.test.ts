/**
 * Compose-bar URL-state allowlist (PHI never in URLs). These tests ENFORCE the hard constraint, not
 * document it: the builder can only emit the NON-PHI compose selections (facility/payer/funding —
 * repeated keys) + window + loc, and the parser ignores/fails-closed on everything else. The compose
 * bar's PHI terms (member id / alpha prefix / group # / client name) have NO field in QualifyUrlState by
 * type, so they structurally cannot leak into a shared link.
 *
 * ⚠ EMPLOYER is EXCLUDED from the URL in BOTH directions (audit 2026-08-12, P0-4): employer_norm is
 * the byte-identical twin of the PHI column employer_name, and I7/R6 rule it out of every URL. The
 * state field still exists (in-memory chips) — these tests pin that it never rides a link.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQualifySearchParams, parseQualifySearchParams, type QualifyUrlState } from '../app/lib/qualify/urlState.js';
import { trailingWindow } from '../app/lib/qualify/contract.js';

test('builder — emits ONLY the allowlisted keys; the arrays repeat, PHI has no slot, employer NEVER appears', () => {
  const qs = buildQualifySearchParams({
    facilities: ['405 recovery', 'harbor light'],
    payers: ['AETNA'],
    employers: ['acme_norm'], // selected in memory — must still never reach the URL (P0-4)
    funding: ['Self-Funded'],
    window: { kind: 'month', year: 2026, month: 7 },
    loc: 'IP',
  });
  const params = new URLSearchParams(qs);
  assert.deepEqual(
    [...new Set(params.keys())].sort(),
    ['facility', 'funding', 'loc', 'payer', 'window'],
    'exactly the allowlist — no employer key and no member/prefix/group/name key can appear',
  );
  assert.deepEqual(params.getAll('facility'), ['405 recovery', 'harbor light'], 'multi-select facility repeats');
  assert.equal(params.get('payer'), 'AETNA');
  assert.equal(params.get('employer'), null, 'employer_norm never rides a URL (audit 2026-08-12, P0-4)');
  assert.equal(params.get('funding'), 'Self-Funded');
  assert.equal(params.get('window'), '2026-07');
  assert.equal(params.get('loc'), 'ip');
});

test('builder — an employer-ONLY selection is "nothing shareable": the URL must not even reveal the filter exists', () => {
  const qs = buildQualifySearchParams({
    facilities: [],
    payers: [],
    employers: ['acme_norm', 'globex_norm'],
    funding: [],
    window: trailingWindow(30),
    loc: null,
  });
  assert.equal(qs, '', 'employer chips alone produce a clean URL, not an empty employer param');
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

test('parser — round-trips the builder output (employers round-trip as EMPTY: dropped at build, never parsed)', () => {
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
  // With employers selected, everything ELSE round-trips and the employers come back empty.
  const withEmployers = parseQualifySearchParams(
    new URLSearchParams(buildQualifySearchParams({ ...state, employers: ['acme_norm'] })),
  );
  assert.deepEqual(withEmployers, state, 'employer selection is the one field a shared link does not restore');
});

test('parser — fails CLOSED: junk window/loc → defaults; PHI-shaped params are IGNORED entirely', () => {
  const parsed = parseQualifySearchParams(
    new URLSearchParams(
      'payer=AETNA&window=999d&loc=zebra&member_id=SHOULD_NEVER_MATTER&clientName=Jane+Doe&q=raw+term&employer=acme_norm',
    ),
  );
  assert.deepEqual(parsed.payers, ['AETNA']);
  assert.deepEqual(parsed.employers, [], 'an inbound ?employer= (old shared link) is ignored, not resurrected');
  assert.deepEqual(parsed.window, trailingWindow(30), 'unparseable window → the default');
  assert.equal(parsed.loc, null, 'unknown loc token → no lens');
  // Nothing PHI-shaped is even representable in the parsed state — the keys simply have no field.
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'memberId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'clientName'), false);
  const oversized = parseQualifySearchParams(new URLSearchParams(`payer=${'x'.repeat(600)}`));
  assert.deepEqual(oversized.payers, [], 'an over-long payer label is rejected, not truncated-and-trusted');
});
