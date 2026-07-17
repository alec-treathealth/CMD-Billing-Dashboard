/**
 * Qualify — RENDERED-HTML tests (DoD, Prompt 3). Unlike the wire-level tests from Prompt 2, these
 * render the actual components to markup and assert on the real HTML:
 *   1) amounts capability gates every dollar element via DOM OMISSION (the $ header + cells are
 *      ABSENT from the markup when !hasAmounts — not merely CSS-hidden), and
 *   2) color derives from RATING, not raw pct: a 90%-on-n=1 facility is 'warn' (not green), and a
 *      case inherits its PARENT FACILITY's bucket (not its own high pct).
 *
 * Runs under app/ (where react-dom resolves) via `npm test`. Imports the presentational leaves by
 * relative path; they use only relative/type-only imports, so no `@/` alias resolution is needed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FacilityPanel } from '../components/qualify/facility-panel';
import { CasesTable } from '../components/qualify/cases-table';
import { buildFacilityBucketMap } from '../components/qualify/colors';
import { qualifyRating, ratingBucket } from '../lib/qualify/rating';
import type { QualifyFacility, QualifyCase } from '../lib/qualify/contract';

const solidRating = qualifyRating(55, 400)!; // ≈52 → ok
const thinHighRating = qualifyRating(90, 1)!; // ≈31.7 → warn (dampened; a 90% pct is NOT green on n=1)

const SOLID: QualifyFacility = {
  rank: 1, name: 'SOLID', city: 'Boulder', state: 'CO',
  pctAllowedOfBilled: 55, rating: solidRating, streakSignal: null,
  billedAmount: 308900, allowedAmount: 166800, lineCount: 400,
};
const THIN_HIGH: QualifyFacility = {
  rank: 2, name: 'THIN HIGH', city: 'Reno', state: 'NV',
  pctAllowedOfBilled: 90, rating: thinHighRating, streakSignal: null,
  billedAmount: 412300, allowedAmount: 251500, lineCount: 1,
};
const FACILITIES = [SOLID, THIN_HIGH];

// A case at the THIN HIGH facility whose OWN pct is a rosy 95% — it must still color 'warn' from the
// parent facility's dampened rating, proving the case color is NOT the case's own raw pct.
const CASE_AT_THIN: QualifyCase = {
  id: 1, memberIdMasked: '••••••', facilityName: 'THIN HIGH', program: 'OP',
  lastDos: '2026-07-15', pctAllowedOfBilled: 95, billedAmount: 18400, allowedAmount: 11592,
};

test('sanity: the dampened rating buckets are what these tests assume', () => {
  assert.equal(ratingBucket(solidRating), 'ok');
  assert.equal(ratingBucket(thinHighRating), 'warn');
});

test('facility panel — NO amounts: zero dollar elements in the markup (DOM omission, not CSS-hide)', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn />);
  assert.ok(!html.includes('$'), 'a no-amounts facility panel must contain no "$"');
  for (const v of ['251,500', '412,300', '166,800', '308,900']) {
    assert.ok(!html.includes(v), `dollar value ${v} must be ABSENT from the markup`);
  }
});

test('facility panel — WITH amounts: the $allowed / $billed line is present', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts heatOn />);
  assert.ok(html.includes('$251,500') && html.includes('$412,300'), 'amounts viewer sees the dollars');
});

test('cases table — NO amounts: Billed/Allowed columns are ABSENT (header + cells)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} />,
  );
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ column headers when !hasAmounts');
  assert.ok(!html.includes('$'), 'no "$" anywhere in a no-amounts cases table');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('cases table — WITH amounts: Billed/Allowed columns + values are present', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} />,
  );
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'headers present for an amounts viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'values present for an amounts viewer');
});

test('facility color derives from RATING, not raw pct: a 90%-on-n=1 row is warn, not green', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={[THIN_HIGH]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-warn'), 'the 90%/n=1 row is colored warn by its dampened rating');
  // Legend dots always include q-ok/q-warn/q-danger, so scope the negative to ROW classes only.
  assert.ok(!html.includes('q-fac q-ok'), 'no facility ROW is green — 90% pct did not earn it on n=1');
});

test('case % cell is tinted by the PARENT FACILITY rating, not the case’s own pct', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} />,
  );
  assert.ok(html.includes('q-pctcell q-warn'), "case inherits the facility's warn bucket");
  assert.ok(!html.includes('q-pctcell q-ok'), 'the case’s own 95% pct did NOT color it green');
});
