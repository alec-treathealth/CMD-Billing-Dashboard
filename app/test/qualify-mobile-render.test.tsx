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
import { mobileBucketStyle } from '../components/qualify/m/colors';
import type { QualifyFacility, QualifyClaim, QualifyPhi } from '../lib/qualify/contract';

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
  confirmedClaims: 700, estimateClaims: 100, unknownClaims: 12, careSetting: 'BOTH',
};

const CASES: QualifyClaim[] = [
  {
    id: 1,
    memberIdMasked: '••••••',
    payerName: 'ANTHEM BLUE CROSS CA',
    facilityName: 'MENTAL HEALTH CENTER OF SAN DIEGO',
    program: 'OP',
    dos: '2026-07-15',
    pctAllowedOfBilled: 63,
    billedAmount: 18400,
    allowedAmount: 11592,
    confidence: 'confirmed',
  },
];

// A mixed-payer facility set for the chip-strip / per-row payer / banner tests: ANTHEM ×2 (avg 50%),
// CIGNA ×1 (20%). Distinct ids so the reveal map / keys stay unique.
const MIXED_CASES: QualifyClaim[] = [
  { id: 11, memberIdMasked: '••••••', payerName: 'ANTHEM BLUE CROSS CA', facilityName: 'MHC', program: 'OP', dos: '2026-07-15', pctAllowedOfBilled: 60, billedAmount: 1000, allowedAmount: 600, confidence: 'confirmed' },
  { id: 12, memberIdMasked: '••••••', payerName: 'ANTHEM BLUE CROSS CA', facilityName: 'MHC', program: 'OP', dos: '2026-07-14', pctAllowedOfBilled: 40, billedAmount: 2000, allowedAmount: 800, confidence: 'confirmed' },
  { id: 13, memberIdMasked: '••••••', payerName: 'CIGNA', facilityName: 'MHC', program: 'IP', dos: '2026-07-13', pctAllowedOfBilled: 20, billedAmount: 3000, allowedAmount: 600, confidence: 'confirmed' },
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
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ labels when !hasAmounts');
  assert.ok(!html.includes('$'), 'no dollar sign when !hasAmounts');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('detail — WITH amounts: Billed/Allowed present', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'amounts labels present for a capable viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'amounts present for a capable viewer');
});

test('detail — facility-scoped label + tappable claim rows (button per case)', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Recent claims at this facility'), 'header is facility-scoped, not payer-wide');
  assert.ok(html.includes('<button'), 'each claim line is a tappable button');
});

test('detail — loading state shows a placeholder, no case rows', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={[]} loading hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Loading claims'), 'loading placeholder while the facility fetch is in flight');
});

test('detail — NOT reveal-capable: no Reveal button, member id stays masked, no PHI in the DOM', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Reveal all'), 'no reveal affordance when !canReveal');
  assert.ok(html.includes('••••••'), 'member id masked');
  for (const v of ['AETMEM777', 'DOE, JANE', 'GRP42']) assert.ok(!html.includes(v), `PHI ${v} absent when not revealed`);
});

test('detail — reveal-capable but not yet shown: Reveal button present, ids still masked', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal />);
  assert.ok(html.includes('Reveal all'), 'reveal affordance shows for a capable viewer');
  assert.ok(html.includes('••••••'), 'ids remain masked until revealed');
  for (const v of ['AETMEM777', 'DOE, JANE']) assert.ok(!html.includes(v), `PHI ${v} absent before reveal`);
});

test('detail — revealed: rows show the real member id + patient, button flips to Hide', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal revealed={REVEALED} phiShown />,
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

test('claim detail — payer shown with the member id, whether masked or revealed', () => {
  const masked = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={null} onClose={noop} />);
  assert.ok(masked.includes('••••••') && masked.includes('ANTHEM BLUE CROSS CA'), 'masked id + payer both present');
  const revealed = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={PHI} onClose={noop} />);
  assert.ok(revealed.includes('AETMEM777') && revealed.includes('ANTHEM BLUE CROSS CA'), 'revealed id + payer coexist (payer is not PHI)');
});

// ── Case-% color parity (Stage 3-color) — the % cell follows the ROW'S OWN pct via mobileBucketStyle
//    (ratingBucket 50/30), NOT the parent facility rating; mirrors the desktop fix (900e084). The detail
//    sheet colors NOTHING by facility rating, so any bucket color in its markup comes from the case %. ─
test('detail — case % cell colored by the case OWN pct: 63% reads ok, 20% reads danger (not the facility)', () => {
  const okHtml = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={[{ ...CASES[0]!, pctAllowedOfBilled: 63 }]} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />,
  );
  assert.ok(okHtml.includes(mobileBucketStyle(63).color), 'a 63% case reads favorable (ok color)');
  const dangerHtml = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={[{ ...CASES[0]!, pctAllowedOfBilled: 20 }]} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />,
  );
  assert.ok(dangerHtml.includes(mobileBucketStyle(20).color), 'a 20% case reads unfavorable (danger color) — its own pct, not the facility');
});

test('detail — null case pct stays neutral (no favorable/unfavorable tint)', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={[{ ...CASES[0]!, pctAllowedOfBilled: null }]} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />,
  );
  assert.ok(html.includes(mobileBucketStyle(null).color), 'null pct → neutral color');
  assert.ok(!html.includes(mobileBucketStyle(63).color), 'a null pct never reads as favorable');
});

test('claim detail — % Allowed value colored by the claim OWN pct (danger at 20%)', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={{ ...CASES[0]!, pctAllowedOfBilled: 20 }} hasAmounts={false} phi={null} onClose={noop} />);
  assert.ok(html.includes(mobileBucketStyle(20).color), 'the % Allowed value is danger-colored by its own pct');
});

// ── Per-row payer + payer chip strip (all-payers facility drill) ───────────────────────────────────
test('detail — each claim row shows the payer next to the (masked) member id', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('••••••') && html.includes('ANTHEM BLUE CROSS CA'), 'masked id + payer both present on the row');
});

test('detail — payer stays visible when IDs are revealed (real id · payer)', () => {
  const revealedAnthem = new Map<number, QualifyPhi>([[1, { patient_name: 'DOE, JANE', member_id_raw: 'EAZ8567', group_number: 'G1' }]]);
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} canReveal revealed={revealedAnthem} phiShown />);
  assert.ok(html.includes('EAZ8567') && html.includes('ANTHEM BLUE CROSS CA'), 'revealed id and payer coexist (payer is not PHI)');
});

test('detail — payer chip strip groups by payer: name · count · avg%, one chip per payer', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('ANTHEM BLUE CROSS CA') && html.includes('CIGNA'), 'every payer at the facility gets a chip');
  assert.ok(html.includes('· 2 ·') && html.includes('· 1 ·'), 'chips carry per-payer claim counts (ANTHEM 2, CIGNA 1)');
  assert.ok(html.includes('50%') && html.includes('20%'), 'chips carry avg allowed% (ANTHEM 50, CIGNA 20)');
});

test('detail — chip avg% is colored by the same thresholds as the rows (ANTHEM 50 ok, CIGNA 20 danger)', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes(mobileBucketStyle(50).color), 'a 50% avg reads ok');
  assert.ok(html.includes(mobileBucketStyle(20).color), 'a 20% avg reads danger');
});

// ── Chip strip LAYOUT (device clipping/snap regression) — the strip contains chips with vertical room and
//    snaps to chip boundaries; the payer name ellipsizes while the count/avg suffix is never clipped. ────
test('detail — chip strip is a snap scroller with vertical containment; every payer chip renders', () => {
  const FOUR: QualifyClaim[] = ['AETNA', 'CIGNA', 'ANTHEM BLUE CROSS OF CALIFORNIA', 'BCBS'].map((p, i) => ({
    id: 20 + i, memberIdMasked: '••••••', payerName: p, facilityName: 'MHC', program: 'OP',
    dos: '2026-07-15', pctAllowedOfBilled: 55, billedAmount: 100, allowedAmount: 55,
    confidence: 'confirmed' as const,
  }));
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={FOUR} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  for (const p of ['AETNA', 'CIGNA', 'ANTHEM BLUE CROSS OF CALIFORNIA', 'BCBS']) assert.ok(html.includes(p), `chip ${p} present`);
  assert.match(html, /scroll-snap-type:\s*x proximity/, 'the strip is a horizontal snap scroller');
  assert.match(html, /scroll-snap-align:\s*start/, 'chips snap to their start edge');
  assert.match(html, /overflow-y:\s*hidden/, 'no vertical scroll/clip on the strip');
  assert.match(html, /text-overflow:\s*ellipsis/, 'the payer name truncates with an ellipsis');
});

// ── Search-context banner — seeded only when opened from a prefix search; drives the initial filter ──
test('detail — search context banner shows the term + a Show-all count', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} searchContext={{ term: 'EAZ', payer: 'ANTHEM BLUE CROSS CA' }} />,
  );
  assert.ok(html.includes('EAZ') && html.includes('claims'), 'banner names the search term');
  assert.ok(html.includes('Show all 3'), 'Show-all count is the full (all-payers) total');
});

test('detail — no search context: no banner (opened from the strength list directly)', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Show all'), 'no banner when opened without a search term');
});

test('detail — capped: counts read "N recent" so they are not mistaken for the facility total', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} capped searchContext={{ term: 'EAZ', payer: 'ANTHEM BLUE CROSS CA' }} />,
  );
  assert.ok(html.includes('Show all 3 recent'), 'the Show-all count is labeled recent when capped');
  assert.ok(html.includes('most recent claims across payers'), 'a caption states the loaded set is the recent cap');
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
