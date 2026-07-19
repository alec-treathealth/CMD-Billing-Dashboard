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
import { AreaChips, deriveAreaChips, facilitiesInArea, AREA_ALL, AREA_OTHER } from '../components/qualify/m/area-chips';
import { qualifyRating } from '../lib/qualify/rating';
import type { QualifyFacility, QualifyCase, QualifyPhi } from '../lib/qualify/contract';

const FAC: QualifyFacility = {
  rank: 1,
  name: 'MENTAL HEALTH CENTER OF SAN DIEGO',
  facilityKey: 'mental health center of san diego',
  city: 'San Diego',
  state: 'CA',
  pctAllowedOfBilled: 61,
  rating: qualifyRating(61)!,
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

// Default reveal props for a MASKED DetailSheet (no reveal capability / nothing revealed).
const noReveal = {
  canReveal: false,
  revealed: new Map<number, QualifyPhi>(),
  phiShown: false,
  revealPending: false,
  revealError: null as string | null,
  onRevealAll: noop,
};
// A revealed-PHI fixture keyed by case id, used to prove the unmasked render.
const PHI: QualifyPhi = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEM777', group_number: 'GRP42' };
const REVEALED = new Map<number, QualifyPhi>([[1, PHI]]);

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
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ labels when !hasAmounts');
  assert.ok(!html.includes('$'), 'no dollar sign when !hasAmounts');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('detail — WITH amounts: Billed/Allowed present', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'amounts labels present for a capable viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'amounts present for a capable viewer');
});

test('detail — facility-scoped label + tappable claim rows (button per case)', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Recent claims at this facility'), 'header is facility-scoped, not payer-wide');
  assert.ok(html.includes('<button'), 'each claim line is a tappable button');
});

test('detail — loading state shows a placeholder, no case rows', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={[]} loading hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Loading claims'), 'loading placeholder while the facility fetch is in flight');
});

test('detail — NOT reveal-capable: no Reveal button, member id stays masked, no PHI in the DOM', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Reveal all'), 'no reveal affordance when !canReveal');
  assert.ok(html.includes('••••••'), 'member id masked');
  for (const v of ['AETMEM777', 'DOE, JANE', 'GRP42']) assert.ok(!html.includes(v), `PHI ${v} absent when not revealed`);
});

test('detail — reveal-capable but not yet shown: Reveal button present, ids still masked', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal />);
  assert.ok(html.includes('Reveal all'), 'reveal affordance shows for a capable viewer');
  assert.ok(html.includes('••••••'), 'ids remain masked until revealed');
  for (const v of ['AETMEM777', 'DOE, JANE']) assert.ok(!html.includes(v), `PHI ${v} absent before reveal`);
});

test('detail — revealed: rows show the real member id + patient, button flips to Hide', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} cases={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal revealed={REVEALED} phiShown />,
  );
  assert.ok(html.includes('AETMEM777'), 'real member id shown when revealed');
  assert.ok(html.includes('DOE, JANE'), 'patient name shown when revealed');
  assert.ok(html.includes('Hide IDs'), 'button flips to Hide once shown');
  assert.ok(!html.includes('••••••'), 'the mask is gone for the revealed row');
});

test('claim detail — NO amounts: Billed/Allowed dollar block omitted from the DOM', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={null} onClose={noop} />);
  // "Billed" is unique to the gated dollar block; "Allowed" alone is NOT a valid probe here because the
  // always-shown percent row is labeled "% Allowed". Prove the gated block is gone via Billed + $ + values.
  assert.ok(!html.includes('Billed'), 'no Billed row when !hasAmounts');
  assert.ok(!html.includes('$'), 'no dollar sign when !hasAmounts');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('claim detail — WITH amounts, phi null: Billed/Allowed present, member id stays masked', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts phi={null} onClose={noop} />);
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'amounts labels present for a capable viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'amounts present for a capable viewer');
  assert.ok(html.includes('••••••'), 'member id remains masked in the claim popup when phi is null');
});

test('claim detail — revealed phi: shows the real member id, patient, and group #', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={PHI} onClose={noop} />);
  assert.ok(html.includes('AETMEM777'), 'real member id shown');
  assert.ok(html.includes('DOE, JANE'), 'patient name shown');
  assert.ok(html.includes('GRP42'), 'group number shown');
  assert.ok(!html.includes('••••••'), 'no mask once revealed');
});

// ── Area filter chips ────────────────────────────────────────────────────────────────────────────
const facAt = (state: string | null, rank: number): QualifyFacility => ({
  ...FAC, rank, name: `FAC ${rank}`, facilityKey: `fac-${rank}`, state, city: state ? 'City' : null,
});
const MIXED = [facAt('TX', 1), facAt('CA', 2), facAt(null, 3), facAt('CA', 4)];

test('deriveAreaChips: All first, distinct states sorted, Other only when a null-state facility exists', () => {
  const chips = deriveAreaChips(MIXED);
  assert.deepEqual(chips.map((c) => c.key), [AREA_ALL, 'CA', 'TX', AREA_OTHER]); // states alpha-sorted, Other last
  assert.equal(chips[0]!.label, 'All');
});

test('deriveAreaChips: no Other bucket when every facility has a state; single-state ⇒ 2 chips (parent hides)', () => {
  const chips = deriveAreaChips([facAt('CA', 1), facAt('CA', 2)]);
  assert.deepEqual(chips.map((c) => c.key), [AREA_ALL, 'CA']);
  assert.ok(chips.length <= 2, 'parent hides the row when <2 real buckets');
});

test('facilitiesInArea: All returns everything; a state returns only that state; Other returns null-state only', () => {
  assert.equal(facilitiesInArea(MIXED, AREA_ALL).length, 4);
  assert.deepEqual(facilitiesInArea(MIXED, 'CA').map((f) => f.rank), [2, 4]);
  assert.deepEqual(facilitiesInArea(MIXED, 'TX').map((f) => f.rank), [1]);
  assert.deepEqual(facilitiesInArea(MIXED, AREA_OTHER).map((f) => f.rank), [3]); // the null-state facility is NOT dropped
});

test('AreaChips: renders every chip label and marks the active one pressed', () => {
  const html = renderToStaticMarkup(<AreaChips chips={deriveAreaChips(MIXED)} active="CA" onSelect={noop} />);
  for (const label of ['All', 'CA', 'TX', 'Other']) assert.ok(html.includes(`>${label}</button>`), `chip ${label} present`);
  assert.match(html, /aria-pressed="true"[^>]*>CA<\/button>/, 'the active (CA) chip is pressed');
  assert.match(html, /aria-pressed="false"[^>]*>TX<\/button>/, 'an inactive chip (TX) is not pressed');
});
