/**
 * Qualify — RENDERED-HTML tests (DoD, Prompts 3 + 3c). Render the actual components to markup and
 * assert on the real HTML:
 *   1) amounts capability gates every dollar element via DOM OMISSION (absent, not CSS-hidden),
 *   2) facility color derives from its rating (= its allowed%); the % ALLOWED case cell derives from the
 *      CASE'S OWN allowed% via the same ratingBucket helper (50/30) — the two scales don't cross-contaminate, and
 *   3) PHI reveal (3c): masked by default, real only after reveal — and reveal is INDEPENDENT of the
 *      amounts gate (revealing PHI never surfaces dollars).
 *
 * Runs under app/ (where react-dom resolves) via `npm test`. Presentational leaves imported by
 * relative path; they use relative/type-only imports, so no `@/` alias resolution is needed under tsx.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FacilityPanel } from '../components/qualify/facility-panel';
import { CasesTable } from '../components/qualify/cases-table';
import { CohortSheet } from '../components/qualify/cohort-sheet';
import { BookKpiTiles, EvidenceGauge } from '../components/qualify/overview';
import { HeatingUpCards } from '../components/qualify/shared/heating-ticker';
import { Spark } from '../components/qualify/spark';
import { buildFacilityBucketMap } from '../components/qualify/colors';
import { qualifyRating, ratingBucket, RATING_LEGEND } from '../lib/qualify/rating';
import { trailingWindow } from '../lib/qualify/contract';
import type {
  QualifyFacility,
  QualifyClaim,
  QualifyBookKpis,
  QualifyFacilityTrend,
  QualifyPhi,
} from '../lib/qualify/contract';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { PolicyStrip } from '../components/qualify/policy-strip';
import { WindowLadder } from '../components/qualify/window-ladder';
import type { QualifyPolicyCard, QualifyWindowLadder, QualifyFactorReading } from '../lib/qualify/contract';

const solidRating = qualifyRating(55)!; // 55 → ok
const thinHighRating = qualifyRating(90)!; // 90 → ok (value-first: a small high-% facility reads GREEN)
const lowRating = qualifyRating(24)!; // 24 → danger (a genuinely weak reimbursement)

const SOLID: QualifyFacility = {
  ...QUALIFY_FACILITY_V2_NULLS,
  rank: 1, name: 'SOLID', facilityKey: 'solid', city: 'Boulder', state: 'CO',
  pctAllowedOfBilled: 55, rating: solidRating, streakSignal: null,
  billedAmount: 308900, allowedAmount: 166800, lineCount: 400, distinctPatients: 40,
  confirmedClaims: 380, estimateClaims: 15, unknownClaims: 5, careSetting: 'OP', entity: 'BXR',
};
// THIN_HIGH: 90% on ONE patient — the sample gate (hotfix 2026-07-27) suppresses its color to
// neutral ("insufficient data"), even though the value-first rating itself is 90 (→ ratingBucket ok).
const THIN_HIGH: QualifyFacility = {
  ...QUALIFY_FACILITY_V2_NULLS,
  rank: 2, name: 'THIN HIGH', facilityKey: 'thin high', city: 'Reno', state: 'NV',
  pctAllowedOfBilled: 90, rating: thinHighRating, streakSignal: null,
  billedAmount: 412300, allowedAmount: 251500, lineCount: 1, distinctPatients: 1,
  confirmedClaims: 1, estimateClaims: 0, unknownClaims: 0, careSetting: null, entity: 'Indigo',
};
const FACILITIES = [SOLID, THIN_HIGH];

const CASE_AT_THIN: QualifyClaim = {
  id: 1, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'THIN HIGH', program: 'OP',
  dos: '2026-07-15', paymentDate: '2026-07-20', pctAllowedOfBilled: 95, billedAmount: 18400, allowedAmount: 11592,
  confidence: 'confirmed', patientKey: 1,
};

// A weak-reimbursement facility (24% → danger) with a HIGH-pct case, to prove the % ALLOWED cell
// follows the case's OWN pct (95% → green), NOT the parent facility's danger bucket.
const LOW: QualifyFacility = {
  ...QUALIFY_FACILITY_V2_NULLS,
  rank: 3, name: 'LOW YIELD', facilityKey: 'low yield', city: 'Fresno', state: 'CA',
  pctAllowedOfBilled: 24, rating: lowRating, streakSignal: null,
  billedAmount: 500000, allowedAmount: 120000, lineCount: 300, distinctPatients: 30,
  confirmedClaims: 290, estimateClaims: 8, unknownClaims: 2, careSetting: 'IP', entity: 'BXR',
};
const CASE_AT_LOW: QualifyClaim = {
  id: 2, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'LOW YIELD', program: 'OP',
  dos: '2026-07-10', paymentDate: '2026-07-16', pctAllowedOfBilled: 95, billedAmount: 9000, allowedAmount: 8550,
  confidence: 'confirmed', patientKey: 1,
};

const PHI: QualifyPhi = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEMBER123', group_number: 'GRP9' };

const noop = () => {};
/** Default (no-reveal) props for the cases table. PER-PATIENT reveal (Part 2): the blanket revealAll toggle
 *  is gone; reveal is triggered per patient (group expand / singleton button). The keyset PAGER props are
 *  also gone — the drill shows the whole window grouped by patient. */
const noReveal = {
  canReveal: false,
  revealed: new Map<number, QualifyPhi>(),
  revealingKeys: new Set<number>(),
  revealError: null,
  onRevealPatient: noop,
  onHideIdentifiers: noop,
};

test('sanity: the rating buckets (= allowed% bands) are what these tests assume', () => {
  assert.equal(ratingBucket(solidRating), 'ok'); // 55%
  assert.equal(ratingBucket(thinHighRating), 'ok'); // 90% — value-first: green regardless of volume
  assert.equal(ratingBucket(lowRating), 'danger'); // 24%
});

test('facility panel — NO amounts: zero dollar elements in the markup (DOM omission, not CSS-hide)', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn />);
  assert.ok(!html.includes('$'), 'a no-amounts facility panel must contain no "$"');
  for (const v of ['251,500', '412,300', '166,800', '308,900']) {
    assert.ok(!html.includes(v), `dollar value ${v} must be ABSENT from the markup`);
  }
});

test('facility panel — WITH amounts: the $allowed / $billed line is present', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts heatOn />);
  assert.ok(html.includes('$251,500') && html.includes('$412,300'), 'amounts viewer sees the dollars');
});

test('cases table — NO amounts: Billed/Allowed columns are ABSENT (header + cells)', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} {...noReveal} />,
  );
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ column headers when !hasAmounts');
  assert.ok(!html.includes('$'), 'no "$" anywhere in a no-amounts cases table');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('cases table — WITH amounts: Billed/Allowed columns + values are present', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} {...noReveal} />,
  );
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'headers present for an amounts viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'values present for an amounts viewer');
});

test('SAMPLE GATE — a 90% facility on ONE patient is SUPPRESSED (neutral + "insufficient data", no confident %)', () => {
  // THIN_HIGH is value-first 90% (ratingBucket ok) but rests on 1 distinct patient. The gate
  // (hotfix 2026-07-27) must render it NEUTRAL, not green — a confident color on 1 patient is noise.
  const html = renderToStaticMarkup(<FacilityPanel facilities={[THIN_HIGH]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-neutral'), 'a <3-patient row is neutral — no confident bucket color');
  assert.ok(!html.includes('q-fac q-ok'), 'NOT green — the sample gate suppresses the color under 3 patients');
  assert.ok(html.includes('insufficient data'), 'shows the explicit insufficient-data state');
  assert.ok(!html.includes('90%'), 'the confident % is suppressed (— instead)');
  assert.ok(/1 patient\b/.test(html), 'the patient count the judgment rests on is visible');
});

test('SAMPLE GATE — color is INTACT once the sample is adequate (v2: a well-sampled 90% wears its IQ band)', () => {
  // v2 paint: the row's color comes from the IQ band (ratingV2), not the legacy bucket. A 90%
  // ample-sample row computes to the 65%+ band server-side; the fixture carries those values.
  const ample = { ...THIN_HIGH, distinctPatients: 12, ratingV2: 94, iqBand: '65' as const };
  const html = renderToStaticMarkup(<FacilityPanel facilities={[ample]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-band65'), 'a well-sampled 90% row wears the 65%+ band — the gate suppresses only thin slices');
  assert.ok(html.includes('90%'), 'the confident % renders');
  // NB: RATING_LEGEND.description mentions "thin sample" prose — assert on the PILL element, not the substring.
  assert.ok(!html.includes('>thin sample<') && !html.includes('>insufficient data<'), 'no thin/insufficient PILL at ≥10 patients');
});

test('SAMPLE GATE — a 3-9 patient facility shows the rating but is flagged a THIN SAMPLE', () => {
  // v2: the thin multiplier lowers the score but the band still colors (suppression is <3 only).
  const thin = { ...THIN_HIGH, distinctPatients: 5, ratingV2: 77, iqBand: '65' as const };
  const html = renderToStaticMarkup(<FacilityPanel facilities={[thin]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-band65'), 'the band still colors at 3-9 patients (not suppressed)');
  assert.ok(html.includes('90%'), 'the % renders');
  assert.ok(html.includes('>thin sample<'), 'but the thin-sample PILL is present');
  assert.ok(/5 patients/.test(html), 'patient count visible');
});

test('case % cell is tinted by the case’s OWN allowed%, NOT the parent facility bucket', () => {
  // Parent facility LOW YIELD is 24% → danger, but CASE_AT_LOW's own pct is 95% → ok. The cell must
  // follow the case's own value; the facility rating scale must NOT bleed into it.
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([LOW])} {...noReveal} />,
  );
  assert.ok(html.includes('q-pctcell q-ok'), "the case's own 95% pct colors the cell green");
  assert.ok(!html.includes('q-pctcell q-danger'), 'the parent facility’s 24% danger bucket does NOT cross-contaminate the cell');
});

test('case % cell — a LOW own-pct reads red even at a GREEN facility (cutoffs 50/30, no cross-contamination)', () => {
  const weakCase: QualifyClaim = { ...CASE_AT_THIN, id: 9, pctAllowedOfBilled: 18, patientKey: 9 }; // 18% → danger
  const midCase: QualifyClaim = { ...CASE_AT_THIN, id: 10, pctAllowedOfBilled: 42, patientKey: 10 }; // 42% → warn
  // Facility THIN HIGH is 90% → ok (green); the cells must still follow each case's own pct.
  const html = renderToStaticMarkup(
    <CasesTable claims={[weakCase, midCase]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} />,
  );
  assert.ok(html.includes('q-pctcell q-danger'), 'the 18% case reads red');
  assert.ok(html.includes('q-pctcell q-warn'), 'the 42% case reads amber');
  assert.ok(!html.includes('q-pctcell q-ok'), 'neither low/mid case borrows the facility’s green rating');
});

// ── PHI reveal (PER-PATIENT — Part 2; the blanket "Reveal all" is retired) ────────────────────────────
test('cases reveal — masked by default; a canReveal viewer sees the per-patient Reveal button + hint, NO blanket toggle', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(!html.includes('Reveal all'), 'the blanket "Reveal all" toggle is GONE');
  assert.ok(html.includes('>Reveal</button>'), 'a single-claim patient row carries a per-patient Reveal button');
  assert.ok(html.includes('Reveal IDs per patient'), 'the header hint explains the per-patient model');
  for (const v of ['AETMEMBER123', 'DOE, JANE', 'GRP9']) assert.ok(!html.includes(v), `no real PHI (${v}) before reveal`);
});

test('cases reveal — a claim whose id is CACHED shows real PHI; "Hide identifiers" appears; its Reveal button is gone', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal revealed={new Map<number, QualifyPhi>([[1, PHI]])} />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE') && html.includes('GRP9'), 'real PHI shown when the claim id is cached');
  assert.ok(html.includes('Hide identifiers'), 'the per-session Hide reset appears once something is revealed');
  assert.ok(!html.includes('>Reveal</button>'), 'the revealed row no longer offers its Reveal button');
});

test('cases reveal — a NON-cached sibling stays masked (DOM omission) while the cached patient is revealed', () => {
  const other: QualifyClaim = { ...CASE_AT_THIN, id: 2, patientKey: 2 };
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN, other]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal revealed={new Map<number, QualifyPhi>([[1, PHI]])} />,
  );
  assert.ok(html.includes('AETMEMBER123'), 'the cached patient is revealed');
  assert.ok(html.includes('>Reveal</button>'), 'the un-revealed sibling still offers Reveal (it stayed masked)');
});

test('cases reveal — a MULTI-claim patient group is an expandable control (expand triggers the per-patient reveal), NOT a Reveal button', () => {
  const grp: QualifyClaim[] = [
    { ...CASE_AT_THIN, id: 11, patientKey: 5 },
    { ...CASE_AT_THIN, id: 12, patientKey: 5, dos: '2026-07-14' },
  ];
  const html = renderToStaticMarkup(
    <CasesTable claims={grp} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(html.includes('2 claims'), 'the two claims collapse into one patient group');
  assert.ok(html.includes('aria-expanded="false"'), 'the group is expandable — expanding is its reveal trigger');
});

test('reveal is INDEPENDENT of the amounts gate: a cached-PHI admissions_seat row shows PHI but ZERO dollars', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal revealed={new Map<number, QualifyPhi>([[1, PHI]])} />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE'), 'PHI reveal works without amounts capability');
  assert.ok(!html.includes('$') && !html.includes('Billed') && !html.includes('Allowed'), 'but ZERO dollars — the two gates are independent');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar ${v} absent even when PHI is revealed`);
});

test('cases header — NO in-panel filter inputs (ruling: the main bar is the one identifier entry); the per-patient reveal affordance stays', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(!html.includes('Filter by ID prefix'), 'the prefix input is gone');
  assert.ok(!html.includes('Group # (employer proxy)'), 'the group-# input is gone');
  assert.ok(html.includes('>Reveal</button>'), 'the per-patient reveal affordance (NOT a filter) remains');
});

// ── Whole window, NO pager (Part 1: the keyset pager is retired) ───────────────────────────────────────
test('cases table — ALL in-window patients render at once; NO Previous/Next pager', () => {
  // 12 distinct single-claim patients — more than the old 15/page would ever have split, but well under the
  // 500 cap. Every one must render, and no pager chrome.
  const many: QualifyClaim[] = Array.from({ length: 12 }, (_, i) => ({
    ...CASE_AT_THIN, id: 900 + i, patientKey: i + 1, memberIdMasked: '••••••',
  }));
  const html = renderToStaticMarkup(
    <CasesTable claims={many} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(!html.includes('Next →') && !html.includes('← Previous'), 'no cursor pager — the whole window shows');
  assert.ok(!html.includes('>Page '), 'no page indicator');
  assert.equal(html.includes('12 recent claims'), true, 'the count reflects the whole loaded set');
});

test('cases table — the capped nudge shows ONLY when the window exceeded the 500 safety cap', () => {
  const under = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} />,
  );
  assert.ok(!under.includes('narrow the window'), 'no nudge under the cap');
  const capped = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} capped />,
  );
  assert.ok(capped.includes('Showing the 500 most recent by payment date') && capped.includes('narrow the window'), 'honest nudge when capped');
});

// ── Fix A: honest-empty copy (identifier search with no ranked in-window claims) ────────────────────
test('cases table — identifier honest-empty: empty + emptyIdentifierLabel shows "No in-window claims for <term> — try a wider window"', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} emptyIdentifierLabel="W29" />,
  );
  assert.ok(html.includes('No in-window claims for W29'), 'names the searched (non-PHI) term');
  assert.ok(/try a wider window/i.test(html), 'nudges toward widening the window');
  assert.ok(!html.includes('No claims for this payer'), 'NOT the payer-wide copy');
});

test('cases table — without emptyIdentifierLabel, an empty panel keeps the payer-wide copy (browse/payer path)', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.ok(html.includes('No claims for this payer in the selected window.'), 'payer-path empty copy unchanged');
  assert.ok(!/try a wider window/i.test(html), 'no identifier honest-empty copy when the label is absent');
});

// ── Q-4: per-facility cases scoping (desktop wiring of the existing getQualifyFacilityCases path) ────
// These fixtures are deliberately self-contained (they do NOT reuse the rating-const fixtures above) so
// the block stays independent of the parallel scoring-track edits to this file.
const CASES_FACILITY_A: QualifyClaim[] = [
  { id: 101, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'ALPHA CLINIC', program: 'IP', dos: '2026-07-15', paymentDate: '2026-07-20', pctAllowedOfBilled: 60, billedAmount: 1000, allowedAmount: 600, confidence: 'confirmed', patientKey: 1 },
  { id: 102, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'ALPHA CLINIC', program: 'OP', dos: '2026-07-14', paymentDate: '2026-07-19', pctAllowedOfBilled: 55, billedAmount: 2000, allowedAmount: 1100, confidence: 'confirmed', patientKey: 2 },
];
const CASES_FACILITY_B: QualifyClaim[] = [
  { id: 201, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'BETA CENTER', program: 'OP', dos: '2026-06-02', paymentDate: '2026-06-10', pctAllowedOfBilled: 40, billedAmount: 3000, allowedAmount: 1200, confidence: 'confirmed', patientKey: 1 },
];

test('cases table — per-facility scope: two facilities yield DIFFERENT case sets (the "same 15 regardless" bug is gone)', () => {
  const buckets = buildFacilityBucketMap([]); // neutral tint — this test is about the case SET, not color
  const htmlA = renderToStaticMarkup(
    <CasesTable claims={CASES_FACILITY_A} hasAmounts heatOn facilityBuckets={buckets} facilityLabel="ALPHA CLINIC" {...noReveal} />,
  );
  const htmlB = renderToStaticMarkup(
    <CasesTable claims={CASES_FACILITY_B} hasAmounts heatOn facilityBuckets={buckets} facilityLabel="BETA CENTER" {...noReveal} />,
  );
  assert.notEqual(htmlA, htmlB, 'different facilities must render different case markup — not the same set regardless');
  assert.ok(htmlA.includes('ALPHA CLINIC') && !htmlA.includes('BETA CENTER'), 'facility A shows ONLY A’s patients');
  assert.ok(htmlB.includes('BETA CENTER') && !htmlB.includes('ALPHA CLINIC'), 'facility B shows ONLY B’s patients');
  assert.ok(
    htmlA.includes('2 recent claims') && htmlB.includes('1 recent claims'),
    'each panel counts its own facility-scoped set',
  );
});

// ── Payment-date axis (the sort is now visible): Payment date + DOS columns + the single-line % pill ──
test('cases table — Payment date + DOS columns both render, distinct values, in that order', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={CASES_FACILITY_A} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} facilityLabel="ALPHA CLINIC" {...noReveal} />,
  );
  assert.ok(html.includes('>Payment date</th>'), 'the Payment date column header renders');
  assert.ok(html.includes('>DOS</th>'), 'the DOS (service date) column stays');
  assert.ok(html.indexOf('>Payment date</th>') < html.indexOf('>DOS</th>'), 'Payment date sits beside/left of DOS');
  // CASES_FACILITY_A[0]: paymentDate 2026-07-20, dos 2026-07-15 — BOTH dates visible on the row.
  assert.ok(html.includes('2026-07-20') && html.includes('2026-07-15'), 'both the payment date and the service date render on a claim row');
});

test('cases table — the % pill is single-line (whitespace-nowrap) so "~x% avg" never wraps', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={CASES_FACILITY_A} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.match(html, /q-pctcell[^"]*whitespace-nowrap/, 'the q-pctcell pill carries whitespace-nowrap (the actual wrap fix)');
});

test('cases table — a patient GROUP row shows the payment date of its most-recent (first) claim', () => {
  const grp: QualifyClaim[] = [
    { ...CASE_AT_THIN, id: 701, patientKey: 3, paymentDate: '2026-07-22', dos: '2026-07-15' },
    { ...CASE_AT_THIN, id: 702, patientKey: 3, paymentDate: '2026-07-21', dos: '2026-07-14' },
  ];
  const html = renderToStaticMarkup(
    <CasesTable claims={grp} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.ok(html.includes('2 claims'), 'the two claims collapse into one patient group row');
  assert.ok(html.includes('2026-07-22'), 'the group row shows the first (most-recently-paid) claim’s payment date');
});

// ── Alec's ruling 2026-08-04: CLICKING A CARD READS IT, it does not edit the search. A card click used
//    to push that facility into the compose filter, so browsing the ranking silently rewrote the query
//    that produced it and the rep's only way back was Clear all. The card is now the "Why this score"
//    disclosure; facility filtering lives only in the Facility picker.
test('facility panel — a card is a DISCLOSURE control (aria-expanded), never a filter toggle', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid'])} payerLabel="AETNA" />,
  );
  assert.ok(html.includes('<button'), 'facility rows are interactive buttons');
  assert.ok(html.includes('aria-expanded="false"'), 'the card body advertises the disclosure state');
  assert.ok(!html.includes('aria-pressed'), 'nothing on a card is a selection toggle any more');
  assert.ok(!/add it to your filter/.test(html), 'the add-to-filter instruction is gone with the behaviour');
  assert.ok(/reasoning behind its score/.test(html), 'the caption says what a click actually does');
});

test('facility panel — a filtered facility is still HIGHLIGHTED, and highlighting never filters the list', () => {
  // selectedKeys reflects the compose bar's Facility picker, so the ranking and the bar visibly agree.
  const one = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid'])} payerLabel="AETNA" />,
  );
  const SELECTED = 'bg-teal50 ring-2 ring-teal500'; // the selection-only pair (focus rings also say ring-teal500)
  assert.equal(one.split(SELECTED).length - 1, 1, 'one selected key → exactly one highlighted row');
  assert.ok(one.includes('SOLID') && one.includes('THIN HIGH'), 'selection highlights, it does not filter the ranking');
  assert.ok(one.includes('AETNA'), 'the payer label names the ranking subject');
  assert.ok(one.includes('across the whole book'), 'the caption states the ranking is book-wide, not this search');
  const both = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid', 'thin high'])} payerLabel="AETNA" />,
  );
  assert.equal(both.split(SELECTED).length - 1, 2, 'the compose bar can hold several facilities at once');
});

test('cases table — a facility-scoped set still omits dollars for a no-amounts viewer (DOM omission)', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={CASES_FACILITY_A} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap([])} facilityLabel="ALPHA CLINIC" {...noReveal} />,
  );
  assert.ok(!html.includes('$'), 'no "$" in a no-amounts facility-scoped cases table');
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ column headers when !hasAmounts');
  for (const v of ['1,000', '2,000', '1,100', '1,200']) assert.ok(!html.includes(v), `dollar ${v} absent even though the fixture carries it`);
});

// ── Redesign OVERVIEW: book KPI tiles + "Facilities Heating Up" trend cards ─────────────────────────
const W30 = trailingWindow(30);
const KPIS: QualifyBookKpis = {
  pctAllowedOfBilled: 44.4, pctPaidOfAllowed: 82.1, pctPaidOfBilled: 36.2, distinctPatients: 120,
  windowStart: '2026-06-18', windowEnd: '2026-07-18', tenantScope: 'cross-tenant-bxr-indigo',
};
const TRENDS: QualifyFacilityTrend[] = [
  {
    facilityKey: 'summit ridge', name: 'SUMMIT RIDGE RECOVERY', city: 'Scottsdale', state: 'AZ',
    careSetting: 'IP', entity: 'BXR', dominantPayer: 'AETNA', lineCount: 210,
    currentRating: 68, priorRating: 62.9, deltaPts: 5.1, points: [61, 62, 64, 63, 66, 67, 68, 68],
  },
  {
    facilityKey: 'valley springs', name: 'VALLEY SPRINGS', city: 'Boise', state: 'ID',
    careSetting: 'OP', entity: 'Indigo', dominantPayer: 'CIGNA', lineCount: 96,
    currentRating: 22, priorRating: 26.5, deltaPts: -4.5, points: [27, 26, 25, 24, 23, 22],
  },
  {
    facilityKey: 'fresh face', name: 'FRESH FACE BH', city: null, state: null,
    careSetting: null, entity: null, dominantPayer: 'AETNA', lineCount: 12,
    currentRating: 55, priorRating: null, deltaPts: null, points: [55],
  },
];

test('KPI tiles — three percentage tiles, ZERO dollars, null renders "—" (never a coerced 0%)', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={KPIS} locActive={false} />);
  assert.ok(html.includes('% allowed of billed') && html.includes('% paid of allowed') && html.includes('% paid of billed'), 'all three tiles');
  assert.ok(html.includes('44') && html.includes('82') && html.includes('36'), 'rounded percentages render');
  assert.ok(!html.includes('$'), 'the KPI strip carries NO dollars for any role');
  const nulled = renderToStaticMarkup(<BookKpiTiles kpis={{ ...KPIS, pctPaidOfBilled: null }} locActive={false} />);
  assert.ok(nulled.includes('—'), 'a collapsed denominator renders — (never 0%)');
});

test('KPI tiles — the LOC lens does not silently re-scope them: locActive adds the "not LOC-scoped" caption', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={KPIS} locActive />);
  assert.equal(html.split('not LOC-scoped').length - 1, 3, 'every tile captions the book-wide scope under an active lens');
});

test('KPI tiles — SAMPLE GATE: a <3-patient slice SUPPRESSES the confident % (— + "insufficient data")', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={{ ...KPIS, distinctPatients: 2 }} locActive={false} />);
  assert.equal(html.split('insufficient data').length - 1, 3, 'every tile flags insufficient data');
  assert.ok(/2 patients/.test(html), 'the patient count the slice rests on is visible');
  for (const pct of ['44', '82', '36']) assert.ok(!html.includes(pct), `the confident % ${pct} is suppressed`);
  assert.ok(html.includes('—'), 'tiles render — instead of a number');
});

test('KPI tiles — SAMPLE GATE: a 3-9 patient slice shows the % but flags a thin sample', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={{ ...KPIS, distinctPatients: 5 }} locActive={false} />);
  assert.ok(html.includes('44'), 'the % still renders at 3-9 patients');
  assert.equal(html.split('thin sample').length - 1, 3, 'every tile flags a thin sample');
  assert.ok(/5 patients/.test(html), 'patient count visible');
  assert.ok(!html.includes('insufficient data'), 'not the insufficient state (that is <3)');
});

test('KPI tiles — SAMPLE GATE: >=10 patients renders unchanged (no thin/insufficient flag)', () => {
  const html = renderToStaticMarkup(<BookKpiTiles kpis={{ ...KPIS, distinctPatients: 10 }} locActive={false} />);
  assert.ok(html.includes('44') && html.includes('82'), 'confident %s render');
  assert.ok(!html.includes('thin sample') && !html.includes('insufficient data'), 'no gate flag at full confidence');
});

test('heating-up cards — defined "n" (claim lines), Δpts ticker (+/−), NEW for null-prior, sparkline present', () => {
  const html = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={W30} onOpen={() => {}} />);
  assert.ok(html.includes('Facilities Heating Up'), 'section title');
  assert.ok(html.includes('210 claim lines'), 'Change A: n is DEFINED as claim lines, never a bare n=');
  assert.ok(!/\bn=\d/.test(html), 'no bare "n=" anywhere');
  assert.ok(html.includes('+5.1 pts'), 'positive delta ticker');
  assert.ok(html.includes('-4.5 pts'), 'negative delta ticker');
  assert.ok(html.includes('NEW'), 'a facility with no prior-window evidence reads NEW');
  assert.ok(html.includes('q-spark'), 'the sparkline draw-in svg renders');
  // Entity labels (BXR/Indigo) were intentionally removed from the card footer — they cluttered the
  // ticker and added nothing next to the location; the footer now shows only "City, ST".
  assert.ok(!html.includes('BXR') && !html.includes('Indigo'), 'entity label no longer clutters the card');
  assert.ok(html.includes('aria-pressed'), 'cards are toggleable buttons (hybrid click)');
});

test('heating-up cards — active (scoped) card is marked pressed; renders nothing on an empty book', () => {
  const html = renderToStaticMarkup(
    <HeatingUpCards trends={TRENDS} window={W30} activeFacilityKeys={new Set(['summit ridge'])} onOpen={() => {}} />,
  );
  assert.equal(html.split('aria-pressed="true"').length - 1, 1, 'exactly one active card');
  assert.equal(renderToStaticMarkup(<HeatingUpCards trends={[]} window={W30} onOpen={() => {}} />), '', 'empty render with no trends');
});

test('heating-up cards — Design B scope LABEL: "across the book" by default, the payer name when payer-scoped', () => {
  const wide = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={W30} onOpen={() => {}} />);
  assert.ok(wide.includes('across the book'), 'book-wide ticker labels its scope');
  const scoped = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={W30} scopePayer="AETNA" onOpen={() => {}} />);
  assert.ok(scoped.includes('AETNA'), 'payer-scoped ticker names the payer');
  assert.ok(!scoped.includes('across the book'), 'not both scopes at once');
});

// NB: the compose-bar match count + its NON-DOLLAR percentages now render inline in qualify-tab's dark
// readout bar / context line (MatchCountReadout was deleted). The amounts-strip guard for that data
// lives at the authoritative CORE boundary — test/qualifyCore.test.ts ("admissions_seat gets count +
// percentages with ZERO dollars (wire-level)" + the sentinel-dollar wire scan) — not here.

// ── EVIDENCE GAUGE (readout) — fill-state only, ZERO tier hues ───────────────────────────────────────
// The dark variant paints a SOLID pip as `bg-teal200` and a HOLLOW pip as `border-dashed`, so counting
// those class occurrences counts the pips. Evidence must NEVER be a hue — assert no amber/red anywhere.
const solidPips = (html: string) => html.split('bg-teal200').length - 1;
const hollowPips = (html: string) => html.split('border-dashed').length - 1;

test('evidence gauge — 41 clients (full) → 4 solid pips, 0 hollow, plain count + "enough to rate"', () => {
  const html = renderToStaticMarkup(<EvidenceGauge distinctPatients={41} />);
  assert.equal(solidPips(html), 4, 'four solid pips at an amply-evidenced count');
  assert.equal(hollowPips(html), 0, 'no hollow pips');
  assert.ok(html.includes('41 clients'), 'the count is stated plainly as text, not only as pips');
  assert.ok(html.includes('enough to rate'), 'the verdict text is present');
});

test('evidence gauge — 1 client → 1 solid + 3 hollow pips, "not enough to rate"', () => {
  const html = renderToStaticMarkup(<EvidenceGauge distinctPatients={1} />);
  assert.equal(solidPips(html), 1, 'one solid pip');
  assert.equal(hollowPips(html), 3, 'three hollow pips');
  assert.ok(html.includes('1 client') && !html.includes('1 clients'), 'singular "client"');
  assert.ok(html.includes('not enough to rate'), 'withheld-rating verdict');
});

test('evidence gauge — 3 clients (thin) → 2 solid + 2 hollow, "directional only"', () => {
  const html = renderToStaticMarkup(<EvidenceGauge distinctPatients={3} />);
  assert.equal(solidPips(html), 2);
  assert.equal(hollowPips(html), 2);
  assert.ok(html.includes('directional only'));
});

test('evidence gauge — signals by FILL ONLY: no amber / red / tier hue anywhere in the markup', () => {
  for (const n of [0, 1, 3, 10, 41]) {
    const html = renderToStaticMarkup(<EvidenceGauge distinctPatients={n} />);
    assert.ok(
      !html.includes('status-warn') && !html.includes('status-danger') && !html.includes('amber') && !html.includes('coral'),
      `no severity hue at ${n} clients — evidence is fill-state only`,
    );
  }
});

test('evidence gauge — carries a text alternative (role=img + count/verdict aria-label)', () => {
  const html = renderToStaticMarkup(<EvidenceGauge distinctPatients={41} />);
  assert.ok(html.includes('role="img"'), 'the pip cluster exposes a role');
  assert.ok(html.includes('41 distinct clients'), 'the aria-label states the count for AT');
});

test('spark — draws a path for ≥2 points, renders NOTHING for a single point (no fabricated trend)', () => {
  const two = renderToStaticMarkup(<Spark points={[40, 60]} hex="#2E8B6F" />);
  assert.ok(two.includes('<path') && two.includes('q-spark'), 'a 2-point line renders');
  assert.equal(renderToStaticMarkup(<Spark points={[40]} hex="#2E8B6F" />), '', 'a 1-point spark renders nothing');
});

test('rating legend — the ruled vocabulary: Strong / Watch / Weak (Typical is gone)', () => {
  assert.deepEqual(RATING_LEGEND.labels, { ok: 'Strong', warn: 'Watch', danger: 'Weak' });
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn />);
  assert.ok(html.includes('Watch'), 'the legend renders Watch');
  assert.ok(!html.includes('Typical'), 'Typical is gone');
});

// ── Compose bar: the panel is ALWAYS the full payer-wide ranking — selection highlights, never filters
//    or collapses (the old Change-E pinned/collapse mode is gone). ─────────────────────────────────────
test('facility panel — always renders the full ranking (selection highlights; no pinned collapse, no clear pill)', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid'])} payerLabel="AETNA" />,
  );
  assert.ok(html.includes('SOLID') && html.includes('THIN HIGH'), 'the full payer-wide list renders even with a facility selected');
  assert.ok(!html.includes('Clear facility filter'), 'no pinned-mode clear pill exists anymore');
  assert.ok(!html.includes('Scoped to this facility'), 'no pinned-mode scope caption anymore');
});

// ── Change B: the global persistent reveal header state ─────────────────────────────────────────────
test('cases table — globalRevealOn shows the standing "identifiers revealed (audited)" hint instead of the per-patient nudge', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal globalRevealOn revealed={new Map<number, QualifyPhi>([[1, PHI]])} />,
  );
  assert.ok(html.includes('identifiers revealed (audited)'), 'the standing-reveal hint renders');
  assert.ok(!html.includes('Reveal IDs per patient'), 'the per-patient nudge is replaced while global reveal is on');
});

// ── Phase 1 (0059 trust signal): confidence-first tint, coverage bar, LOC tag, thin-sample pill ──────
const ESTIMATE_CLAIM: QualifyClaim = {
  id: 301, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'REVERSAL HOUSE', program: 'OP',
  dos: '2026-07-12', paymentDate: '2026-07-18', pctAllowedOfBilled: 95, billedAmount: 4000, allowedAmount: 3800,
  confidence: 'estimate', patientKey: 1, // 95% but UNVERIFIED — must never read green
};
const UNKNOWN_CLAIM: QualifyClaim = {
  id: 302, memberIdMasked: '••••••', payerName: 'AETNA', facilityName: 'REVERSAL HOUSE', program: 'OP',
  dos: '2026-07-11', paymentDate: '2026-07-17', pctAllowedOfBilled: null, billedAmount: 500, allowedAmount: null,
  confidence: 'unknown', patientKey: 2,
};

test('cases table — an ESTIMATE claim is amber with ~ prefix and caption, NEVER green (however high its pct)', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[ESTIMATE_CLAIM]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} facilityLabel="REVERSAL HOUSE" {...noReveal} />,
  );
  assert.ok(html.includes('q-warn'), 'estimate cell wears q-warn (amber)');
  assert.ok(!html.includes('q-ok'), 'a 95% estimate must NOT wear the green class');
  assert.ok(html.includes('~95%'), 'estimate pct carries the ~ prefix');
  assert.ok(html.includes('estimate · reversals'), 'estimate caption present');
});

test('cases table — an UNKNOWN claim is neutral and reads "no allowed on file", never 0%', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[UNKNOWN_CLAIM]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} facilityLabel="REVERSAL HOUSE" {...noReveal} />,
  );
  assert.ok(html.includes('q-neutral'), 'unknown cell is neutral');
  assert.ok(html.includes('no allowed on file'), 'unknown caption present');
  assert.ok(!html.includes('0%'), 'an unknown allowed never renders as a zero percent');
});

test('cases table — a CONFIRMED claim still grades by its own pct (95% → green), unchanged', () => {
  const html = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([LOW])} facilityLabel="LOW YIELD" {...noReveal} />,
  );
  assert.ok(html.includes('q-ok'), 'confirmed 95% grades green via ratingBucket');
  assert.ok(!html.includes('~95%'), 'no ~ prefix on a confirmed value');
});

test('facility panel — coverage bar caption, LOC tag, thin-sample pill, confidence legend', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={[SOLID, THIN_HIGH]} hasAmounts heatOn={false} />,
  );
  assert.ok(html.includes('Rated on 380 of 400 claims'), 'coverage caption shows the rating evidence honestly');
  assert.ok(html.includes('Rated on 1 of 1 claims'), 'full-coverage facility still captions');
  assert.ok(html.includes('>OP<'), 'careSetting renders as the LOC tag (SOLID = OP)');
  assert.ok(html.includes('thin sample'), 'THIN_HIGH (1 line < limited-data floor) wears the thin-sample pill');
  assert.ok(html.includes('No allowed on file'), 'confidence legend labels render');
  assert.ok(html.includes('Estimate'), 'estimate legend label present');
});

// ── Phase 2: patient grouping (one row per patient) + the group-# filter affordance ──────────────────
test('cases table — same-patient claims fold into ONE expandable group row (collapsed by default)', () => {
  const dayRun: QualifyClaim[] = [
    { ...CASE_AT_LOW, id: 501, patientKey: 42, dos: '2026-07-15', pctAllowedOfBilled: 80 },
    { ...CASE_AT_LOW, id: 502, patientKey: 42, dos: '2026-07-14', pctAllowedOfBilled: 40 },
  ];
  const html = renderToStaticMarkup(
    <CasesTable claims={dayRun} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.ok(html.includes('Patient 42'), 'group row labels by the per-response ordinal (masked identity)');
  assert.ok(html.includes('2 claims'), 'claim-count badge');
  assert.ok(html.includes('60% avg'), 'roll-up pct = plain mean of the per-claim pcts');
  assert.ok(!html.includes('↳'), 'day-by-day rows are collapsed by default');
  assert.ok(html.includes('aria-expanded="false"'), 'the chevron reads collapsed');
});

test('cases table — a group with ANY estimate claim rolls up amber with ~avg, never green', () => {
  const mix: QualifyClaim[] = [
    { ...CASE_AT_LOW, id: 601, patientKey: 5, pctAllowedOfBilled: 95 },
    { ...CASE_AT_LOW, id: 602, patientKey: 5, pctAllowedOfBilled: 95, confidence: 'estimate' },
  ];
  const html = renderToStaticMarkup(
    <CasesTable claims={mix} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.ok(html.includes('~95% avg'), 'estimate-tainted roll-up carries the ~ prefix');
  assert.ok(html.includes('q-warn'), 'amber');
  assert.ok(!html.includes('q-pctcell q-ok'), 'one unverified reversal means the roll-up can never read green');
});

// ── Phase 3: the cohort slide-over (suppression-first; dollars stripped for seats) ───────────────────
test('cohort sheet — suppressed state renders the honest floor copy, nothing else', () => {
  const html = renderToStaticMarkup(
    <CohortSheet
      data={{ suppressed: true, floor: 5, patients: null, pctCollected: null, pctAllowed: null, pctPaid: null, byPayer: [], byCpt: [], viewerHasAmountsCapability: true, tenantScope: 'cross-tenant-bxr-indigo' }}
      loading={false}
      patientLabel="Patient 3"
      onClose={() => {}}
    />,
  );
  assert.ok(html.includes('cohort context is shown only for groups of 5+ patients'), 'floor copy');
  assert.ok(!html.includes('Payer mix'), 'no partial data below the floor');
});

test('cohort sheet — populated: pcts + mixes; NO dollars for a stripped (seat) payload', () => {
  const data = {
    suppressed: false, floor: 5, patients: 12, pctCollected: 30, pctAllowed: 40, pctPaid: 75,
    byPayer: [{ label: 'AETNA', count: 30, charge: null }],
    byCpt: [{ label: 'H0015', count: 18, charge: null }],
    viewerHasAmountsCapability: false, tenantScope: 'cross-tenant-bxr-indigo' as const,
  };
  const html = renderToStaticMarkup(<CohortSheet data={data} loading={false} patientLabel="Patient 3" onClose={() => {}} />);
  assert.ok(html.includes('12</span>-patient'), 'patient count renders');
  assert.ok(html.includes('40%') && html.includes('75%'), 'yield pcts render');
  assert.ok(html.includes('AETNA') && html.includes('H0015'), 'mix rows render');
  assert.ok(!html.includes('$'), 'zero dollar signs for a non-amounts viewer (DOM omission)');
});

test('cases table — the cohort chip renders on patient rows only when the handler is wired', () => {
  const withHandler = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} onViewCohort={() => {}} />,
  );
  assert.ok(withHandler.includes('>cohort<'), 'chip present with a handler');
  const without = renderToStaticMarkup(
    <CasesTable claims={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([])} {...noReveal} />,
  );
  assert.ok(!without.includes('>cohort<'), 'chip omitted without a handler (hermetic mounts unchanged)');
});

test('heating-up cards — a null-dominant-payer card is DISABLED (inert), not a silent-no-op button', () => {
  const html = renderToStaticMarkup(<HeatingUpCards trends={TRENDS} window={W30} onOpen={() => {}} />);
  // TRENDS[2] 'FRESH FACE BH' has dominantPayer 'AETNA' — make a payer-less one to prove the disable.
  const noPayer = [{ ...TRENDS[2]!, facilityKey: 'orphan', name: 'ORPHAN FAC', dominantPayer: null }];
  const orphanHtml = renderToStaticMarkup(<HeatingUpCards trends={noPayer} window={W30} onOpen={() => {}} />);
  assert.ok(orphanHtml.includes('disabled'), 'a card with no dominant payer is disabled (never a dead click)');
  assert.ok(!html.includes('role="listitem"'), 'cards are native buttons (no role=listitem clobbering aria-pressed)');
});


// ── Rating v2 surfaces (Phases 0/B/D/E): policy strip, window ladder, scorecard factors ─────────

const POLICY: QualifyPolicyCard = {
  found: true,
  memberCount: 14,
  carrier: 'AETNA',
  employerName: 'Vanderbilt Univ. Medical Center',
  // Unambiguous by default so the pre-existing assertions below keep testing the CONFIDENT rendering;
  // the ambiguous path gets its own tests rather than silently changing every existing expectation.
  employerCount: 1,
  carrierCount: 1,
  carriers: [],
  funding: 'Self-Funded',
  policyType: 'PPO',
  planType: 'OPEN ACCESS',
  groupOnFile: true,
  network: null,
  vobFreshAsOf: '2026-08-02',
  vobStale: false,
  deductible: '$1,500',
  deductibleMet: null,
  oopMax: '$6,000',
  oopMet: null,
};

test('PolicyStrip — the plan identifies itself: chips, self-funded banner, null-network line (Phase D today)', () => {
  const html = renderToStaticMarkup(<PolicyStrip policy={POLICY} provenance="direct" hasAmounts prefixEcho="W29" />);
  assert.ok(html.includes('AETNA'), 'carrier chip');
  assert.ok(html.includes('Vanderbilt'), 'employer chip');
  assert.ok(html.includes('Self-Funded'), 'funding chip');
  assert.ok(html.includes('network not captured on this VOB'), 'the Phase D null path is explicit, never blank');
  assert.ok(html.includes('Self-funded plan'), 'the §5 modifier banner (who decides the claim)');
  assert.ok(html.includes('$1,500'), 'benefit strings render for an amounts-capable viewer');
  assert.ok(html.includes('display only'), 'and are labeled display-only — never scored');
  assert.ok(!html.includes('Estimated read'), 'no estimate banner on direct provenance');
});

test('PolicyStrip — admissions_seat sees NO dollar strings; stale feed banner fires on vobStale', () => {
  const stripped = { ...POLICY, deductible: null, deductibleMet: null, oopMax: null, oopMet: null, vobStale: true };
  const html = renderToStaticMarkup(<PolicyStrip policy={stripped} provenance="comparable_employer" hasAmounts={false} prefixEcho="W29" />);
  assert.ok(!html.includes('$'), 'zero dollar signs for the blind view');
  assert.ok(html.includes('VOB feed is stale'), 'Phase 0: the confidently-wrong defence is loud');
  assert.ok(html.includes('Estimated read'), 'comparable provenance is labeled');
  assert.ok(html.includes('same employer plan'), 'and says what the estimate rests on');
});

// ── The SPREAD disclosure (2026-08-06). Measured: member-weighted, 86.8% of searches land on a
// multi-carrier prefix and 57% on one where the displayed employer is a MINORITY. A bare modal chip
// was confidently wrong more often than right; these pin that it now says so — and, just as
// important, that an UNAMBIGUOUS prefix is not cluttered with a warning it doesn't warrant.

test('PolicyStrip — an unambiguous prefix renders NO spread disclosure and NO "1 of" suffix', () => {
  const html = renderToStaticMarkup(<PolicyStrip policy={POLICY} provenance="direct" hasAmounts prefixEcho="W29" />);
  assert.ok(!html.includes('1 of '), 'no dominance suffix when every field has exactly one value');
  assert.ok(!html.includes('is not one plan'), 'no spread sentence — it would be wallpaper');
  assert.ok(html.includes('Vanderbilt'), 'and the self-funded banner still names the single employer');
});

test('PolicyStrip — a multi-carrier/multi-employer prefix says so on the chips AND in a sentence', () => {
  const spread = { ...POLICY, memberCount: 46, carrierCount: 3, employerCount: 7 };
  const html = renderToStaticMarkup(<PolicyStrip policy={spread} provenance="direct" hasAmounts prefixEcho="W20" />);
  assert.ok(html.includes('1 of 3'), 'carrier chip carries its denominator');
  assert.ok(html.includes('1 of 7'), 'employer chip carries its denominator');
  assert.ok(html.includes('This prefix is not one plan'), 'the disclosure sentence fires');
  assert.ok(html.includes('3 carriers') && html.includes('7 employers'), 'and states both counts');
  assert.ok(html.includes('46'), 'against the member count they are drawn from');
  // The self-funded line must stop naming ONE employer once several are on file — otherwise it
  // re-asserts exactly the specificity the sentence above just withdrew.
  assert.ok(!html.includes('Vanderbilt Univ. Medical Center carries the risk'));
  assert.ok(html.includes('the employer carries the risk'));
});

test('PolicyStrip — one ambiguous field alone is enough to disclose, and only that field is marked', () => {
  const html = renderToStaticMarkup(
    <PolicyStrip policy={{ ...POLICY, carrierCount: 4 }} provenance="direct" hasAmounts prefixEcho="W20" />,
  );
  assert.ok(html.includes('1 of 4') && html.includes('4 carriers'), 'the carrier side discloses');
  assert.ok(!html.includes('employers'), 'the unambiguous employer side stays silent');
  assert.ok(html.includes('Vanderbilt'), 'and still names the sole employer on the self-funded line');
});

test('MobilePolicyLine and PolicyStrip agree on carrier ambiguity — the two shells cannot diverge', async () => {
  const { MobilePolicyLine } = await import('../components/qualify/m/policy-line');
  const spread = { ...POLICY, carrierCount: 3 };
  const mobile = renderToStaticMarkup(<MobilePolicyLine policy={spread} provenance="direct" />);
  const desktop = renderToStaticMarkup(<PolicyStrip policy={spread} provenance="direct" hasAmounts prefixEcho="W20" />);
  assert.ok(mobile.includes('1 of 3') && desktop.includes('1 of 3'), 'both disclose the same denominator');
  // The phone line's standing rule: plan shape only, never an employer identifier.
  assert.ok(!mobile.includes('Vanderbilt'), 'employer name still never reaches the phone line');
});

test('PolicyStrip — not-found renders the honest VOB prompt, never an empty card', () => {
  const html = renderToStaticMarkup(
    <PolicyStrip policy={{ ...POLICY, found: false, memberCount: 0 }} provenance="none" hasAmounts prefixEcho="ZZZ" />,
  );
  assert.ok(html.includes('No VOB on file'));
  assert.ok(html.includes('ZZZ'));
});

const LADDER: QualifyWindowLadder = {
  rungs: [
    { days: 30, distinctPatients: 2, sufficient: false },
    { days: 60, distinctPatients: 4, sufficient: false },
    { days: 90, distinctPatients: 11, sufficient: true },
    { days: 180, distinctPatients: 15, sufficient: true },
    { days: 365, distinctPatients: 22, sufficient: true },
  ],
  chosenDays: 90,
  sufficient: true,
};

test('WindowLadder — shows every rung it weighed and states the outcome in plain language', () => {
  const html = renderToStaticMarkup(<WindowLadder ladder={LADDER} />);
  assert.ok(html.includes('Finding a window with enough patients to trust'));
  assert.ok(html.includes('2 patients — too few'), 'the 30d rung shows why it was ruled out');
  assert.ok(html.includes('11 patients — enough'), 'the chosen rung shows why it cleared');
  assert.ok(/Showing trailing[^]*?90[^]*?days/.test(html), 'the disclosure names the chosen window');
});

test('WindowLadder — the insufficient outcome is disclosed, never silent', () => {
  const insufficient: QualifyWindowLadder = {
    rungs: LADDER.rungs.map((r) => ({ ...r, distinctPatients: 2, sufficient: false })),
    chosenDays: 365,
    sufficient: false,
  };
  const html = renderToStaticMarkup(<WindowLadder ladder={insufficient} />);
  assert.ok(html.includes('directional, not confirmed'), 'the honest-restraint copy');
});

const FACTORS: QualifyFactorReading[] = [
  { key: 'coding', label: 'Coding decision confidence', weight: 30, score: 1, available: true, direction: 'pos', detail: 'CONFIRMED CODES (H0017 / 0158) — decided 30d ago.' },
  { key: 'claims', label: 'Claims reliability', weight: 25, score: 0.62, available: true, direction: 'neu', detail: '62% of billed allowed across 120 lines (110 confirmed-tier).' },
  { key: 'dataConfidence', label: 'Data confidence', weight: 20, score: 1, available: true, direction: 'pos', detail: '22 distinct patients · window reached 90d · this policy’s own claims.' },
  { key: 'ttp', label: 'Time to payment', weight: 15, score: 0.83, available: true, direction: 'pos', detail: 'Median 38 days from service to payment — paid lines only; claims still unresolved are not visible on this axis.' },
  { key: 'authFit', label: 'Auth / LOS fit', weight: 10, score: null, available: false, direction: 'neu', detail: 'No authorization / length-of-stay data for this facility.' },
];

test('scorecard v2 — IQ numeral + band pill + weight bar + expandable factor list with renormalization note', () => {
  const scored = {
    ...QUALIFY_FACILITY_V2_NULLS,
    ...SOLID,
    ratingV2: 84,
    iqBand: '65' as const,
    factors: FACTORS,
    availableWeight: 90,
    medianDaysToPayment: 38,
  };
  const expanded = new Set([scored.facilityKey]);
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={[scored]} hasAmounts heatOn expandedKeys={expanded} />,
  );
  assert.ok(html.includes('q-fac q-band65'), 'the card paints from the IQ band');
  assert.ok(html.includes('>84<'), 'the big v2 numeral');
  assert.ok(html.includes('Strong · 65%+'), 'the team’s own band vocabulary on the pill');
  assert.ok(html.includes('Why this score') || html.includes('Hide the reasoning'), 'the expansion affordance');
  assert.ok(html.includes('CONFIRMED CODES (H0017 / 0158)'), 'factor detail ships the registry decision');
  assert.ok(html.includes('Scored on 90 of 100 weighting'), 'renormalization disclosed, never hidden');
  assert.ok(html.includes('no data yet'), 'an unavailable factor says so instead of pretending');
});

// ── compose: the single-identifier narrows (the "two fields" contract) ────────────────────────────
//
// REWRITTEN 2026-08-05 (D3). This test previously PINNED THE DEFECT: its `AB1` case asserted
// `{ memberId: 'AB1' }` with the comment "digit ⇒ not a prefix", which is precisely the client-side
// rule that disagreed with the server and produced "0 charge lines match" beside a populated policy
// card. A test that locks in a bug is worse than no test, because it makes the fix look like the
// regression. The function is now a projection of `classifyQualifyHandle` (the one authority) and was
// renamed to `qualifyIdentifierNarrows` so no caller can reach the old rule by muscle memory.
// Exhaustive handle-shape coverage lives in `qualifyHandle.test.tsx` (I2).
test('qualifyIdentifierNarrows: <=3 chars is the prefix narrow, anything longer the member-id narrow', async () => {
  const { qualifyIdentifierNarrows } = await import('../lib/qualify/contract');
  assert.deepEqual(qualifyIdentifierNarrows('XQH'), { memberId: '', alphaPrefix: 'XQH' });
  assert.deepEqual(qualifyIdentifierNarrows(' ab '), { memberId: '', alphaPrefix: 'ab' });
  assert.deepEqual(qualifyIdentifierNarrows('W2740123'), { memberId: 'W2740123', alphaPrefix: '' });
  // THE CORRECTED CASE — an alphanumeric 3-char handle is a PREFIX. This is the whole D3 fix.
  assert.deepEqual(qualifyIdentifierNarrows('AB1'), { memberId: '', alphaPrefix: 'AB1' });
  assert.deepEqual(qualifyIdentifierNarrows('W26'), { memberId: '', alphaPrefix: 'W26' });
  assert.deepEqual(qualifyIdentifierNarrows('ABCD'), { memberId: 'ABCD', alphaPrefix: '' }); // 4 chars ⇒ member id
  assert.deepEqual(qualifyIdentifierNarrows('   '), { memberId: '', alphaPrefix: '' });
  // exactly one narrow is ever active — the both-identifiers dead-end is unrepresentable
  for (const raw of ['XQH', 'W2740123', 'AB1', 'W26', '']) {
    const c = qualifyIdentifierNarrows(raw);
    assert.ok(!(c.memberId !== '' && c.alphaPrefix !== ''));
  }
});

// ── PAYER RAIL (2026-08-06): the non-blocking drill-down. Measured — 80.6% of member-weighted
// searches land on a multi-payer prefix, but the dominant payer is right ~84% of the time, so this
// must NEVER become a gate. These pin both halves: it appears when there is a real choice, and it is
// completely absent when there is not.

const PAYER_OPTS = [
  { payer: 'AETNA', lines: 120, patients: 9, lastPayment: '2026-07-30' },
  { payer: 'CIGNA', lines: 44, patients: 4, lastPayment: '2026-06-02' },
  { payer: 'BCBS', lines: 36, patients: 3, lastPayment: null },
];

test('PayerRail — renders every payer with its line count, and marks the active one', async () => {
  const { PayerRail } = await import('../components/qualify/payer-rail');
  const html = renderToStaticMarkup(
    <PayerRail options={PAYER_OPTS} activePayer="AETNA" overridden={false} onSelect={() => {}} />,
  );
  for (const p of ['AETNA', 'CIGNA', 'BCBS']) assert.ok(html.includes(p), `${p} is offered`);
  assert.ok(html.includes('3 payers'), 'the count is stated');
  assert.ok(html.includes('120 lines') && html.includes('44 lines'), 'evidence rides each chip');
  assert.ok(html.includes('aria-pressed="true"'), 'the active payer is marked for assistive tech');
  assert.ok(html.includes('leads'), 'and is explained as the volume winner, not an arbitrary pick');
});

test('PayerRail — SELF-HIDES at one option or none: no rail, no implied choice', async () => {
  const { PayerRail } = await import('../components/qualify/payer-rail');
  const one = renderToStaticMarkup(
    <PayerRail options={[PAYER_OPTS[0]!]} activePayer="AETNA" overridden={false} onSelect={() => {}} />,
  );
  assert.equal(one, '', 'a single payer is not a choice — 17.8% of searches must be untouched');
  // Empty means "spread not loaded", NOT "one payer". Rendering anything would assert alternatives
  // were checked and none existed — a claim the component cannot make here.
  const none = renderToStaticMarkup(
    <PayerRail options={[]} activePayer="AETNA" overridden={false} onSelect={() => {}} />,
  );
  assert.equal(none, '', 'an unloaded spread renders nothing rather than a false all-clear');
});

test('PayerRail — flags a MINORITY dominant payer instead of presenting it silently', async () => {
  const { PayerRail } = await import('../components/qualify/payer-rail');
  // 120 of 380 = 31.6%, under the half-the-lines bar — the 15.7% case.
  const minority = [...PAYER_OPTS, { payer: 'UMR', lines: 180, patients: 12, lastPayment: '2026-07-01' }];
  const html = renderToStaticMarkup(
    <PayerRail options={minority} activePayer="AETNA" overridden={false} onSelect={() => {}} />,
  );
  assert.ok(html.includes('is only 120 of 380 claim lines'), 'the thinness is quantified, not hinted');
  assert.ok(html.includes('check the others'));
  assert.ok(!html.includes('leads'), 'and it must NOT simultaneously claim the payer leads');
});

test('PayerRail — a user drill-down is labelled as THEIR choice, not as our resolve', async () => {
  const { PayerRail } = await import('../components/qualify/payer-rail');
  const html = renderToStaticMarkup(
    <PayerRail options={PAYER_OPTS} activePayer="CIGNA" overridden onSelect={() => {}} />,
  );
  assert.ok(html.includes('showing your selection'), '"you picked this" and "we picked this" differ');
  assert.ok(!html.includes('ranked by volume'), 'the resolve wording must not also appear');
  assert.ok(html.includes('never widens'), 'and the scope promise is stated on the surface');
});

test('PayerRail — carries NO dollars, so a blind seat and a sighted session see the same rail', async () => {
  const { PayerRail } = await import('../components/qualify/payer-rail');
  const html = renderToStaticMarkup(
    <PayerRail options={PAYER_OPTS} activePayer="AETNA" overridden={false} onSelect={() => {}} />,
  );
  assert.ok(!html.includes('$'), 'zero dollar signs — this renders identically for admissions_seat');
});

// ── BED OCCUPANCY (2026-08-06). bed_capacity was WRITTEN hourly from the curated licensed-bed map
// and read by nothing — the chip could say "8 open beds" but not "8 of 12". Those are different
// facts: 8 free at a 20-bed house and 8 free at a 12-bed house are opposite signals about whether
// the facility will take this patient.

test('facility panel — open beds render as OCCUPANCY when the licensed count is on file', () => {
  const withCapacity = [{ ...FACILITIES[0]!, openBeds: 8, bedCapacity: 20 }];
  const html = renderToStaticMarkup(<FacilityPanel facilities={withCapacity} hasAmounts heatOn />);
  assert.ok(html.includes('8 of 20 beds'), 'the denominator is shown, not just the free count');
  assert.ok(html.includes('40% free'), 'and the percentage is spelled out in the tooltip');
});

test('facility panel — NO licensed count falls back to the bare count, never an invented denominator', () => {
  // Outpatient (no beds) and not-yet-curated residential both land here. Showing a made-up capacity
  // would be worse than showing less.
  const noCapacity = [{ ...FACILITIES[0]!, openBeds: 8, bedCapacity: null }];
  const html = renderToStaticMarkup(<FacilityPanel facilities={noCapacity} hasAmounts heatOn />);
  assert.ok(html.includes('8 open beds'), 'the pre-existing wording is preserved exactly');
  // Scoped to the occupancy shape: a bare `' of '` also matches unrelated copy elsewhere on the card.
  assert.ok(!/\d+ of \d+ beds/.test(html), 'no denominator is implied');
  assert.ok(html.includes('occupancy is unknown'), 'and the tooltip says WHY it is missing');
});

test('facility panel — a nearly-full house is flagged, a roomy one is not', () => {
  const tight = renderToStaticMarkup(
    <FacilityPanel facilities={[{ ...FACILITIES[0]!, openBeds: 1, bedCapacity: 12 }]} hasAmounts heatOn />,
  );
  assert.ok(tight.includes('text-status-warn'), '1 of 12 (8% free) reads as tight');
  const roomy = renderToStaticMarkup(
    <FacilityPanel facilities={[{ ...FACILITIES[0]!, openBeds: 6, bedCapacity: 12 }]} hasAmounts heatOn />,
  );
  assert.ok(!roomy.includes('text-status-warn'), '6 of 12 (50% free) does not');
  // Occupancy is a FACT on the card, never folded into the score — the rating is unchanged by it.
  assert.ok(tight.includes('of 12 beds') && roomy.includes('of 12 beds'));
});

test('facility panel — bed occupancy carries no dollars, so a blind seat sees the same chip', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={[{ ...FACILITIES[0]!, openBeds: 8, bedCapacity: 20 }]} hasAmounts={false} heatOn />,
  );
  assert.ok(html.includes('8 of 20 beds'), 'occupancy is visible to admissions_seat');
  assert.ok(!html.includes('$'), 'and still no dollars anywhere');
});

// ── ANCHORED FINDINGS + SEARCH TRACE (CCR-Agent port, 2026-08-06) ───────────────────────────────

test('FacilityFindings — renders the claim, the verbatim rationale, and labelled evidence', async () => {
  const { FacilityFindings } = await import('../components/qualify/facility-findings');
  const html = renderToStaticMarkup(
    <FacilityFindings
      findings={[{
        factorKey: 'ttp', severity: 'watch',
        title: 'Time to payment is pulling this score down',
        rationale: 'Median 130 days on paid lines.',
        evidence: [{ label: 'Sample', value: '14 distinct patients' }, { label: 'Window', value: '90d' }],
      }]}
    />,
  );
  assert.ok(html.includes('Watch'), 'severity chip');
  assert.ok(html.includes('pulling this score down'), 'the claim');
  assert.ok(html.includes('Median 130 days'), 'the server sentence, verbatim');
  assert.ok(html.includes('Evidence') && html.includes('14 distinct patients'), 'cited support');
});

test('FacilityFindings — a gap reads as neutral, NOT as an alarm', async () => {
  const { FacilityFindings } = await import('../components/qualify/facility-findings');
  const html = renderToStaticMarkup(
    <FacilityFindings
      findings={[{ factorKey: 'coding', severity: 'gap', title: 'Coding decision confidence could not be measured',
        rationale: 'Registry not seeded yet.', evidence: [{ label: 'Effect on the score', value: '30 points renormalized away' }] }]}
    />,
  );
  assert.ok(html.includes('No data'));
  // An honest absence coloured like a defect trains the reader to ignore both.
  assert.ok(!html.includes('status-warn'), 'a gap must not borrow the warning tone');
  assert.ok(html.includes('renormalized away'), 'but it still says what the absence costs');
});

test('FacilityFindings — renders NOTHING when there is nothing to report', async () => {
  const { FacilityFindings } = await import('../components/qualify/facility-findings');
  assert.equal(renderToStaticMarkup(<FacilityFindings findings={[]} />), '', 'no reassuring placeholder');
});

test('SearchTrace — lists the decisions and labels itself a record, not a live feed', async () => {
  const { SearchTrace } = await import('../components/qualify/search-trace');
  const html = renderToStaticMarkup(
    <SearchTrace lines={[
      { tone: 'ok', text: '46 verified members on file behind this prefix' },
      { tone: 'flag', text: 'Not one plan — 3 carriers and 7 employers behind it' },
      { tone: 'note', text: 'Widened to 90d to reach 11 patients' },
    ]} />,
  );
  assert.ok(html.includes('How this was resolved'));
  assert.ok(html.includes('46 verified members') && html.includes('Widened to 90d'));
  // The honesty line: getQualifySnapshot is one round trip, so this cannot be a live feed and the
  // UI must not imply otherwise.
  assert.ok(html.includes('a record of the decisions, not a live feed'));
});

test('SearchTrace — renders NOTHING for an empty trace', async () => {
  const { SearchTrace } = await import('../components/qualify/search-trace');
  assert.equal(renderToStaticMarkup(<SearchTrace lines={[]} />), '');
});

test('neither new component emits a dollar — admissions_seat parity holds', async () => {
  const { SearchTrace } = await import('../components/qualify/search-trace');
  const { FacilityFindings } = await import('../components/qualify/facility-findings');
  const a = renderToStaticMarkup(<SearchTrace lines={[{ tone: 'ok', text: '12 facilities ranked' }]} />);
  const b = renderToStaticMarkup(
    <FacilityFindings findings={[{ factorKey: 'claims', severity: 'watch', title: 't', rationale: 'r',
      evidence: [{ label: 'Sample', value: '14 distinct patients' }] }]} />,
  );
  assert.ok(!a.includes('$') && !b.includes('$'));
});
