/**
 * Code Performance — RENDERED-HTML tests for the pieces most likely to erode between the query layer
 * and the UI. Each is a correctness requirement, not styling (rulings 2026-09-08):
 *   1) allowed_coverage renders IN THE SAME CELL as allowed_rate;
 *   2) paid_of_allowed is never clamped — 123.07% renders as 123.07%;
 *   3) a suppressed metric is a VISIBLE state with its reason in the header — never blank/absent/zero;
 *   4) the maturity guard dims yield columns and the banner names velocity-not-yield;
 *   5) incomplete months are per tenant (the drill-down note names that tenant's feed date);
 *   6) definitions render review markers (unreviewed / conflict);
 *   7) no localStorage, no ui/table.tsx, recharts is the only chart dependency.
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CodeDescriptionMap, CodePerfPairingRow, CodePerfSummary } from '../lib/code-performance/contract';
import { CODE_PERF_SUPPRESSION_REASONS } from '../../src/collections/codePerformanceQuery.js';
import { DEFAULT_PAIRING_SORT, nextSort, PairingTable, sortPairingRows, pairKeyOf } from '../components/code-performance/pairing-table';
import { MaturityBanner, KpiGrid } from '../components/code-performance/kpi-grid';
import { CHART_BY_TENANT, FacilityTable, PayerTable, firstIncompleteMonth } from '../components/code-performance/pair-drilldown';
import { DefinitionsPanel } from '../components/code-performance/definitions-panel';
import { fmtMoney, fmtPct } from '../components/code-performance/format';
import {
  FacilityMixChart,
  TopPairingsChart,
  YieldHistogram,
  YIELD_BAND_LABELS,
  yieldBandOf,
} from '../components/code-performance/mini-charts';
import { describeCodeSlot } from '../../src/collections/codePerformanceQuery.js';

const here = dirname(fileURLToPath(import.meta.url));

function row(over: Partial<CodePerfPairingRow>): CodePerfPairingRow {
  return {
    hcpcs: 'S9480', loc_suffix: null, revcode: '0905', payers: 28, facilities: 13, charges: 3352,
    billed: 13565725, collected: 2884981.82, allowed_coverage: 97.3, allowed_rate: 21.97, paid_of_allowed: 95.87,
    underpaid_dollars: 170307.97, days_p50: 30, days_p90: 96, pct_zero_paid: 3.3, matured_share: 88,
    first_seen: '2026-03-12', last_seen: '2026-08-21', days_idle: 18, payer_concentration: 36, facilities_rated: 13,
    facility_spread: 30.1, write_off_rate: { state: 'available', value: 75.91 },
    patient_balance_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance },
    flags: ['wide_facility_spread'],
    ...over,
  };
}
const indigoSummary: CodePerfSummary = {
  charges: 42852, pairings: 78, facilities: 28, payers: 78, no_procedure_code_charges: 5172, no_revenue_code_charges: 0,
  billed: 200255352.96, collected: 50462514.64, allowed_coverage: 99.2, allowed_rate: 27.65, paid_of_allowed: 91.04,
  underpaid_dollars: 5008781.3, days_p50: 28, days_p90: 75, pct_zero_paid: 3.1, matured_share: 91.7,
  write_off_rate: { state: 'available', value: 70.67 },
  patient_balance_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance },
};
const bxrSummary: CodePerfSummary = {
  ...indigoSummary,
  write_off_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff },
  patient_balance_rate: { state: 'available', value: 3.4 },
};
const descriptions: CodeDescriptionMap = {
  'procedure:S9480': { codeType: 'HCPCS', code: 'S9480', shortLabel: 'Intensive outpatient psychiatric services, per diem', longDescription: null, priorDescription: 'IOP', sourceCitation: 'Novitas — url', provenance: 'alec-seed-2026-09-08', needsReview: true, descriptionConflict: false, tenantOverride: false },
  'procedure:S9475': { codeType: 'HCPCS', code: 'S9475', shortLabel: 'Ambulatory setting detoxification, per diem', longDescription: null, priorDescription: 'PHP Per Diem — Non-Medicare Payers', sourceCitation: 'Ensora', provenance: 'alec-seed-2026-09-08', needsReview: true, descriptionConflict: true, tenantOverride: false },
  'procedure:—': { codeType: 'OTHER', code: '—', shortLabel: 'No procedure code reported', longDescription: null, priorDescription: null, sourceCitation: null, provenance: 'alec-seed-2026-09-08', needsReview: true, descriptionConflict: false, tenantOverride: false },
  'revenue:0905': { codeType: 'REV', code: '0905', shortLabel: 'BH treatment/services — intensive outpatient, psychiatric', longDescription: null, priorDescription: null, sourceCitation: null, provenance: 'alec-seed-2026-09-08', needsReview: true, descriptionConflict: false, tenantOverride: false },
};
const noop = () => {};

function renderTable(rows: CodePerfPairingRow[], summary: CodePerfSummary, immature = false) {
  return renderToStaticMarkup(
    <PairingTable rows={rows} descriptions={descriptions} summary={summary} immatureWindow={immature} sort={DEFAULT_PAIRING_SORT} onSort={noop} expandedKey={null} onToggle={noop} />,
  );
}
/** The COLUMN headers only. The row-identity cell is a `th[scope=row]` in tbody (WCAG 1.3.1), so a
 *  document-wide `<th>` scrape would mix body cells into the column list and silently break the
 *  "which column is last" assertions. Slice the thead first. */
function columnHeaders(html: string): string[] {
  const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  return thead.match(/<th[\s\S]*?<\/th>/g) ?? [];
}

/** The body cells of the first row, in order — `<td>` plus the leading `th[scope=row]`. */
function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf('<tbody>'));
  const tr = body.slice(body.indexOf('<tr'), body.indexOf('</tr>'));
  return [...(tr.match(/<th[\s\S]*?<\/th>/g) ?? []), ...(tr.match(/<td[\s\S]*?<\/td>/g) ?? [])];
}

test('allowed_coverage renders in the SAME cell as allowed_rate, and flags the rate as noise under 60%', () => {
  const cells = firstRowCells(renderTable([row({})], indigoSummary));
  const allowedCell = cells.find((c) => c.includes('21.97%'));
  assert.ok(allowedCell, 'allowed rate cell present');
  assert.ok(allowedCell.includes('coverage 97.3%'), 'coverage sits beside the rate, not in another column');
  assert.ok(!allowedCell.includes('rate is noise'));
  const noisy = firstRowCells(renderTable([row({ allowed_coverage: 42.5 })], indigoSummary)).find((c) => c.includes('21.97%'));
  assert.ok(noisy?.includes('coverage 42.5%') && noisy.includes('rate is noise'));
});

test('paid_of_allowed is NEVER clamped: 123.07% renders as 123.07% and is flagged', () => {
  const html = renderTable([row({ paid_of_allowed: 123.07, flags: ['paid_over_allowed'] })], indigoSummary);
  assert.ok(html.includes('123.07%'));
  assert.ok(!html.includes('>100.00%<'), 'no clamp to 100');
  assert.ok(html.includes('paid &gt; allowed'));
  assert.equal(fmtPct(123.07, 2), '123.07%');
});

test('a suppressed metric is a VISIBLE state — pill in the cell, reason in the header — for the right tenant', () => {
  const indigo = renderTable([row({})], indigoSummary);
  assert.ok(indigo.includes('data-state="suppressed"'), 'Indigo: patient balance cell shows the suppressed pill');
  assert.ok(indigo.includes(CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance.slice(0, 40)), 'Indigo: header carries the reason');
  assert.ok(indigo.includes('75.91%'), 'Indigo: write-off value shown');
  assert.ok(!indigo.includes(CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff.slice(0, 40)));
  const bxr = renderTable(
    [row({ write_off_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff }, patient_balance_rate: { state: 'available', value: 3.4 } })],
    bxrSummary,
  );
  assert.ok(bxr.includes(CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff.slice(0, 40)), 'BXR: write-off header carries the reason');
  assert.ok(bxr.includes('3.40%'), 'BXR: patient balance value shown');
  const pills = (bxr.match(/data-state="suppressed"/g) ?? []).length;
  assert.equal(pills, 1, 'exactly one suppressed cell per row on BXR');
  // The column is PRESENT with a label in both tenants — it never vanishes on tenant switch.
  for (const html of [indigo, bxr]) {
    assert.ok(html.includes('Write-off rate') && html.includes('Patient balance'));
  }
});

/**
 * REGRESSION (2026-09-09). The header `sub` used to render a suppressed metric's REASON inline. Those
 * reasons run past 200 characters, so the cell wrapped to a dozen lines; a table row is as tall as its
 * tallest cell, so ONE of them inflated the whole header to ~250px, and because the header is STICKY
 * that slab was pinned over the top of the scroll area — reported as "a huge blue gap above the
 * columns". Height is invisible to a string render, so this asserts the PROXY that actually caused it:
 * how much text a header cell carries inline, excluding what is tucked inside a hidden hint.
 */
test('the sticky header stays short — no header cell carries a long inline caveat', () => {
  for (const [name, summary] of [['indigo', indigoSummary], ['bxr', bxrSummary]] as const) {
    const html = renderTable([row({})], summary);
    for (const th of columnHeaders(html)) {
      // Drop the hint panel first: it is `hidden`, so it occupies no height and may be long.
      const visible = th
        .replace(/<span[^>]*\bhidden\b[^>]*>[\s\S]*?<\/span>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      assert.ok(visible.length <= 60, `${name}: header cell carries ${visible.length} chars inline: ${visible}`);
    }
  }
});

test('a suppressed column still carries its full reason, just not inline', () => {
  // The hint keeps it in the DOM — `hidden` toggles visibility, not presence — so find-in-page and
  // assistive tech still reach it while the header stays one line tall.
  const indigo = renderTable([row({})], indigoSummary);
  assert.ok(indigo.includes(CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance.slice(0, 40)));
  assert.ok(indigo.includes('suppressed'), 'the header says the column is suppressed');
  // The marker must NOT be the cell's data-state pill, which the per-row count depends on.
  const headerBlock = indigo.slice(indigo.indexOf('<thead>'), indigo.indexOf('</thead>'));
  assert.equal(headerBlock.includes('data-state="suppressed"'), false, 'the header must not carry the cell marker');
});

test('patient balance is labelled as AR aging and sits at the far right, apart from allowed rate', () => {
  const html = renderTable([row({})], indigoSummary);
  const headers = columnHeaders(html);
  const idx = (needle: string) => headers.findIndex((h) => h.includes(needle));
  assert.ok(idx('Patient balance') === headers.length - 1, 'last column');
  assert.ok(idx('Patient balance') - idx('Allowed rate') > 5, 'not adjacent to allowed rate');
  assert.ok(html.includes('AR aging') || html.includes('Outstanding patient balance as of today'));
});

test('maturity guard: banner names velocity-not-yield; yield headers and cells are dimmed; other columns are not', () => {
  const banner = renderToStaticMarkup(<MaturityBanner maturedShare={41.2} />);
  assert.ok(banner.includes('measures velocity and volume, not yield'));
  assert.ok(banner.includes('41.2%'));
  assert.ok(banner.includes('role="status"'));
  const html = renderTable([row({ matured_share: 41.2, flags: ['immature_window'] })], indigoSummary, true);
  const headers = columnHeaders(html);
  const dimmed = headers.filter((h) => h.includes('opacity-60'));
  assert.ok(dimmed.some((h) => h.includes('Allowed rate')) && dimmed.some((h) => h.includes('Paid of allowed')), 'yield headers dimmed');
  assert.ok(!headers.find((h) => h.includes('Charges'))?.includes('opacity-60'), 'volume header not dimmed');
  assert.ok(!headers.find((h) => h.includes('Days to money'))?.includes('opacity-60'), 'velocity header not dimmed');
  const mature = renderTable([row({})], indigoSummary, false);
  assert.ok(!columnHeaders(mature).some((h) => h.includes('opacity-60')), 'nothing dimmed when mature');
});

test('KPI grid: coverage rides with the allowed tile; gated tiles show Suppressed + reason; nothing truncates', () => {
  const board = {
    tenant: 'indigo' as const, window: '6mo' as const, windowDays: 180, windowStart: '2026-03-12', windowEnd: '2026-09-08',
    facilitiesApplied: null, summary: indigoSummary, immatureWindow: false, rows: [], facilityOptions: [],
    freshness: { businessToday: '2026-09-08', maxIngestedAt: null, maxChargeDate: '2026-08-23', maxPaymentReceived: null, futurePaymentCharges: 114, chargeLagDays: 16 },
    descriptions,
  };
  const html = renderToStaticMarkup(<KpiGrid board={board} />);
  assert.ok(html.includes('27.65%') && html.includes('coverage 99.2%'));
  assert.ok(html.includes('Suppressed') && html.includes(CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance.slice(0, 40)));
  assert.ok(html.includes(fmtMoney(200255352.96)), 'full dollar value, no truncation');
  assert.ok(html.includes('whitespace-nowrap') && !html.includes('truncate'));
  assert.ok(html.includes('LAST posting'));
});

test('drill-down tables: raw payer strings, coverage beside rate, unclamped paid, tenant-specific suppression', () => {
  const payer = renderToStaticMarkup(
    <PayerTable
      rows={[{ payer_raw: 'BLUE SHIELD OF CA', share_of_billed: 4.1, charges: 133, billed: 551000, collected: 124538.6, allowed_coverage: 98.5, allowed_rate: 16.14, paid_of_allowed: 123.07, underpaid_dollars: 9048.12, days_p50: 29, days_p90: 50, pct_zero_paid: 0.8, matured_share: 86.5, write_off_rate: { state: 'available', value: 75.54 }, patient_balance_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance } }]}
      summary={indigoSummary}
      dim={false}
    />,
  );
  assert.ok(payer.includes('BLUE SHIELD OF CA') && payer.includes('raw CMD string, unaliased'));
  assert.ok(payer.includes('123.07%') && payer.includes('coverage 98.5%'));
  assert.ok(payer.includes('data-state="suppressed"'));
  const fac = renderToStaticMarkup(<FacilityTable rows={[]} belowFloor={3} summary={bxrSummary} dim={false} />);
  assert.ok(fac.includes('No facility reaches 30 charges') && fac.includes('3 facilities excluded'));
});

test('incomplete months are per tenant: the first incomplete month is the shading edge', () => {
  const months = [
    { month: '2026-06-01', charges: 1, billed: 1, collected: 0, allowed_rate: null, allowed_coverage: null, matured_share: 100, incomplete: false },
    { month: '2026-07-01', charges: 1, billed: 1, collected: 0, allowed_rate: null, allowed_coverage: null, matured_share: 80, incomplete: false },
    { month: '2026-08-01', charges: 1, billed: 1, collected: 0, allowed_rate: null, allowed_coverage: null, matured_share: 0, incomplete: true },
  ];
  assert.equal(firstIncompleteMonth(months), '2026-08-01');
  assert.equal(firstIncompleteMonth(months.map((m) => ({ ...m, incomplete: false }))), null);
});

test('definitions panel renders review markers: every row unreviewed, S9475 flagged as a conflict with both texts', () => {
  const html = renderToStaticMarkup(
    <DefinitionsPanel rows={[row({}), row({ hcpcs: 'S9475', revcode: '0912' }), row({ hcpcs: '—', revcode: '1002' })]} descriptions={descriptions} />,
  );
  assert.ok(html.includes('unreviewed'));
  assert.ok(html.includes('conflict'));
  assert.ok(html.includes('Ambulatory setting detoxification, per diem') && html.includes('PHP Per Diem — Non-Medicare Payers'));
  assert.ok(html.includes('No procedure code reported'), 'the em dash renders through the shared no-code label');
  assert.ok(html.includes('No description on file'), 'a code with no 038 row says so instead of inventing text');
});

test('client-side sort: allowlisted keys only, nulls last both ways, stable tie-break, desc first then toggles', () => {
  const rows = [row({ hcpcs: 'A', allowed_rate: 10 }), row({ hcpcs: 'B', allowed_rate: null }), row({ hcpcs: 'C', allowed_rate: 30 })];
  assert.deepEqual(sortPairingRows(rows, { key: 'allowed_rate', direction: 'desc' }).map((r) => r.hcpcs), ['C', 'A', 'B']);
  assert.deepEqual(sortPairingRows(rows, { key: 'allowed_rate', direction: 'asc' }).map((r) => r.hcpcs), ['A', 'C', 'B']);
  assert.deepEqual(nextSort(DEFAULT_PAIRING_SORT, 'charges'), { key: 'charges', direction: 'desc' });
  assert.deepEqual(nextSort({ key: 'charges', direction: 'desc' }, 'charges'), { key: 'charges', direction: 'asc' });
  assert.equal(pairKeyOf(row({ hcpcs: null, loc_suffix: null, revcode: null })), pairKeyOf(row({ hcpcs: null, loc_suffix: null, revcode: null })));
  assert.notEqual(pairKeyOf(row({ hcpcs: 'H2013', loc_suffix: 'IOP' })), pairKeyOf(row({ hcpcs: 'H2013', loc_suffix: null })), 'the suffix is part of the identity');
});

test('source sweeps: no browser storage, no ui/table.tsx, recharts only, hex only inside the chart module', () => {
  const dir = join(here, '..', 'components', 'code-performance');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /localStorage\.|sessionStorage\.|document\.cookie/, `${f}: persists client-side`);
    assert.doesNotMatch(src, /components\/ui\/table/, `${f}: imports the shared ui/table (10 consumers — ruled off limits)`);
    assert.doesNotMatch(src, /from 'chart\.js'|from 'd3|from 'victory|from 'nivo|from '@nivo/, `${f}: a second charting dependency`);
    if (f !== 'pair-drilldown.tsx') assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, `${f}: literal hex outside the chart`);
  }
  const lib = join(here, '..', 'lib', 'code-performance');
  for (const f of readdirSync(lib)) {
    assert.doesNotMatch(readFileSync(join(lib, f), 'utf8'), /localStorage\.|sessionStorage\./, `${f}: persists client-side`);
  }
});

test('the old route is a redirect stub and the static component is gone', () => {
  const stub = readFileSync(join(here, '..', 'app', 'code-reference', 'page.tsx'), 'utf8');
  assert.ok(stub.includes("redirect('/code-performance')"));
  assert.throws(() => readFileSync(join(here, '..', 'components', 'code-reference.tsx'), 'utf8'), 'the 402-line static dataset is retired');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE CHARTS — three Qodo #350 findings, all of them correctness rather than styling.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * FINDING 2. The denominator counted every non-null rate while the bands stopped at 101, so a
 * negative or above-100 rate reached the total and appeared in no bar. `allowed_rate` is an
 * unclamped sum-over-sum and the rollup does not bound allowed by the charge amount, so both are
 * reachable. Totality is the property, asserted directly rather than through pixels.
 */
test('yieldBandOf is TOTAL — every finite rate lands in exactly one band', () => {
  for (const rate of [-1e6, -0.01, 0, 0.01, 19.99, 20, 39.99, 40, 60, 79.99, 80, 99.99, 100, 100.01, 1e6]) {
    const i = yieldBandOf(rate);
    assert.ok(Number.isInteger(i), `${rate} -> ${i}`);
    assert.ok(i >= 0 && i < YIELD_BAND_LABELS.length, `${rate} fell outside the band set: ${i}`);
  }
  // The boundaries that decide whether a value is an edge case or a core band.
  assert.equal(yieldBandOf(-0.01), 0, 'below zero is its own band');
  assert.equal(yieldBandOf(0), 1, 'exactly zero is a core band');
  assert.equal(yieldBandOf(100), 5, 'exactly 100 is a core band, not overflow');
  assert.equal(yieldBandOf(100.01), 6, 'above 100 is overflow — allowed exceeds billed');
  assert.equal(yieldBandOf(20), 2, 'a band is closed at its lower bound');
});

test('the histogram bars SUM to the rated count, including out-of-range rates', () => {
  const rates = [-4.2, 0, 12, 21, 55, 78, 95, 100, 118.4, null, null];
  const html = renderToStaticMarkup(
    <YieldHistogram rows={rates.map((allowed_rate) => row({ allowed_rate }))} />,
  );
  // Every bar prints its own count; those counts must add up to the caption's rated total.
  const printed = [...html.matchAll(/tabular-nums text-ink600">(\d+)</g)].map((m) => Number(m[1]));
  const rated = rates.filter((r) => r !== null).length;
  assert.equal(printed.reduce((a, b) => a + b, 0), rated, `bars ${printed.join('+')} must sum to ${rated}`);
  assert.ok(html.includes('9 rated'), html.slice(0, 200));
  assert.ok(html.includes('2 with no reliable allowed'));
  // Both edge bands are populated here, so both are drawn and labelled.
  assert.ok(html.includes('&lt;0'), 'the underflow band is drawn when it holds a row');
  assert.ok(html.includes('&gt;100'), 'the overflow band is drawn when it holds a row');
});

test('the edge bands are HIDDEN when empty — a healthy tenant gets five bars, not seven', () => {
  const html = renderToStaticMarkup(
    <YieldHistogram rows={[12, 34, 56, 78, 92].map((allowed_rate) => row({ allowed_rate }))} />,
  );
  assert.equal(html.includes('&lt;0'), false, 'no underflow band when nothing is below zero');
  assert.equal(html.includes('&gt;100'), false, 'no overflow band when nothing exceeds 100');
  // Count the BAND buttons only — Panel's own MetricHint is a <button> too, so a bare <button
  // count is 6 and reads as a failure. Each band's aria-label ends in "pairings".
  assert.equal((html.match(/aria-label="[^"]*pairings"/g) ?? []).length, 5, 'exactly the five core bands');
});

/**
 * FINDING 3. The bars were keyed on the DISPLAY label, and `describeCodeSlot` maps both a null code
 * and the em-dash no-code marker to the same visible text — so two distinct query groups collided on
 * one React key. This asserts the collision is real (which is why a label cannot be an identity) and
 * that `pairKeyOf` separates them.
 */
test('a display label is NOT an identity — null and the em-dash marker collide, pairKeyOf does not', () => {
  assert.equal(
    describeCodeSlot('procedure', null).label,
    describeCodeSlot('procedure', '—').label,
    'the premise: both no-code forms render the same label',
  );
  const a = row({ hcpcs: null, loc_suffix: null, revcode: '0905' });
  const b = row({ hcpcs: '—', loc_suffix: null, revcode: '0905' });
  assert.notEqual(pairKeyOf(a), pairKeyOf(b), 'the raw identity must separate them');
  // Both bars render rather than one silently replacing the other.
  const html = renderToStaticMarkup(<TopPairingsChart rows={[a, b]} />);
  assert.equal((html.match(/<li>/g) ?? []).length, 2, 'both pairings are drawn');
});

/**
 * FINDING 1. `facilityOptions` is the picker's vocabulary and its query ignores the facility filter
 * by design, so feeding it here unscoped drew every site in the tenant while the KPIs and table
 * showed the selection — with percentages against an all-facility denominator.
 */
const facOpts = [
  { facility: 'ALPHA', charges: 100, billed: 1000 },
  { facility: 'BETA', charges: 50, billed: 500 },
  { facility: 'GAMMA', charges: 10, billed: 250 },
  { facility: null, charges: 5, billed: 125 },
];

test('the facility chart SCOPES to the active selection, and says so', () => {
  const html = renderToStaticMarkup(<FacilityMixChart options={facOpts} facilitiesApplied={['ALPHA', 'GAMMA']} />);
  assert.ok(html.includes('ALPHA') && html.includes('GAMMA'));
  assert.equal(html.includes('BETA'), false, 'an unselected facility must not be drawn');
  assert.equal(html.includes('No facility on the feed'), false, 'null-facility rows are excluded under a selection, as the board excludes them');
  assert.ok(html.includes('2 facilities'), html.slice(-400));
  assert.ok(html.includes('filtered'), 'the title states that the chart is scoped');
});

test('with no selection the chart shows every facility, null bar included', () => {
  for (const applied of [null, [] as string[]]) {
    const html = renderToStaticMarkup(<FacilityMixChart options={facOpts} facilitiesApplied={applied} />);
    for (const f of ['ALPHA', 'BETA', 'GAMMA']) assert.ok(html.includes(f), `${String(applied)}: ${f} missing`);
    assert.ok(html.includes('No facility on the feed'), 'the unattributed bar is never merged away');
    assert.ok(html.includes('4 facilities'));
    assert.equal(html.includes('filtered'), false, 'unscoped, so the title must not claim otherwise');
  }
});

test('a selected facility with no rows in the window simply does not appear', () => {
  const html = renderToStaticMarkup(<FacilityMixChart options={facOpts} facilitiesApplied={['ZETA']} />);
  assert.ok(html.includes('No facilities in this window'), html.slice(0, 300));
});

/* ── a11y pass 2026-09-10 ─────────────────────────────────────────────────────────────────────── */

test('the row-identity cell is a th[scope=row] — 13 columns need a row header', () => {
  const html = renderTable([row({})], indigoSummary);
  const body = html.slice(html.indexOf('<tbody>'));
  const tr = body.slice(body.indexOf('<tr'), body.indexOf('</tr>'));
  const rowHeaders = tr.match(/<th[^>]*scope="row"[^>]*>/g) ?? [];
  assert.equal(rowHeaders.length, 1, 'exactly one cell names the row');
  // It is the FIRST cell, and it is the sticky one — identity stays on screen and stays announced.
  assert.ok(tr.indexOf('scope="row"') < tr.indexOf('<td'), 'the row header leads the row');
  assert.ok((rowHeaders[0] ?? '').includes('sticky'), 'the row header is the pinned identity column');
});

test('the row primary action clears the target-size floor with margin', () => {
  const html = renderTable([row({})], indigoSummary);
  // ⚠ Match the ROW's expand control specifically. A bare `aria-expanded` scrape finds the header's
  // MetricHint button first, which is a legitimately-24px inline info affordance, not a row action.
  const expand = html.match(/<button[^>]*aria-label="(?:Expand|Collapse) drill-down[^"]*"[^>]*>/)?.[0] ?? '';
  assert.ok(expand.includes('h-8') && expand.includes('w-8'), `expand control is not 32px: ${expand}`);
  assert.equal(expand.includes('h-6'), false, '24px is the SC 2.5.8 floor exactly — leave margin');
});

test('rows carry scroll-margin so a focused control clears the sticky header (SC 2.4.11)', () => {
  const html = renderTable([row({})], indigoSummary);
  const body = html.slice(html.indexOf('<tbody>'));
  assert.ok(body.includes('scroll-mt-12'), 'without it, Tab parks focus under the pinned header');
});

test('the table paints its OWN background, so it cannot end mid-scroll', () => {
  // The colour seam: a wrapper carrying bg-card is only as wide as the scroll container, while the
  // table is w-max and wider — past the wrapper the page ground showed through as a fake column tint.
  const html = renderTable([row({})], indigoSummary);
  const table = html.match(/<table[^>]*>/)?.[0] ?? '';
  assert.ok(table.includes('bg-card'), `the table must carry the fill: ${table}`);
  assert.ok(table.includes('w-max'), 'and it is the element that is wider than the viewport');
  // The old wrapper's signature was a div carrying BOTH the fill and the border. Cells legitimately
  // contain divs, so the check is for that pairing rather than for the absence of any div.
  const stranding = (html.match(/<div[^>]*>/g) ?? []).filter((d) => d.includes('bg-card') && d.includes('border-line'));
  assert.deepEqual(stranding, [], 'a div carrying the fill would strand it at the scroll-container edge');
});

/* ── the drill-down: tenant colour, and being navigated to ────────────────────────────────────── */

/**
 * The chart hardcoded the CONSOLIDATED teal, so it painted teal on every tenant while the rest of
 * the route resolved `--brand-*` from `data-view` — a tenant's number wearing another tenant's
 * colour. It must stay literal hex (recharts writes SVG attributes, where a CSS var is unreliable),
 * so the only thing that can keep it honest is asserting it MIRRORS globals.css.
 */
test('the drill-down chart bar colour mirrors each tenant brand-ink in globals.css', () => {
  const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');
  const inkFor = (view: string): string | null => {
    const block = css.slice(css.indexOf(`[data-view='${view}']`));
    const m = block.slice(0, 400).match(/--brand-ink:\s*(#[0-9a-fA-F]{6})/);
    return m?.[1]?.toLowerCase() ?? null;
  };
  for (const tenant of ['bxr', 'indigo'] as const) {
    const ink = inkFor(tenant);
    assert.ok(ink, `globals.css has no --brand-ink for ${tenant}`);
    assert.equal(
      CHART_BY_TENANT[tenant].billed.toLowerCase(),
      ink,
      `${tenant}: the chart bar must be that tenant's brand ink`,
    );
  }
  // And it must not be the consolidated teal, which is what it used to be for everyone.
  const consolidated = inkFor('consolidated');
  for (const tenant of ['bxr', 'indigo'] as const) {
    assert.notEqual(CHART_BY_TENANT[tenant].billed.toLowerCase(), consolidated, `${tenant} is wearing the consolidated colour`);
  }
});

/**
 * Opening a row must MOVE the reader to what it opened. The panel renders below a full-height table
 * inside the same scroller, so revealing it off-screen looked like the chevron did nothing. Focus is
 * the mechanism (it scrolls, and a screen reader's position follows); `scroll-mt` keeps it clear of
 * the sticky header. Asserted on the view SOURCE because the behaviour needs a real scrollport.
 */
test('view source: expanding a row moves focus to the drill-down, and it clears the sticky header', () => {
  const raw = readFileSync(join(here, '..', 'components', 'code-performance', 'code-performance-view.tsx'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const drilldownRef = useRef<HTMLElement \| null>\(null\);/, 'a ref on the panel');
  assert.match(
    src,
    /useEffect\(\(\) => \{\s*if \(expanded === null\) return;\s*drilldownRef\.current\?\.focus\(\);\s*\}, \[expanded\]\);/,
    'focus moves on EXPAND only — collapsing must not yank focus',
  );
  assert.match(src, /ref=\{drilldownRef\}\s*tabIndex=\{-1\}/, 'the panel is a programmatic focus target');
  assert.match(src, /className="scroll-mt-12 space-y-2"/, 'and it clears the sticky header when scrolled to');
});

/**
 * The two layout levers and the horizontal-scroll fix. A flex item's `min-width:auto` refuses to
 * shrink below its content, and this column holds a `w-max` table — so without `min-w-0` the column
 * grew past `main`, the DOCUMENT scrolled sideways, and the pinned KPI header rode off-screen with
 * it. The symptom reads as a sticky bug and is a min-width bug, which is why it is pinned here.
 */
test('view source: the table column cannot blow out its container, and the charts are a landmark', () => {
  const raw = readFileSync(join(here, '..', 'components', 'code-performance', 'code-performance-view.tsx'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /flex min-h-0 min-w-0 flex-1 flex-col/, 'the table column carries min-w-0');
  assert.match(src, /min-h-0 min-w-0 flex-1 overflow-auto/, 'so does the scroller itself');
  assert.match(src, /<aside\s+id="cp-charts"\s+aria-label="Summary charts"/, 'the charts are a LABELLED complementary landmark');
  // Conditionally rendered, never `hidden` — a display:flex class beats the hidden attribute.
  assert.match(src, /\{chartsOpen && \(/, 'the sidebar unmounts rather than relying on [hidden]');
  assert.equal(/<aside[^>]*\shidden/.test(src), false, 'a hidden aside carrying display:flex would stay visible');
});
