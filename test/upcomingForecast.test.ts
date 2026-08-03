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
 *   5) the payer heuristic's real cases: the sheet's shorthand against the 835's legal name.
 *
 * Pure module: no DB, no network, no clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountFromCents,
  centsFromAmount,
  matchKey,
  payersCorrespond,
  resolveForecast,
  suggestLandedMatches,
  type EraCandidate,
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

test('the match key is case- and whitespace-insensitive on the payer label only', () => {
  assert.equal(matchKey('CAMH', ' umr ', '2026-08-04'), matchKey('CAMH', 'UMR', '2026-08-04'));
  assert.notEqual(matchKey('CAMH', 'UMR', '2026-08-04'), matchKey('camh', 'UMR', '2026-08-04'));
  // A correction keyed with sloppy spacing still lands on its row.
  const r = resolveForecast([sheet()], [manual({ payer_label: '  umr  ', amount: '1.00' })]);
  assert.equal(r.rows[0]!.amount, '1.00');
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
