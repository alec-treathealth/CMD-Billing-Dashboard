/**
 * THE COLLECTIONS FACILITY PICKER'S LABELS (2026-08-10).
 *
 * Two raw CMD spellings of one facility resolve to the same curated name and the same IP badge, so
 * the dropdown rendered the same row twice while the two options scoped to 4,195 and 81 charge
 * lines. `facilityPickerOptionsFrom` appends the raw text to exactly the labels that collide.
 *
 * ⚠ THE FIXTURE IS REAL. `LONESTAR MENTAL HEALTH` / `LONESTAR MENTAL HEALTH LLC` → LSMH / IP is live
 * production data, reproducible from the picker's own query. Do not "simplify" it to FOO/BAR — the
 * bug was invisible precisely because the two labels were plausible, and a synthetic fixture would
 * not have caught that the curated name is byte-identical to ONE of the raw spellings.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  facilityPickerOptionsFrom,
  FACILITY_DISAMBIGUATOR,
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

const byValue = (opts: ReturnType<typeof facilityPickerOptionsFrom>, v: string) => {
  const o = opts.find((x) => x.value === v);
  assert.ok(o, `no option for ${v}`);
  return o;
};

// ── 1. The collision is legible ─────────────────────────────────────────────────────────────────
test('the two Lonestar options no longer render identically', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  const bare = byValue(opts, 'LONESTAR MENTAL HEALTH');
  const llc = byValue(opts, 'LONESTAR MENTAL HEALTH LLC');
  assert.notEqual(bare.display, llc.display, 'the whole defect: same text, different data');
  assert.equal(bare.display, `LONESTAR MENTAL HEALTH LLC${FACILITY_DISAMBIGUATOR}LONESTAR MENTAL HEALTH`);
  assert.equal(llc.display, `LONESTAR MENTAL HEALTH LLC${FACILITY_DISAMBIGUATOR}LONESTAR MENTAL HEALTH LLC`);
});

// ── 2. THE BEHAVIOUR THE DIFF CHANGES THAT "displays differ" WOULD NOT CATCH ────────────────────
//
// `display` is also the type-ahead's haystack. If the separator or the appended text broke the
// substring match, the fix would trade a confusing dropdown for a facility nobody can find — a
// strictly worse outcome, and one every assertion above would still pass through.
test('typing "Lonestar" still matches BOTH options through the real pickerMatches', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  const hits = opts.filter((o) => pickerMatches(o, 'Lonestar'));
  assert.equal(hits.length, 2, 'both spellings must remain findable');
  assert.deepEqual(
    hits.map((h) => h.value).sort(),
    ['LONESTAR MENTAL HEALTH', 'LONESTAR MENTAL HEALTH LLC'],
  );
});

test('the queries an operator actually types still match', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  const count = (q: string) => opts.filter((o) => pickerMatches(o, q)).length;
  assert.equal(count('mental'), 2, 'the query from the original report');
  assert.equal(count('LONESTAR MENTAL HEALTH'), 2, 'the full curated name still matches both');
  assert.equal(count('lonestar mental health llc'), 2, 'case-insensitive, and the LLC row is not lost');
  // The appended text is what makes the narrower query selective — this is the point of the change.
  assert.equal(count('HEALTH LLC · LONESTAR MENTAL HEALTH LLC'), 1, 'the raw text disambiguates');
  assert.equal(count('nashville'), 1);
  assert.equal(count('zzz'), 0);
});

// ── 3. Nothing else moves ───────────────────────────────────────────────────────────────────────
test('an unambiguous facility keeps its curated label byte-for-byte', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  const nash = byValue(opts, 'NASHVILLE TREATMENT');
  // Its curated name differs from its raw text — live, 11 of 48 options are like this — and it must
  // NOT pick up the suffix. Only collisions do.
  assert.equal(nash.display, 'NASHVILLE TREATMENT CENTER');
  assert.doesNotMatch(nash.display, /·/);
});

test('a null facility_name can never produce "X · X"', () => {
  // Display falls back to the raw text, and raw texts are DISTINCT by construction (the query
  // selects `distinct value`), so an unresolved bucket can never collide with itself.
  const opts = facilityPickerOptionsFrom(LIVE);
  const none = byValue(opts, 'No Facility');
  assert.equal(none.display, 'No Facility');
  assert.equal(none.badge, null);
});

// ── 4. THE GRAIN IS UNCHANGED — the ruling this test exists to protect ──────────────────────────
test('every option still carries ONE raw facility text as its value', () => {
  // Collapsing to one option per facility_code with an array_agg of variants is QUALIFY's behaviour
  // and was explicitly ruled out for Collections (Alec, 2026-08-10): this is a raw-grain payment
  // search, not a facility rollup. If someone later collapses the query, the option count drops and
  // this fails — which is the intended alarm, not a nuisance.
  const opts = facilityPickerOptionsFrom(LIVE);
  assert.equal(opts.length, LIVE.length, 'one option per RAW spelling, still');
  assert.deepEqual(
    opts.map((o) => o.value),
    LIVE.map((s) => s.facility),
    'value is the raw CMD text, in input order, untouched',
  );
  for (const o of opts) {
    assert.equal(typeof o.value, 'string', 'value is a single string, never an array of variants');
  }
});

test('badges pass through untouched', () => {
  const opts = facilityPickerOptionsFrom(LIVE);
  assert.deepEqual(opts.map((o) => o.badge), ['IP', 'IP', 'OP', null]);
});

// ── 5. It generalises without a code change ─────────────────────────────────────────────────────
test('a third spelling disambiguates itself, and removing the collision reverts the labels', () => {
  const three = facilityPickerOptionsFrom([
    ...LIVE,
    { facility: 'LONESTAR MH', facility_name: 'LONESTAR MENTAL HEALTH LLC', care_setting: 'IP' },
  ]);
  const lonestar = three.filter((o) => o.display.startsWith('LONESTAR MENTAL HEALTH LLC'));
  assert.equal(lonestar.length, 3);
  assert.equal(new Set(lonestar.map((o) => o.display)).size, 3, 'all three distinct');

  // If an alias change ever leaves one spelling, the suffix disappears on its own.
  const one = facilityPickerOptionsFrom([LIVE[0]!]);
  assert.equal(one[0]!.display, 'LONESTAR MENTAL HEALTH LLC', 'clean curated label, no suffix');
});

// ── 6. searchText stays OUT ─────────────────────────────────────────────────────────────────────
test('no searchText is set — that is a separate, unapproved change', () => {
  // Making every raw CMD spelling findable is a search-behaviour change, not a display fix
  // (Alec, 2026-08-10). Pinned so it cannot arrive by accident inside a display edit.
  for (const o of facilityPickerOptionsFrom(LIVE)) {
    assert.equal(o.searchText, undefined);
  }
  // Consequence, asserted so the gap is visible rather than assumed: an unambiguous facility is
  // still NOT findable by its raw CMD text when that differs from the curated name.
  const nash = byValue(facilityPickerOptionsFrom(LIVE), 'NASHVILLE TREATMENT');
  assert.equal(pickerMatches(nash, 'NASHVILLE TREATMENT CENTER'), true);
  assert.equal(pickerMatches(nash, 'NASHVILLE TREATMENT'), true, 'substring of the curated name');
});
