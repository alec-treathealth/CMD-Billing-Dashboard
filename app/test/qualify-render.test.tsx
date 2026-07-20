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
import { HeatingUpBar } from '../components/qualify/heating-up-bar';
import { buildFacilityBucketMap } from '../components/qualify/colors';
import { qualifyRating, ratingBucket } from '../lib/qualify/rating';
import type { QualifyFacility, QualifyCase, QualifyMover, QualifyPhi } from '../lib/qualify/contract';

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

// A weak-reimbursement facility (24% → danger) with a HIGH-pct case, to prove the % ALLOWED cell
// follows the case's OWN pct (95% → green), NOT the parent facility's danger bucket.
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

const noop = () => {};
/** Default (no-reveal) props for the cases table — single header-toggle + prefix filter + cursor pager API. */
const noReveal = {
  canReveal: false,
  revealed: new Map<number, QualifyPhi>(),
  revealAll: false,
  revealing: false,
  revealError: null,
  onToggleRevealAll: noop,
  prefix: '',
  onPrefixChange: noop,
  onApplyPrefix: noop,
  page: 1,
  hasPrev: false,
  hasNext: false,
  paging: false,
  onPrevPage: noop,
  onNextPage: noop,
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

test('case % cell is tinted by the case’s OWN allowed%, NOT the parent facility bucket', () => {
  // Parent facility LOW YIELD is 24% → danger, but CASE_AT_LOW's own pct is 95% → ok. The cell must
  // follow the case's own value; the facility rating scale must NOT bleed into it.
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_LOW]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([LOW])} {...noReveal} />,
  );
  assert.ok(html.includes('q-pctcell q-ok'), "the case's own 95% pct colors the cell green");
  assert.ok(!html.includes('q-pctcell q-danger'), 'the parent facility’s 24% danger bucket does NOT cross-contaminate the cell');
});

test('case % cell — a LOW own-pct reads red even at a GREEN facility (cutoffs 50/30, no cross-contamination)', () => {
  const weakCase: QualifyCase = { ...CASE_AT_THIN, id: 9, pctAllowedOfBilled: 18 }; // 18% → danger
  const midCase: QualifyCase = { ...CASE_AT_THIN, id: 10, pctAllowedOfBilled: 42 }; // 42% → warn
  // Facility THIN HIGH is 90% → ok (green); the cells must still follow each case's own pct.
  const html = renderToStaticMarkup(
    <CasesTable cases={[weakCase, midCase]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} />,
  );
  assert.ok(html.includes('q-pctcell q-danger'), 'the 18% case reads red');
  assert.ok(html.includes('q-pctcell q-warn'), 'the 42% case reads amber');
  assert.ok(!html.includes('q-pctcell q-ok'), 'neither low/mid case borrows the facility’s green rating');
});

// ── PHI reveal (single header toggle) ───────────────────────────────────────────────────────────────
test('cases reveal — masked by default; the header Reveal-all toggle is shown to a canReveal viewer', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(html.includes('Reveal all'), 'the header reveal-all toggle is present');
  for (const v of ['AETMEMBER123', 'DOE, JANE', 'GRP9']) {
    assert.ok(!html.includes(v), `no real PHI (${v}) before reveal is toggled on`);
  }
});

test('cases reveal — real PHI shown ONLY when revealAll is on AND the PHI is cached', () => {
  const html = renderToStaticMarkup(
    <CasesTable
      cases={[CASE_AT_THIN]}
      hasAmounts
      heatOn
      facilityBuckets={buildFacilityBucketMap([THIN_HIGH])}
      {...noReveal}
      canReveal
      revealed={new Map<number, QualifyPhi>([[1, PHI]])}
      revealAll
    />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE') && html.includes('GRP9'), 'real PHI shown when cached + toggled on');
  assert.ok(html.includes('Hide identifiers'), 'the header toggle flips to "Hide identifiers" when revealAll is on');
});

test('cases reveal — cached PHI stays masked while revealAll is OFF (DOM omission, not CSS-hide)', () => {
  const html = renderToStaticMarkup(
    <CasesTable
      cases={[CASE_AT_THIN]}
      hasAmounts
      heatOn
      facilityBuckets={buildFacilityBucketMap([THIN_HIGH])}
      {...noReveal}
      canReveal
      revealed={new Map<number, QualifyPhi>([[1, PHI]])}
    />,
  );
  for (const v of ['AETMEMBER123', 'DOE, JANE', 'GRP9']) {
    assert.ok(!html.includes(v), `cached PHI (${v}) is absent from the DOM while the toggle is off`);
  }
  assert.ok(html.includes('Reveal all') && !html.includes('Hide identifiers'), 'the toggle reads "Reveal all" when off');
});

test('reveal is INDEPENDENT of the amounts gate: an admissions_seat reveal shows PHI but ZERO dollars', () => {
  const html = renderToStaticMarkup(
    <CasesTable
      cases={[CASE_AT_THIN]}
      hasAmounts={false}
      heatOn
      facilityBuckets={buildFacilityBucketMap([THIN_HIGH])}
      {...noReveal}
      canReveal
      revealed={new Map<number, QualifyPhi>([[1, PHI]])}
      revealAll
    />,
  );
  assert.ok(html.includes('AETMEMBER123') && html.includes('DOE, JANE'), 'PHI reveal works without amounts capability');
  assert.ok(!html.includes('$') && !html.includes('Billed') && !html.includes('Allowed'), 'but ZERO dollars — the two gates are independent');
  for (const v of ['18,400', '11,592']) assert.ok(!html.includes(v), `dollar ${v} absent even when PHI is revealed`);
});

// ── prefix filter + cursor pager (Stage 2 desktop UI) ───────────────────────────────────────────────
test('cases prefix — the header filter input is present and labeled STARTS-WITH, never "contains"', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(html.includes('Filter by ID prefix'), 'the prefix input placeholder is present');
  assert.ok(/starts with/i.test(html), 'the control is labeled as a starts-with / prefix match');
  assert.ok(!/contains/i.test(html), 'never labeled "contains" — starts-with only (the mixed-ID guard)');
});

test('cases prefix — a sub-3-char entry shows the "activates at 3" affordance (mints no filter)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal prefix="ab" />,
  );
  assert.ok(html.includes('Enter 3 characters to filter'), 'sub-3-char affordance: not yet filtering');
});

test('cases prefix — a 3-char entry shows the starts-with helper (ready to apply)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal prefix="ABC" />,
  );
  assert.ok(/starting with/i.test(html), 'active-prefix helper says "starting with"');
  assert.ok(!/contains/i.test(html), 'never "contains"');
});

test('cases pager — Next is ENABLED when hasNext (more pages to walk)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} hasNext page={1} />,
  );
  const nextTag = html.match(/<button([^>]*)>Next →<\/button>/)?.[1] ?? '';
  assert.ok(nextTag.length > 0, 'the Next control renders when hasNext');
  // `disabled=""` is the ATTRIBUTE; the className's `disabled:opacity-50` is a Tailwind variant, not it.
  assert.ok(!nextTag.includes('disabled=""'), 'Next is enabled when hasNext');
});

test('cases pager — Next is DISABLED at the end of the walk (!hasNext); Prev enabled off page 1', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} hasNext={false} hasPrev page={2} />,
  );
  const nextTag = html.match(/<button([^>]*)>Next →<\/button>/)?.[1] ?? '';
  const prevTag = html.match(/<button([^>]*)>← Previous<\/button>/)?.[1] ?? '';
  // `disabled=""` is the ATTRIBUTE; the className's `disabled:opacity-50` is a Tailwind variant, not it.
  assert.ok(nextTag.includes('disabled=""'), 'Next is disabled at the end of the walk');
  assert.ok(!prevTag.includes('disabled=""'), 'Prev is enabled once past page 1');
  assert.ok(html.includes('Page 2'), 'shows the current page');
});

test('cases pager — hidden on a single page (no hasNext, page 1)', () => {
  const html = renderToStaticMarkup(
    <CasesTable cases={[CASE_AT_THIN]} hasAmounts heatOn facilityBuckets={buildFacilityBucketMap([THIN_HIGH])} {...noReveal} canReveal />,
  );
  assert.ok(!html.includes('Next →') && !html.includes('← Previous'), 'no pager when there is only one page');
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

// ── "Heating up" desktop payer quick-pick (parity with mobile HeatingUp chips) ──────────────────────
const MOVERS: QualifyMover[] = [
  { rank: 1, label: 'AETNA', thisWindowPatients: 41, priorWindowPatients: 31, deltaPatients: 10, deltaPct: 32 },
  { rank: 2, label: 'UNITEDHEALTHCARE', thisWindowPatients: 63, priorWindowPatients: 0, deltaPatients: 63, deltaPct: null },
  { rank: 3, label: 'FLAT PAYER', thisWindowPatients: 20, priorWindowPatients: 20, deltaPatients: 0, deltaPct: 0 }, // not trending → excluded
  { rank: 4, label: 'SHRINKING PAYER', thisWindowPatients: 5, priorWindowPatients: 12, deltaPatients: -7, deltaPct: -58 }, // down → excluded
];

test('heating-up bar — renders ONLY trending-up payers as clickable chips (delta<=0 excluded)', () => {
  const html = renderToStaticMarkup(<HeatingUpBar movers={MOVERS} windowDays={30} onOpen={() => {}} />);
  assert.ok(html.includes('AETNA') && html.includes('UNITEDHEALTHCARE'), 'trending-up payers appear');
  assert.ok(!html.includes('FLAT PAYER') && !html.includes('SHRINKING PAYER'), 'flat/declining payers are excluded');
  assert.ok(html.includes('+32%'), 'a payer with a prior window shows its % growth');
  assert.ok(html.includes('+63 new'), 'a brand-new payer (no prior) shows "+N new"');
  assert.ok(html.includes('<button'), 'each chip is a clickable button (auto-resolve on click)');
});

test('heating-up bar — marks the active (currently-resolved) payer chip', () => {
  const html = renderToStaticMarkup(<HeatingUpBar movers={MOVERS} windowDays={30} activeLabel="AETNA" onOpen={() => {}} />);
  assert.ok(html.includes('aria-pressed="true"'), 'the active payer chip is marked pressed');
  assert.equal(html.split('aria-pressed="true"').length - 1, 1, 'exactly one chip is active');
});

test('heating-up bar — renders nothing when no payer is trending up', () => {
  const flat: QualifyMover[] = [
    { rank: 1, label: 'FLAT', thisWindowPatients: 10, priorWindowPatients: 10, deltaPatients: 0, deltaPct: 0 },
  ];
  assert.equal(renderToStaticMarkup(<HeatingUpBar movers={flat} windowDays={30} onOpen={() => {}} />), '', 'empty render when nothing trends up');
});
