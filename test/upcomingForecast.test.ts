/**
 * Forecast resolution + landed-match suggestion (src/veris/upcomingForecast.ts).
 *
 * What these lock:
 *   1) suppress beats correct — a corrected-then-landed row is GONE, never shown corrected,
 *      because showing it would double-count against the 835 that landed it,
 *   2) an orphaned correct/suppress is reported STALE and a stale correct is NOT promoted to
 *      an add — a correction asserts nothing without the sheet row it describes,
 *   3) money is exact to the cent through a correction,
 *   4) a suggestion is never emitted on facility+date alone, at most one per forecast row,
 *      and high confidence requires BOTH amount and payer to agree,
 *   5) the payer heuristic's real cases: the sheet's shorthand against the 835's legal name,
 *   6) THE WIRE SHAPE. 024's `id` is bigint and node-pg hands int8 back as TEXT, so the runtime
 *      row is `{ id: "15" }` while the type says `number`. manualRowFromDb is the narrowing, and
 *      these tests drive STRING ids through it and then through the predicate the delete Server
 *      Action actually guards with — the coverage whose absence let every delete button be a
 *      guaranteed no-op while the suite stayed green on numeric literals,
 *   7) THE SHEET WINS a match-key collision: an add duplicating a sheet row is surfaced, not
 *      emitted, so the money is counted once.
 *
 * Pure module: no DB, no network, no clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_CMD_CUSTOMERS,
  BXR_CUSTOMERS,
  INDIGO_CUSTOMERS,
  OWNED_CMD_CUSTOMERS,
  RETIRED_CMD_CUSTOMERS,
  activeFacilityCodesForEntity,
  facilityBelongsToEntity,
  facilityCodesForEntity,
  facilityIsActiveForEntity,
} from '../src/collections/cmdCustomers.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import {
  amountFromCents,
  centsFromAmount,
  expectedCentsByFacilityForMonth,
  isRemoved,
  manualRowFromDb,
  manualStatus,
  matchKey,
  payersCorrespond,
  resolveForecast,
  suggestLandedMatches,
  type EraCandidate,
  type ManualForecastDbRow,
  type ManualForecastRow,
  type SheetForecastRow,
} from '../src/veris/upcomingForecast.js';

const sheet = (over: Partial<SheetForecastRow> = {}): SheetForecastRow => ({
  expected_date: '2026-08-04',
  facility_code: 'CAMH',
  payer_label: 'UMR',
  method_label: 'EFT',
  amount: '16117.31',
  is_patient_specific: false,
  ...over,
});

let nextId = 1;
const manual = (over: Partial<ManualForecastRow> = {}): ManualForecastRow => ({
  id: nextId++,
  kind: 'correct',
  facility_code: 'CAMH',
  payer_label: 'UMR',
  expected_date: '2026-08-04',
  method_label: null,
  amount: '20000.00',
  suppress_reason: null,
  matched_era_key: null,
  ...over,
});

/**
 * The SAME row as `manual()`, but shaped the way the driver really hands it back: `id` is a
 * STRING, because staging.expected_payment_manual.id is bigint and node-pg's default int8 parser
 * returns text. Every fixture in the render suite uses numeric literals, which is precisely why
 * nothing caught the delete path being dead.
 */
const dbRow = (over: Partial<ManualForecastDbRow> = {}): ManualForecastDbRow => {
  const m = manual();
  return { ...m, id: String(m.id), ...over };
};

const era = (over: Partial<EraCandidate> = {}): EraCandidate => ({
  payment_date: '2026-08-04',
  facility_code: 'CAMH',
  payer_name: 'UMR',
  amount: '16117.31',
  ...over,
});

// --- resolution -------------------------------------------------------------

test('no edits: the sheet passes through untouched, total is exact', () => {
  const r = resolveForecast([sheet(), sheet({ facility_code: 'KWC', amount: '0.01' })], []);
  assert.equal(r.rows.length, 2);
  assert.equal(r.stale.length, 0);
  assert.equal(r.totalCents, 1611731 + 1);
  assert.ok(r.rows.every((x) => x.origin === 'sheet' && !x.corrected));
});

test("a 'correct' replaces the amount, keeps the sheet's method, and marks the row", () => {
  const r = resolveForecast([sheet()], [manual({ amount: '20000.00' })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.amount, '20000.00');
  assert.equal(r.rows[0]!.method_label, 'EFT', 'null method on the correction keeps the sheet value');
  assert.equal(r.rows[0]!.corrected, true, 'the UI must be able to say this was overridden');
  assert.equal(r.rows[0]!.origin, 'sheet', 'origin is still the sheet — it was corrected, not authored');
  assert.equal(r.totalCents, 2000000);
  assert.equal(r.stale.length, 0);
});

test("a 'suppress' removes the row entirely and contributes nothing to the total", () => {
  const r = resolveForecast(
    [sheet()],
    [manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' })],
  );
  assert.equal(r.rows.length, 0);
  assert.equal(r.totalCents, 0);
  assert.equal(r.stale.length, 0, 'it matched, so it is not stale');
});

test('THE ORDERING CONTRACT: suppress beats correct on the same row', () => {
  const r = resolveForecast(
    [sheet()],
    [
      manual({ amount: '20000.00' }),
      manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' }),
    ],
  );
  assert.equal(r.rows.length, 0, 'corrected-then-landed is GONE, not shown at the new amount');
  // The correction must NOT be reported stale: a human deliberately hid the row, and sending
  // the operator to re-point a correction they superseded themselves is noise.
  assert.equal(r.stale.length, 0);
});

test("an orphaned 'correct' is reported stale and is NOT promoted to an add", () => {
  // The operator moved the sheet row's date, so the correction's match key no longer resolves.
  const r = resolveForecast([sheet({ expected_date: '2026-08-11' })], [manual({ amount: '20000.00' })]);
  assert.equal(r.rows.length, 1, 'only the sheet row survives');
  assert.equal(r.rows[0]!.amount, '16117.31', 'uncorrected — the correction did not apply');
  assert.equal(r.rows[0]!.corrected, false);
  assert.equal(r.stale.length, 1, 'and the orphan is surfaced, not silently dropped');
  assert.equal(r.stale[0]!.reason, 'no_matching_sheet_row');
  assert.equal(r.totalCents, 1611731, 'the orphan contributes NO money');
});

test("an orphaned 'suppress' is stale and hides nothing", () => {
  const r = resolveForecast(
    [sheet({ payer_label: 'AETNA' })],
    [manual({ kind: 'suppress', amount: null, suppress_reason: 'incorrect' })],
  );
  assert.equal(r.rows.length, 1, 'a suppression that matches nothing must not hide a neighbour');
  assert.equal(r.stale.length, 1);
});

test("an 'add' appears with manual origin, and can itself be suppressed", () => {
  const added = manual({
    kind: 'add',
    facility_code: 'TREAT_WA',
    payer_label: 'REGENCE',
    expected_date: '2026-08-05',
    method_label: 'Check',
    amount: '4200.00',
  });
  const one = resolveForecast([], [added]);
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0]!.origin, 'manual');
  assert.equal(one.rows[0]!.method_label, 'Check');
  assert.equal(one.totalCents, 420000);

  const suppressed = resolveForecast(
    [],
    [
      added,
      manual({
        kind: 'suppress',
        facility_code: 'TREAT_WA',
        payer_label: 'REGENCE',
        expected_date: '2026-08-05',
        method_label: null,
        amount: null,
        suppress_reason: 'landed',
      }),
    ],
  );
  assert.equal(suppressed.rows.length, 0, 'confirming "landed" must work on a manual add too');
  assert.equal(suppressed.stale.length, 0);
});

// --- THE WIRE SHAPE: bigint id → JS number ----------------------------------
// staging.expected_payment_manual.id is bigint (oid 20). node-pg's DEFAULT parser returns int8
// as a STRING and this repo registers no type parser, so an unmapped read puts "15" in a field
// declared `number`. Everything below drives the REAL shape.

test('manualRowFromDb narrows the driver\'s bigint text and leaves every other field alone', () => {
  const r = manualRowFromDb(dbRow({ id: '15' }));
  assert.equal(r.id, 15);
  assert.equal(typeof r.id, 'number', 'a React key coerces either way — the DELETE GUARD does not');
  // Idempotent, so the mapper is safe to apply to an already-narrowed row and every existing
  // numeric-literal fixture stays valid.
  assert.equal(manualRowFromDb({ ...dbRow(), id: 15 }).id, 15);
  const raw = dbRow({ id: '15' });
  // 033 added TWO deliberate normalizations beside the id narrowing, and they are asserted
  // here rather than loosened out of the deepEqual: an absent `status` becomes 'expected' and
  // an absent `removed_at` becomes null. Both matter downstream — `isRemoved` exists precisely
  // because `undefined !== null` is TRUE, so leaving removed_at undefined here would let a
  // bare comparison anywhere downstream read every live row as removed.
  assert.deepEqual(
    manualRowFromDb(raw),
    { ...raw, id: 15, status: 'expected', removed_at: null },
    'the id is narrowed, the two lifecycle fields are defaulted, nothing else is touched',
  );
});

test('manualRowFromDb preserves lifecycle fields that ARE present', () => {
  // The defaulting above must not clobber real values coming off the wire.
  const r = manualRowFromDb(
    dbRow({ id: '21', status: 'needs_review', removed_at: '2026-08-09T12:00:00Z' }),
  );
  assert.equal(r.status, 'needs_review');
  assert.equal(r.removed_at, '2026-08-09T12:00:00Z');
});

test('manualRowFromDb THROWS rather than truncating — a wrong id deletes the wrong decision', () => {
  // 2^53 + 1 cannot round-trip through a JS number. Unreachable on an identity sequence from 1,
  // which is the point: this is a tripwire, not a recovery strategy. Silently truncating would
  // aim a delete at somebody else's money decision.
  for (const bad of ['9007199254740993', '0', '-1', '1.5', 'abc', '', '  ']) {
    assert.throws(
      () => manualRowFromDb(dbRow({ id: bad })),
      /not a safe positive integer/,
      `id ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('THE REGRESSION: every id the tile can act on passes deleteUpcomingManual\'s guard', () => {
  // The live 2026-08-06 book, as the driver returns it: 11 manual rows with STRING ids, plus the
  // one sheet row. Before the read boundary was fixed these ids reached
  // `Number.isSafeInteger(id) && id > 0` (app/lib/actions.ts) as strings, so EVERY "Remove edit",
  // "Remove row" and "Undo correction" button returned bad_id without touching the database.
  const K = (over: Partial<ManualForecastDbRow>) =>
    dbRow({ method_label: null, amount: null, ...over });
  const live: ManualForecastDbRow[] = [
    K({ id: '6', kind: 'correct', facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05', amount: '32000.00' }),
    K({ id: '7', kind: 'suppress', facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05', suppress_reason: 'landed' }),
    K({ id: '8', kind: 'add', facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05', method_label: 'EFT', amount: '32000.00' }),
    K({ id: '9', kind: 'suppress', facility_code: 'LSMH', payer_label: 'Aetna', expected_date: '2026-08-05', suppress_reason: 'incorrect' }),
    K({ id: '10', kind: 'suppress', facility_code: 'NASH', payer_label: 'BCBS', expected_date: '2026-08-05', suppress_reason: 'incorrect' }),
    K({ id: '11', kind: 'suppress', facility_code: 'TBH', payer_label: 'BCBS', expected_date: '2026-08-05', suppress_reason: 'incorrect' }),
    K({ id: '12', kind: 'suppress', facility_code: 'TREAT_WA', payer_label: 'Regence', expected_date: '2026-08-05', suppress_reason: 'incorrect' }),
    K({ id: '13', kind: 'suppress', facility_code: 'TBH', payer_label: 'Aetna', expected_date: '2026-08-06', suppress_reason: 'incorrect' }),
    K({ id: '14', kind: 'suppress', facility_code: 'TREAT_WA', payer_label: 'Aetna', expected_date: '2026-08-06', suppress_reason: 'incorrect' }),
    K({ id: '15', kind: 'add', facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-05-26', method_label: 'Check', amount: '72000.00' }),
    K({ id: '16', kind: 'suppress', facility_code: 'KWC', payer_label: 'Anthem', expected_date: '2026-08-06', suppress_reason: 'landed' }),
  ];
  const liveSheet: SheetForecastRow[] = [
    sheet({ facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-05-26',
            method_label: 'Check', amount: '72000.00', is_patient_specific: true }),
  ];

  const r = resolveForecast(liveSheet, live.map(manualRowFromDb));

  // Copied VERBATIM from app/lib/actions.ts deleteUpcomingManual — if that guard changes, this
  // assertion is the thing that should notice.
  const passesDeleteGuard = (id: number) => Number.isSafeInteger(id) && id > 0;
  for (const row of r.rows) {
    if (row.manualId !== undefined) {
      assert.ok(passesDeleteGuard(row.manualId), `rendered row id ${row.manualId} must be deletable`);
    }
  }
  assert.ok(r.stale.length > 0, 'the live book really does carry stale edits');
  for (const st of r.stale) {
    assert.ok(passesDeleteGuard(st.manual.id), `stale edit id ${st.manual.id} must be deletable`);
  }

  // And the sort at the end of resolveForecast is numeric BY TYPE now, not numeric by the
  // accident of JS coercing "10" - "2". A localeCompare "simplification" would order 10 before 2.
  const ids = r.stale.map((s) => s.manual.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'stale is ascending by id');
  assert.ok(ids.includes(15), 'the duplicate add is among them (see the duplicate tests below)');
});

test('the match key is case- and whitespace-insensitive on the payer label only', () => {
  assert.equal(matchKey('CAMH', ' umr ', '2026-08-04'), matchKey('CAMH', 'UMR', '2026-08-04'));
  assert.notEqual(matchKey('CAMH', 'UMR', '2026-08-04'), matchKey('camh', 'UMR', '2026-08-04'));
  // A correction keyed with sloppy spacing still lands on its row.
  const r = resolveForecast([sheet()], [manual({ payer_label: '  umr  ', amount: '1.00' })]);
  assert.equal(r.rows[0]!.amount, '1.00');
});

// --- THE SHEET WINS A KEY COLLISION -----------------------------------------

test('a manual add duplicating a sheet row is SKIPPED and surfaced — the money is counted once', () => {
  // The live 2026-08-06 state: add id 15 duplicates the sheet's KWC / BCBS AR / 2026-05-26
  // $72,000 row exactly, and the tile rendered both for a $144,000 overdue subtotal.
  const r = resolveForecast([sheet()], [manual({ kind: 'add', method_label: 'EFT', amount: '16117.31' })]);
  assert.equal(r.rows.length, 1, 'one payment, one row');
  assert.equal(r.rows[0]!.origin, 'sheet', 'the feed of record wins');
  assert.equal(r.totalCents, 1611731, 'NOT 3223462 — the double count is the whole defect');
  assert.equal(r.stale.length, 1, 'and the add is surfaced, never silently dropped');
  assert.equal(r.stale[0]!.reason, 'duplicate_of_sheet_row');
  assert.equal(r.stale[0]!.manual.kind, 'add');
  assert.deepEqual(r.stale[0]!.sheetAmounts, ['16117.31'], 'the money that IS counted is named');
});

test('the duplicate check is on the MATCH KEY, not on the amount', () => {
  // Loosening this to key+amount would let a mistyped add render beside its sheet twin at a key
  // that 024's vocabulary cannot address separately: suppress(key) kills both, correct(key) hits
  // only the sheet row. Same ambiguous state, differently spelled.
  const r = resolveForecast([sheet()], [manual({ kind: 'add', method_label: 'EFT', amount: '999.00' })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.amount, '16117.31', "the sheet's amount, not the add's");
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0]!.reason, 'duplicate_of_sheet_row');
});

test('a suppress on a duplicated key consumes the sheet row AND the add, and nothing is stale', () => {
  // Locks the suppress-before-duplicate ordering, and proves the double-mark of usedSuppress is
  // harmless (it is a Set).
  const r = resolveForecast(
    [sheet()],
    [
      manual({ kind: 'add', method_label: 'EFT', amount: '16117.31' }),
      manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' }),
    ],
  );
  assert.equal(r.rows.length, 0);
  assert.equal(r.totalCents, 0);
  assert.equal(r.stale.length, 0, 'no duplicate complaint about a row the human already hid');
});

test("THE DELIBERATE ASYMMETRY: a 'correct' on a key held only by an ADD is stale", () => {
  // This is the live ids 6/7/8 shape, and it is NOT the sub-defect it looks like. The adds loop
  // never consults the correct map — a correction is a statement about a SHEET row and 024 does
  // not promote it to an add — so this correct is changing nothing whether or not the add is
  // suppressed. Marking it "used" for symmetry with the sheet loop would HIDE a dead edit, which
  // is the one thing the stale strip exists to prevent. Pinned so nobody "fixes" the asymmetry.
  const at = { facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05' };
  const r = resolveForecast(
    [],
    [
      manual({ id: 6, kind: 'correct', ...at, amount: '32000.00' }),
      manual({ id: 7, kind: 'suppress', ...at, amount: null, suppress_reason: 'landed' }),
      manual({ id: 8, kind: 'add', ...at, method_label: 'EFT', amount: '32000.00' }),
    ],
  );
  assert.equal(r.rows.length, 0, 'the add is suppressed');
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0]!.manual.id, 6);
  assert.equal(r.stale[0]!.manual.kind, 'correct');
  assert.equal(r.stale[0]!.reason, 'no_matching_sheet_row', 'orphaned, not duplicate');
});

test('two identical sheet forecasts BOTH survive — this module never dedupes the feed of record', () => {
  // 023 has no unique index and its header is explicit that two identical forecasts are legal.
  const two = resolveForecast([sheet({ amount: '100.00' }), sheet({ amount: '900.00' })], []);
  assert.equal(two.rows.length, 2, 'the dedupe applies to ADDS, never to the sheet');
  assert.equal(two.totalCents, 100000);

  const withAdd = resolveForecast(
    [sheet({ amount: '100.00' }), sheet({ amount: '900.00' })],
    [manual({ kind: 'add', method_label: 'EFT', amount: '1.00' })],
  );
  assert.equal(withAdd.rows.length, 2, 'still both sheet rows');
  assert.equal(withAdd.stale.length, 1);
  assert.deepEqual(withAdd.stale[0]!.sheetAmounts, ['100.00', '900.00'], 'both colliding amounts');
});

test('the resolved order is a TOTAL order over a duplicated match key', () => {
  // (date, facility, payer) is not unique and OVERRIDE_*_ROWS_SQL orders by those same three
  // columns, so without the amount/method tiebreak the render order of a duplicated key is
  // planner order — stable-sorted into place and free to flip between page loads.
  const amounts = (rows: SheetForecastRow[]) =>
    resolveForecast(rows, []).rows.map((r) => r.amount);
  const forward = amounts([sheet({ amount: '100.00' }), sheet({ amount: '900.00' })]);
  const reverse = amounts([sheet({ amount: '900.00' }), sheet({ amount: '100.00' })]);
  assert.deepEqual(forward, ['900.00', '100.00'], 'larger first, matching the group-list idiom');
  assert.deepEqual(forward, reverse, 'and input order cannot change it');
});

// --- hidden: an applied suppression must stay reversible -------------------
//
// Suppression used to be a ONE-WAY DOOR. An applied suppress is consumed into `usedSuppress`,
// so it is not stale (it is working exactly as asked) and rendered nowhere — there was no id on
// screen to delete and the hidden row could never come back from the UI. These pin the way out.

test('an applied suppression is HIDDEN, not stale, and names the money it removed', () => {
  const r = resolveForecast(
    [sheet({ amount: '16117.31' })],
    [manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' })],
  );
  assert.equal(r.rows.length, 0, 'the row is off the tile — that is what suppress means');
  assert.equal(r.stale.length, 0, 'and it is NOT stale: a working edit is not an orphaned one');
  assert.equal(r.hidden.length, 1, 'it is hidden, so the UI can offer an Undo');
  assert.equal(r.hidden[0]!.manual.kind, 'suppress');
  assert.deepEqual(r.hidden[0]!.hiddenAmounts, ['16117.31'], 'the operator sees what left');
  assert.equal(r.hidden[0]!.hidAdd, false);
});

test('hidden reports the CORRECTED amount — that is what an Undo brings back', () => {
  const key = { facility_code: 'CAMH', payer_label: 'UMR', expected_date: '2026-08-04' };
  const r = resolveForecast(
    [sheet({ ...key, amount: '16117.31' })],
    [
      manual({ ...key, kind: 'correct', amount: '20000.00' }),
      manual({ ...key, kind: 'suppress', amount: null, suppress_reason: 'landed' }),
    ],
  );
  assert.equal(r.hidden.length, 1);
  assert.deepEqual(
    r.hidden[0]!.hiddenAmounts,
    ['20000.00'],
    'naming the pre-correction 16117.31 would understate the money coming back',
  );
});

test('a suppressed manual ADD is hidden with hidAdd — the invisible-and-undeletable case', () => {
  // The regression that made this a blocker: the adds loop consumed the add into the same
  // branch, so it rendered nowhere, was not stale, and re-keying it through the add form was
  // swallowed by the suppress still standing. Recovery meant SQL.
  const key = { facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05' };
  const r = resolveForecast(
    [],
    [
      manual({ ...key, kind: 'add', method_label: 'EFT', amount: '32000.00' }),
      manual({ ...key, kind: 'suppress', amount: null, suppress_reason: 'landed' }),
    ],
  );
  assert.equal(r.rows.length, 0);
  assert.equal(r.hidden.length, 1);
  assert.equal(r.hidden[0]!.hidAdd, true, 'so the copy can say the add comes back too');
  assert.deepEqual(r.hidden[0]!.hiddenAmounts, ['32000.00']);
  assert.equal(
    r.hidden[0]!.manual.kind,
    'suppress',
    'Undo deletes the SUPPRESS, which is what restores the add',
  );
});

test('one suppress hiding a duplicated sheet key reports BOTH amounts under ONE undo', () => {
  const r = resolveForecast(
    [sheet({ amount: '100.00' }), sheet({ amount: '900.00' })],
    [manual({ kind: 'suppress', amount: null, suppress_reason: 'incorrect' })],
  );
  assert.equal(r.hidden.length, 1, 'one edit, one Undo — not one per row it happens to cover');
  assert.deepEqual(r.hidden[0]!.hiddenAmounts, ['100.00', '900.00']);
});

test('a suppress that hides NOTHING stays stale — hidden means in effect', () => {
  const r = resolveForecast([], [manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' })]);
  assert.equal(r.hidden.length, 0);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0]!.reason, 'no_matching_sheet_row');
});

test('hidden money is NEVER in totalCents — undoing is how it comes back, not summing', () => {
  const r = resolveForecast(
    [sheet({ amount: '16117.31' }), sheet({ facility_code: 'KWC', amount: '500.00' })],
    [manual({ kind: 'suppress', amount: null, suppress_reason: 'landed' })],
  );
  assert.equal(r.totalCents, 50000, 'only the surviving KWC row');
  assert.ok(r.hidden.length > 0, 'and the suppressed 16117.31 is recorded, not counted');
});

test('THE LIVE BOOK: every one of the 11 manual rows is reachable from the UI', () => {
  // The 2026-08-06 production state that produced this work. Before the fix the operator could
  // clear NONE of them (the delete guard rejected the bigint-as-string id); after the dedupe
  // alone, ids 7 and 8 were still unreachable. This asserts the whole book is addressable.
  const k = (facility_code: string, payer_label: string, expected_date: string) => ({
    facility_code,
    payer_label,
    expected_date,
  });
  const rows: ManualForecastDbRow[] = [
    dbRow({ id: '6', kind: 'correct', ...k('KWC', 'BCBS TN', '2026-08-05'), amount: '32000.00' }),
    dbRow({ id: '7', kind: 'suppress', ...k('KWC', 'BCBS TN', '2026-08-05'), amount: null, suppress_reason: 'landed' }),
    dbRow({ id: '8', kind: 'add', ...k('KWC', 'BCBS TN', '2026-08-05'), method_label: 'EFT', amount: '32000.00' }),
    dbRow({ id: '9', kind: 'suppress', ...k('LSMH', 'Aetna', '2026-08-05'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '10', kind: 'suppress', ...k('NASH', 'BCBS', '2026-08-05'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '11', kind: 'suppress', ...k('TBH', 'BCBS', '2026-08-05'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '12', kind: 'suppress', ...k('TREAT_WA', 'Regence', '2026-08-05'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '13', kind: 'suppress', ...k('TBH', 'Aetna', '2026-08-06'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '14', kind: 'suppress', ...k('TREAT_WA', 'Aetna', '2026-08-06'), amount: null, suppress_reason: 'incorrect' }),
    dbRow({ id: '15', kind: 'add', ...k('KWC', 'BCBS AR', '2026-05-26'), method_label: 'Check', amount: '72000.00' }),
    dbRow({ id: '16', kind: 'suppress', ...k('KWC', 'Anthem', '2026-08-06'), amount: null, suppress_reason: 'landed' }),
  ];
  const liveSheet = [
    sheet({ ...k('KWC', 'BCBS AR', '2026-05-26'), method_label: 'Check', amount: '72000.00', is_patient_specific: true }),
  ];
  const r = resolveForecast(liveSheet, rows.map(manualRowFromDb));

  assert.equal(r.rows.length, 1, 'one real forecast row, not the two that made it $144,000');
  assert.equal(r.totalCents, 7200000);

  const staleIds = r.stale.map((s) => s.manual.id);
  const hiddenIds = r.hidden.map((h) => h.manual.id);
  assert.deepEqual(staleIds, [6, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(hiddenIds, [7]);
  // 8 is not listed anywhere BY ITSELF, and must not be: it is restored by undoing 7. Asserting
  // that explicitly is the point — an add reachable only through its suppress is the design.
  assert.equal(r.hidden[0]!.hidAdd, true, 'undoing 7 brings add 8 back');

  const addressable = new Set([...staleIds, ...hiddenIds]);
  for (const id of [6, 7, 9, 10, 11, 12, 13, 14, 15, 16]) {
    assert.ok(addressable.has(id), `edit ${id} must have a control on screen`);
  }
  // And every id the UI puts on a delete-edit intent must survive the Server Action's guard —
  // copied verbatim from deleteUpcomingManual, because that is the check that was rejecting.
  for (const id of addressable) {
    assert.ok(Number.isSafeInteger(id) && id > 0, `id ${String(id)} must pass the delete guard`);
  }
});

test('cents helpers are exact and reject junk', () => {
  assert.equal(centsFromAmount('16117.31'), 1611731);
  assert.equal(centsFromAmount('0.1'), 10);
  assert.equal(centsFromAmount('$100'), null);
  assert.equal(centsFromAmount(null), null);
  assert.equal(amountFromCents(1611731), '16117.31');
  assert.equal(amountFromCents(1), '0.01');
  assert.equal(amountFromCents(0), '0.00');
});

// --- payer correspondence ---------------------------------------------------

test('payersCorrespond: the real sheet-vs-835 pairs', () => {
  assert.ok(payersCorrespond('AETNA', 'AETNA'), 'identical');
  assert.ok(payersCorrespond('UMR', 'UMR'), 'identical short');
  assert.ok(payersCorrespond('CIGNA', 'CIGNA HEALTH AND LIFE INSURANCE COMPANY'), 'substring');
  assert.ok(payersCorrespond('UHC SUREST', 'UHC SUREST'), 'multiword identical');
  assert.ok(payersCorrespond('SUREST', 'UHC SUREST'), 'shared significant token');
  assert.ok(payersCorrespond('BCBS', 'BLUE CROSS BLUE SHIELD OF TEXAS'), 'initialism');
  assert.ok(payersCorrespond('GEHA', 'GOVERNMENT EMPLOYEES HEALTH ASSOCIATION'), 'initialism');

  assert.ok(!payersCorrespond('AETNA', 'CIGNA HEALTH AND LIFE INSURANCE COMPANY'), 'different payers');
  assert.ok(!payersCorrespond('UMR', null), 'an unnamed 835 payer cannot correspond');
  assert.ok(!payersCorrespond('', 'AETNA'), 'empty shorthand matches nothing');
  // The documented limitation, asserted so nobody assumes it works: this pair is a real
  // same-payer case the heuristic CANNOT see, which is exactly why matching is suggest-only.
  assert.ok(
    !payersCorrespond('BCBS', 'BLUE CROSS OF CALIFORNIA (CA)'),
    'known miss — no reliable join exists here, hence human confirmation',
  );
});

// --- suggestion -------------------------------------------------------------

const resolved = (over: Partial<SheetForecastRow> = {}) => resolveForecast([sheet(over)], []).rows;

test('high confidence needs BOTH the amount and the payer to agree', () => {
  const s = suggestLandedMatches(resolved(), [era()]);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.confidence, 'high');
  assert.equal(s[0]!.dayGap, 0);
  assert.equal(s[0]!.eraKey, '2026-08-04|CAMH|UMR');
});

test('one signal only is medium confidence', () => {
  const amountOnly = suggestLandedMatches(resolved(), [era({ payer_name: 'AETNA' })]);
  assert.equal(amountOnly[0]!.confidence, 'medium', 'amount agrees, payer does not');
  const payerOnly = suggestLandedMatches(resolved(), [era({ amount: '999.00' })]);
  assert.equal(payerOnly[0]!.confidence, 'medium', 'payer agrees, amount does not');
});

test('NO suggestion on facility + date alone — that describes half a busy facility', () => {
  const s = suggestLandedMatches(resolved(), [era({ payer_name: 'AETNA', amount: '999.00' })]);
  assert.equal(s.length, 0);
});

test('the day window bounds the search, and the gap is reported signed', () => {
  assert.equal(suggestLandedMatches(resolved(), [era({ payment_date: '2026-08-09' })]).length, 1);
  assert.equal(
    suggestLandedMatches(resolved(), [era({ payment_date: '2026-08-09' })])[0]!.dayGap,
    5,
    'era is 5 days after the forecast',
  );
  assert.equal(
    suggestLandedMatches(resolved(), [era({ payment_date: '2026-07-30' })])[0]!.dayGap,
    -5,
    'and negative when the money landed early',
  );
  assert.equal(
    suggestLandedMatches(resolved(), [era({ payment_date: '2026-08-20' })]).length,
    0,
    'outside the window is not a candidate at all',
  );
});

test('a different facility is never a candidate, however well everything else matches', () => {
  assert.equal(suggestLandedMatches(resolved(), [era({ facility_code: 'KWC' })]).length, 0);
});

test('at most ONE suggestion per forecast row — the best candidate wins', () => {
  const s = suggestLandedMatches(resolved(), [
    era({ payment_date: '2026-08-06', payer_name: 'AETNA' }), // medium, gap 2
    era({ payment_date: '2026-08-05' }), // high, gap 1
    era({ payment_date: '2026-08-04', amount: '1.00' }), // medium, gap 0
  ]);
  assert.equal(s.length, 1, 'the operator answers yes/no about one payment');
  assert.equal(s[0]!.confidence, 'high');
  assert.equal(s[0]!.era.payment_date, '2026-08-05', 'confidence outranks a smaller day gap');
});

test('an unquantified 835 group can still match on the payer', () => {
  const s = suggestLandedMatches(resolved(), [era({ amount: null })]);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.confidence, 'medium', 'no readable amount means no amount agreement');
});

test('suggestions are deterministic regardless of input order', () => {
  const rows = resolveForecast([sheet({ facility_code: 'KWC' }), sheet()], []).rows;
  const cands = [era(), era({ facility_code: 'KWC' })];
  const a = suggestLandedMatches(rows, cands).map((x) => x.forecast.facility_code);
  const b = suggestLandedMatches([...rows].reverse(), [...cands].reverse()).map(
    (x) => x.forecast.facility_code,
  );
  assert.deepEqual(a, ['CAMH', 'KWC']);
  assert.deepEqual(a, b);
});

// --- the cross-tenant facility guard --------------------------------------------------
// This is what stops a super admin on the BXR view filing an Indigo facility's expected
// payment under BXR. 024 has no FK on facility_code and collections.facilities is
// tenant-agnostic, so the roster is the only thing that can answer "whose facility is this".

test('facilityCodesForEntity returns exactly one tenant, and covers OWNED (not just polled)', () => {
  const bxr = facilityCodesForEntity(BXR_ENTITY_ID);
  const indigo = facilityCodesForEntity(INDIGO_ENTITY_ID);
  assert.equal(bxr.length, BXR_CUSTOMERS.length, 'BXR has no retired facilities today');
  // Ownership spans active + retired. Asserting against INDIGO_CUSTOMERS alone would re-encode
  // the bug this separation exists to prevent (a removed facility losing its owner).
  assert.equal(indigo.length, INDIGO_CUSTOMERS.length + RETIRED_CMD_CUSTOMERS.length);
  assert.ok(bxr.includes('CAMH'), 'a known BXR short code');
  // THE POINT OF THE GUARD: no facility may appear on both rosters, or "whose is it" has no
  // answer and the guard would wave a cross-tenant write through.
  const overlap = bxr.filter((c) => indigo.includes(c));
  assert.deepEqual(overlap, [], 'the two books share no facility code');
});

// --- polling vs ownership vs new-work: three questions, one `retired` field ------------------
// Retiring a facility must stop polling and stop NEW writes while keeping ownership true. These
// lock all three so a future retirement cannot silently resume polling, cannot lose an owner, and
// cannot answer a liveness question with a tenancy error.

test('retired facilities are OWNED but never POLLED', () => {
  assert.ok(RETIRED_CMD_CUSTOMERS.length > 0, 'the marker is load-bearing; keep it exercised');
  for (const retired of RETIRED_CMD_CUSTOMERS) {
    // Not in any ingest roster — polling must stay stopped. Excluded on BOTH keys: for Indigo
    // customerId and facilityCode are the same string, so checking one would hide a BXR-shaped
    // mistake where they differ (facilityCode is a mnemonic like 'CAMH').
    assert.ok(
      !ALL_CMD_CUSTOMERS.some((c) => c.customerId === retired.customerId),
      `${retired.customerId} must NOT be in the polling roster (customerId)`,
    );
    assert.ok(
      !ALL_CMD_CUSTOMERS.some((c) => c.facilityCode === retired.facilityCode),
      `${retired.facilityCode} must NOT be in the polling roster (facilityCode)`,
    );
    // But still owned, so guards and history-facing surfaces answer truthfully.
    assert.ok(
      OWNED_CMD_CUSTOMERS.some((c) => c.facilityCode === retired.facilityCode),
      `${retired.facilityCode} must be in the owned set`,
    );
    assert.ok(
      facilityBelongsToEntity(retired.facilityCode, retired.businessEntityId),
      `${retired.facilityCode} must still belong to its tenant`,
    );
    assert.ok(
      !facilityBelongsToEntity(retired.facilityCode, BXR_ENTITY_ID),
      'a retired Indigo facility is still not BXR\'s',
    );
    // ...and must NOT accept new work. This is the pair that keeps the two errors distinct.
    assert.ok(
      !facilityIsActiveForEntity(retired.facilityCode, retired.businessEntityId),
      `${retired.facilityCode} must not accept a NEW forecast row`,
    );
    assert.ok(
      !activeFacilityCodesForEntity(retired.businessEntityId).includes(retired.facilityCode),
      `${retired.facilityCode} must not be offered in a create picker`,
    );
  }
});

test('every retired marker is an ISO date — so `retired` cannot be a falsy typo', () => {
  // `retired: ''` would read as retired under `!== undefined` and as active under truthiness.
  // The predicates all compare against undefined, and this pins the value shape too.
  for (const c of RETIRED_CMD_CUSTOMERS) {
    assert.match(c.retired ?? '', /^\d{4}-\d{2}-\d{2}$/, `${c.facilityCode} retired marker`);
  }
});

test('an ACTIVE facility accepts new work, and both predicates agree on it', () => {
  const active = INDIGO_CUSTOMERS[0]!;
  assert.ok(facilityBelongsToEntity(active.facilityCode, INDIGO_ENTITY_ID));
  assert.ok(facilityIsActiveForEntity(active.facilityCode, INDIGO_ENTITY_ID));
  assert.ok(activeFacilityCodesForEntity(INDIGO_ENTITY_ID).includes(active.facilityCode));
  // Liveness never widens tenancy: an active BXR facility is still not Indigo's.
  assert.ok(!facilityIsActiveForEntity('CAMH', INDIGO_ENTITY_ID));
});

test('10035467 stays owned but is closed to new work', () => {
  // Measured 2026-08-10: 8 collections.daily_collections rows, $28,843.12, plus its
  // collections.facilities dimension row. Reporting reads the DB and is roster-independent, but
  // the ownership guard reads the roster — so dropping ownership would break attribution of that
  // history. Its CMD account closed 2026-08-06, so no NEW payment can ever arrive for it.
  assert.ok(facilityBelongsToEntity('10035467', INDIGO_ENTITY_ID));
  assert.ok(facilityCodesForEntity(INDIGO_ENTITY_ID).includes('10035467'));
  assert.ok(!facilityIsActiveForEntity('10035467', INDIGO_ENTITY_ID));
  assert.ok(!activeFacilityCodesForEntity(INDIGO_ENTITY_ID).includes('10035467'));
});

test('OWNED_CMD_CUSTOMERS is active plus retired, unique on BOTH keys', () => {
  assert.equal(OWNED_CMD_CUSTOMERS.length, ALL_CMD_CUSTOMERS.length + RETIRED_CMD_CUSTOMERS.length);
  const codes = OWNED_CMD_CUSTOMERS.map((c) => c.facilityCode);
  assert.equal(new Set(codes).size, codes.length, 'a facility must not be both active and retired');
  // customerId too: for BXR the two keys differ, so uniqueness on facilityCode alone would let a
  // future retirement reuse an active customerId under a different code and pass.
  const ids = OWNED_CMD_CUSTOMERS.map((c) => c.customerId);
  assert.equal(new Set(ids).size, ids.length, 'a CMD customer id must appear once');
});

test('Indigo owns exactly 32 codes — the set cmdCsvDailyBackfill must name', () => {
  // The backfill's INDIGO_NAME_BY_CODE labels HISTORICAL deposits, so it must cover retired
  // facilities too. It cannot be imported here (that module runs a CLI main() on import), so this
  // pins the count its comment cites; keeping the number honest is the most a test can do until
  // that entry point is guarded.
  const indigoOwned = OWNED_CMD_CUSTOMERS.filter((c) => c.businessEntityId === INDIGO_ENTITY_ID);
  assert.equal(indigoOwned.length, 32, 'cmdCsvDailyBackfill.ts cites 32 — update both together');
});

test('facilityBelongsToEntity is exact and rejects the other tenant', () => {
  assert.ok(facilityBelongsToEntity('CAMH', BXR_ENTITY_ID));
  assert.ok(!facilityBelongsToEntity('CAMH', INDIGO_ENTITY_ID), 'a BXR facility is not Indigo');
  const anIndigoCode = INDIGO_CUSTOMERS[0]!.facilityCode;
  assert.ok(facilityBelongsToEntity(anIndigoCode, INDIGO_ENTITY_ID));
  assert.ok(!facilityBelongsToEntity(anIndigoCode, BXR_ENTITY_ID), 'and not the reverse');
  assert.ok(!facilityBelongsToEntity('camh', BXR_ENTITY_ID), 'codes are canonical, not case-folded');
  assert.ok(!facilityBelongsToEntity('NOT_A_FACILITY', BXR_ENTITY_ID));
  assert.ok(!facilityBelongsToEntity('CAMH', '00000000-0000-0000-0000-000000000000'));
});

test('every alias the sheet parser can produce is a real BXR facility', async () => {
  // 023's alias table resolves sheet labels to canonical codes, and the sheet cron writes as
  // BXR. If those two ever disagree the guard would start rejecting legitimate sheet-derived
  // corrections — so lock them together here rather than discovering it in production.
  const { knownFacilityCodes } = await import('../src/veris/upcomingOverrideSheet.js');
  const bxr = facilityCodesForEntity(BXR_ENTITY_ID);
  for (const code of knownFacilityCodes()) {
    assert.ok(bxr.includes(code), `alias target ${code} must be on the BXR roster`);
  }
});

// ===========================================================================
// 033 — SOFT DELETE, RECONCILIATION STATUS, AND THE CHART'S EXPECTED SERIES
// ===========================================================================
// Migration 033 gave the manual table a lifecycle: removal became a tombstone instead of a
// DELETE, and a manual 'add' gained somewhere to record that an 835 has since covered it.
// The resolver is where all three states become (or stop being) money on a screen, so this is
// where they are pinned.

// --- THE undefined !== null TRAP -------------------------------------------
// `status` and `removed_at` are OPTIONAL on ManualForecastRow, because every pre-033 fixture
// omits them. That makes a bare `m.removed_at !== null` evaluate TRUE for a live row — which
// would invert the filter and hide the entire tile while showing only tombstones. isRemoved()
// exists solely to close that, and this is the test that would have caught it.

test('isRemoved: an ABSENT removed_at is not a removal (the undefined !== null trap)', () => {
  const live = manual({ kind: 'add', method_label: 'EFT' });
  assert.equal('removed_at' in live, false, 'the fixture genuinely omits the field');
  assert.equal(isRemoved(live), false, 'absent must read as NOT removed');
  // The exact expression this helper exists to replace, proving it would have been wrong.
  assert.equal((live as { removed_at?: string | null }).removed_at !== null, true);
  assert.equal(isRemoved({ removed_at: null }), false);
  assert.equal(isRemoved({ removed_at: '2026-08-09T12:00:00Z' }), true);
});

test('manualStatus: an ABSENT status defaults to the honest "expected"', () => {
  assert.equal(manualStatus(manual()), 'expected');
  assert.equal(manualStatus({ status: 'matched' }), 'matched');
  assert.equal(manualStatus({ status: 'needs_review' }), 'needs_review');
});

// --- Soft delete ------------------------------------------------------------

test('a removed ADD contributes no money and is reported as removed', () => {
  const r = resolveForecast(
    [],
    [
      manual({
        kind: 'add',
        method_label: 'EFT',
        amount: '32000.00',
        facility_code: 'KWC',
        payer_label: 'BCBS TN',
        expected_date: '2026-08-05',
        removed_at: '2026-08-09T12:00:00Z',
      }),
    ],
  );
  assert.equal(r.rows.length, 0, 'a decision taken back is not on the tile');
  assert.equal(r.totalCents, 0, 'and contributes nothing to the total');
  assert.equal(r.removed.length, 1, 'but is still reported, so the audit row resolves');
  assert.equal(r.stale.length, 0, 'a removal is not an orphaned edit');
});

test('a removed SUPPRESS stops hiding the sheet row — the money comes back', () => {
  // THE POINT OF SOFT DELETE, operationally. Removal must un-apply the decision, not merely
  // stop listing it. If the resolver kept honouring a tombstoned suppress, the operator would
  // remove it, see nothing change, and have no way to get the row back short of SQL.
  const s = sheet({ amount: '16117.31' });
  const kill = (over: Partial<ManualForecastRow>) =>
    manual({ kind: 'suppress', method_label: null, amount: null, suppress_reason: 'landed', ...over });

  const applied = resolveForecast([s], [kill({})]);
  assert.equal(applied.rows.length, 0, 'baseline: a live suppress hides it');
  assert.equal(applied.hidden.length, 1);

  const undone = resolveForecast([s], [kill({ removed_at: '2026-08-09T12:00:00Z' })]);
  assert.equal(undone.rows.length, 1, 'the sheet row is back');
  assert.equal(undone.totalCents, 1611731, 'and its money is counted again');
  assert.equal(undone.hidden.length, 0, 'nothing is hidden any more');
  assert.equal(undone.removed.length, 1);
});

test('a removed CORRECT reverts to the sheet amount rather than going stale', () => {
  const s = sheet({ amount: '16117.31' });
  const r = resolveForecast(
    [s],
    [manual({ kind: 'correct', amount: '20000.00', removed_at: '2026-08-09T12:00:00Z' })],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]?.amount, '16117.31', 'the correction is not applied');
  assert.equal(r.rows[0]?.corrected, false);
  assert.equal(r.stale.length, 0, 'a removed correction is removed, not orphaned');
});

// --- Reconciliation status --------------------------------------------------

test('a MATCHED add renders once, not twice — it leaves rows and totals', () => {
  // THE DUPLICATION GUARD. Once a human confirms an 835 covers this forecast, the 835 is
  // already on the tile through the confirmed half. Emitting the forecast beside it renders
  // one payment twice and doubles its money.
  const add = manual({
    kind: 'add',
    method_label: 'EFT',
    amount: '32000.00',
    facility_code: 'KWC',
    payer_label: 'BCBS TN',
    expected_date: '2026-08-05',
    status: 'matched',
    matched_era_key: '2026-08-06|KWC|BLUE CROSS BLUE SHIELD OF TENNESSEE',
  });
  const r = resolveForecast([], [add]);
  assert.equal(r.rows.length, 0, 'not rendered as expected money');
  assert.equal(r.totalCents, 0, 'and not counted');
  assert.equal(r.matched.length, 1, 'surfaced so it can be undone — never silently evaporated');
  assert.equal(r.matched[0]?.amount, '32000.00', 'carrying what it would contribute if undone');
  assert.equal(
    r.matched[0]?.eraKey,
    '2026-08-06|KWC|BLUE CROSS BLUE SHIELD OF TENNESSEE',
    'and the remit a human agreed it was',
  );
});

test('a NEEDS_REVIEW add is STILL rendered and STILL counted, only flagged', () => {
  // The distinction that makes suggest-then-confirm safe. A low-confidence match is a prompt,
  // never a suppression — hiding money on a guess is exactly what suggestLandedMatches refuses
  // to do, and doing it through a status column would be the same mistake in a new place.
  const r = resolveForecast(
    [],
    [
      manual({
        kind: 'add',
        method_label: 'EFT',
        amount: '32000.00',
        status: 'needs_review',
        matched_era_key: '2026-08-06|CAMH|AETNA',
      }),
    ],
  );
  assert.equal(r.rows.length, 1, 'still on the tile');
  assert.equal(r.totalCents, 3200000, 'still counted — a guess must not remove money');
  assert.equal(r.rows[0]?.needsReview, true, 'but flagged for a human');
  assert.equal(r.rows[0]?.candidateEraKey, '2026-08-06|CAMH|AETNA');
  assert.equal(r.matched.length, 0);
});

test('removal beats a matched status — a removed matched row is removed, not matched', () => {
  // Order matters in the classification pass: a row that is both must land in exactly one
  // bucket, and "the operator took it back" is the later, stronger statement.
  const r = resolveForecast(
    [],
    [
      manual({
        kind: 'add',
        method_label: 'EFT',
        amount: '32000.00',
        status: 'matched',
        matched_era_key: 'k',
        removed_at: '2026-08-09T12:00:00Z',
      }),
    ],
  );
  assert.equal(r.removed.length, 1);
  assert.equal(r.matched.length, 0);
  assert.equal(r.rows.length, 0);
});

test('a matched status on a SUPPRESS is ignored by the matched branch', () => {
  // 033's status coherence CHECK confines a non-'expected' status to an 'add'. The resolver
  // guards on kind anyway, so a hand-inserted row cannot make a suppression silently stop
  // suppressing — which would put hidden money back on the tile.
  const s = sheet();
  const r = resolveForecast(
    [s],
    [
      manual({
        kind: 'suppress',
        method_label: null,
        amount: null,
        suppress_reason: 'landed',
        status: 'matched' as ManualForecastRow['status'],
        matched_era_key: 'k',
      }),
    ],
  );
  assert.equal(r.rows.length, 0, 'the suppression still applies');
  assert.equal(r.hidden.length, 1);
  assert.equal(r.matched.length, 0, 'and it is not reported as a reconciled add');
});

// --- The chart's expected series -------------------------------------------

test('expectedCentsByFacilityForMonth sums per facility within the month only', () => {
  const rows = resolveForecast(
    [],
    [
      manual({ kind: 'add', method_label: 'EFT', amount: '32000.00', facility_code: 'KWC', expected_date: '2026-08-05' }),
      manual({ kind: 'add', method_label: 'EFT', amount: '1000.50', facility_code: 'KWC', expected_date: '2026-08-28' }),
      manual({ kind: 'add', method_label: 'EFT', amount: '500.00', facility_code: 'CAMH', expected_date: '2026-08-01' }),
      // Adjacent months on BOTH sides — the prefix match must exclude them.
      manual({ kind: 'add', method_label: 'EFT', amount: '99999.00', facility_code: 'KWC', expected_date: '2026-07-31' }),
      manual({ kind: 'add', method_label: 'EFT', amount: '88888.00', facility_code: 'KWC', expected_date: '2026-09-01' }),
    ],
  ).rows;
  const m = expectedCentsByFacilityForMonth(rows, 2026, 8);
  assert.equal(m.get('KWC'), 3300050, 'both August KWC rows, exact cents, no float drift');
  assert.equal(m.get('CAMH'), 50000);
  assert.equal(m.size, 2, 'July and September contribute nothing');
});

test('expectedCentsByFacilityForMonth zero-pads the month — 2026-09 is not 2026-9', () => {
  const rows = resolveForecast(
    [],
    [manual({ kind: 'add', method_label: 'EFT', amount: '100.00', facility_code: 'KWC', expected_date: '2026-09-02' })],
  ).rows;
  assert.equal(expectedCentsByFacilityForMonth(rows, 2026, 9).get('KWC'), 10000);
  assert.equal(expectedCentsByFacilityForMonth(rows, 2026, 1).size, 0, 'no accidental prefix hit');
});

test('a facility whose only forecast amount is unreadable gets NO entry, not a zero bar', () => {
  const rows = resolveForecast(
    [],
    [manual({ kind: 'add', method_label: 'EFT', amount: 'not-a-number', facility_code: 'KWC', expected_date: '2026-08-05' })],
  ).rows;
  assert.equal(expectedCentsByFacilityForMonth(rows, 2026, 8).size, 0);
});

test('THE CHART CANNOT SEE HIDDEN OR MATCHED MONEY — only resolved.rows feeds it', () => {
  // The chart passes resolveForecast(...).rows and nothing else. This pins WHY: `hidden` is
  // money a human removed and `matched` is money an 835 already covers, so either one folded
  // into the expected series would put settled money back on screen as outstanding.
  const key = { facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05' };
  const r = resolveForecast(
    [],
    [
      manual({ kind: 'add', method_label: 'EFT', amount: '32000.00', ...key }),
      manual({ kind: 'suppress', method_label: null, amount: null, suppress_reason: 'landed', ...key }),
      manual({
        kind: 'add', method_label: 'EFT', amount: '77000.00', status: 'matched', matched_era_key: 'k',
        facility_code: 'CAMH', payer_label: 'AETNA', expected_date: '2026-08-07',
      }),
    ],
  );
  assert.equal(r.hidden.length, 1, 'the KWC add is hidden by its suppress');
  assert.equal(r.matched.length, 1, 'the CAMH add is reconciled');
  assert.equal(expectedCentsByFacilityForMonth(r.rows, 2026, 8).size, 0, 'neither reaches the chart');
});
