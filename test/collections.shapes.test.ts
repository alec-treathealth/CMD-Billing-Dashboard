import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyShape, parseTab, type Tab } from '../src/collections/shapes.js';
import type { CollectionsFailure, FailSink } from '../src/collections/report.js';
import type {
  DailyRow, NegotiationRow, PaymentLineRow, RollupRow, TypedRecord, Workbook,
} from '../src/collections/types.js';

const sink = () => {
  const fails: CollectionsFailure[] = [];
  const s: FailSink = { fail: (f) => fails.push(f) };
  return { s, fails };
};
const GROUP_TREAT: Workbook = { code: 'TREAT_FRCA', sheetId: 'x', kind: 'group', groupCode: 'TREAT_FRCA' };
const PAY_HEADER = ['Charge From Date', 'Charge Primary Payment Date', 'Charge CPT Code', 'CPT Default Rev Code', 'Patient Full Name', 'Claim Primary Member ID', 'Primary Group Number', 'Charge/Debit Amount', 'Payment Allowed Amount', 'Charge Insurance Payments', 'Charge Total Adjustments w/o Transfers', 'Charge Balance Due Pat', 'Charge Primary Payer Name'];

const rows = <T>(recs: TypedRecord[], shape: T): Extract<TypedRecord, { shape: T }>['row'][] =>
  recs.filter((r) => r.shape === shape).map((r) => r.row as never);

test('daily: group workbook resolves horizontal + stacked blocks, skips TOTALS, no failures', () => {
  const tab: Tab = { title: 'January', rows: [
    ['TMH CA', '', '', '', '', 'TMH TN'],
    ['', 'Checks', 'EFT', 'Gross', '', '', 'Checks', 'EFT', 'Gross'],
    ['01/02/2026', '$ -', '$ 100.00', '$ 100.00', '', '01/03/2026', '$ 5.00', '$ -', '$ 5.00'],
    ['TOTALS', '$ -', '$ 100.00', '$ 100.00', '', 'TOTALS', '$ 5.00', '$ -', '$ 5.00'],
    ['FRCA'],
    ['', 'Checks', 'EFT', 'Gross'],
    ['01/05/2026', '$ 50.00', '$ -', '$ 50.00'],
  ] };
  assert.equal(classifyShape(GROUP_TREAT, tab), 'daily');
  const { s, fails } = sink();
  const res = parseTab(GROUP_TREAT, tab, 'x', 'daily', s);
  const daily = rows(res.typed, 'daily') as DailyRow[];
  assert.deepEqual(daily.map((d) => d.facility_code).sort(), ['FRCA', 'TREAT_CA', 'TREAT_TN']);
  assert.ok(daily.every((d) => d.source_group_code === 'TREAT_FRCA'));
  assert.equal(daily.find((d) => d.facility_code === 'TREAT_CA')?.gross_amount, '100.00');
  assert.equal(fails.length, 0);
});

test('payment_line: facility from tab; comma name split; member-id whitespace stripped; mixed dates', () => {
  const tab: Tab = { title: 'Treat CA', rows: [
    PAY_HEADER,
    ['05/10/2024', '5/24/2024', 'S9480', '905', 'DOE, JAYNE', 'AB1234567 89', '', '$1,000.00', '$250.00', '$250.00', '$750.00', '$0.00', 'UNITED HEALTHCARE'],
  ] };
  assert.equal(classifyShape(GROUP_TREAT, tab), 'payment_line');
  const { s, fails } = sink();
  const res = parseTab(GROUP_TREAT, tab, 'x', 'payment_line', s);
  const pl = rows(res.typed, 'payment_line') as PaymentLineRow[];
  assert.equal(pl.length, 1);
  const r = pl[0]!;
  assert.equal(r.facility_code, 'TREAT_CA');
  assert.equal(r.source_group_code, 'TREAT_FRCA');
  assert.equal(r.patient_last, 'DOE');
  assert.equal(r.patient_first, 'JAYNE');
  assert.equal(r.member_id_raw, 'AB1234567 89');
  assert.equal(r.member_id_norm, 'AB123456789');
  assert.equal(r.service_date, '2024-05-10');
  assert.equal(r.payment_date, '2024-05-24'); // M/D/YYYY accepted
  assert.equal(fails.length, 0);
});

test('negotiation: client_name kept unsplit; facility from own column or workbook', () => {
  const kwc: Workbook = { code: 'KWC', sheetId: 'k', kind: 'single', facilityCode: 'KWC' };
  const tabNoFac: Tab = { title: 'TPP Plans', rows: [
    ['Client Name', 'Insurance', 'Alpha', 'Homeplan', 'Billed Amount', 'Allowed Amount', 'Percentage', 'TPP'],
    ['John Smith', 'AETNA', 'ABC', 'CA', '$1,000.00', '$200.00', '20.00%', 'Zelis'],
  ] };
  assert.equal(classifyShape(kwc, tabNoFac), 'negotiation');
  const a = parseTab(kwc, tabNoFac, 'k', 'negotiation', sink().s);
  const n = (rows(a.typed, 'negotiation') as NegotiationRow[])[0]!;
  assert.equal(n.client_name, 'John Smith'); // verbatim, no last/first
  assert.equal(n.facility_code, 'KWC');
  assert.equal(n.negotiated_pct, '0.2000');
  assert.equal(n.tpp, 'Zelis');

  const grp: Workbook = { code: 'LSMH_DMH', sheetId: 'l', kind: 'group', groupCode: 'LSMH_DMH' };
  const tabFac: Tab = { title: 'TPP Plans', rows: [
    ['Client Name', 'Insurance', 'Alpha', 'Homeplan', 'Billed Amount', 'Allowed Amount', 'Percentage', 'TPP', 'Facility'],
    ['Jane Doe', 'CIGNA', 'XYZ', 'TX', '$2,000.00', '$500.00', '25%', 'Multiplan', 'LONESTAR MENTAL HEALTH LLC'],
  ] };
  const b = (rows(parseTab(grp, tabFac, 'l', 'negotiation', sink().s).typed, 'negotiation') as NegotiationRow[])[0]!;
  assert.equal(b.facility_code, 'LSMH'); // resolved from the row's own Facility column
  assert.equal(b.source_group_code, 'LSMH_DMH');
});

test('rollup: grain facility vs payer, raw landed verbatim', () => {
  const wb: Workbook = { code: 'BXR_ROLLUP', sheetId: 'b', kind: 'rollup' };
  const facTab: Tab = { title: 'All Facility Data', rows: [
    ['Facility', 'Total Billed', 'Total Allowed', 'Average Percentage'],
    ['California Mental Health', '$1.00', '$1.00', '50%'],
  ] };
  const payTab: Tab = { title: 'Nashville Mental Health', rows: [
    ['Payer Name', 'Billed Amount', 'Allowed Amount', 'Percentage'],
    ['AETNA', '$1.00', '$1.00', '27%'],
  ] };
  const f = (rows(parseTab(wb, facTab, 'b', 'rollup', sink().s).typed, 'rollup') as RollupRow[])[0]!;
  assert.equal(f.grain, 'facility');
  assert.equal(f.raw['Facility'], 'California Mental Health');
  const p = (rows(parseTab(wb, payTab, 'b', 'rollup', sink().s).typed, 'rollup') as RollupRow[])[0]!;
  assert.equal(p.grain, 'payer');
  assert.equal(p.raw['Payer Name'], 'AETNA');
});
