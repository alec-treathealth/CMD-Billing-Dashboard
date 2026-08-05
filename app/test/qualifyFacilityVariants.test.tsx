/**
 * The facility-spelling indexes decide how WIDE a Qualify facility search scopes, and every failure
 * mode here is silent — the screen shows a facility name either way, just over fewer charge lines.
 * These are the live numbers: LSMH carries two spellings, `LONESTAR MENTAL HEALTH` (4,156 lines) and
 * `LONESTAR MENTAL HEALTH LLC` (81), and the canonical value is the former.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalFacilityValue,
  expandFacilitySelection,
  indexFacilityCanonical,
  indexFacilityVariants,
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
