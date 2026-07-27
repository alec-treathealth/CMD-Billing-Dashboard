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
import { MobileFacilityList } from '../components/qualify/m/facility-list';
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
  distinctPatients: 60,
  confirmedClaims: 700, estimateClaims: 100, unknownClaims: 12, careSetting: 'BOTH', entity: 'Indigo',
};

const CASES: QualifyClaim[] = [
  {
    id: 1,
    memberIdMasked: '••••••',
    payerName: 'ANTHEM BLUE CROSS CA',
    facilityName: 'MENTAL HEALTH CENTER OF SAN DIEGO',
    program: 'OP',
    dos: '2026-07-15',
    paymentDate: '2026-07-20',
    pctAllowedOfBilled: 63,
    billedAmount: 18400,
    allowedAmount: 11592,
    confidence: 'confirmed',
    patientKey: 1,
  },
];

// A mixed-payer facility set for the chip-strip / per-row payer / banner tests: ANTHEM ×2 (avg 50%),
// CIGNA ×1 (20%). Distinct ids so the reveal map / keys stay unique.
const MIXED_CASES: QualifyClaim[] = [
  { id: 11, memberIdMasked: '••••••', payerName: 'ANTHEM BLUE CROSS CA', facilityName: 'MHC', program: 'OP', dos: '2026-07-15', paymentDate: '2026-07-20', pctAllowedOfBilled: 60, billedAmount: 1000, allowedAmount: 600, confidence: 'confirmed', patientKey: 1 },
  { id: 12, memberIdMasked: '••••••', payerName: 'ANTHEM BLUE CROSS CA', facilityName: 'MHC', program: 'OP', dos: '2026-07-14', paymentDate: '2026-07-19', pctAllowedOfBilled: 40, billedAmount: 2000, allowedAmount: 800, confidence: 'confirmed', patientKey: 2 },
  { id: 13, memberIdMasked: '••••••', payerName: 'CIGNA', facilityName: 'MHC', program: 'IP', dos: '2026-07-13', paymentDate: '2026-07-18', pctAllowedOfBilled: 20, billedAmount: 3000, allowedAmount: 600, confidence: 'confirmed', patientKey: 3 },
];

const noop = () => {};

// Default reveal props for a MASKED DetailSheet (no reveal capability / nothing revealed). Per-patient
// reveal (Part 2): the sheet only DISPLAYS the `revealed` cache; the trigger lives in the claim popup.
const noReveal = {
  canReveal: false,
  revealed: new Map<number, QualifyPhi>(),
  revealError: null as string | null,
  onHideIdentifiers: noop,
};
// A revealed-PHI fixture keyed by case id, used to prove the unmasked render.
const PHI: QualifyPhi = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEM777', group_number: 'GRP42' };
const REVEALED = new Map<number, QualifyPhi>([[1, PHI]]);

// Phase 4b NOTE — the per-row swipe GESTURE is retired: paging moved to the list CONTAINER
// (facility-list.tsx). SwipeRow is a plain tappable card again (tap → open; on-card WHY control → the
// trend sheet). The former per-row gesture was NEVER mountable under this harness (documented Stage-3a
// limit), so no async test is voided; this markup test drops the pass/stamp assertions (stamps are gone)
// and adds the tap-to-open + WHY-control aria-labels.
test('list card (Phase 4b) — no dollars; rank + LOC tag + coverage bar; tap-to-open + WHY control; no swipe stamps', () => {
  const html = renderToStaticMarkup(<SwipeRow facility={FAC} onWhy={noop} onOpen={noop} />);
  assert.ok(!html.includes('$'), 'no dollar sign in a list card');
  for (const v of ['412,300', '251,500', '412300', '251500']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
  assert.ok(html.includes('812 lines'), 'shows non-dollar line volume');
  assert.ok(html.includes('60 patients'), 'shows the distinct-patient count (the sample-gate unit)');
  assert.ok(html.includes('>Both<'), 'careSetting renders as the LOC tag');
  // the per-row swipe stamps are GONE (no "Next 5" / "Pass" vocabulary — paging is a container gesture now).
  assert.ok(!html.includes('Next 5') && !html.includes('>Pass<'), 'no per-row swipe stamps remain');
  // Part C: the card body is the tap-to-open target; the dedicated WHY control renders with its aria-label.
  assert.ok(html.includes('aria-label="Open MENTAL HEALTH CENTER OF SAN DIEGO claims"'), 'card body opens the detail on tap');
  assert.ok(html.includes('aria-label="Why this rating for MENTAL HEALTH CENTER OF SAN DIEGO"'), 'the WHY control renders with its aria-label');
  assert.ok(html.includes('#2e8b6f') || html.includes('rgb(46, 139, 111)'), 'confirmed coverage segment painted');
  assert.ok(html.includes('#c9881e') || html.includes('rgb(201, 136, 30)'), 'estimate segment amber — never green');
});

test('SAMPLE GATE (mobile) — a 1-patient card is neutral + "Insufficient", rating suppressed; ≥10 keeps its color', () => {
  const thin = { ...FAC, distinctPatients: 1 };
  const thinHtml = renderToStaticMarkup(<SwipeRow facility={thin} onWhy={noop} onOpen={noop} />);
  assert.ok(thinHtml.includes('Insufficient'), 'a <3-patient card labels "Insufficient"');
  assert.ok(thinHtml.includes('#6B7B79') || thinHtml.includes('rgb(107, 123, 121)'), 'neutral gray, not a rating color');
  assert.ok(!/>61<\/div>/.test(thinHtml), 'the confident rating number is suppressed');
  assert.ok(/1 patient\b/.test(thinHtml), 'patient count visible');
  // Adequate sample → color + rating intact (the gate suppresses thin slices, not the rating).
  const okHtml = renderToStaticMarkup(<SwipeRow facility={{ ...FAC, distinctPatients: 12 }} onWhy={noop} onOpen={noop} />);
  assert.ok(okHtml.includes('>61<') && okHtml.includes('Strong'), 'a well-sampled card keeps its rating + Strong label');
});

// An identifier-scoped list (scoped) is EXEMPT from the gate — one known patient by construction.
test('SAMPLE GATE (mobile) — an identifier-scoped list is EXEMPT (keeps the raw rating on 1 patient)', () => {
  const html = renderToStaticMarkup(
    <MobileFacilityList
      facilities={[{ ...FAC, rank: 1, distinctPatients: 1 }]}
      page={0} scoped onPageNext={noop} onPagePrev={noop} onWhy={noop} onOpen={noop}
    />,
  );
  assert.ok(html.includes('>61<'), 'scoped (identifier) view keeps the rating even at 1 patient');
  assert.ok(!html.includes('Insufficient'), 'no insufficient-data suppression on the identifier-scoped path');
});

// ── List container (Phase 4b) — Part A scope + Part B paging, rendered ───────────────────────────────
// N distinct-rank facilities off the base fixture (rank drives the SwipeRow key + is unique per card).
const facN = (n: number): QualifyFacility[] =>
  Array.from({ length: n }, (_, i) => ({ ...FAC, rank: i + 1, name: `FAC ${i + 1}`, facilityKey: `fac-${i + 1}` }));
const whyCount = (html: string) => (html.match(/aria-label="Why this rating for /g) || []).length;

test('facility list — an identifier-search scope shows exactly ONE card, no pager / indicator / hint', () => {
  const html = renderToStaticMarkup(
    <MobileFacilityList
      facilities={[{ ...FAC, rank: 4, name: 'LANDING FAC', facilityKey: 'landing' }]}
      page={0} scoped onPageNext={noop} onPagePrev={noop} onWhy={noop} onOpen={noop}
    />,
  );
  assert.equal(whyCount(html), 1, 'the scoped identifier view is a single card');
  assert.ok(html.includes('LANDING FAC'), 'the landing facility renders');
  assert.ok(!html.includes('Page 1 of'), 'no page indicator on the single scoped card');
  assert.ok(!html.includes('Swipe left or right'), 'no swipe hint on the scoped view');
});

test('facility list — a payer-browse of 7 shows UP TO 5 cards + a page indicator (page 1 of 2)', () => {
  const html = renderToStaticMarkup(
    <MobileFacilityList
      facilities={facN(7)} page={0} scoped={false}
      onPageNext={noop} onPagePrev={noop} onWhy={noop} onOpen={noop}
    />,
  );
  assert.equal(whyCount(html), 5, 'the 5-up window renders, not all 7');
  assert.ok(html.includes('aria-label="Page 1 of 2"'), 'the page indicator reflects 2 pages');
  assert.ok(html.includes('1–5 of 7'), 'the page label counts the full filtered set');
  assert.ok(html.includes('Swipe left or right to page'), 'the browse swipe hint renders');
});

test('facility list — page 1 of a 7-list shows the remainder (cards 6–7) and the label advances', () => {
  const html = renderToStaticMarkup(
    <MobileFacilityList
      facilities={facN(7)} page={1} scoped={false}
      onPageNext={noop} onPagePrev={noop} onWhy={noop} onOpen={noop}
    />,
  );
  assert.equal(whyCount(html), 2, 'the last page carries the 2-card remainder');
  assert.ok(html.includes('aria-label="Page 2 of 2"') && html.includes('6–7 of 7'), 'the indicator + label reflect the second page');
});

test('facility list — a short browse list (<=5) shows every card and NO swipe hint (single page)', () => {
  const html = renderToStaticMarkup(
    <MobileFacilityList
      facilities={facN(3)} page={0} scoped={false}
      onPageNext={noop} onPagePrev={noop} onWhy={noop} onOpen={noop}
    />,
  );
  assert.equal(whyCount(html), 3);
  assert.ok(!html.includes('Swipe left or right'), 'no swipe hint when there is only one page');
  assert.ok(html.includes('1–3 of 3'), 'the single-page label still shows the count');
});

test('trend sheet markup carries NO dollar values (percent + lines only)', () => {
  const html = renderToStaticMarkup(<TrendSheet facility={FAC} onClose={noop} />);
  assert.ok(!html.includes('$'), 'no dollar sign in the trend sheet');
  for (const v of ['412,300', '251,500']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
  assert.ok(html.includes('61%'), 'shows raw pct (non-dollar)');
});

test('trend sheet (Phase 4) — the why-sheet carries the coverage breakdown + the reversal note', () => {
  const html = renderToStaticMarkup(<TrendSheet facility={FAC} onClose={noop} />);
  assert.ok(html.includes('Confirmed claims'), 'confirmed count row');
  assert.ok(html.includes('Estimates (excluded)'), 'estimate count row, labeled excluded');
  assert.ok(html.includes('Rated on 700 of 812 claims'), 'coverage caption from the Phase-0 counts');
  assert.ok(html.includes('payer reversals we'), 'the estimate explanation note renders');
});

test('trend sheet — shows the facility City, ST under the name (parity with the card + detail)', () => {
  const html = renderToStaticMarkup(<TrendSheet facility={FAC} onClose={noop} />);
  assert.ok(html.includes('San Diego, CA'), 'the trend sheet header carries City, ST like the card and detail sheet');
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

test('detail — a claim row shows BOTH the payment date (sort axis) and the service date (DOS)', () => {
  // CASES[0]: paymentDate 2026-07-20, dos 2026-07-15 — both must render, labeled, same as desktop.
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Paid 2026-07-20'), 'the payment date renders on the sheet claim row');
  assert.ok(html.includes('DOS 2026-07-15'), 'the service date (DOS) renders alongside it');
});

test('detail — loading state shows a placeholder, no case rows', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={[]} loading hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(html.includes('Loading claims'), 'loading placeholder while the facility fetch is in flight');
});

test('detail — NOT reveal-capable: no reveal chrome, member id stays masked, no PHI in the DOM', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} />);
  assert.ok(!html.includes('Reveal all') && !html.includes('Hide IDs') && !html.includes('Tap a claim to reveal'), 'no reveal chrome when !canReveal');
  assert.ok(html.includes('••••••'), 'member id masked');
  for (const v of ['AETMEM777', 'DOE, JANE', 'GRP42']) assert.ok(!html.includes(v), `PHI ${v} absent when not revealed`);
});

test('detail — reveal-capable, nothing revealed: the "Tap a claim to reveal" hint (NO blanket toggle); ids masked', () => {
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal />);
  assert.ok(!html.includes('Reveal all'), 'the blanket "Reveal all" is GONE');
  assert.ok(html.includes('Tap a claim to reveal'), 'the per-patient reveal is triggered from the claim popup — the header hints so');
  assert.ok(html.includes('••••••'), 'ids remain masked until a patient is revealed');
  for (const v of ['AETMEM777', 'DOE, JANE']) assert.ok(!html.includes(v), `PHI ${v} absent before reveal`);
});

test('detail — a CACHED patient renders real id + patient on its row; the header shows the Hide reset', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts={false} onOpenClaim={noop} onClose={noop} {...noReveal} canReveal revealed={REVEALED} />,
  );
  assert.ok(html.includes('AETMEM777'), 'real member id shown for the cached patient');
  assert.ok(html.includes('DOE, JANE'), 'patient name shown for the cached patient');
  assert.ok(html.includes('Hide IDs'), 'the per-session Hide reset shows once something is revealed');
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

test('claim detail — shows a Payment date row alongside DOS (parity with the list + desktop)', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={null} onClose={noop} />);
  assert.ok(html.includes('Payment date') && html.includes('2026-07-20'), 'the claim popup shows the payment date (sort axis)');
  assert.ok(html.includes('DOS') && html.includes('2026-07-15'), 'DOS (service date) stays');
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
  const html = renderToStaticMarkup(<DetailSheet facility={FAC} claims={CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} canReveal revealed={revealedAnthem} />);
  assert.ok(html.includes('EAZ8567') && html.includes('ANTHEM BLUE CROSS CA'), 'revealed id and payer coexist (payer is not PHI)');
});

// ── ClaimDetailSheet — the PER-PATIENT reveal trigger (Part 2) ───────────────────────────────────────
test('claim detail — canReveal + no phi: a "Reveal identifiers" button renders; ids masked', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={null} canReveal onReveal={noop} onClose={noop} />);
  assert.ok(html.includes('Reveal identifiers'), 'the per-patient reveal button shows for a capable viewer with nothing revealed');
  assert.ok(html.includes('••••••'), 'the member id stays masked until revealed');
});

test('claim detail — once phi is present: NO reveal button (the patient is revealed)', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={PHI} canReveal onReveal={noop} onClose={noop} />);
  assert.ok(!html.includes('Reveal identifiers'), 'the reveal button is gone once the patient is revealed');
  assert.ok(html.includes('AETMEM777'), 'the real member id shows');
});

test('claim detail — NOT reveal-capable: no reveal button at all', () => {
  const html = renderToStaticMarkup(<ClaimDetailSheet claim={CASES[0]!} hasAmounts={false} phi={null} onClose={noop} />);
  assert.ok(!html.includes('Reveal identifiers'), 'no reveal affordance when !canReveal');
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
    dos: '2026-07-15', paymentDate: '2026-07-20', pctAllowedOfBilled: 55, billedAmount: 100, allowedAmount: 55,
    confidence: 'confirmed' as const,
    patientKey: i + 1,
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

test('detail — capped (>500 window): honest "narrow the window" nudge; NOT shown for a small set', () => {
  const capped = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} capped />,
  );
  assert.ok(capped.includes('Showing the 500 most recent by payment date') && capped.includes('narrow the window'), 'the cap nudge shows when truncated');
  const full = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />,
  );
  assert.ok(!full.includes('narrow the window'), 'no nudge for a set under the cap (the whole window fits)');
});

test('detail — the full loaded window renders (no 50-cap truncation): every claim row shows', () => {
  const html = renderToStaticMarkup(
    <DetailSheet facility={FAC} claims={MIXED_CASES} loading={false} hasAmounts onOpenClaim={noop} onClose={noop} {...noReveal} />,
  );
  // MIXED_CASES = 3 claims across 2 payers; all three render as tappable rows (grouped by payer chips).
  const rows = (html.match(/type="button"/g) || []).length;
  assert.ok(rows >= 3, 'every loaded claim renders — nothing hidden behind a page');
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

// ── Redesign: the mobile "Facilities heating up" chips (facility-shaped, defined n, hybrid tap) ──────
test('mobile heating-up chips — facility-shaped with rating, Δpts, and the DEFINED n (claim lines)', async () => {
  const { HeatingUp } = await import('../components/qualify/m/heating-up');
  const { trailingWindow } = await import('../lib/qualify/contract');
  const trends = [
    {
      facilityKey: 'summit ridge', name: 'SUMMIT RIDGE RECOVERY', city: 'Scottsdale', state: 'AZ',
      careSetting: 'IP' as const, entity: 'BXR' as const, dominantPayer: 'AETNA', lineCount: 210,
      currentRating: 68, priorRating: 62.9, deltaPts: 5.1, points: [61, 64, 66, 68],
    },
    {
      facilityKey: 'fresh face', name: 'FRESH FACE BH', city: null, state: null,
      careSetting: null, entity: null, dominantPayer: null, lineCount: 12,
      currentRating: 55, priorRating: null, deltaPts: null, points: [55],
    },
  ];
  const html = renderToStaticMarkup(<HeatingUp trends={trends} window={trailingWindow(30)} onOpen={() => {}} />);
  assert.ok(html.includes('Facilities Heating Up'), 'facility-shaped module title');
  assert.ok(html.includes('SUMMIT RIDGE RECOVERY'), 'facility name renders');
  assert.ok(html.includes('210 claim lines'), 'Change A: n defined as claim lines on mobile too');
  assert.ok(!/\bn=\d/.test(html), 'no bare n=');
  assert.ok(html.includes('+5.1 pts'), 'delta ticker');
  assert.ok(html.includes('· new'), 'null-prior facility reads new');
  assert.ok(html.includes('disabled'), 'a chip with no dominant payer is not tappable (never a dead resolve)');
  assert.equal(renderToStaticMarkup(<HeatingUp trends={[]} window={trailingWindow(30)} onOpen={() => {}} />), '', 'empty render with no trends');
});
