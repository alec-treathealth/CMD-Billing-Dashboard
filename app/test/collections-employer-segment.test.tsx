/**
 * THE COLLECTIONS EMPLOYER NARROW (2026-08-17, segment removed 2026-08-18).
 *
 * Reported: *"The 'Employer' search also has bad UX, this should be searchable regardless. The
 * filter back and forth sets the bar to the left or the right."* Then, after the browser pass:
 * *"the selection tab doesn't need to exist anymore … if the user searches an employer, they're
 * looking for an employer policy. If not, they are looking for all. Never 'Individual'."*
 *
 * The layout half is CSS and is verified in a browser. THIS file pins what reaches the wire.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupEmployerNames } from '../../src/collections/employerCanonical.js';
import {
  applyEmployerFilter,
  type EmployerFilterTarget,
} from '../lib/collections/employerSegment';

/** The live Tesla + Apple collision, canonicalised — 'TESLA' covers three raw spellings. */
const VOCAB = groupEmployerNames(['TESLA,INC.', 'TESLA INC', 'TESLA, INC.', 'APPLE INC']);

test('a picked employer narrows, expanded to EVERY raw spelling', () => {
  // The grid predicate matches raw text; no row's employer_name is literally 'TESLA'. Sending the
  // bare canonical key would return an empty grid for every merged employer.
  const f = applyEmployerFilter({} as EmployerFilterTarget, ['TESLA'], VOCAB);
  assert.deepEqual(f.employer_names, ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.']);
});

test('several picks concatenate, in selection order', () => {
  const f = applyEmployerFilter({} as EmployerFilterTarget, ['TESLA', 'APPLE'], VOCAB);
  assert.deepEqual(f.employer_names, ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.', 'APPLE INC']);
});

test('an empty selection emits NO key at all', () => {
  // Keeps the unfiltered payload — the common case — byte-identical to the pre-employer-filter wire.
  const f = applyEmployerFilter({} as EmployerFilterTarget, [], VOCAB);
  assert.equal('employer_names' in f, false);
});

test('THE SEGMENT IS GONE: no employerMode ever reaches the filter', () => {
  // ⚠ THE REGRESSION GUARD. The segment's last teeth were SERVER-side: applyEmployerFilter in
  // actions.ts gated the names on `employerMode === 'employer'`, so once the picker became
  // always-available the client sent names while in `all` and the server silently dropped them —
  // chips on screen, grid unfiltered, nothing thrown. If a mode is ever reintroduced here, that
  // failure mode comes back, so its ABSENCE is pinned rather than assumed.
  const f = applyEmployerFilter({} as EmployerFilterTarget, ['TESLA'], VOCAB);
  assert.deepEqual(Object.keys(f), ['employer_names'], 'employer_names is the ONLY key written');
});

test('an EMPTY vocabulary still sends the key rather than dropping the filter', () => {
  // The vocabulary loads asynchronously. Expanding to nothing would silently WIDEN the grid to every
  // row while a chip on screen claims a narrow. Passing the key through at worst matches nothing.
  const f = applyEmployerFilter({} as EmployerFilterTarget, ['TESLA'], []);
  assert.deepEqual(f.employer_names, ['TESLA']);
});

test('an unmerged employer expands to its single spelling', () => {
  const f = applyEmployerFilter({} as EmployerFilterTarget, ['APPLE'], VOCAB);
  assert.deepEqual(f.employer_names, ['APPLE INC']);
});

test('the selection is COPIED onto the filter, not aliased', () => {
  // The three call sites pass component state straight in. Aliasing would let a later setState
  // mutate a filter object already captured by an in-flight request.
  const selection = ['TESLA'];
  const f = applyEmployerFilter({} as EmployerFilterTarget, selection, VOCAB);
  assert.notEqual(f.employer_names, selection, 'must not be the same array reference');
});

test('applyEmployerFilter preserves unrelated keys and returns the same object', () => {
  const f = { facility: ['LONESTAR MENTAL HEALTH'] } as EmployerFilterTarget & { facility: string[] };
  const out = applyEmployerFilter(f, ['TESLA'], VOCAB);
  assert.equal(out, f, 'returns the same object it mutated');
  assert.deepEqual(out.facility, ['LONESTAR MENTAL HEALTH']);
});
