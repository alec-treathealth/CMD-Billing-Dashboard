/**
 * QODO 10 (stale responses) and QODO 7 (a failed replacement import) — the Billable Days
 * import lifecycle, asserted as ordinary synchronous calls.
 *
 * WHY A REDUCER TEST AND NOT A RENDERED ONE. Both defects are about ORDERING, and the wrong
 * behaviour only shows when an older response resolves after a newer one. Reproducing that
 * through a mounted component means fake timers, a mocked Server Action and an `act()` dance,
 * all of which are ways for the test to go green without the interleaving ever happening.
 * `importReducer` is pure, so the interleaving IS the test: four calls, in the order the
 * network produced them.
 *
 * Every assertion below names the WRONG value explicitly. "data is the newer payload" passes
 * just as well if both payloads are the same object; "data is not the older payload, and its
 * week is not the older week" does not.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  importReducer as reduce,
  initialImportState,
  type ImportState,
} from '../components/billing-audit/billable-days/import-state';
import { WEEK_A, WEEK_B, makePayload, makeRow } from './helpers/billableDays';

const OLD = makePayload({ selectedWeek: WEEK_A, rows: [makeRow({ id: 'row-OLD' })] });
const NEW = makePayload({ selectedWeek: WEEK_B, rows: [makeRow({ id: 'row-NEW' })] });

const oldFiles = [new File(['old'], 'old-export.csv', { type: 'text/csv' })];
const newFiles = [new File(['new'], 'new-export.csv', { type: 'text/csv' })];

/** Runs a script of actions from the initial state, so each test reads as a timeline. */
const run = (...actions: Parameters<typeof reduce>[1][]): ImportState =>
  actions.reduce<ImportState>(reduce, initialImportState);

/* ══════════════════════ QODO 10 — the latest request is the only writer ══════════════════ */

test('an older response resolving SECOND cannot overwrite the newer payload, files or busy', () => {
  // Request 1 (a big export), then request 2 while it is still in flight. 2 comes back first.
  const s = run(
    { type: 'request', id: 1 },
    { type: 'request', id: 2 },
    { type: 'applied', id: 2, payload: NEW, files: newFiles, fresh: true },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
  );

  assert.notEqual(s.data, OLD, 'the superseded response overwrote the newer payload');
  assert.notEqual(s.data?.selectedWeek, WEEK_A, 'the grid is showing the superseded week');
  assert.equal(s.data, NEW);

  // The files matter MORE than the rows: they are re-posted on every later week change, so a
  // stale set means every subsequent week silently reports on the wrong corpus.
  assert.notEqual(s.files, oldFiles, 'the retained file handles were replaced by the stale set');
  assert.equal(s.files, newFiles);
  assert.equal(s.busy, false);
});

test('a stale FAILURE cannot blank the newer payload or raise a phantom error', () => {
  const s = run(
    { type: 'request', id: 1 },
    { type: 'request', id: 2 },
    { type: 'applied', id: 2, payload: NEW, files: newFiles, fresh: true },
    { type: 'failed', id: 1, error: 'parse-failed', fresh: true },
  );

  assert.equal(s.data, NEW, 'a superseded failure cleared the current payload');
  assert.equal(s.error, null, 'a superseded failure surfaced as an error to the user');
  assert.equal(s.files, newFiles);
});

test('a stale response does not clear busy while the current request is still in flight', () => {
  // The spinner belongs to request 2. Request 1 finishing must not turn it off, or the tab
  // looks idle while it is still loading and the user fires a third request into the gap.
  const s = run(
    { type: 'request', id: 1 },
    { type: 'request', id: 2 },
    { type: 'failed', id: 1, error: 'parse-failed', fresh: false },
  );
  assert.equal(s.busy, true, 'a superseded response cleared the in-flight spinner');
  assert.equal(s.error, null);
});

test('the CURRENT response still applies normally — the guard must not drop everything', () => {
  // A guard that rejected every response would pass all three tests above. Pin the happy path.
  const s = run(
    { type: 'request', id: 1 },
    { type: 'applied', id: 1, payload: NEW, files: newFiles, fresh: true },
  );
  assert.equal(s.data, NEW);
  assert.equal(s.files, newFiles);
  assert.equal(s.busy, false);
  assert.equal(s.error, null);
});

/* ══════════════ QODO 7 — a failed REPLACEMENT import leaves nothing behind ═══════════════ */

/** A loaded export with one cell override, one week status and the drawer open on that client. */
const loaded = (): ImportState =>
  run(
    { type: 'request', id: 1 },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
    { type: 'set-cell', key: `${WEEK_A}|row-OLD:1`, codes: ['G'] },
    { type: 'set-status', key: `${WEEK_A}|row-OLD`, status: 'NEEDS BILLED' },
    { type: 'open-drawer', target: { row: OLD.rows[0]!, dayIndex: 0 } },
  );

test('a fresh import failing with no-weeks clears the PREVIOUS export, not just the error line', () => {
  // This is the exact hole: `no-weeks` is returned AFTER parsing a corpus that produced no
  // dated weeks, and a fresh pick is a replacement. Showing "no dated sessions" above the
  // previous export's clients and billing totals reads as a statement about the data on screen.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2 }), {
    type: 'failed',
    id: 2,
    error: 'no-weeks',
    fresh: true,
  });

  assert.notEqual(s.data, OLD, 'the previous export is still rendered under the error');
  assert.equal(s.data, null);
  assert.equal(s.files, null, 'the previous corpus is still retained for the next week change');
  assert.equal(s.cellOv.size, 0, 'overrides survived onto an export that no longer exists');
  assert.equal(s.statusOv.size, 0, 'week statuses survived onto an export that no longer exists');
  assert.equal(s.target, null, 'the drawer is still open on a client from the discarded export');
  assert.equal(s.error, 'no-weeks');
  assert.equal(s.busy, false);
});

test('every other fresh failure clears the same way — the rule is fresh, not the error code', () => {
  for (const error of ['parse-failed', 'unmapped-location', 'not-csv', 'send-failed'] as const) {
    const s = reduce(reduce(loaded(), { type: 'request', id: 2 }), { type: 'failed', id: 2, error, fresh: true });
    assert.equal(s.data, null, `${error} left the previous payload rendered`);
    assert.equal(s.files, null, `${error} left the previous corpus retained`);
    assert.equal(s.cellOv.size, 0, `${error} left overrides behind`);
  }
});

test('a WEEK-NAVIGATION failure keeps the loaded export — a different case, deliberately', () => {
  // The corpus is still valid; only the hop failed. Overrides and files must survive, or a
  // biller loses their work to a transient error on a week they were only passing through.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2 }), {
    type: 'failed',
    id: 2,
    error: 'no-weeks',
    fresh: false,
  });
  assert.equal(s.data, OLD, 'a failed week hop discarded the loaded export');
  assert.equal(s.files, oldFiles);
  assert.equal(s.cellOv.size, 1);
  assert.equal(s.statusOv.size, 1);
  assert.equal(s.error, 'no-weeks');
});

test('a week change PRESERVES overrides — they are week-keyed, so they are already scoped', () => {
  const s = reduce(reduce(loaded(), { type: 'request', id: 2 }), {
    type: 'applied',
    id: 2,
    payload: makePayload({ selectedWeek: WEEK_B }),
    files: oldFiles,
    fresh: false,
  });
  assert.equal(s.cellOv.size, 1, 'a week change discarded work it did not need to');
  assert.equal(s.statusOv.size, 1);
});

test('a SUCCESSFUL fresh import clears overrides and the drawer — row ids are per-import ordinals', () => {
  const s = reduce(reduce(loaded(), { type: 'request', id: 2 }), {
    type: 'applied',
    id: 2,
    payload: NEW,
    files: newFiles,
    fresh: true,
  });
  assert.equal(s.cellOv.size, 0, 'an override re-pointed at whoever holds that ordinal now');
  assert.equal(s.statusOv.size, 0);
  assert.equal(s.target, null);
  assert.equal(s.data, NEW);
});
