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
    { type: 'request', id: 1, fresh: true },
    { type: 'request', id: 2, fresh: true },
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
    { type: 'request', id: 1, fresh: true },
    { type: 'request', id: 2, fresh: true },
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
    { type: 'request', id: 1, fresh: true },
    { type: 'request', id: 2, fresh: true },
    { type: 'failed', id: 1, error: 'parse-failed', fresh: true },
  );
  assert.equal(s.busy, true, 'a superseded response cleared the in-flight spinner');
  assert.equal(s.error, null);
});

test('the CURRENT response still applies normally — the guard must not drop everything', () => {
  // A guard that rejected every response would pass all three tests above. Pin the happy path.
  const s = run(
    { type: 'request', id: 1, fresh: true },
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
    { type: 'request', id: 1, fresh: true },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
    { type: 'set-cell', key: `${WEEK_A}|row-OLD:1`, codes: ['G'] },
    { type: 'set-status', key: `${WEEK_A}|row-OLD`, status: 'NEEDS BILLED' },
    { type: 'open-drawer', target: { row: OLD.rows[0]!, dayIndex: 0 } },
    { type: 'set-filter', filter: 'loc', value: 'SYNTHETIC IOP' },
    { type: 'set-filter', filter: 'fac', value: 'SYNTHETIC IOP' },
  );

test('a fresh import failing with no-weeks clears the PREVIOUS export, not just the error line', () => {
  // This is the exact hole: `no-weeks` is returned AFTER parsing a corpus that produced no
  // dated weeks, and a fresh pick is a replacement. Showing "no dated sessions" above the
  // previous export's clients and billing totals reads as a statement about the data on screen.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: true }), {
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
    const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: true }), {
      type: 'failed',
      id: 2,
      error,
      fresh: true,
    });
    assert.equal(s.data, null, `${error} left the previous payload rendered`);
    assert.equal(s.files, null, `${error} left the previous corpus retained`);
    assert.equal(s.cellOv.size, 0, `${error} left overrides behind`);
  }
});

test('a WEEK-NAVIGATION failure keeps the loaded export — a different case, deliberately', () => {
  // The corpus is still valid; only the hop failed. Overrides and files must survive, or a
  // biller loses their work to a transient error on a week they were only passing through.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: false }), {
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
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: false }), {
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
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: true }), {
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

/* ═══ QODO REVIEW OF THIS PR — three transitions the first draft got wrong ════════════════
 * All three are the same class again: state surviving a boundary it was only valid inside.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('a fresh request discards the loaded export IMMEDIATELY, not when it resolves', () => {
  // Qodo 1. The first draft cleared on the RESPONSE, so for the whole round trip the tab showed
  // the previous export's clients and totals beneath a "Parsing…" button — which reads as the
  // state of the import now running. The end state was always the same; only this window differed.
  const s = reduce(loaded(), { type: 'request', id: 2, fresh: true });

  assert.notEqual(s.data, OLD, 'the previous export is still on screen while its replacement loads');
  assert.equal(s.data, null);
  assert.equal(s.files, null);
  assert.equal(s.cellOv.size, 0);
  assert.equal(s.statusOv.size, 0);
  assert.equal(s.target, null, 'the drawer is still open on a client from the export being replaced');
  assert.equal(s.busy, true, 'the request must still be in flight');
});

test('a WEEK-NAVIGATION request leaves the loaded export alone while it loads', () => {
  // The other half: a week hop must NOT blank the grid. Without this, the assertions above would
  // also pass if `request` cleared unconditionally.
  const s = reduce(loaded(), { type: 'request', id: 2, fresh: false });
  assert.equal(s.data, OLD, 'a week hop blanked the grid it was navigating within');
  assert.equal(s.files, oldFiles);
  assert.equal(s.cellOv.size, 1);
  assert.equal(s.busy, true);
});

test('a stale response cannot resurrect an export a newer fresh request already discarded', () => {
  // The two fixes composed: request 2 clears, then request 1 — issued earlier, still in flight —
  // comes back. Dropping it is the only thing standing between the user and the export they
  // explicitly replaced reappearing under the new import's error.
  const s = run(
    { type: 'request', id: 1, fresh: true },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
    { type: 'request', id: 2, fresh: true },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
  );
  assert.notEqual(s.data, OLD, 'the discarded export came back after its replacement was issued');
  assert.equal(s.data, null);
  assert.equal(s.files, null);
});

test('a failed week hop keeps the export for EVERY error code, not just no-weeks', () => {
  // Qodo 2. The first draft inherited `error !== 'no-weeks' -> clear` from the pre-reducer code,
  // which left `files` and the override maps retained while `data` went null: a corpus with no
  // grid, no week selector and no way back. Re-posting the SAME files cannot invalidate a corpus
  // that already parsed.
  for (const error of ['parse-failed', 'send-failed', 'unauthorized', 'unmapped-location'] as const) {
    const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: false }), {
      type: 'failed',
      id: 2,
      error,
      fresh: false,
    });
    assert.equal(s.data, OLD, `a failed week hop (${error}) discarded the loaded export`);
    assert.equal(s.files, oldFiles, `${error} left a corpus the user can no longer reach`);
    assert.equal(s.cellOv.size, 1, `${error} orphaned the overrides`);
    assert.equal(s.error, error);
    assert.equal(s.busy, false);
  }
});

test('a successful week change CLOSES the drawer — its row belongs to the previous payload', () => {
  // Qodo 3. The drawer holds a whole row captured on open, while its billable-day count is
  // recomputed from the CURRENT selectedWeek — so a retained target renders one week's sessions
  // beside another week's count. Reachable because grid cells stay interactive while busy: open
  // a drawer after a week hop is issued and before it lands.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: false }), {
    type: 'applied',
    id: 2,
    payload: makePayload({ selectedWeek: WEEK_B }),
    files: oldFiles,
    fresh: false,
  });
  assert.equal(s.target, null, 'the drawer survived a week change holding the old week row');
  // ...and the week-scoped work it navigated to is still there, which is the point of keeping it.
  assert.equal(s.cellOv.size, 1);
  assert.equal(s.data?.selectedWeek, WEEK_B);
});

/* ═══ THE GRID FILTERS ARE EXPORT-SCOPED, NOT TAB-SCOPED ═════════════════════════════════
 * `locOptions` / `facilityOptions` are built from the whole EXPORT (`build.clients` and
 * `build.facilities` in kipu-import.ts), so a filter is valid for every week of the export it
 * was chosen in — and for no other export.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('a replacement import clears the grid filters — a stale one renders a FALSE empty week', () => {
  // The visible symptom is the point: an unmatched filter shows "No clients with counted hours
  // in this week", which reads as a statement about the data and is wrong. The user is shown an
  // empty week caused by their own stale control.
  const s = reduce(loaded(), { type: 'request', id: 2, fresh: true });
  assert.notEqual(s.locFilter, 'SYNTHETIC IOP', 'a level-of-care filter survived a new import');
  assert.notEqual(s.facFilter, 'SYNTHETIC IOP', 'a location filter survived a new import');
  assert.equal(s.locFilter, '');
  assert.equal(s.facFilter, '');
});

test('a fresh import that FAILS clears them too — nothing valid is left to filter', () => {
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: true }), {
    type: 'failed',
    id: 2,
    error: 'parse-failed',
    fresh: true,
  });
  assert.equal(s.locFilter, '');
  assert.equal(s.facFilter, '');
});

test('a WEEK CHANGE keeps them — the option lists are per-export, so they stay valid', () => {
  // Clearing here would be gratuitous: every value the user could have picked is still offered
  // by the new payload, because both option lists come from the export rather than the week.
  const s = reduce(reduce(loaded(), { type: 'request', id: 2, fresh: false }), {
    type: 'applied',
    id: 2,
    payload: makePayload({ selectedWeek: WEEK_B }),
    files: oldFiles,
    fresh: false,
  });
  assert.equal(s.locFilter, 'SYNTHETIC IOP', 'a week hop discarded a filter that is still valid');
  assert.equal(s.facFilter, 'SYNTHETIC IOP');
});

test('a filter changed DURING a week hop survives the response that lands', () => {
  // This is the reachable in-flight case, and the only one. During a fresh import the two
  // selects unmount with the grid (they sit inside `{data && …}` and a fresh request nulls
  // `data`), so nothing can be picked. During a WEEK hop they stay mounted and are NOT
  // disabled while busy — so a user can change the filter mid-request, and the arriving
  // payload must not throw that away.
  const s = run(
    { type: 'request', id: 1, fresh: true },
    { type: 'applied', id: 1, payload: OLD, files: oldFiles, fresh: true },
    { type: 'request', id: 2, fresh: false },
    { type: 'set-filter', filter: 'loc', value: 'PICKED-MID-HOP' },
    { type: 'applied', id: 2, payload: makePayload({ selectedWeek: WEEK_B }), files: oldFiles, fresh: false },
  );
  assert.equal(s.locFilter, 'PICKED-MID-HOP', 'the week response undid a live selection');
});

test('each filter moves independently — one setter must not clobber the other', () => {
  const s = run(
    { type: 'request', id: 1, fresh: true },
    { type: 'set-filter', filter: 'loc', value: 'A' },
    { type: 'set-filter', filter: 'fac', value: 'B' },
  );
  assert.equal(s.locFilter, 'A');
  assert.equal(s.facFilter, 'B');
});
