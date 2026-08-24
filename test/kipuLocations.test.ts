/**
 * The Kipu location registry: exact-match mapping, the N:1 telehealth rollup, the
 * fail-loud gate, and the null-facility exclusion.
 *
 * The labels asserted here were MEASURED against the nine-export corpus on 2026-08-24
 * (18,434 session rows). They are not guesses, and a change to one is a change to real
 * data — re-probe before editing.
 *
 * No DB, no network, no PHI: these are session-container labels, not patient data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIPU_LOCATIONS,
  KIPU_FACILITY_CODES,
  locationFor,
  labelsForFacility,
  assertKnownLabels,
} from '../src/kipu/locations.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

/** Every label observed in the corpus. Two exports carry two labels each. */
const OBSERVED = [
  'Treat California',
  'Telehealth MH CO Group Sessions',
  'Group Session NV',
  'Group Session TN',
  'Telehealth MH TN Group Sessions',
  'TX Group Session',
  'Scott & Jenny Group Session TX',
  'Telehealth MH TX Group Sessions',
  'Group Session VA',
  'Group Session 1',
  'Treat Mental Health Washington',
] as const;

test('every observed corpus label resolves', () => {
  for (const label of OBSERVED) {
    assert.ok(locationFor(label), `unmapped: ${label}`);
  }
  assert.equal(KIPU_LOCATIONS.length, OBSERVED.length);
});

test('the registry maps labels to the CMD codes Alec ratified', () => {
  const code = (l: string) => locationFor(l)?.facilityCode;
  assert.equal(code('Treat California'), 'TREAT_CA');
  assert.equal(code('Group Session NV'), 'TREAT_NV');
  assert.equal(code('Treat Mental Health Washington'), 'TREAT_WA');
  assert.equal(code('Group Session TN'), 'TREAT_TN');
  assert.equal(code('TX Group Session'), 'TREAT_TX');
  assert.equal(code('Scott & Jenny Group Session TX'), 'TREAT_TX');
});

test('N:1 — every Telehealth MH state rolls up to the ONE CMD account, never a state code', () => {
  for (const label of ['Telehealth MH TX Group Sessions', 'Telehealth MH TN Group Sessions', 'Telehealth MH CO Group Sessions']) {
    assert.equal(locationFor(label)?.facilityCode, 'TELEHEALTH_MH', label);
  }
  // The reconciliation MUST sum over all three, so the reverse lookup has to return them all.
  const labels = labelsForFacility('TELEHEALTH_MH');
  assert.equal(labels.length, 3);
  assert.ok(labels.includes('Telehealth MH CO Group Sessions'));
});

test('Colorado telehealth is TELEHEALTH_MH, NOT TREAT_CO (10035974 is not yet open)', () => {
  const co = locationFor('Telehealth MH CO Group Sessions');
  assert.equal(co?.facilityCode, 'TELEHEALTH_MH');
  assert.notEqual(co?.facilityCode, 'TREAT_CO');
  assert.equal(co?.state, 'CO');
});

test('both Texas labels sum into one customer', () => {
  const labels = labelsForFacility('TREAT_TX');
  assert.equal(labels.length, 2);
  assert.ok(labels.includes('TX Group Session'));
  assert.ok(labels.includes('Scott & Jenny Group Session TX'));
});

test('Virginia has NO CMD facility and is therefore excluded from reconciliation', () => {
  for (const label of ['Group Session VA', 'Group Session 1']) {
    const loc = locationFor(label);
    assert.equal(loc?.facilityCode, null, label);
    assert.equal(loc?.state, 'VA', label);
  }
  // Excluded, not silently attributed: no reconcilable code may be a Virginia label's.
  assert.ok(!KIPU_FACILITY_CODES.includes('TREAT_VA'));
  assert.equal(labelsForFacility('TREAT_VA').length, 0);
});

test('the reconcilable code set is exactly the six live CMD customers', () => {
  assert.deepEqual([...KIPU_FACILITY_CODES], [
    'TELEHEALTH_MH',
    'TREAT_CA',
    'TREAT_NV',
    'TREAT_TN',
    'TREAT_TX',
    'TREAT_WA',
  ]);
});

test('every location states an explicit IANA zone — the corpus spans four of them', () => {
  const zones = new Map<string, string>();
  for (const l of KIPU_LOCATIONS) {
    assert.match(l.iana, /^America\/(Los_Angeles|Denver|Chicago|New_York)$/, l.label);
    assert.ok(l.state.length === 2, l.label);
    assert.equal(l.businessEntityId, BXR_ENTITY_ID, l.label);
    zones.set(l.zoneLabel, l.iana);
  }
  assert.equal(zones.size, 4, 'expected Pacific, Mountain, Central and Eastern all present');
  assert.equal(zones.get('Mountain'), 'America/Denver');
  assert.equal(zones.get('Central'), 'America/Chicago');
});

test('zones are per LOCATION, not per state name — TN telehealth and TN in-person agree, CO differs', () => {
  assert.equal(locationFor('Group Session TN')?.iana, 'America/Chicago');
  assert.equal(locationFor('Telehealth MH TN Group Sessions')?.iana, 'America/Chicago');
  // CO is the one that disagrees with Kipu's own declared zone (Kipu says Eastern).
  assert.equal(locationFor('Telehealth MH CO Group Sessions')?.zoneLabel, 'Mountain');
});

test('assertKnownLabels passes the whole corpus and is a no-op on empty input', () => {
  assert.doesNotThrow(() => assertKnownLabels(OBSERVED));
  assert.doesNotThrow(() => assertKnownLabels([]));
  assert.doesNotThrow(() => assertKnownLabels(['', '  ']));
});

test('assertKnownLabels THROWS on an unmapped label and names every one at once', () => {
  assert.throws(
    () => assertKnownLabels(['TX Group Session', 'Telehealth MH AZ Group Sessions', 'Group Session 2']),
    (err: unknown) => {
      const m = err instanceof Error ? err.message : '';
      assert.match(m, /Group Session 2/);
      assert.match(m, /Telehealth MH AZ Group Sessions/);
      assert.ok(!/TX Group Session/.test(m), 'a mapped label must not be reported unknown');
      assert.match(m, /Refusing to infer/);
      return true;
    },
  );
});

test('lookup is exact — a near-miss does not resolve to its neighbour', () => {
  assert.equal(locationFor('Telehealth MH TX'), undefined); // the STRIPPED form is not the label
  assert.equal(locationFor('TX Group Sessions'), undefined); // plural
  assert.equal(locationFor('Treat Texas'), undefined); // the display name
  // whitespace is the one tolerated difference
  assert.ok(locationFor('  TX Group Session  '));
});

test('no duplicate labels — a duplicate would make the map silently drop one', () => {
  const labels = KIPU_LOCATIONS.map((l) => l.label);
  assert.equal(new Set(labels).size, labels.length);
});
