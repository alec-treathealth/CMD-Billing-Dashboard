/**
 * The Collections grid's Facility cell — the migration-0086 resolution fallback.
 *
 * Locks the three claims the 2026-08-30 rulings actually made, and nothing decorative:
 *   1. a 'No Facility' charge with a MANUAL assignment shows the assigned facility AND its method
 *      (the PRIMACIO case: 71 charges a human assigned to TREAT_WA that the grid showed as
 *      'No Facility' for 25 days);
 *   2. an INFERRED method is visually distinguishable from an exact one on channels that survive
 *      greyscale — not colour alone;
 *   3. the RAW CMD value is never destroyed and never hover-only.
 *
 * renderToStaticMarkup, no jsdom: every claim here is a MARKUP claim. Nothing on this cell has an
 * effect, focus behaviour or layout dependency, so a string render is a complete proof (see
 * app/test/helpers/dom.tsx for where that stops being true).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FacilityCell, type FacilityCellRow } from '../components/dashboard/facility-cell';

const NF = 'No Facility';
const row = (over: Partial<FacilityCellRow> = {}): FacilityCellRow => ({
  facility: NF,
  facility_resolved: null,
  facility_method: null,
  ...over,
});

// ── 1. MANUAL — exact evidence ────────────────────────────────────────────────────────────────
test('a manually-assigned No-Facility charge renders the assigned facility and its method', () => {
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'TREAT_WA', facility_method: 'manual' })} fallback={NF} />,
  );
  assert.match(html, /TREAT_WA/, 'the assigned facility is the primary text');
  assert.match(html, /Manual/, 'the method is shown — an attribution without its provenance is a bare claim');
  assert.match(html, /data-resolution="exact"/, 'manual is EXACT evidence: a human ruling with an audit trail');
});

test('named (0084 pull provenance) is exact evidence too', () => {
  // 1,003 charges as of 2026-08-30. veris-data-notes.md still says "Zero today" — it was written
  // 2026-08-05 and predicted exactly this growth; the ledger is stale, not wrong.
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'CAMH', facility_method: 'named' })} fallback={NF} />,
  );
  assert.match(html, /data-resolution="exact"/);
  assert.doesNotMatch(html, /inferred/, 'exact evidence is never labelled inferred');
});

// ── 2. INFERRED — must not look like a CMD-named facility ─────────────────────────────────────
for (const method of ['member_inference', 'vob', 'tie_break'] as const) {
  test(`${method} renders in the INFERRED style, distinguishable without colour`, () => {
    const html = renderToStaticMarkup(
      <FacilityCell row={row({ facility_resolved: 'TREAT_TN', facility_method: method })} fallback={NF} />,
    );
    assert.match(html, /data-resolution="inferred"/);
    // Channel 1: border STYLE. Survives greyscale, colour-blindness and forced-colours mode, none
    // of which a colour swap does. WCAG 1.4.1 — never encode meaning in colour alone.
    assert.match(html, /border-dashed/, 'inferred carries a dashed border, not just a different hue');
    // Channel 2: the literal word, so the distinction is legible to someone who cannot see either.
    assert.match(html, /inferred/, 'the badge says so in words');
    // And it must NOT wear the exact-evidence pill.
    assert.doesNotMatch(html, /bg-teal50/, 'an inference must never render as a CMD-named facility does');
  });
}

test('exact and inferred do not produce the same markup', () => {
  const exact = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'TREAT_TN', facility_method: 'manual' })} fallback={NF} />,
  );
  const inferred = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'TREAT_TN', facility_method: 'tie_break' })} fallback={NF} />,
  );
  // Same facility, same cell, different evidence — the whole ruling in one assertion.
  assert.notEqual(exact, inferred);
});

// ── 3. THE RAW CMD VALUE SURVIVES ─────────────────────────────────────────────────────────────
test('the raw CMD value stays reachable, and not only on hover', () => {
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'TREAT_WA', facility_method: 'manual' })} fallback={NF} />,
  );
  assert.match(html, /title="[^"]*No Facility/, 'hover discloses what CMD actually sent');
  // `title` is invisible to keyboard and screen-reader users. If this ever becomes the only
  // disclosure, the cell is asserting an attribution with no way to check it.
  assert.match(html, /class="sr-only"/, 'and it is disclosed to assistive tech, not hover-only');
});

// ── FALL-THROUGH — the cases that must NOT change ─────────────────────────────────────────────
test('an unattributed placeholder still shows No Facility', () => {
  // 6,064 charges as of 2026-08-30. 0086 covers them; it just could not resolve them.
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: null, facility_method: 'unresolved' })} fallback={NF} />,
  );
  assert.equal(html, NF, 'no pill, no badge — the raw value, untouched');
});

test('a CMD-named facility is untouched — 0086 never covers it', () => {
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility: 'NASHVILLE MENTAL HEALTH LLC' })} fallback="NASHVILLE MENTAL HEALTH LLC" />,
  );
  assert.equal(html, 'NASHVILLE MENTAL HEALTH LLC');
});

test('a resolved facility with a method we do not recognise fails CLOSED to the raw value', () => {
  // A seventh method added to 0086 without being classified must never be presented as evidence.
  const html = renderToStaticMarkup(
    <FacilityCell row={row({ facility_resolved: 'TREAT_WA', facility_method: 'brand_new_method' })} fallback={NF} />,
  );
  assert.equal(html, NF);
});
