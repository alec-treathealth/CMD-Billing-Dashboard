/**
 * THE COLLECTIONS EMPLOYER SEGMENT (2026-08-17).
 *
 * Reported: *"The 'Employer' search also has bad UX, this should be searchable regardless. The
 * filter back and forth sets the bar to the left or the right."*
 *
 * Two defects behind one sentence:
 *   · the picker was mounted only in the Employer segment, so it was NOT searchable "regardless";
 *   · mounting/unmounting it inside a `flex-wrap` row of `flex-1` controls made every neighbouring
 *     input resize — the bar sliding left and right.
 *
 * The layout half is CSS and is verified in a browser. THIS file pins the behavioural half: which
 * predicates reach the wire, and when a selection survives.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupEmployerNames } from '../../src/collections/employerCanonical.js';
import {
  applyEmployerFilter,
  clearsEmployerSelection,
  employerPickerDisabled,
  modeAfterEmployerPick,
  type EmployerFilterTarget,
  type EmployerMode,
} from '../lib/collections/employerSegment';

const ALL_MODES: EmployerMode[] = ['all', 'employer', 'individual'];

/** The live Tesla + Apple collision, canonicalised — 'TESLA' covers three raw spellings. */
const VOCAB = groupEmployerNames(['TESLA,INC.', 'TESLA INC', 'TESLA, INC.', 'APPLE INC']);

// ── 1. THE REGRESSION THE REQUEST IS ABOUT ──────────────────────────────────────────────────────
test('a picked employer narrows in All — it used to be dropped unless the segment was Employer', () => {
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'all', ['TESLA'], VOCAB);
  // Expanded to EVERY raw spelling — the grid predicate matches raw text, and no row's
  // employer_name is literally 'TESLA'. Sending the bare key would return an empty grid.
  assert.deepEqual(
    f.employer_names,
    ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.'],
    'the whole point: searchable regardless, and it matches all three spellings',
  );
  // `all` still emits NO employerMode key — absent and 'all' mean the same thing to the server, and
  // omitting it keeps the common unfiltered payload byte-identical to what shipped before.
  assert.equal('employerMode' in f, false);
});

test('Employer still narrows, and still declares its segment', () => {
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'employer', ['TESLA', 'APPLE'], VOCAB);
  assert.equal(f.employerMode, 'employer');
  assert.deepEqual(f.employer_names, ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.', 'APPLE INC']);
});

// ── 2. THE CONTRADICTORY COMBINATION ────────────────────────────────────────────────────────────
test('Individual never emits employer_names, even if a selection somehow survived', () => {
  // Individual is "no plan sponsor"; a named employer IS one. The intersection is empty BY
  // CONSTRUCTION, so sending it would render a zero-row grid that looks like a finding.
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'individual', ['TESLA'], VOCAB);
  assert.equal(f.employerMode, 'individual');
  assert.equal('employer_names' in f, false, 'defence in depth behind the clear-on-switch');
});

test('picking an employer moves Individual to Employer, and moves nothing else', () => {
  assert.equal(modeAfterEmployerPick('individual'), 'employer');
  // MUST NOT drag All → Employer: narrowing by name inside "no restriction" is precisely the
  // combination this change exists to allow. A helpful-looking coercion here would undo the fix.
  assert.equal(modeAfterEmployerPick('all'), 'all');
  assert.equal(modeAfterEmployerPick('employer'), 'employer');
});

// ── 3. THE SELECTION SURVIVES A TOGGLE ──────────────────────────────────────────────────────────
test('only Individual discards the picked employers', () => {
  assert.equal(clearsEmployerSelection('individual'), true);
  // Clearing on All⇄Employer was correct while the picker was unmounted outside Employer (an unseen
  // filter is untrustworthy). Now the picker is always on screen, so clearing would destroy work the
  // user can see they still have.
  assert.equal(clearsEmployerSelection('all'), false);
  assert.equal(clearsEmployerSelection('employer'), false);
});

test('the picker is inert ONLY in Individual', () => {
  assert.equal(employerPickerDisabled('individual'), true);
  assert.equal(employerPickerDisabled('all'), false);
  assert.equal(employerPickerDisabled('employer'), false);
});

// ── 4. Invariants across every mode ─────────────────────────────────────────────────────────────
test('an empty selection never emits employer_names, in any mode', () => {
  for (const m of ALL_MODES) {
    const f = applyEmployerFilter({} as EmployerFilterTarget, m, [], VOCAB);
    assert.equal('employer_names' in f, false, `${m} must not emit an empty narrow`);
  }
});

test('the selection is COPIED onto the filter, not aliased', () => {
  // The three call sites pass component state straight in. Aliasing would let a later setState on
  // the selection array mutate a filter object already captured by an in-flight request — the kind
  // of bug that only shows up under fast clicking and never in a test that checks equality once.
  // 'TESLA INC' is a RAW spelling, not a canonical key, so it exercises the unknown-key fallback
  // too: it passes through as itself rather than being dropped (dropping would widen the grid).
  const selection = ['TESLA INC'];
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'employer', selection, VOCAB);
  assert.deepEqual(f.employer_names, ['TESLA INC']);
  assert.notEqual(f.employer_names, selection, 'must not be the same array reference');
});

test('applyEmployerFilter preserves unrelated keys and returns the same object', () => {
  // It mutates mid-construction, so a caller`s already-set fields must survive untouched.
  const f = { facility: ['LONESTAR MENTAL HEALTH'] } as EmployerFilterTarget & { facility: string[] };
  const out = applyEmployerFilter(f, 'employer', ['TESLA'], VOCAB);
  assert.equal(out, f, 'returns the same object it mutated');
  assert.deepEqual(out.facility, ['LONESTAR MENTAL HEALTH']);
});

// ── 5. THE EXPANSION IS THE WHOLE CANONICAL LAYER ───────────────────────────────────────────────
test('an EMPTY vocabulary still sends the key rather than dropping the filter', () => {
  // The vocabulary loads asynchronously. If a selection somehow exists before it arrives, expanding
  // to nothing would silently WIDEN the grid to every row while a chip on screen claims a narrow.
  // Passing the key through at worst matches nothing, which the user can see.
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'employer', ['TESLA'], []);
  assert.deepEqual(f.employer_names, ['TESLA']);
});

test('an unmerged employer expands to its single spelling', () => {
  // variantCount 1 must not be a special case — APPLE covers exactly 'APPLE INC'.
  const f = applyEmployerFilter({} as EmployerFilterTarget, 'employer', ['APPLE'], VOCAB);
  assert.deepEqual(f.employer_names, ['APPLE INC']);
});
