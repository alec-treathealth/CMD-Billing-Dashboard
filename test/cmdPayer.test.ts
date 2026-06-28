import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLineFields } from '../src/collections/cmdPayer.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';

/**
 * REGRESSION GUARD for the payer-rollup facility fallback.
 *
 * cmdPayer.ts powers the ALREADY-SHIPPED payer rollup (collections.cmd_payer_facility_monthly),
 * which pulls a DIFFERENT CMD report (report 10091729 / filter 10147241) than the
 * Collections Explorer. That payer report emits the older 'Facility Name/ID' header, so
 * FACILITY_KEYS MUST keep 'Facility Name/ID' as a fallback. The Explorer codebase
 * (cmdExplorer.ts / cmdExplorerSeed.ts) standardized on the bare 'Facility Name'; that
 * cleanup is Explorer-scoped and does NOT extend to this payer-rollup path.
 *
 * If someone "tidies up" by dropping the fallback from FACILITY_KEYS, facility
 * attribution on the next rollup cron silently becomes null — these tests fail first.
 */

/** A minimal payer-report row: a parseable service date (required by extractLineFields)
 *  plus a facility cell under the given header. */
function rowWithFacilityHeader(header: string, value: string): CmdReportRow {
  return {
    'Charge From Date': '03/14/2026',
    'Charge Primary Payer Name': 'Beacon Carelon',
    [header]: value,
  };
}

test('extractLineFields: FACILITY_KEYS keeps the Facility Name/ID fallback (payer rollup)', () => {
  const fields = extractLineFields(rowWithFacilityHeader('Facility Name/ID', 'Saddleback / 12'));
  assert.ok(fields, 'row with a valid date should map');
  // If the 'Facility Name/ID' fallback is removed from FACILITY_KEYS this is null.
  assert.equal(fields.facility, 'Saddleback / 12');
});

test('extractLineFields: the canonical Facility Name header still maps', () => {
  const fields = extractLineFields(rowWithFacilityHeader('Facility Name', 'Saddleback'));
  assert.ok(fields);
  assert.equal(fields.facility, 'Saddleback');
});
