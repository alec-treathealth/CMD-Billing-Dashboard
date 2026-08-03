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
import { BookKpiTiles, EvidenceGauge, HeatingUpCards } from '../components/qualify/overview';
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

test('SAMPLE GATE — value-first color is INTACT once the sample is adequate (90% on ≥10 patients reads GREEN)', () => {
  const ample = { ...THIN_HIGH, distinctPatients: 12 };
  const html = renderToStaticMarkup(<FacilityPanel facilities={[ample]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-ok'), 'a well-sampled 90% row is green — the gate suppresses only thin slices, not the rating');
  assert.ok(html.includes('90%'), 'the confident % renders');
  // NB: RATING_LEGEND.description mentions "thin sample" prose — assert on the PILL element, not the substring.
  assert.ok(!html.includes('>thin sample<') && !html.includes('>insufficient data<'), 'no thin/insufficient PILL at ≥10 patients');
});

test('SAMPLE GATE — a 3-9 patient facility shows the rating but is flagged a THIN SAMPLE', () => {
  const thin = { ...THIN_HIGH, distinctPatients: 5 };
  const html = renderToStaticMarkup(<FacilityPanel facilities={[thin]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-ok'), 'the rating still colors at 3-9 patients (not suppressed)');
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

test('facility panel — rows are interactive buttons; ONE selected key marks exactly one row pressed', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid'])} payerLabel="AETNA" />,
  );
  assert.ok(html.includes('<button'), 'facility rows are interactive buttons (add-to-filter)');
  assert.ok(html.includes('aria-pressed="true"'), 'the selected facility is marked pressed');
  assert.ok(html.includes('ring-teal500'), 'the selected facility carries the selection ring');
  assert.equal(html.split('aria-pressed="true"').length - 1, 1, 'one selected key → one pressed row');
  assert.ok(html.includes('payer-wide across the'), 'the header states the ranking is payer-wide across the book');
  assert.ok(html.includes('AETNA'), 'the payer label names the ranking subject');
  // Highlighting NEVER filters — both facilities still render even though only one is selected.
  assert.ok(html.includes('SOLID') && html.includes('THIN HIGH'), 'selection highlights, it does not filter the ranking');
});

test('facility panel — MULTI-highlight: several selected keys mark several rows pressed at once', () => {
  const html = renderToStaticMarkup(
    <FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKeys={new Set(['solid', 'thin high'])} payerLabel="AETNA" />,
  );
  assert.equal(html.split('aria-pressed="true"').length - 1, 2, 'two selected keys → two pressed rows (the compose bar can select several facilities)');
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
