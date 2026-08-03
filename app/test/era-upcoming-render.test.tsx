/**
 * "Upcoming Payments" — RENDERED-HTML tests on the pure body leaf.
 *
 * What these lock, against real markup:
 *   1) the READ-PATH CONTRACT reaches the USER: whenever unquantified_remits > 0 the
 *      floor banner renders alongside the total — the tile may never show a silent
 *      understatement as an authoritative number,
 *   2) the empty state is calm prose ("nothing scheduled"), not an error and not a
 *      zero-dollar figure presented as data,
 *   3) money renders formatted, null group amounts render as an em dash (never $0.00),
 *      and the truncation footnote appears only when the breakdown was capped,
 *   4) the headline never blends incoming remits with BPR04=NON non-payments, and the
 *      zero-dollar clause vanishes at zero rather than rendering "· 0 zero-dollar",
 *   5) THE ADDITIVE-ONLY CONTRACT: operator-keyed forecast money is never summed into the
 *      ERA-confirmed headline, is labelled as forecast wherever it appears, and an absent
 *      forecast payload degrades to the confirmed half alone rather than to an error,
 *   6) the (date × facility) hierarchy is a native disclosure — one <details> per parent,
 *      with the per-payer split inside it — and the forecast half never renders a name.
 *
 * EraUpcomingBody is a presentational leaf with relative/type-only imports, so this
 * renders it directly (same harness as qualify-render.test.tsx). No DB, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildUpcomingGroups,
  payerSuggestions,
  centsFromText,
  EraUpcomingBody,
  paymentMethodLabel,
} from '../components/dashboard/era-upcoming';
import type { EraUpcomingGroup, EraUpcomingSummary } from '../../src/veris/era835Upcoming.js';
import type {
  UpcomingOverrideRow,
  UpcomingOverrideSummary,
} from '../../src/veris/upcomingOverride.js';

const G = (over: Partial<EraUpcomingGroup>): EraUpcomingGroup => ({
  payment_date: '2026-08-03',
  facility_code: 'CAMH',
  payer_name: 'ACME HEALTH PLAN',
  payment_method: 'ACH',
  remits: 1,
  amount: '100.00',
  unquantified_remits: 0,
  ...over,
});

const S = (over: Partial<EraUpcomingSummary>): EraUpcomingSummary => {
  const remits = over.remits ?? 0;
  const zeroDollar = over.zero_dollar_remits ?? 0;
  return {
    total: '0.00',
    remits,
    // incoming + zero-dollar = remits by default, matching the SQL partition.
    incoming_remits: remits - zeroDollar,
    zero_dollar_remits: zeroDollar,
    unquantified_remits: 0,
    groups: [],
    groups_truncated: false,
    ...over,
  };
};

test('empty state: calm "nothing scheduled" — no dollars, no error styling', () => {
  const html = renderToStaticMarkup(<EraUpcomingBody data={S({})} />);
  assert.ok(html.includes('No future payments scheduled'), 'the calm empty read');
  assert.ok(!html.includes('$'), 'no zero presented as data');
  assert.ok(!html.includes('Unable to load'), 'not an error state');
  assert.ok(!html.includes('floor'), 'no floor banner when there is nothing to understate');
});

test('populated: formatted total, remit count, earliest date, per-group amounts', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '72986.79',
        remits: 3,
        groups: [
          G({ payment_date: '2026-08-03', remits: 2, amount: '52986.79' }),
          G({ payment_date: '2026-08-04', payer_name: 'BETA PLAN', amount: '20000.00' }),
        ],
      })}
    />,
  );
  assert.ok(html.includes('$72,986.79'), 'headline money formatted');
  assert.ok(html.includes('3 incoming'), 'incoming remit count');
  assert.ok(html.includes('earliest 2026-08-03'), 'earliest date from the ascending groups');
  assert.ok(html.includes('$52,986.79') && html.includes('$20,000.00'), 'group amounts');
  assert.ok(html.includes('ACME HEALTH PLAN') && html.includes('BETA PLAN'));
  assert.ok(!html.includes('floor'), 'no banner when every remit is quantified');
  assert.ok(!html.includes('capped'), 'no truncation footnote when nothing was cut');
});

test('THE CONTRACT TEST: unquantified remits force the floor banner next to the total', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '100.00',
        remits: 5,
        unquantified_remits: 2,
        groups: [G({ remits: 5, amount: '100.00', unquantified_remits: 2 })],
      })}
    />,
  );
  assert.ok(html.includes('$100.00'), 'the sum still shows');
  assert.ok(
    html.includes('2') && html.includes('floor, not the full sum'),
    '…but NEVER without the floor disclosure (013 read-path contract)',
  );
  assert.ok(html.includes('+2 unq.'), 'the affected group is marked too');
});

test('an all-unquantified group renders an em dash, never $0.00', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '0.00',
        remits: 1,
        unquantified_remits: 1,
        groups: [G({ amount: null, unquantified_remits: 1 })],
      })}
    />,
  );
  assert.ok(html.includes('—'), 'null amount is visibly unknown');
  assert.ok(!html.includes('$0.00'), 'never a fabricated zero for money we cannot read');
  assert.ok(html.includes('floor, not the full sum'), 'and the banner still fires');
});

test('headline splits incoming from zero-dollar and never shows a blended remit count', () => {
  // The live first-run window: 38 remits, of which 4 are BPR04=NON at $0.00. A single
  // "38 remits" implied 38 deposits were arriving; only 34 are.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '331481.42',
        remits: 38,
        zero_dollar_remits: 4,
        groups: [G({ payment_date: '2026-07-31', amount: '331481.42', remits: 38 })],
      })}
    />,
  );
  assert.ok(html.includes('$331,481.42'), 'money unchanged by the split');
  assert.ok(html.includes('34 incoming'), 'the count that means "deposits arriving"');
  assert.ok(html.includes('4 zero-dollar'), 'non-payments are disclosed, not hidden');
  assert.ok(!html.includes('38 remits'), 'the blended count is gone from the headline');
  assert.ok(!html.includes('38 incoming'), 'and NON is excluded from incoming, not relabelled');
});

test('the zero-dollar clause disappears entirely when there are no non-payments', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '44730.00', remits: 34, zero_dollar_remits: 0, groups: [G({})] })}
    />,
  );
  assert.ok(html.includes('34 incoming'), 'an unqualified incoming count is the right read');
  assert.ok(!html.includes('zero-dollar'), 'no "· 0 zero-dollar" noise');
  assert.ok(!html.includes('· 0'), 'and no stray empty clause of any shape');
});

test('BPR04 codes render as billing-desk English, and NON is never a check', () => {
  // X12 BPR04: ACH = electronic deposit ("EFT" to the billing team), CHK = paper check,
  // NON = "Non-Payment Data", a $0 informational remit (denial / all patient
  // responsibility). Live BXR data: all 32 NON remits were $0.00, all 7 CHK positive.
  assert.equal(paymentMethodLabel('ACH'), 'EFT');
  assert.equal(paymentMethodLabel('CHK'), 'Check');
  assert.equal(paymentMethodLabel('NON'), 'No payment');
  assert.equal(paymentMethodLabel('FWT'), 'Wire');

  // THE ANTI-COLLISION ASSERTION: a $0 non-payment must never read as money in transit.
  assert.notEqual(
    paymentMethodLabel('NON'),
    paymentMethodLabel('CHK'),
    'NON and CHK are opposite facts and may never share a label',
  );
  assert.ok(!/check/i.test(paymentMethodLabel('NON')), 'NON is not a check, in any casing');

  // Unknown codes stay loud rather than being guessed at, and blanks are em dashes.
  assert.equal(paymentMethodLabel('BOP'), 'BOP', 'unmapped code renders as itself');
  assert.equal(paymentMethodLabel('ach'), 'EFT', 'case-insensitive on the wire value');
  assert.equal(paymentMethodLabel(null), '—');
  assert.equal(paymentMethodLabel('  '), '—');
});

test('the table attributes each group to its facility and shows translated methods', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '89355.00',
        remits: 3,
        groups: [
          G({ payment_date: '2026-07-31', facility_code: 'LSMH', amount: '44625.00' }),
          G({ payment_date: '2026-08-04', facility_code: 'PCMH', amount: '44730.00' }),
          G({ payment_date: '2026-08-04', facility_code: 'DMH', payment_method: 'NON', amount: '0.00' }),
        ],
      })}
    />,
  );
  assert.ok(html.includes('>Facility<'), 'the Facility column header exists');
  assert.ok(html.includes('LSMH') && html.includes('PCMH') && html.includes('DMH'), 'per-row codes');
  assert.ok(html.includes('EFT'), 'ACH is shown as EFT');
  assert.ok(html.includes('No payment'), 'NON is shown as a non-payment');
  assert.ok(!html.includes('>ACH<'), 'the raw code is not the visible cell text');
  assert.ok(html.includes('title="ACH"'), 'but the raw BPR04 stays available for reconciliation');
});

test('truncation footnote appears when the breakdown was capped', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '10.00', remits: 60, groups: [G({})], groups_truncated: true })}
    />,
  );
  assert.ok(html.includes('capped at the first 50'), 'silent truncation is not allowed');
  assert.ok(html.includes('include everything'), 'and the headline is stated to be uncapped');
});

// ---------------------------------------------------------------------------
// The FORECAST half (migration 023) and the hierarchy.
// ---------------------------------------------------------------------------

const OR = (over: Partial<UpcomingOverrideRow>): UpcomingOverrideRow => ({
  expected_date: '2026-08-03',
  facility_code: 'CAMH',
  payer_label: 'BCBS',
  method_label: 'EFT',
  amount: '5000.00',
  is_patient_specific: false,
  ...over,
});

const OS = (rows: UpcomingOverrideRow[], over: Partial<UpcomingOverrideSummary> = {}): UpcomingOverrideSummary => ({
  total: rows
    .reduce((c, r) => c + (centsFromText(r.amount) ?? 0), 0)
    .toString()
    .replace(/(\d\d)$/, '.$1'),
  rows,
  rows_truncated: false,
  ...over,
});

test('THE ADDITIVE-ONLY CONTRACT: forecast money never enters the ERA headline', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ amount: '5000.00' })])}
    />,
  );
  assert.ok(html.includes('$100.00'), 'the confirmed total still shows');
  assert.ok(html.includes('$5,000.00'), 'the forecast total shows too');
  // The blended figure is the whole hazard: a forecast row left in the sheet after its 835
  // lands would double-count, so $5,100.00 must never appear anywhere on this tile.
  assert.ok(!html.includes('$5,100.00'), 'the two are NEVER summed into one number');
  assert.ok(html.includes('not included in the total above'), 'and the split is stated in words');
  assert.ok(html.includes('Forecast'), 'forecast money is labelled as such');
});

test('a missing forecast payload degrades to the confirmed half, not to an error', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody data={S({ total: '100.00', remits: 1, groups: [G({})] })} overrides={null} />,
  );
  assert.ok(html.includes('$100.00'), 'the confirmed half renders');
  assert.ok(!html.includes('Forecast'), 'no forecast furniture with no forecast data');
  assert.ok(!html.includes('Unable to load'), 'an unapplied migration 023 is NOT an error here');
});

test('forecast-only: the tile renders even with zero ERA remits, headline stays unknown', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} overrides={OS([OR({ amount: '5000.00' })])} />,
  );
  assert.ok(!html.includes('No future payments scheduled'), 'not the empty state');
  assert.ok(html.includes('$5,000.00'), 'the forecast is visible on its own');
  // The ERA headline is CONFIRMED money. With no confirmed remits it is unknown, not $0.00 —
  // and above all not the forecast figure promoted into the confirmed slot.
  assert.ok(html.includes('—'), 'confirmed headline is unknown, not a fabricated zero');
});

test('the hierarchy is one native <details> disclosure per (date x facility)', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({
        total: '300.00',
        remits: 3,
        groups: [
          G({ payer_name: 'ACME HEALTH PLAN', amount: '100.00' }),
          G({ payer_name: 'BETA PLAN', amount: '150.00' }),
          G({ facility_code: 'KWC', payer_name: 'ACME HEALTH PLAN', amount: '50.00' }),
        ],
      })}
    />,
  );
  // Two facilities on one date => two parents, not three payer rows at the top level.
  assert.equal(html.split('<details').length - 1, 2, 'one disclosure per date x facility');
  assert.ok(html.includes('2 payers') && html.includes('1 payer'), 'parents state their child count');
  assert.ok(html.includes('$250.00'), 'the CAMH parent shows the summed subtotal');
  assert.ok(html.includes('ACME HEALTH PLAN') && html.includes('BETA PLAN'), 'subitems are present');
});

test('a forecast leaf never renders a patient name — only the unnamed marker', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({})}
      overrides={OS([OR({ is_patient_specific: true, payer_label: 'UHC' })])}
    />,
  );
  assert.ok(html.includes('1 patient'), 'patient-specific rows are marked');
  assert.ok(html.includes('UHC'), 'the payer label is shown');
  // 023's PHI boundary: the parser drops the sheet's Client cell, so there is no name to
  // render here and this type cannot carry one.
  assert.ok(!/patient['\s]*name/i.test(html), 'and no name field is rendered');
});

test('buildUpcomingGroups: confirmed subtotal stays null when every leaf is unquantified', () => {
  const groups = buildUpcomingGroups(
    S({ remits: 2, unquantified_remits: 2, groups: [G({ amount: null, unquantified_remits: 2, remits: 2 })] }),
    null,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.confirmedCents, null, 'null, never 0 — unreadable is not zero');
  assert.equal(groups[0]!.unquantified, 2);
});

test('buildUpcomingGroups: confirmed leaves sort ahead of forecast leaves in a parent', () => {
  const groups = buildUpcomingGroups(
    S({ total: '10.00', remits: 1, groups: [G({ amount: '10.00' })] }),
    OS([OR({ amount: '9999.00' })]),
  );
  assert.equal(groups.length, 1, 'same date + facility folds into ONE parent');
  assert.deepEqual(
    groups[0]!.items.map((i) => i.kind),
    ['confirmed', 'forecast'],
    'certain money is read before asserted money, regardless of size',
  );
  assert.equal(groups[0]!.confirmedCents, 1000);
  assert.equal(groups[0]!.forecastCents, 999900);
});

test('centsFromText is exact and rejects junk', () => {
  assert.equal(centsFromText('19832.60'), 1983260);
  assert.equal(centsFromText('291000'), 29100000);
  assert.equal(centsFromText('0.1'), 10);
  assert.equal(centsFromText(null), null);
  assert.equal(centsFromText('$100'), null, 'formatting is the UI edge, not this parser');
  assert.equal(centsFromText('1.234'), null, 'more than cents precision is not a money value');
});

// ---------------------------------------------------------------------------
// The add-a-payment form (024 kind='add').
// ---------------------------------------------------------------------------

const FACILITIES = [
  { code: 'CAMH', label: 'CAMH — CA MENTAL HEALTH' },
  { code: 'KWC', label: 'KWC — KENTUCKY WELLNESS CENTER' },
];

test('the add form renders only for a super admin', () => {
  const withEdit = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} canEdit facilityOptions={FACILITIES} />,
  );
  assert.ok(withEdit.includes('Add an expected payment'), 'super admin gets the form');
  assert.ok(withEdit.includes('CA MENTAL HEALTH'), 'facilities are selectable, not free text');

  const withoutEdit = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} facilityOptions={FACILITIES} />,
  );
  assert.ok(!withoutEdit.includes('Add an expected payment'), 'nobody else sees it');
});

test('the form appears on an EMPTY tile too — that is when it is most needed', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} canEdit facilityOptions={FACILITIES} />,
  );
  assert.ok(html.includes('No future payments scheduled'), 'still the calm empty read');
  assert.ok(html.includes('Add an expected payment'), 'and the form is reachable from it');
});

test('Consolidated explains instead of offering a form the server would reject', () => {
  // A write must name one tenant; Consolidated resolves to two entity ids, so the action
  // returns 'pick_a_tenant_view'. Offering the form there would be a guaranteed dead end.
  const html = renderToStaticMarkup(<EraUpcomingBody data={S({})} canEdit facilityOptions={[]} />);
  assert.ok(!html.includes('Add an expected payment'), 'no form without a single tenant');
  assert.ok(html.includes('Switch to the BXR or Indigo view'), 'it says what to do instead');
});

test('the amount field constrains itself to a money shape in the markup', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} canEdit facilityOptions={FACILITIES} />,
  );
  // The browser blocks a bad value and announces it on the field — the accessible place for
  // the message — before the client check or the Server Action ever see it.
  assert.ok(html.includes('pattern="\\d{1,10}(\\.\\d{1,2})?"'), 'money pattern is on the input');
  assert.ok(html.includes('type="date"'), 'native date input, not a parsed text field');
  assert.ok(html.includes('required'), 'the required fields are marked for the browser');
});

test('payerSuggestions dedupes across both feeds, forecast vocabulary first', () => {
  const forecast = buildUpcomingGroups(S({}), OS([OR({ payer_label: 'BCBS' })]))
    .flatMap((g) => g.items)
    .map((i) => ({
      expected_date: '2026-08-03',
      facility_code: 'CAMH',
      payer_label: i.payer ?? '',
      method_label: i.methodLabel,
      amount: i.amount ?? '0.00',
      is_patient_specific: false,
      origin: 'sheet' as const,
      corrected: false,
    }));
  const out = payerSuggestions(forecast, [
    G({ payer_name: 'AETNA' }),
    G({ payer_name: 'bcbs' }),
    G({ payer_name: null }),
  ]);
  assert.deepEqual(out, ['AETNA', 'BCBS'], 'case-insensitive dedupe, unnamed payer dropped');
});
