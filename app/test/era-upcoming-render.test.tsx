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
 *      and the truncation footnote appears only when the breakdown was capped.
 *
 * EraUpcomingBody is a presentational leaf with relative/type-only imports, so this
 * renders it directly (same harness as qualify-render.test.tsx). No DB, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EraUpcomingBody } from '../components/dashboard/era-upcoming';
import type { EraUpcomingGroup, EraUpcomingSummary } from '../../src/veris/era835Upcoming.js';

const G = (over: Partial<EraUpcomingGroup>): EraUpcomingGroup => ({
  payment_date: '2026-08-03',
  payer_name: 'ACME HEALTH PLAN',
  payment_method: 'ACH',
  remits: 1,
  amount: '100.00',
  unquantified_remits: 0,
  ...over,
});

const S = (over: Partial<EraUpcomingSummary>): EraUpcomingSummary => ({
  total: '0.00',
  remits: 0,
  unquantified_remits: 0,
  groups: [],
  groups_truncated: false,
  ...over,
});

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
  assert.ok(html.includes('3 remits'), 'remit count');
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

test('truncation footnote appears when the breakdown was capped', () => {
  const html = renderToStaticMarkup(
    <EraUpcomingBody
      data={S({ total: '10.00', remits: 60, groups: [G({})], groups_truncated: true })}
    />,
  );
  assert.ok(html.includes('capped at the first 50'), 'silent truncation is not allowed');
  assert.ok(html.includes('include everything'), 'and the headline is stated to be uncapped');
});
