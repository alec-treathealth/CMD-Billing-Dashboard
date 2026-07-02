import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdRunReportToZip, extractLineFields } from '../src/collections/cmdPayer.js';
import type { CmdApiConfig, CmdReportRow } from '../src/collections/cmdPayer.js';

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

/**
 * POLL-RACE GUARD (the 2026-07-02 incident): CMD returns `Status: SUCCESS` with no `Data`
 * BOTH transiently (report accepted, CSV not materialized yet) AND permanently (empty window).
 * cmdRunReportToZip must ride out the transient form and only conclude "empty" after the grace.
 * A fake fetch scripts the run step (returns an Identifier) then a queue of results-step bodies.
 */
function fakeCmd(resultsQueue: Array<Record<string, unknown>>, overrides: Partial<CmdApiConfig> = {}): CmdApiConfig {
  let i = 0;
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('/run')) return { ok: true, json: async () => ({ Status: 'SUCCESS', Identifier: 999 }) };
    const body = resultsQueue[Math.min(i, resultsQueue.length - 1)]!; // last entry repeats
    i += 1;
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  return {
    baseUrl: 'https://cmd.test', customerId: '1', reportId: 'r', filterId: 'f',
    auth: { kind: 'basic', username: 'u', password: 'p' },
    fetchImpl, pollIntervalMs: 0, maxPollAttempts: 8, emptyGraceAttempts: 4, ...overrides,
  };
}
const SUCCESS_EMPTY = { Status: 'SUCCESS' }; // SUCCESS with no Data field
const RUNNING = { Status: 'REPORT RUNNING' };
const WITH_DATA = { Status: 'SUCCESS', Data: 'QUJD' }; // base64('ABC') → non-empty zip bytes

test('cmdRunReportToZip: rides out transient SUCCESS-empty and returns the data', async () => {
  // Two poll-1/2 SUCCESS-empty "not ready" responses, then the data — must NOT abort early.
  const zip = await cmdRunReportToZip(fakeCmd([SUCCESS_EMPTY, SUCCESS_EMPTY, WITH_DATA]));
  assert.ok(Buffer.isBuffer(zip));
  assert.equal(zip!.toString('utf8'), 'ABC');
});

test('cmdRunReportToZip: genuinely empty (SUCCESS-empty past the grace) returns null, not a throw', async () => {
  const zip = await cmdRunReportToZip(fakeCmd([SUCCESS_EMPTY], { emptyGraceAttempts: 3 }));
  assert.equal(zip, null); // 3 consecutive empties → concluded empty, non-fatal
});

test('cmdRunReportToZip: a RUNNING poll resets the empty streak so a busy report still resolves', async () => {
  // Max 2 consecutive empties (RUNNING breaks the run) with grace=3 ⇒ never prematurely "empty".
  const zip = await cmdRunReportToZip(
    fakeCmd([SUCCESS_EMPTY, SUCCESS_EMPTY, RUNNING, SUCCESS_EMPTY, SUCCESS_EMPTY, WITH_DATA], { emptyGraceAttempts: 3 }),
  );
  assert.ok(Buffer.isBuffer(zip));
});
