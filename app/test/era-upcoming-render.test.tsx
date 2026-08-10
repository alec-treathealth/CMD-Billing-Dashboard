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
  AddForecastForm,
  buildUpcomingGroups,
  payerSuggestions,
  centsFromText,
  EraUpcomingBody,
  ForecastEditBanner,
  forecastRowKey,
  paymentMethodLabel,
} from '../components/dashboard/era-upcoming';
import type { EraUpcomingGroup, EraUpcomingSummary } from '../../src/veris/era835Upcoming.js';
import type {
  ManualForecastRow,
  ResolvedForecastRow,
} from '../../src/veris/upcomingForecast.js';
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

/** Fixture cutoff: at-or-before every OR default date, so plain OS(rows) rows are UPCOMING. */
const CUTOFF = '2026-08-03';

const sumFixed2 = (rows: UpcomingOverrideRow[]): string =>
  rows
    .reduce((c, r) => c + (centsFromText(r.amount) ?? 0), 0)
    .toString()
    .replace(/(\d\d)$/, '.$1');

const OS = (
  rows: UpcomingOverrideRow[],
  over: {
    cutoff?: string;
    overdueRows?: UpcomingOverrideRow[];
    upcomingTruncated?: boolean;
    overdueTruncated?: boolean;
  } = {},
): UpcomingOverrideSummary => ({
  cutoff: over.cutoff ?? CUTOFF,
  upcoming: {
    total: sumFixed2(rows),
    rows,
    rows_truncated: over.upcomingTruncated ?? false,
  },
  overdue: {
    total: sumFixed2(over.overdueRows ?? []),
    rows: over.overdueRows ?? [],
    rows_truncated: over.overdueTruncated ?? false,
  },
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
    OS([OR({ amount: '9999.00' })]).upcoming,
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

// ---------------------------------------------------------------------------
// The OVERDUE partition (LANDED, not DATE-PASSED — Alec's ruling 2026-08-03).
// ---------------------------------------------------------------------------

/** THE PROOF CASE from the live sheet: $72,000 KWC / BCBS AR, expected 2026-05-26. */
const PROOF_OVERDUE = OR({
  expected_date: '2026-05-26',
  facility_code: 'KWC',
  payer_label: 'BCBS AR',
  method_label: 'Check',
  amount: '72000.00',
  is_patient_specific: true,
});

test('THE PROOF CASE: the past-dated $72,000 row renders in Overdue and NOWHERE else', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ amount: '5000.00' })], { overdueRows: [PROOF_OVERDUE] })}
    />,
  );
  assert.ok(html.includes('Overdue'), 'the Overdue section renders');
  assert.ok(html.includes('$72,000.00'), 'the overdue money is visible');
  assert.ok(html.includes('69 days overdue'), '2026-05-26 → 2026-08-03 is 69 days');
  // Exclusions — the partition is only right if the money is in exactly one place:
  assert.ok(html.includes('$100.00'), 'ERA headline is untouched');
  assert.ok(html.includes('$5,000.00'), 'the upcoming forecast subtotal is untouched');
  assert.ok(!html.includes('$77,000.00'), 'overdue never folds into the forecast subtotal');
  assert.ok(!html.includes('$72,100.00'), 'overdue never folds into the ERA headline');
});

test('A PAST-DATED MANUAL ADD STAYS IN THE TABLE — it is never Overdue', () => {
  // ⚠️ THIS TEST WAS INVERTED ON 2026-08-10, and the old assertion pinned a real bug.
  // It used to require exactly the opposite ("buckets into Overdue"), which is why the defect
  // shipped green: the suite was enforcing it.
  //
  // A super admin keys a payment by hand BECAUSE a check arrived and CollaborateMD has not
  // logged it yet — so the date they type is today or earlier, essentially always. Filing that
  // under a heading reading "past their date without landing — not in any total above" is
  // wrong in every clause, and it also dropped the money out of the Forecast subtotal. Live
  // 2026-08-10: an add dated 2026-08-12 worked; the same form with 2026-08-07 disappeared.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([])}
      manual={[
        {
          id: 7,
          kind: 'add',
          facility_code: 'KWC',
          payer_label: 'TRICARE',
          expected_date: '2026-07-01',
          method_label: 'Check',
          amount: '1234.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('$1,234.00'), 'the add renders');
  assert.ok(!html.includes('Overdue'), 'and NOT under an Overdue heading');
  assert.ok(
    html.includes('not included in the total above'),
    'it counts in the upcoming Forecast subtotal, which is the money it represents',
  );
});

test('a past-dated SHEET row IS still Overdue — the asymmetry is the decision', () => {
  // The counterpart to the test above. Nobody watches the sheet feed row by row, so a sheet
  // row past its date genuinely is an escalation (Alec, 2026-08-03) and must keep escalating.
  // `origin` is what separates "a human just asserted this" from "a forecast quietly failed".
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ expected_date: '2026-05-26', amount: '72000.00' })])}
    />,
  );
  assert.ok(html.includes('Overdue'), 'a sheet row past its date still escalates');
  assert.ok(html.includes('$72,000.00'));
});

test('TOTALS PROVENANCE: the overdue subtotal is the RESOLVED recomputation, not the SQL aggregate', () => {
  // A 'correct' halves the overdue row. The payload's SQL aggregate still says 72000 —
  // rendering it would show pre-correction money. The rendered subtotal must be 36000.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      manual={[
        {
          id: 9,
          kind: 'correct',
          facility_code: 'KWC',
          payer_label: 'BCBS AR',
          expected_date: '2026-05-26',
          method_label: null,
          amount: '36000.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('$36,000.00'), 'the corrected amount renders');
  assert.ok(!html.includes('$72,000.00'), 'the pre-correction SQL aggregate is NOT rendered');
  assert.ok(html.includes('corrected'), 'the correction is marked');
});

test('a suppress removes an overdue row entirely — landed money never shows as overdue', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      manual={[
        {
          id: 11,
          kind: 'suppress',
          facility_code: 'KWC',
          payer_label: 'BCBS AR',
          expected_date: '2026-05-26',
          method_label: null,
          amount: null,
          suppress_reason: 'landed',
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(!html.includes('Overdue'), 'no Overdue section when its only row is suppressed');
  assert.ok(!html.includes('$72,000.00'), 'the suppressed money is gone');
});

test('EMPTY STATE, THIRD POPULATION: all-overdue never claims "nothing scheduled" alone', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} overrides={OS([], { overdueRows: [PROOF_OVERDUE] })} />,
  );
  // The approved wording, verbatim shape: statement + count + pointer.
  assert.ok(
    html.includes('No future payments scheduled — 1 overdue expected payment below.'),
    'the approved third-population wording',
  );
  assert.ok(html.includes('$72,000.00'), 'and the overdue section actually renders below it');
});

test('an unparseable overdue amount is a COUNTED FLOOR, never a silent zero', () => {
  // sumCents' contract: the bad row still renders, the subtotal excludes it, and the
  // exclusion is stated — the ERA half's floor idiom, not a crash and not a quiet 0.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], {
        overdueRows: [PROOF_OVERDUE, OR({ expected_date: '2026-06-01', amount: 'garbage' })],
      })}
    />,
  );
  assert.ok(html.includes('$72,000.00'), 'the readable subtotal is exactly the good row');
  assert.ok(
    html.includes('1 overdue row carries an unreadable amount'),
    'the exclusion is stated, not silent',
  );
  assert.ok(html.includes('is a floor'), 'and the subtotal is named a floor');
});

test('an all-overdue book still surfaces stale 024 edits', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({})}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      manual={[
        {
          id: 13,
          kind: 'correct',
          facility_code: 'CAMH',
          payer_label: 'GONE FROM SHEET',
          expected_date: '2026-08-05',
          method_label: null,
          amount: '500.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('No future payments scheduled — 1 overdue'), 'third population');
  assert.ok(
    html.includes('1 manual edit not in effect'),
    'the stale edit is visible exactly when the operator is reconciling by hand',
  );
  assert.ok(
    html.includes('No forecast row at this date, facility and payer'),
    'and it says WHY — the strip heading is reason-neutral now that two reasons exist',
  );
});

test('overdue truncation is announced per partition and names the drop direction', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE], overdueTruncated: true })}
    />,
  );
  assert.ok(html.includes('Overdue list capped'), 'truncation is stated');
  assert.ok(html.includes('newest overdue were dropped'), 'oldest-first retention is stated');
});

// ---------------------------------------------------------------------------
// OVERDUE CONTROLS. Overdue was the ONE row class with no buttons at all — the highest-value
// row on the tile (Alec's ruling 2026-08-03) and the only one that could not be marked landed
// or not-coming. With every live forecast row currently overdue, that made the entire forecast
// half of the tile unactionable.
// ---------------------------------------------------------------------------

test('overdue rows carry Mark landed / Not coming for a super admin, labelled as overdue', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      canEdit
    />,
  );
  assert.ok(
    html.includes('aria-label="Mark landed: KWC BCBS AR 2026-05-26 (overdue)"'),
    'the highest-value row can finally be confirmed landed',
  );
  assert.ok(
    html.includes('aria-label="Mark not coming: KWC BCBS AR 2026-05-26 (overdue)"'),
    '…and marked not coming',
  );
  // The context suffix is not decoration: a screen-reader user tabbing this flat list is a long
  // way from the section heading, and the same row can also appear in the group table.
  assert.ok(html.includes('(overdue)'), 'the section is named in the accessible label');
});

test('THE MISSED CALL SITE: the all-overdue empty state renders the controls too', () => {
  // This branch fires only when the ENTIRE tile is overdue (zero remits, zero upcoming) — which
  // is exactly the state the controls exist for, and a state no populated-tile fixture reaches.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({})}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      canEdit
    />,
  );
  assert.ok(
    html.includes('No future payments scheduled — 1 overdue expected payment below.'),
    'still the approved third-population wording',
  );
  assert.ok(
    html.includes('aria-label="Mark landed: KWC BCBS AR 2026-05-26 (overdue)"'),
    'and the second OverdueStrip call site is wired identically to the first',
  );
});

test('overdue controls are absent for everyone but a super admin', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
    />,
  );
  assert.ok(html.includes('$72,000.00') && html.includes('69 days overdue'), 'the read is intact');
  assert.ok(!html.includes('Mark landed'), 'no controls');
  assert.ok(!html.includes('Not coming'), 'none of them');
  assert.ok(!html.includes('cannot be re-dated here'), 'and no editor-only prose');
});

test('a manual-origin row offers Remove row but NOT the correct-amount form', () => {
  // resolveForecast's adds loop never consults the correct map, so a correction keyed to a
  // manual add is unconditionally orphaned. Offering the box would invite an operator to type a
  // dollar figure straight into the not-in-effect strip.
  //
  // The aria-labels lost their "(overdue)" suffix on 2026-08-10 — not a wording change, a
  // LOCATION change. A past-dated manual add now renders in the group table instead of the
  // Overdue strip (see "A PAST-DATED MANUAL ADD STAYS IN THE TABLE"), and `context` is only
  // passed by the strip. The behaviour under test — Remove yes, correct-amount no — is
  // unchanged, and is what this test is actually for.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([])}
      canEdit
      manual={[
        {
          id: 7,
          kind: 'add',
          facility_code: 'KWC',
          payer_label: 'TRICARE',
          expected_date: '2026-07-01',
          method_label: 'Check',
          amount: '1234.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('aria-label="Remove admin edit: KWC TRICARE 2026-07-01"'));
  assert.ok(html.includes('Remove row'), 'a manual add is removed, not un-corrected');
  assert.ok(
    !html.includes('Correct amount: KWC TRICARE 2026-07-01'),
    'no amount box on a row a correction cannot reach',
  );
});

test('a corrected SHEET-origin overdue row keeps the amount form, at the RESOLVED amount', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      canEdit
      manual={[
        {
          id: 9,
          kind: 'correct',
          facility_code: 'KWC',
          payer_label: 'BCBS AR',
          expected_date: '2026-05-26',
          method_label: null,
          amount: '36000.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('aria-label="Correct amount: KWC BCBS AR 2026-05-26 (overdue)"'));
  assert.ok(html.includes('value="36000.00"'), 'the box holds the corrected amount, not 72000.00');
  assert.ok(html.includes('Undo correction'), 'and the delete button reads as an undo');
});

test('forecastRowKey is unique when two forecast rows share date, facility and payer', () => {
  // 023 has no unique index and its header is explicit that two identical forecasts are legal,
  // so the old `date-facility-payer` key collided on legitimate sheet-only data — independently
  // of the duplicate-add defect. These rows also carry an uncontrolled amount input, where a
  // colliding key lets React reuse one row's DOM node for another row's money.
  const R = (over: Partial<ResolvedForecastRow>): ResolvedForecastRow => ({
    expected_date: '2026-05-26',
    facility_code: 'KWC',
    payer_label: 'BCBS AR',
    method_label: 'Check',
    amount: '72000.00',
    is_patient_specific: false,
    origin: 'sheet',
    corrected: false,
    ...over,
  });
  const rows = [R({}), R({ amount: '5.00' }), R({})];
  const keys = rows.map(forecastRowKey);
  assert.equal(new Set(keys).size, 3, 'three rows, three keys');
  // A pipe separator, not a hyphen: an ISO date carries its own hyphens, so 'BCBS-AR' at one
  // facility could otherwise key-collide with a different facility/payer split.
  assert.notEqual(
    forecastRowKey(R({ facility_code: 'KWC', payer_label: 'BCBS-AR' }), 0),
    forecastRowKey(R({ facility_code: 'KWC-BCBS', payer_label: 'AR' }), 0),
  );
});

// ---------------------------------------------------------------------------
// DUPLICATE ADD (the resolver's 'duplicate_of_sheet_row'), end to end through the tile.
// ---------------------------------------------------------------------------

test('REGRESSION: an add duplicating the overdue sheet row renders $72,000 ONCE, not $144,000', () => {
  // The live 2026-08-06 state, asserted through the whole tile: manual add id 15 duplicates the
  // sheet's KWC / BCBS AR / 2026-05-26 row exactly. The strip rendered it twice and summed both.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([], { overdueRows: [PROOF_OVERDUE] })}
      manual={[
        {
          id: 15,
          kind: 'add',
          facility_code: 'KWC',
          payer_label: 'BCBS AR',
          expected_date: '2026-05-26',
          method_label: 'Check',
          amount: '72000.00',
          suppress_reason: null,
          matched_era_key: null,
        },
      ]}
    />,
  );
  assert.ok(html.includes('across 1 expected payment'), 'one payment, one overdue row');
  assert.ok(!html.includes('$144,000.00'), 'the double count is gone');
  assert.ok(html.includes('$72,000.00'), 'and the money is still there, once');
  assert.ok(
    html.includes('The sheet already carries this facility, payer and date ($72,000.00)'),
    'the dropped add is NAMED with the money that is counted instead — never silently skipped',
  );
  assert.ok(html.includes('1 manual edit not in effect'), 'under a reason-neutral heading');
});

// ---------------------------------------------------------------------------
// EDIT FEEDBACK. Failure and success used to be visually identical.
// ---------------------------------------------------------------------------

test('the edit banner mounts BOTH live regions before any text exists', () => {
  const html = renderToStaticMarkup(<ForecastEditBanner outcome={null} />);
  assert.ok(html.includes('role="alert"'), 'the assertive region is in the DOM up front');
  assert.ok(html.includes('role="status"'), 'and the polite one');
  // A live region that is created already containing its text is silent on most screen readers,
  // which is why these are mounted empty rather than rendered on demand.
  assert.ok(!html.includes('ths-alert'), 'but nothing is styled as a message yet');
  assert.ok(!html.includes('ths-tag'), 'and no tag is shown');
});

test('the banner is never colour-only — every tone carries a word', () => {
  const err = renderToStaticMarkup(
    <ForecastEditBanner outcome={{ tone: 'error', text: 'Could not remove that edit.' }} />,
  );
  assert.ok(err.includes('ths-alert') && err.includes('ths-tag-danger'), 'danger treatment');
  assert.ok(err.includes('Not saved'), 'stated in words, not implied by red');
  assert.ok(err.includes('Could not remove that edit.'), 'and the message itself');

  const ok = renderToStaticMarkup(
    <ForecastEditBanner outcome={{ tone: 'ok', text: 'Marked landed — KWC · BCBS AR · 2026-05-26.' }} />,
  );
  assert.ok(ok.includes('ths-tag-ok') && ok.includes('Saved'));
  assert.ok(!ok.includes('ths-alert'), 'success is not an alert');

  const info = renderToStaticMarkup(
    <ForecastEditBanner outcome={{ tone: 'info', text: 'That edit was already gone.' }} />,
  );
  assert.ok(info.includes('No change'), 'an idempotent no-op is not reported as a success');
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

// THE FORM MOVED (2026-08-10). It used to render at the BOTTOM of EraUpcomingBody, below the
// upcoming list, the overdue strip and the hidden strip — inside a tile that is collapsed by
// default. Creating a forecast row therefore took a click, a scroll past three sections, and
// prior knowledge that a form was down there. It now lives in a standalone "Add expected
// payment" button at the top of the Overview tab (AddForecastPanel in overview-kpis.tsx).
//
// These four tests kept their original intent and moved with it: they exercise the exported
// AddForecastForm directly, which is where the behaviour they were always really about lives.
// The fifth pins the move itself, so nothing quietly re-adds a second form to the tile.

const renderForm = (facilityOptions: { code: string; label: string }[]) =>
  renderToStaticMarkup(
    <AddForecastForm
      facilityOptions={facilityOptions}
      payerSuggestions={[]}
      busy={false}
      onEdit={() => {}}
    />,
  );

test('the add form offers facilities as a closed list, never free text', () => {
  const html = renderForm(FACILITIES);
  assert.ok(html.includes('Add an expected payment'), 'the form names itself');
  assert.ok(html.includes('CA MENTAL HEALTH'), 'facilities are selectable, not free text');
  assert.ok(html.includes('KENTUCKY WELLNESS CENTER'));
});

test('THE FORM IS GONE FROM THE TILE — it must not render in two places', () => {
  // Two live forms would be two ways to write the same row, with two states and two banners.
  // The empty tile is the branch that used to carry its own copy, so it is the one asserted.
  const empty = renderToStaticMarkup(
    <EraUpcomingBody data={S({})} canEdit facilityOptions={FACILITIES} />,
  );
  assert.ok(empty.includes('No future payments scheduled'), 'still the calm empty read');
  assert.ok(!empty.includes('Add an expected payment'), 'the tile no longer carries the form');
});

test('Consolidated explains instead of offering a form the server would reject', () => {
  // A write must name one tenant; Consolidated resolves to two entity ids, so the action
  // returns 'pick_a_tenant_view'. Offering the form there would be a guaranteed dead end.
  // The caller ALSO hides the button entirely in that case (overview-kpis.tsx gates on
  // facilityOptions.length > 0) — this is the form's own second line of defence, which is what
  // makes a stale open panel safe rather than merely unlikely.
  const html = renderForm([]);
  assert.ok(!html.includes('<select'), 'no facility picker without a single tenant');
  assert.ok(html.includes('Switch to the BXR or Indigo view'), 'it says what to do instead');
});

test('the amount field constrains itself to a money shape in the markup', () => {
  // The browser blocks a bad value and announces it on the field — the accessible place for
  // the message — before the client check or the Server Action ever see it.
  const html = renderForm(FACILITIES);
  assert.ok(html.includes('pattern="\\d{1,10}(\\.\\d{1,2})?"'), 'money pattern is on the input');
  assert.ok(html.includes('type="date"'), 'native date input, not a parsed text field');
  assert.ok(html.includes('required'), 'the required fields are marked for the browser');
});

test('payerSuggestions dedupes across both feeds, forecast vocabulary first', () => {
  const forecast = buildUpcomingGroups(S({}), OS([OR({ payer_label: 'BCBS' })]).upcoming)
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

// --- HIDDEN BY YOU: an applied suppression must stay reversible on screen ----
//
// The one-way door. "Mark landed" writes a suppress, the resolver applies it, the money leaves
// the tile — and before this strip there was no id on screen to delete it with, so the row
// could never come back. These assert the way out actually renders, in every branch that can
// reach it, and that it never becomes a total.

/** One 'suppress' manual row, the shape the resolver folds. */
const SUP = (over: Partial<ManualForecastRow> = {}): ManualForecastRow => ({
  id: 7,
  kind: 'suppress',
  facility_code: 'KWC',
  payer_label: 'BCBS AR',
  expected_date: '2026-08-05',
  method_label: null,
  amount: null,
  suppress_reason: 'landed',
  matched_era_key: null,
  ...over,
});

test('an applied suppression renders an Undo for a super admin', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-08-05', amount: '72000.00' })])}
      manual={[SUP()]}
      canEdit
    />,
  );
  assert.ok(html.includes('Hidden by you'), 'the strip appears');
  assert.ok(html.includes('$72,000.00'), 'and names the money that left the tile');
  assert.ok(html.includes('marked landed'), 'in the operator vocabulary, not the 024 enum');
  assert.ok(
    html.includes('Undo hiding: KWC BCBS AR 2026-08-05'),
    'with a distinctly-labelled control — several hidden rows can share a payer',
  );
});

test('THE STATE THAT MOST NEEDS IT: hiding the last row still offers the Undo', () => {
  // Suppressing the only forecast row drops the tile into the calm "nothing scheduled" branch.
  // Without the strip there, the operator has just made money vanish and the screen offers
  // nothing to click — the exact one-way door, reached in one plausible click.
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({})}
      overrides={OS([OR({ facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-08-05', amount: '72000.00' })])}
      manual={[SUP()]}
      canEdit
    />,
  );
  assert.ok(html.includes('No future payments scheduled'), 'still the calm empty copy');
  assert.ok(html.includes('Hidden by you'), 'and the way back is on screen');
  assert.ok(html.includes('$72,000.00'));
});

test('hidden money is never summed into a tile total', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-08-05', amount: '72000.00' })])}
      manual={[SUP()]}
      canEdit
    />,
  );
  assert.ok(
    !html.includes('not included in the total above'),
    'no Forecast line — the only forecast row is hidden, so there is no upcoming forecast money',
  );
  assert.ok(html.includes('$100.00'), 'the ERA headline is untouched by what was hidden');
  assert.ok(
    !/Hidden by you[\s\S]{0,400}?across .{0,40}\$72,000\.00 (?:total|hidden)/.test(html),
    'per-row amounts only — a hidden subtotal would put the money back on the tile as a number',
  );
});

test('the hidden strip is super-admin only', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ facility_code: 'KWC', payer_label: 'BCBS AR', expected_date: '2026-08-05', amount: '72000.00' })])}
      manual={[SUP()]}
    />,
  );
  assert.ok(!html.includes('Hidden by you'), 'a viewer who cannot undo is not shown the option');
});

test('a suppression that also killed a manual add says the add comes back', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([])}
      manual={[
        SUP({ id: 7, facility_code: 'KWC', payer_label: 'BCBS TN', expected_date: '2026-08-05' }),
        SUP({
          id: 8,
          kind: 'add',
          facility_code: 'KWC',
          payer_label: 'BCBS TN',
          expected_date: '2026-08-05',
          method_label: 'EFT',
          amount: '32000.00',
          suppress_reason: null,
        }),
      ]}
      canEdit
    />,
  );
  assert.ok(html.includes('Hidden by you'));
  assert.ok(
    html.includes('including the row you added at this date'),
    'the add is recoverable only through its suppress, so the copy has to say so',
  );
  assert.ok(html.includes('$32,000.00'), 'and name the amount that comes back');
});

// --- the stale strip is informational; its BUTTON is not ---------------------

test('Remove edit is hidden from a non-super-admin, but the reason still shows', () => {
  // loadUpcomingManual is deliberately open to any entitled viewer, so an entity admin reads
  // these rows. This was the one edit control on the tile that was never gated — invisible
  // while it failed silently, and a visibly-broken button once failures started speaking.
  const staleProps = {
    data: S({ total: '100.00', remits: 1, groups: [G({})] }),
    overrides: OS([]),
    manual: [SUP({ id: 9, kind: 'correct', amount: '500.00', suppress_reason: null })],
  };
  const viewer = renderToStaticMarkup(<EraUpcomingBody {...staleProps} />);
  assert.ok(viewer.includes('not in effect'), 'the strip itself is informational and stays');
  assert.ok(!viewer.includes('Remove edit'), 'but a viewer who cannot delete gets no button');

  const admin = renderToStaticMarkup(<EraUpcomingBody {...staleProps} canEdit />);
  assert.ok(admin.includes('Remove edit'), 'a super admin does');
});

test('the correct-amount box carries native validation, not a silent return', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '100.00', remits: 1, groups: [G({})] })}
      overrides={OS([OR({ amount: '5000.00' })])}
      canEdit
    />,
  );
  assert.ok(html.includes('Correct amount:'), 'the box renders for a sheet-origin row');
  assert.ok(
    html.includes('pattern="\\d{1,10}(\\.\\d{1,2})?"'),
    'a bad amount is blocked and announced ON THE FIELD rather than swallowed by a bare return',
  );
});
