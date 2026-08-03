import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdRunReportToZip, collectRowsAcrossCustomers, extractLineFields } from '../src/collections/cmdPayer.js';
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

// --- collectRowsAcrossCustomers (whole-book pull) ----------------------------
//
// GUARDS THE ALL-OR-NOTHING INVARIANT. writeRollup DELETEs per (month × tenant) across every
// facility and re-INSERTs from the tuples handed to it, so a partial book silently destroys the
// accounts that did not answer. These tests fail first if someone "improves" the loop into a
// resilient per-customer skip the way cmdExplorerCron does it — correct there, destructive here.

/** A row tagged with its source account, so concatenation order is observable. */
const taggedRow = (customerId: string): CmdReportRow => ({
  'Charge From Date': '03/14/2026',
  'Charge Primary Payer Name': 'Beacon Carelon',
  'Facility Name': customerId,
});

test('collectRowsAcrossCustomers: concatenates every account in roster order', async () => {
  const seen: string[] = [];
  const rows = await collectRowsAcrossCustomers(['10027973', '10029105', '10030471'], async (id) => {
    seen.push(id);
    return [taggedRow(id), taggedRow(id)];
  });
  assert.deepEqual(seen, ['10027973', '10029105', '10030471'], 'must pull sequentially, in roster order');
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => r['Facility Name']),
    ['10027973', '10027973', '10029105', '10029105', '10030471', '10030471'],
  );
});

test('collectRowsAcrossCustomers: one failing account aborts the whole pull (no partial book)', async () => {
  const attempted: string[] = [];
  await assert.rejects(
    () =>
      collectRowsAcrossCustomers(['10027973', '10029105', '10030471'], async (id) => {
        attempted.push(id);
        if (id === '10029105') throw new Error('INVALID CRITERIA');
        return [taggedRow(id)];
      }),
    /customer 10029105 failed/,
  );
  // Stopped AT the failure — never went on to pull the rest and hand back a partial book.
  assert.deepEqual(attempted, ['10027973', '10029105']);
});

test('collectRowsAcrossCustomers: preserves the underlying error as `cause`', async () => {
  const original = new Error('CMD report.run returned no identifier (status: INVALID CRITERIA)');
  await assert.rejects(
    () => collectRowsAcrossCustomers(['10027973'], async () => { throw original; }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.cause, original, 'the CMD failure must stay diagnosable');
      return true;
    },
  );
});

test('collectRowsAcrossCustomers: an empty roster fails closed rather than reporting a clean no-op', async () => {
  await assert.rejects(
    () => collectRowsAcrossCustomers([], async () => [taggedRow('nope')]),
    /empty customer roster/,
  );
});

test('collectRowsAcrossCustomers: an account with zero rows is not an error', async () => {
  // A facility with no activity in the window is normal — only a THROW aborts the book.
  const rows = await collectRowsAcrossCustomers(['10027973', '10029105'], async (id) =>
    id === '10027973' ? [] : [taggedRow(id)],
  );
  assert.equal(rows.length, 1);
});

// --- PAYER_KEYS aliases ------------------------------------------------------
//
// Report 10093971 has emitted THREE different payer labels across its rebuilds. Each is mapped,
// and the 'Primary' forms stay ahead of the others so no previously-shipped pull changes value.
// 'Charge Current Payer Name' is the CURRENTLY-RESPONSIBLE payer and is a poor substitute — it
// collapsed one facility's book to 2 distinct payers where 'Payer Name' yields 30 — but it is
// kept mapped so an un-rebuilt report degrades to a wrong-ish payer rather than to the blank
// sentinel, which would silently merge every payer into one rollup row.

test('extractLineFields: maps the plain "Payer Name" label (report 10093971, 2026-08-03 rebuild)', () => {
  const f = extractLineFields({
    'Charge From Date': '03/14/2026',
    'Payer Name': 'AETNA',
    'Facility Name': 'CAMH',
  });
  assert.equal(f?.payer, 'AETNA');
});

test('extractLineFields: a Primary payer label still wins over the newer aliases', () => {
  // Order matters: pick() takes the FIRST candidate present. A report emitting both must keep
  // resolving to the Primary column so existing rollup values are unchanged.
  const f = extractLineFields({
    'Charge From Date': '03/14/2026',
    'Charge Primary Payer Name': 'PRIMARY WINS',
    'Payer Name': 'SHOULD NOT WIN',
    'Charge Current Payer Name': 'SHOULD NOT WIN EITHER',
    'Facility Name': 'CAMH',
  });
  assert.equal(f?.payer, 'PRIMARY WINS');
});
