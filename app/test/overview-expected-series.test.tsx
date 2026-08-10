/**
 * The Master BXR Chart's EXPECTED-payment series (app/components/dashboard/overview-bar-chart).
 *
 * WHY THIS SERIES EXISTS. A check can physically arrive days before CollaborateMD logs it, so
 * the collections feed shows nothing while the money is provably in hand. A super admin keys
 * it as a forecast row; this series is what puts that row on the chart immediately instead of
 * after the next hourly CMD pull.
 *
 * WHAT THESE LOCK — all four are ways the feature could quietly corrupt a collected figure:
 *   1) `gross` NEVER absorbs expected money. Every existing total, tooltip, sort and CSV that
 *      reads gross keeps meaning exactly "what CMD confirmed was collected".
 *   2) A facility with expected money and NO collected row still appears. That is the entire
 *      use case — an early check at a facility CMD has logged nothing for this month.
 *   3) Cents-to-dollars conversion is exact, because the source is integer cents and the chart
 *      is dollars, and this is the one boundary where a float could drift.
 *   4) An empty forecast produces byte-identical rows to the pre-feature behaviour.
 *
 * ⚠️ THE ARCHITECTURAL CONSTRAINT THIS FEATURE IS SHAPED BY, restated so nobody "simplifies" it
 * later: a manual expected payment must NEVER be written into collections.daily_collections.
 * That table is read through daily_collections_resolved, which is MAX-GROSS-WINS per
 * (entity, facility, payment_date) — not SUM. A forecast row there would either be silently
 * discarded or REPLACE the real CMD deposit for that facility-day. Reading it live from
 * staging and stacking it as a separate labelled series is the only form of this that cannot
 * destroy a collected number.
 *
 * Pure function under test; no DB, no network, no clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeExpectedIntoFacilityRows } from '../lib/forecast/chart-series';

/** One collected-only facility row, in the shape the chart builds from collections. */
const row = (
  facility_code: string,
  gross: number,
  over: Partial<{ checks: number; eft: number; facility: string }> = {},
) => ({
  facility: over.facility ?? facility_code,
  facility_code,
  blank: false,
  gross,
  checks: over.checks ?? gross,
  eft: over.eft ?? 0,
  expected: 0,
});

test('expected money is added as its own field and NEVER folded into gross', () => {
  const out = mergeExpectedIntoFacilityRows(
    [row('KWC', 77025.68), row('CAMH', 176150.03)],
    new Map([['KWC', 3200000]]), // $32,000.00 in integer cents
  );
  const kwc = out.find((r) => r.facility_code === 'KWC');
  assert.equal(kwc?.expected, 32000, 'cents converted to dollars exactly');
  assert.equal(kwc?.gross, 77025.68, 'GROSS IS UNTOUCHED — it still means "CMD confirmed"');
  assert.equal(kwc?.checks, 77025.68, 'and the payment-type split is untouched too');
  const camh = out.find((r) => r.facility_code === 'CAMH');
  assert.equal(camh?.expected, 0, 'a facility with no forecast gets a zero, not a guess');
  assert.equal(camh?.gross, 176150.03);
});

test('a facility with ONLY expected money still gets a bar — the whole point of the feature', () => {
  // An early check at a facility CMD has logged nothing for this month. An inner join would
  // hide exactly the row the operator added the payment in order to see.
  const out = mergeExpectedIntoFacilityRows([row('KWC', 100)], new Map([['LSMH', 4200050]]));
  const lsmh = out.find((r) => r.facility_code === 'LSMH');
  assert.ok(lsmh, 'the forecast-only facility is present');
  assert.equal(lsmh?.expected, 42000.5, 'exact to the cent');
  assert.equal(lsmh?.gross, 0, 'with no collected money claimed on its behalf');
  assert.equal(lsmh?.checks, 0);
  assert.equal(lsmh?.eft, 0);
});

test('a forecast-only facility is labelled through the dimension, falling back to its code', () => {
  const labelled = mergeExpectedIntoFacilityRows([], new Map([['LSMH', 1000]]), (c) =>
    c === 'LSMH' ? 'LoneStar' : null,
  );
  assert.equal(labelled[0]?.facility, 'LoneStar', 'matches its neighbours on the axis');

  const unlabelled = mergeExpectedIntoFacilityRows([], new Map([['LSMH', 1000]]));
  assert.equal(unlabelled[0]?.facility, 'LSMH', 'a bare code beats a blank axis label');
});

test('an empty forecast leaves the rows exactly as they were', () => {
  // The no-regression guard. A book with no forecast rows must render the chart it rendered
  // before this feature existed — same values, same order, no zero-height segment.
  const base = [row('KWC', 500), row('CAMH', 900)];
  const out = mergeExpectedIntoFacilityRows(base, new Map());
  assert.deepEqual(
    out.map((r) => [r.facility_code, r.gross, r.expected]),
    [
      ['CAMH', 900, 0],
      ['KWC', 500, 0],
    ],
    'descending by total, expected uniformly zero',
  );
});

test('a zero-cent forecast entry does not conjure a phantom facility', () => {
  const out = mergeExpectedIntoFacilityRows([row('KWC', 500)], new Map([['LSMH', 0]]));
  assert.equal(out.length, 1, 'no bar for a facility expecting nothing');
  assert.equal(out[0]?.facility_code, 'KWC');
});

test('ordering follows collected + expected, so an all-forecast facility is not buried', () => {
  const out = mergeExpectedIntoFacilityRows(
    [row('KWC', 1000), row('CAMH', 5000)],
    new Map([['LSMH', 900000]]), // $9,000 — more than either collected total
  );
  assert.deepEqual(
    out.map((r) => r.facility_code),
    ['LSMH', 'CAMH', 'KWC'],
  );
});

test('the unassigned bucket (null facility_code) can never receive expected money', () => {
  // Forecast rows are keyed by a real facility_code the roster validated on write, so there is
  // no such thing as unassigned expected money. Attributing any to the null bucket would put
  // an operator's payment under "(unassigned)" where no one would look for it.
  const out = mergeExpectedIntoFacilityRows(
    [{ facility: '(unassigned)', facility_code: null, blank: true, gross: 10, checks: 10, eft: 0, expected: 0 }],
    new Map([['KWC', 5000]]),
  );
  const unassigned = out.find((r) => r.facility_code === null);
  assert.equal(unassigned?.expected, 0);
  assert.equal(out.find((r) => r.facility_code === 'KWC')?.expected, 50);
});
