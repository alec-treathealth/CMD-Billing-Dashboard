/**
 * Qualify mobile — RENDERED-MARKUP amounts-gate tests (Prompt 4b DoD), same standard as Prompt 3:
 * dollar elements are OMITTED from the DOM (not CSS-hidden) when !viewerHasAmountsCapability, proven at
 * all three surfaces — the row summary, the trend sheet, and the detail screen. The row + trend carry
 * no dollars by construction; the detail's Billed/Allowed block is the gated one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwipeRow } from '../components/qualify/m/swipe-row';
import { TrendSheet } from '../components/qualify/m/trend-sheet';
import { DetailSheet } from '../components/qualify/m/detail-sheet';
import { ClaimDetailSheet } from '../components/qualify/m/claim-detail-sheet';
import { qualifyRating } from '../lib/qualify/rating';
import type { QualifyFacility, QualifyCase } from '../lib/qualify/contract';

const FAC: QualifyFacility = {
  rank: 1,
  name: 'MENTAL HEALTH CENTER OF SAN DIEGO',
  facilityKey: 'mental health center of san diego',
  city: 'San Diego',
  state: 'CA',
  pctAllowedOfBilled: 61,
  rating: qualifyRating(61, 812)!,
  streakSignal: null,
  billedAmount: 412300,
  allowedAmount: 251500,
  lineCount: 812,
};

const CASES: QualifyCase[] = [
  {
    id: 1,
    memberIdMasked: '••••••',
    facilityName: 'MENTAL HEALTH CENTER OF SAN DIEGO',
    program: 'OP',
    lastDos: '2026-07-15',
    pctAllowedOfBilled: 63,
    billedAmount: 18400,
    allowedAmount: 11592,
  },
];

const noop = () => {};

test('swipe row markup carries NO dollar values (rating + line count only)', () => {
  const html = renderToStaticMarkup(<SwipeRow facility={FAC} onPass={noop} onWhy={noop} onOpen={noop} />);
  assert.ok(!html.includes('$'), 'no dollar sign in a swipe row');
  for (const v of ['412,300', '251,500', '412300', '251500']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
  assert.ok(html.includes('812 lines this window'), 'shows non-dollar volume');
});

test('trend sheet markup carries NO dollar values (percent + lines only)', () => {
  const html = renderToStaticMarkup(<TrendSheet facility={FAC} onClose={noop} />);
  assert.ok(!html.includes('$'), 'no dollar sign in the trend sheet');
  for (const v of ['412,300', '251,500']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
  assert.ok(html.includes('61%'), 'shows raw pct (non-dollar)');
});

test('detail — NO amounts: Billed/Allowed columns omitted from the DOM', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} />);
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ labels when !hasAmounts');
  assert.ok(!html.includes('$'), 'no dollar sign when !hasAmounts');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('detail — WITH amounts: Billed/Allowed present', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} />);
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'amounts labels present for a capable viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'amounts present for a capable viewer');
});

test('detail — facility-scoped label + tappable claim rows (button per case)', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} />);
  assert.ok(html.includes('Recent claims at this facility'), 'header is facility-scoped, not payer-wide');
  assert.ok(html.includes('<button'), 'each claim line is a tappable button');
});

test('detail — loading state shows a placeholder, no case rows', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={[]} loading hasAmounts onOpenClaim={noop} onClose={noop} />);
  assert.ok(html.includes('Loading claims'), 'loading placeholder while the facility fetch is in flight');
});

test('claim detail — NO amounts: Billed/Allowed dollar block omitted from the DOM', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} onClose={noop} />);
  // "Billed" is unique to the gated dollar block; "Allowed" alone is NOT a valid probe here because the
  // always-shown percent row is labeled "% Allowed". Prove the gated block is gone via Billed + $ + values.
  assert.ok(!html.includes('Billed'), 'no Billed row when !hasAmounts');
  assert.ok(!html.includes('$'), 'no dollar sign when !hasAmounts');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('claim detail — WITH amounts: Billed/Allowed present, member id stays masked', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts onClose={noop} />);
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'amounts labels present for a capable viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'amounts present for a capable viewer');
  assert.ok(html.includes('••••••'), 'member id remains masked in the claim popup');
});
