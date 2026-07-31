/**
 * "ERA-Confirmed Upcoming Payments" — RENDERED-HTML tests on the pure body leaf.
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
 *      zero-dollar clause vanishes at zero rather than rendering "· 0 zero-dollar".
 *
 * EraUpcomingBody is a presentational leaf with relative/type-only imports, so this
 * renders it directly (same harness as qualify-render.test.tsx). No DB, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EraUpcomingBody, paymentMethodLabel } from '../components/dashboard/era-upcoming';
import type { EraUpcomingGroup, EraUpcomingSummary } from '../../src/veris/era835Upcoming.js';

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
  assert.ok(html.includes('No ERA-confirmed payments scheduled'), 'the calm empty read');
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
