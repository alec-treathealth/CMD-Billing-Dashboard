/**
 * THE COLLECTIONS FACILITY PICKER — one option per real facility.
 *
 * ⚠ THE FIXTURE IS REAL. `LONESTAR MENTAL HEALTH` / `LONESTAR MENTAL HEALTH LLC` → LSMH / IP is live
 * production data, reproducible from the picker's own query. Do not "simplify" it to FOO/BAR — the
 * bug was invisible precisely because the two labels were plausible, and a synthetic fixture would
 * not have caught that the curated name is byte-identical to ONE of the raw spellings.
 *
 * ⚠ THIS FILE REVERSED DIRECTION ON 2026-08-18. It previously asserted that the two LONESTAR options
 * stayed TWO options and were merely labelled apart — the 2026-08-10 ruling ("Collections is a
 * raw-grain payment search, not a facility rollup"). Two label-only fixes shipped under that ruling
 * and both failed the same user: the first was clipped by CSS `truncate`, the second was legible and
 * still rejected in a browser pass ("it should be merged into one facility"). The ruling is reversed
 * and these tests now pin the MERGE. See facilityPickerOptions.ts before restoring anything.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandFacilityKeys,
  facilityGroupsFrom,
  facilityPickerOptionsFrom,
  type FacilityLabelSource,
} from '../lib/collections/facilityPickerOptions';
// THE REAL FILTER the picker runs — not a reimplementation. See the type-ahead test below.
import { pickerMatches } from '../components/ui/multi-select-tag-picker';

/** The live LSMH collision, plus two ordinary facilities that must be untouched. */
const LIVE: FacilityLabelSource[] = [
  { facility: 'LONESTAR MENTAL HEALTH', facility_name: 'LONESTAR MENTAL HEALTH LLC', care_setting: 'IP' },
  { facility: 'LONESTAR MENTAL HEALTH LLC', facility_name: 'LONESTAR MENTAL HEALTH LLC', care_setting: 'IP' },
  { facility: 'NASHVILLE TREATMENT', facility_name: 'NASHVILLE TREATMENT CENTER', care_setting: 'OP' },
  { facility: 'No Facility', facility_name: null, care_setting: null },
];

// ── 1. THE MERGE ────────────────────────────────────────────────────────────────────────────────
test('the two Lonestar spellings become ONE option', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  assert.equal(opts.length, 3, 'four raw spellings, three real facilities');
  const lonestar = opts.filter((o) => o.display.startsWith('LONESTAR'));
  assert.equal(lonestar.length, 1, 'the whole defect: one place, one row');
  assert.equal(lonestar[0]!.value, 'LONESTAR MENTAL HEALTH LLC', 'the curated name is the key');
  assert.equal(lonestar[0]!.detail, '2 CMD spellings', 'the merge is stated, not hidden');
});

test('THE FILTER STILL MATCHES RAW TEXT — the merge is display-only', () => {
  // The predicate is `facility = any(...)` over raw CMD text. If a curated key reached it unexpanded
  // the grid would return ZERO rows for every merged facility — worse than the bug being fixed.
  const groups = facilityGroupsFrom(LIVE);
  assert.deepEqual(
    expandFacilityKeys(['LONESTAR MENTAL HEALTH LLC'], groups),
    ['LONESTAR MENTAL HEALTH', 'LONESTAR MENTAL HEALTH LLC'],
    'picking the merged row asks for BOTH spellings — 10,044 + 162 charge lines, not 162',
  );
});

test('every raw spelling is reachable through exactly one option', () => {
  // A spelling under no option is invisible data; a spelling under two would over-select.
  const groups = facilityGroupsFrom(LIVE);
  const all = groups.flatMap((g) => g.variants);
  assert.equal(all.length, new Set(all).size, 'no spelling appears twice');
  assert.deepEqual([...all].sort(), LIVE.map((s) => s.facility).sort());
  // Selecting every option reproduces the entire vocabulary — "all facilities" is expressible.
  assert.deepEqual(expandFacilityKeys(groups.map((g) => g.key), groups).sort(), all.sort());
});

// ── 2. THE TYPE-AHEAD ───────────────────────────────────────────────────────────────────────────
test('the raw CMD spellings stay findable through the REAL pickerMatches', () => {
  // `display` is now the CURATED name, so without searchText someone typing what CMD actually calls
  // the facility would get "No matches" for a facility that is right there.
  const opts = facilityPickerOptionsFrom(LIVE);
  const count = (q: string) => opts.filter((o) => pickerMatches(o, q)).length;
  assert.equal(count('Lonestar'), 1, 'one row, not two');
  assert.equal(count('mental'), 1, 'the query from the original report');
  assert.equal(count('LONESTAR MENTAL HEALTH LLC'), 1, 'the raw spelling that is not the label');
  assert.equal(count('nashville'), 1);
  assert.equal(count('zzz'), 0);
});

// ── 3. Nothing else moves ───────────────────────────────────────────────────────────────────────
test('an unmerged facility keeps its curated label and gains no detail line', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  const nash = opts.find((o) => o.value === 'NASHVILLE TREATMENT CENTER');
  assert.ok(nash);
  assert.equal(nash.display, 'NASHVILLE TREATMENT CENTER');
  assert.equal(nash.detail, undefined, 'no "N CMD spellings" when there is only one');
});

test('an UNRESOLVED facility can never merge with anything', () => {
  // facility_name === null groups under its own raw text. That is the safe direction: a missing
  // crosswalk entry leaves two options rather than silently fusing two different facilities.
  const opts = facilityPickerOptionsFrom([
    ...LIVE,
    { facility: 'No Facility 2', facility_name: null, care_setting: null },
  ]);
  const unresolved = opts.filter((o) => o.value.startsWith('No Facility'));
  assert.equal(unresolved.length, 2, 'unresolved rows stay separate');
});

test('badges pass through, and survive a spelling that did not resolve a care setting', () => {
  const groups = facilityGroupsFrom([
    { facility: 'LONESTAR MENTAL HEALTH', facility_name: 'LSMH', care_setting: null },
    { facility: 'LONESTAR MENTAL HEALTH LLC', facility_name: 'LSMH', care_setting: 'IP' },
  ]);
  assert.equal(groups[0]!.badge, 'IP', 'first NON-NULL setting wins, not a null from spelling #1');
  assert.deepEqual(facilityPickerOptionsFrom(LIVE).map((o) => o.badge), ['IP', 'OP', null]);
});

// ── 4. The expansion cannot silently widen ──────────────────────────────────────────────────────
test('an unknown key falls back to itself rather than being dropped', () => {
  // Dropping it would WIDEN the grid: a chip naming a facility while the results ignore it. This
  // also keeps a summary DRILL chip working — those carry a RAW facility text, not a curated key.
  const groups = facilityGroupsFrom(LIVE);
  assert.deepEqual(expandFacilityKeys(['LONESTAR MENTAL HEALTH'], groups), ['LONESTAR MENTAL HEALTH']);
  assert.deepEqual(expandFacilityKeys([], groups), [], 'no keys, no predicate');
});
