/**
 * Qualify — RENDERED-HTML tests (DoD, Prompts 3 + 3c). Render the actual components to markup and
 * assert on the real HTML:
 *   1) amounts capability gates every dollar element via DOM OMISSION (absent, not CSS-hidden),
 *   2) color derives from RATING, not raw pct (a 90%/n=1 facility is 'warn'; a case inherits its
 *      parent facility's bucket), and
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
import { buildFacilityBucketMap } from '../components/qualify/colors';
import { qualifyRating, ratingBucket } from '../lib/qualify/rating';
import type { QualifyFacility, QualifyCase, QualifyPhi } from '../lib/qualify/contract';

const solidRating = qualifyRating(55)!; // 55 → ok
const thinHighRating = qualifyRating(90)!; // 90 → ok (value-first: a small high-% facility reads GREEN)
const lowRating = qualifyRating(24)!; // 24 → danger (a genuinely weak reimbursement)

const SOLID: QualifyFacility = {
  rank: 1, name: 'SOLID', facilityKey: 'solid', city: 'Boulder', state: 'CO',
  pctAllowedOfBilled: 55, rating: solidRating, streakSignal: null,
  billedAmount: 308900, allowedAmount: 166800, lineCount: 400,
};
const THIN_HIGH: QualifyFacility = {
  rank: 2, name: 'THIN HIGH', facilityKey: 'thin high', city: 'Reno', state: 'NV',
  pctAllowedOfBilled: 90, rating: thinHighRating, streakSignal: null,
  billedAmount: 412300, allowedAmount: 251500, lineCount: 1,
};
const FACILITIES = [SOLID, THIN_HIGH];

const CASE_AT_THIN: QualifyCase = {
  id: 1, memberIdMasked: '••••••', facilityName: 'THIN HIGH', program: 'OP',
  lastDos: '2026-07-15', pctAllowedOfBilled: 95, billedAmount: 18400, allowedAmount: 11592,
};

// A weak-reimbursement facility (24% → danger) with a HIGH-pct case, to prove a case inherits its
// PARENT facility's bucket, not its own pct.
const LOW: QualifyFacility = {
  rank: 3, name: 'LOW YIELD', facilityKey: 'low yield', city: 'Fresno', state: 'CA',
  pctAllowedOfBilled: 24, rating: lowRating, streakSignal: null,
  billedAmount: 500000, allowedAmount: 120000, lineCount: 300,
};
const CASE_AT_LOW: QualifyCase = {
  id: 2, memberIdMasked: '••••••', facilityName: 'LOW YIELD', program: 'OP',
  lastDos: '2026-07-10', pctAllowedOfBilled: 95, billedAmount: 9000, allowedAmount: 8550,
};

const PHI: QualifyPhi = { patient_name: 'DOE, JANE', member_id_raw: 'AETMEMBER123', group_number: 'GRP9' };

/** Default (no-reveal) props for the cases table. */
const noReveal = {
  canReveal: false,
  revealed: new Map<number, QualifyPhi>(),
  shown: new Set<number>(),
  pendingIds: new Set<number>(),
  revealErrors: new Map<number, string>(),
  onToggle: () => {},
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
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} {...noReveal} />,
  );
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ column headers when !hasAmounts');
  assert.ok(!html.includes('$'), 'no "$" anywhere in a no-amounts cases table');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar value ${v} must be absent`);
});

test('cases table — WITH amounts: Billed/Allowed columns + values are present', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap(FACILITIES)} {...noReveal} />,
  );
  assert.ok(html.includes('Billed') && html.includes('Allowed'), 'headers present for an amounts viewer');
  assert.ok(html.includes('$18,400') && html.includes('$11,592'), 'values present for an amounts viewer');
});

test('facility color = the allowed% bucket (value-first): a 90% facility reads GREEN', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={[THIN_HIGH]} hasAmounts heatOn />);
  assert.ok(html.includes('q-fac q-ok'), 'the 90% row is green — the rating IS its allowed%');
  assert.ok(!html.includes('q-fac q-warn'), 'not amber — volume no longer demotes a high %');
});

test('case % cell is tinted by the PARENT FACILITY bucket, not the case’s own pct', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([LOW])} {...noReveal} />,
  );
  assert.ok(html.includes('q-pctcell q-danger'), "case inherits the parent facility's danger bucket (24%)");
  assert.ok(!html.includes('q-pctcell q-ok'), 'the case’s own 95% pct did NOT color it green');
});

// ── 3c: PHI reveal ────────────────────────────────────────────────────────────────────────────────
test('cases reveal — masked by default; per-row Reveal control shown to a canReveal viewer', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(html.includes('Reveal'), 'a per-row Reveal control is present');
  for (const v of ['AETMEMBER123', 'DOE, JANE', 'GRP9']) {
    assert.ok(!html.includes(v), `no real PHI (${v}) before reveal resolves`);
  }
});

test('cases reveal — real PHI shown ONLY after reveal resolves (revealed + shown)', () => {
  const html = renderToStaticMarkup(
    <CasesTable
      cases={[CASE_AT_THIN]}
      hasAmounts
      heatOn
      facilityBuckets={buildFacilityBucketMap([THIN_HIGH])}
      canReveal
      revealed={new Map<number, QualifyPhi>([[1, PHI]])}
      shown={new Set<number>([1])}
      pendingIds={new Set<number>()}
      revealErrors={new Map<number, string>()}
      onToggle={() => {}}
    />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE') && html.includes('GRP9'), 'real PHI shown after reveal');
  assert.ok(html.includes('Hide'), 'toggle flips to Hide when the row is shown');
});

test('reveal is INDEPENDENT of the amounts gate: an admissions_seat reveal shows PHI but ZERO dollars', () => {
  const html = renderToStaticMarkup(
    <CasesTable
      cases={[CASE_AT_THIN]}
      hasAmounts={false}
      heatOn
      facilityBuckets={buildFacilityBucketMap([THIN_HIGH])}
      canReveal
      revealed={new Map<number, QualifyPhi>([[1, PHI]])}
      shown={new Set<number>([1])}
      pendingIds={new Set<number>()}
      revealErrors={new Map<number, string>()}
      onToggle={() => {}}
    />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE'), 'PHI reveal works without amounts capability');
  assert.ok(!html.includes('$') && !html.includes('Billed') && !html.includes('Allowed'), 'but ZERO dollars — the two gates are independent');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar ${v} absent even when PHI is revealed`);
});

// ── Q-4: per-facility cases scoping (desktop wiring of the existing getQualifyFacilityCases path) ────
// These fixtures are deliberately self-contained (they do NOT reuse the rating-const fixtures above) so
// the block stays independent of the parallel scoring-track edits to this file.
const CASES_FACILITY_A: QualifyCase[] = [
  { id: 101, memberIdMasked: '••••••', facilityName: 'ALPHA CLINIC', program: 'IP', lastDos: '2026-07-15', pctAllowedOfBilled: 60, billedAmount: 1000, allowedAmount: 600 },
  { id: 102, memberIdMasked: '••••••', facilityName: 'ALPHA CLINIC', program: 'OP', lastDos: '2026-07-14', pctAllowedOfBilled: 55, billedAmount: 2000, allowedAmount: 1100 },
];
const CASES_FACILITY_B: QualifyCase[] = [
  { id: 201, memberIdMasked: '••••••', facilityName: 'BETA CENTER', program: 'OP', lastDos: '2026-06-02', pctAllowedOfBilled: 40, billedAmount: 3000, allowedAmount: 1200 },
];

test('cases table — per-facility scope: two facilities yield DIFFERENT case sets (the "same 15 regardless" bug is gone)', () => {
  const buckets = buildFacilityBucketMap([]); // neutral tint — this test is about the case SET, not color
  const htmlA = renderToStaticMarkup(
    <CasesTable cases={CASES_FACILITY_A} hasAmounts heatOn facilityBuckets={buckets} facilityLabel="ALPHA CLINIC" {...noReveal} />,
  );
  const htmlB = renderToStaticMarkup(
    <CasesTable cases={CASES_FACILITY_B} hasAmounts heatOn facilityBuckets={buckets} facilityLabel="BETA CENTER" {...noReveal} />,
  );
  assert.notEqual(htmlA, htmlB, 'different facilities must render different case markup — not the same set regardless');
  assert.ok(htmlA.includes('ALPHA CLINIC') && !htmlA.includes('BETA CENTER'), 'facility A shows ONLY A’s patients');
  assert.ok(htmlB.includes('BETA CENTER') && !htmlB.includes('ALPHA CLINIC'), 'facility B shows ONLY B’s patients');
  assert.ok(
    htmlA.includes('2 most-recent distinct patients') && htmlB.includes('1 most-recent distinct patients'),
    'each panel counts its own facility-scoped set',
  );
});

test('facility panel — rows are interactive buttons and the selected row is marked (Q-4 selection)', () => {
  const html = renderToStaticMarkup(<FacilityPanel facilities={FACILITIES} hasAmounts={false} heatOn selectedKey="solid" />);
  assert.ok(html.includes('<button'), 'facility rows are interactive buttons (the desktop equivalent of a card tap)');
  assert.ok(html.includes('aria-pressed="true"'), 'the selected facility is marked pressed');
  assert.ok(html.includes('ring-teal500'), 'the selected facility carries the selection ring');
  const selectedCount = html.split('aria-pressed="true"').length - 1;
  assert.equal(selectedCount, 1, 'exactly one facility row is selected at a time');
});

test('cases table — a facility-scoped set still omits dollars for a no-amounts viewer (DOM omission)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={CASES_FACILITY_A} hasAmounts={false} heatOn facilityBuckets={buildFacilityBucketMap([])} facilityLabel="ALPHA CLINIC" {...noReveal} />,
  );
  assert.ok(!html.includes('$'), 'no "$" in a no-amounts facility-scoped cases table');
  assert.ok(!html.includes('Billed') && !html.includes('Allowed'), 'no $ column headers when !hasAmounts');
  for (const v of ['1,000', '2,000', '1,100', '1,200']) assert.ok(!html.includes(v), `dollar ${v} absent even though the fixture carries it`);
});
