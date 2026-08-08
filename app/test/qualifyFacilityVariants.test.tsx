/**
 * The facility-spelling indexes decide how WIDE a Qualify facility search scopes, and every failure
 * mode here is silent — the screen shows a facility name either way, just over fewer charge lines.
 * These are the live numbers: LSMH carries two spellings, `LONESTAR MENTAL HEALTH` (4,156 lines) and
 * `LONESTAR MENTAL HEALTH LLC` (81), and the canonical value is the former.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  andList,
  canonicalFacilityValue,
  expandFacilitySelection,
  facilitiesElsewhere,
  facilityDisplayNames,
  facilityNarrowKeys,
  indexFacilityCanonical,
  indexFacilityVariants,
  narrowByFacility,
  offerableFacilityOptions,
} from '@/lib/qualify/facilityVariants';

const LSMH = { value: 'LONESTAR MENTAL HEALTH', variants: ['LONESTAR MENTAL HEALTH', 'LONESTAR MENTAL HEALTH LLC'] };
const NASH = { value: 'NASHVILLE MENTAL HEALTH LLC', variants: ['NASHVILLE MENTAL HEALTH LLC'] };
const NO_FACILITY = { value: 'No Facility', variants: ['No Facility'] };
const OPTIONS = [LSMH, NASH, NO_FACILITY];

test('variants index is keyed by EVERY spelling, not just the canonical one', () => {
  const idx = indexFacilityVariants(OPTIONS);
  // The canonical key resolves...
  assert.deepEqual(idx['LONESTAR MENTAL HEALTH'], LSMH.variants);
  // ...and so does the NON-canonical one. This is the whole point: a ticker-card click stores the raw
  // trend `facilityKey`, and a canonical-only map would miss it and scope the search to 81 lines.
  assert.deepEqual(idx['LONESTAR MENTAL HEALTH LLC'], LSMH.variants);
  assert.deepEqual(idx['NASHVILLE MENTAL HEALTH LLC'], NASH.variants);
});

test('expansion: EITHER spelling scopes to BOTH — 4,237 lines, never 4,156 or 81', () => {
  const idx = indexFacilityVariants(OPTIONS);
  assert.deepEqual(expandFacilitySelection(['LONESTAR MENTAL HEALTH'], idx), LSMH.variants);
  assert.deepEqual(expandFacilitySelection(['LONESTAR MENTAL HEALTH LLC'], idx), LSMH.variants);
});

test('expansion: a single-spelling facility is unchanged, and multiple picks concatenate', () => {
  const idx = indexFacilityVariants(OPTIONS);
  assert.deepEqual(expandFacilitySelection(['NASHVILLE MENTAL HEALTH LLC'], idx), ['NASHVILLE MENTAL HEALTH LLC']);
  assert.deepEqual(expandFacilitySelection(['NASHVILLE MENTAL HEALTH LLC', 'LONESTAR MENTAL HEALTH'], idx), [
    'NASHVILLE MENTAL HEALTH LLC',
    'LONESTAR MENTAL HEALTH',
    'LONESTAR MENTAL HEALTH LLC',
  ]);
  assert.deepEqual(expandFacilitySelection([], idx), []);
});

test('expansion: an UNKNOWN value expands to itself — never to nothing', () => {
  // Reachable on first paint: a URL-restored facility before the option list has loaded. Expanding to
  // [] would turn a restored filter into "no facility restriction", i.e. silently widen the search to
  // the whole book. Expanding to itself keeps the previous (correct, if narrow) behaviour.
  const idx = indexFacilityVariants(OPTIONS);
  assert.deepEqual(expandFacilitySelection(['SOMETHING NOT YET LOADED'], idx), ['SOMETHING NOT YET LOADED']);
  assert.deepEqual(expandFacilitySelection(['LONESTAR MENTAL HEALTH'], {}), ['LONESTAR MENTAL HEALTH']);
});

test('canonical index maps every spelling to the picker value the chip can match', () => {
  const idx = indexFacilityCanonical(OPTIONS);
  assert.equal(idx['LONESTAR MENTAL HEALTH LLC'], 'LONESTAR MENTAL HEALTH');
  assert.equal(idx['LONESTAR MENTAL HEALTH'], 'LONESTAR MENTAL HEALTH');
  assert.equal(canonicalFacilityValue('LONESTAR MENTAL HEALTH LLC', idx), 'LONESTAR MENTAL HEALTH');
  // Unknown passes through: an unresolved bucket is still a real selection.
  assert.equal(canonicalFacilityValue('No Facility', idx), 'No Facility');
  assert.equal(canonicalFacilityValue('NOT LOADED', idx), 'NOT LOADED');
  assert.equal(canonicalFacilityValue('anything', {}), 'anything');
});

test('canonicalize-then-expand is the ticker-click path, and it covers the whole facility', () => {
  // The exact sequence openTrendCard runs: a trend row spelled with the NON-canonical text becomes
  // the canonical selection value (so the chip matches an option), which then expands to every
  // spelling (so the filter covers the facility).
  const variants = indexFacilityVariants(OPTIONS);
  const canonical = indexFacilityCanonical(OPTIONS);
  const trendFacilityKey = 'LONESTAR MENTAL HEALTH LLC';
  const selected = canonicalFacilityValue(trendFacilityKey, canonical);
  assert.equal(selected, 'LONESTAR MENTAL HEALTH', 'stored value is in the picker vocabulary');
  assert.deepEqual(expandFacilitySelection([selected], variants), LSMH.variants, 'filter covers both spellings');
});

test('an option with an empty variants array degrades to its own value', () => {
  // Belt-and-braces: the server always returns at least the grouped row, but a null array would
  // otherwise drop the facility out of the filter entirely rather than out of the list.
  const odd = [{ value: 'SOLO FACILITY', variants: [] as string[] }];
  assert.deepEqual(indexFacilityVariants(odd)['SOLO FACILITY'], ['SOLO FACILITY']);
  assert.equal(indexFacilityCanonical(odd)['SOLO FACILITY'], 'SOLO FACILITY');
  assert.deepEqual(expandFacilitySelection(['SOLO FACILITY'], indexFacilityVariants(odd)), ['SOLO FACILITY']);
});

// ── S4 — THE GRID NARROW BUILT ON THESE INDEXES (2026-08-08) ─────────────────────────────────────
//
// The facility narrow restored beside the AREA row is a DISPLAY narrow over rows the ranking already
// returned, so everything below is a set operation on `facilityKey` — the RAW rollup text, the same
// grain these indexes are keyed by. Nothing here reaches a request; see flow-state invariant (m).

const NARROW_OPTIONS = [
  { ...LSMH, display: 'LSMH', careSetting: 'IP' as const },
  { ...NASH, display: 'NASH', careSetting: null },
  { ...NO_FACILITY, display: 'No Facility', careSetting: null },
];

const row = (facilityKey: string, name: string) => ({ facilityKey, name });

test('S4 — the narrow key set is EVERY spelling of every pick; an empty pick is NULL, never an empty Set', () => {
  // ⚠ NULL vs `new Set()` IS THE WHOLE CONTRACT. An empty Set filters everything OUT — the
  // `= any(ARRAY[])` mistake in set form. The repo's standing rule is that an empty selection is NO
  // restriction, so "no narrow" gets its own value that the filter passes through untouched.
  assert.equal(facilityNarrowKeys([], NARROW_OPTIONS), null);
  const keys = facilityNarrowKeys(['LONESTAR MENTAL HEALTH'], NARROW_OPTIONS);
  assert.deepEqual([...(keys ?? [])].sort(), ['LONESTAR MENTAL HEALTH', 'LONESTAR MENTAL HEALTH LLC']);
  // The non-canonical spelling picks the same facility — the 81-lines-vs-4,237 trap, in set form.
  assert.deepEqual([...(facilityNarrowKeys(['LONESTAR MENTAL HEALTH LLC'], NARROW_OPTIONS) ?? [])].sort(), [
    'LONESTAR MENTAL HEALTH',
    'LONESTAR MENTAL HEALTH LLC',
  ]);
  // An unknown value narrows to exactly itself rather than to nothing (the expansion rule above).
  assert.deepEqual([...(facilityNarrowKeys(['NOT LOADED'], NARROW_OPTIONS) ?? [])], ['NOT LOADED']);
});

test('S4 — narrowByFacility passes the SAME array through when nothing is picked, and filters on RAW text', () => {
  const rows = [row('LONESTAR MENTAL HEALTH LLC', 'LSMH'), row('NASHVILLE MENTAL HEALTH LLC', 'NASH')];
  // IDENTITY, not a copy: this feeds a useMemo chain, and a fresh-but-equal array on the no-narrow
  // path would invalidate every downstream memo on every render (the NO_ANSWER_FILTERS lesson).
  assert.equal(narrowByFacility(rows, null), rows);
  const keys = facilityNarrowKeys(['LONESTAR MENTAL HEALTH'], NARROW_OPTIONS);
  assert.deepEqual(narrowByFacility(rows, keys).map((r) => r.name), ['LSMH']);
  // AND semantics against a second narrow are the CALLER's composition — this one is total on its own.
  assert.deepEqual(narrowByFacility([], keys), []);
});

test('S4 — facilitiesElsewhere names the EXCLUDED rows, de-duplicated, with the placeholder removed', () => {
  // ⚠ TWO SPELLINGS OF ONE FACILITY RESOLVE TO ONE `name`, so an un-deduped list says "billed at
  // LSMH and LSMH". And `No Facility` is not a PLACE — "this member billed at No Facility" is the
  // exact fabricated-place claim S3 suppressed the history annotation for.
  const rows = [
    row('LONESTAR MENTAL HEALTH', 'LSMH'),
    row('LONESTAR MENTAL HEALTH LLC', 'LSMH'),
    row('NASHVILLE MENTAL HEALTH LLC', 'NASH'),
    row('No Facility', 'No Facility'),
  ];
  const keys = facilityNarrowKeys(['NASHVILLE MENTAL HEALTH LLC'], NARROW_OPTIONS);
  assert.deepEqual(facilitiesElsewhere(rows, keys ?? new Set()), ['LSMH']);
  // Nothing but the placeholder left ⇒ nothing to name, and the caller must not claim a place.
  assert.deepEqual(facilitiesElsewhere([row('No Facility', 'No Facility')], new Set(['NASHVILLE MENTAL HEALTH LLC'])), []);
});

test('S4 — offerableFacilityOptions drops the placeholder: you cannot send someone to “No Facility”', () => {
  // It stays a real ranked ROW everywhere (dropping it would hide $29,081,575.38 of charges) — it is
  // only un-OFFERABLE, because picking it asks a question about a place that does not exist.
  assert.deepEqual(offerableFacilityOptions(NARROW_OPTIONS).map((o) => o.value), [
    'LONESTAR MENTAL HEALTH',
    'NASHVILLE MENTAL HEALTH LLC',
  ]);
  assert.equal(offerableFacilityOptions([]).length, 0);
});

test('S4 — facilityDisplayNames labels the picks; an unknown value wears itself', () => {
  assert.deepEqual(facilityDisplayNames(['LONESTAR MENTAL HEALTH'], NARROW_OPTIONS), ['LSMH']);
  assert.deepEqual(facilityDisplayNames(['LONESTAR MENTAL HEALTH LLC'], NARROW_OPTIONS), ['LSMH'], 'any spelling');
  assert.deepEqual(facilityDisplayNames(['NOT LOADED'], NARROW_OPTIONS), ['NOT LOADED']);
  assert.deepEqual(facilityDisplayNames([], NARROW_OPTIONS), []);
});

test('S4 — andList reads as English at one, two and three; empty is the empty string', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['A']), 'A');
  assert.equal(andList(['A', 'B']), 'A and B');
  assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
});
