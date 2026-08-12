/**
 * The shared guided type-ahead's MATCH PREDICATE — the first direct test this primitive has ever had.
 *
 * WHY IT EXISTS NOW. `MultiSelectTagPicker` is rendered by the Collections explorer (facility, payer,
 * employer, funding), the v2 Qualify tab (employer, funding) and the v3 verdict card
 * (employer; it was the NARROW SEARCH card until 2026-08-12) — four surfaces, and a grep of
 * `app/test/` for it returned ZERO hits. That absence was
 * the stated blocker on fixing the S4 finding that the facility narrow cannot be found by typing its
 * raw CMD spelling: changing a filter four surfaces depend on, with no unit-level guard, is not a
 * change anyone should make. So the predicate is extracted and tested, and only then extended.
 *
 * ⚠ `'use client'` IS INERT UNDER THIS LOADER. The directive is a bundler instruction; the module is
 * plain ESM to `node --test`, and it already loads transitively through the v3 flow's render tests.
 * There is no React here — this file tests the pure predicate, not the component.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickerMatches, type PickerOption } from '../components/ui/multi-select-tag-picker';

/** Exactly the shape every pre-existing caller builds: value + display, and nothing else. */
const COLLECTIONS_SHAPED: PickerOption[] = [
  { value: 'LONESTAR MENTAL HEALTH', display: 'LONESTAR MENTAL HEALTH' },
  { value: 'CALIFORNIA MENTAL HEALTH LLC', display: 'CA MENTAL HEALTH' },
  { value: 'SOUTHWEST AIRLINES CO', display: 'SOUTHWEST AIRLINES CO' },
];

/** The Qualify facility shape: an ACRONYM display, with the raw CMD spellings behind it. */
const FACILITY_SHAPED: PickerOption[] = [
  {
    value: 'CALIFORNIA MENTAL HEALTH LLC',
    display: 'CA MENTAL HEALTH',
    searchText: ['CALIFORNIA MENTAL HEALTH LLC', 'CALIFORNIA MENTAL HEALTH'],
  },
];

test('pickerMatches: an empty or whitespace query matches everything — a blank box hides nothing', () => {
  for (const q of ['', '   ', '\t']) {
    for (const o of COLLECTIONS_SHAPED) assert.equal(pickerMatches(o, q), true, `${o.display} on ${JSON.stringify(q)}`);
  }
});

test('pickerMatches: case-insensitive SUBSTRING on display — the shipped behaviour, unchanged', () => {
  const [lonestar, ca] = COLLECTIONS_SHAPED;
  assert.equal(pickerMatches(lonestar!, 'lonestar'), true);
  assert.equal(pickerMatches(lonestar!, 'MENTAL'), true, 'substring, not prefix');
  assert.equal(pickerMatches(lonestar!, '  MeNtAl  '), true, 'trimmed and case-folded');
  assert.equal(pickerMatches(ca!, 'CA MENTAL'), true);
  assert.equal(pickerMatches(ca!, 'zzz'), false);
});

test('pickerMatches: an option with NO searchText behaves EXACTLY as display-only filtering did', () => {
  // ⚠ THE COMPATIBILITY CLAIM, ASSERTED RATHER THAN REASONED. `searchText` is optional and no existing
  // caller passes it, so every Collections / v2-tab / payer / funding picker must filter byte-for-byte
  // as before. This compares the new predicate against the OLD expression over a query sweep instead
  // of hand-listing outcomes — a hand-listed table would agree with a subtly different predicate.
  const legacy = (o: PickerOption, q: string) => o.display.toLowerCase().includes(q.trim().toLowerCase());
  const queries = ['', 'l', 'mental', 'MENTAL HEALTH', 'ca', 'california', 'southwest', 'llc', 'zzz', '  '];
  for (const o of COLLECTIONS_SHAPED) {
    for (const q of queries) {
      assert.equal(pickerMatches(o, q), legacy(o, q), `drift on ${JSON.stringify(q)} for ${o.display}`);
    }
  }
});

test('pickerMatches: searchText finds the RAW CMD spelling behind an acronym label', () => {
  // THE S4 FINDING. 16 of 47 live Qualify facility options have display !== value, so on a display-only
  // filter an operator typing what CMD actually calls the facility gets "No matches" for a facility
  // that is right there. `display` is NOT recomposed to fix this — label parity with the score cards
  // is the whole reason `display_acronym` exists — so the raw spellings ride alongside instead.
  const [ca] = FACILITY_SHAPED;
  assert.equal(pickerMatches(ca!, 'CALIFORNIA'), true, 'the raw CMD spelling now finds it');
  assert.equal(pickerMatches(ca!, 'california mental health llc'), true, 'in full, case-folded');
  assert.equal(pickerMatches(ca!, 'CA MENTAL'), true, 'and the acronym label still does');
  assert.equal(pickerMatches(ca!, 'OREGON'), false, 'searchText widens the haystack, it does not match everything');
  // The label the picker DISPLAYS is untouched by any of this.
  assert.equal(ca!.display, 'CA MENTAL HEALTH', 'display is the score cards’ label, not a composite');
});

test('pickerMatches: an EMPTY searchText array is the same as none at all', () => {
  const bare: PickerOption = { value: 'X', display: 'ALPHA', searchText: [] };
  assert.equal(pickerMatches(bare, 'ALPHA'), true);
  assert.equal(pickerMatches(bare, 'X'), false, 'value is not searched unless a caller opts in via searchText');
});

test('SERVER mode still short-circuits: the predicate is not applied to server-filtered options', () => {
  /* ⚠ A COMPONENT-LEVEL RULE A PURE TEST CANNOT SEE. In server mode the parent has already filtered
   * `options` for the query, so re-filtering client-side would drop rows the server deliberately
   * returned — and `employerNarrowFor` needs the full returned set. The guard is the `serverDriven ||
   * q === ''` short-circuit in front of the filter; it is asserted by reading the source, with a
   * positive control, because the branch lives in a hook this file does not mount. */
  const src = readFileSync(
    fileURLToPath(new URL('../components/ui/multi-select-tag-picker.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(src, /const serverDriven = typeof onQueryChange === 'function';/, 'positive control: the mode flag');
  assert.match(
    src,
    /serverDriven \|\| q === ''\s*\?\s*options\s*:\s*options\.filter\(\(o\) => pickerMatches\(o, q\)\)/,
    'the server short-circuit must sit in FRONT of the predicate, not inside it',
  );
});
