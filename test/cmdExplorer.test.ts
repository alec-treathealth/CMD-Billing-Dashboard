import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapReportRows, toNonPhi } from '../src/collections/cmdExplorer.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';

const baseRow: CmdReportRow = {
  'Charge From Date': '03/14/2026',
  'Payment Received': '',
  'Charge CPT Code': '90853',
  'Revenue Code': '0915',
  'Facility Name/ID': 'Saddleback / 12',
  'Patient Full Name': 'DOE, JANE',
  'Claim Primary Member ID': 'PGE081',
  'Primary Group Number': 'GRP-7',
  'Charge/Debit Amount': '$250.00',
  'Payment Allowed Amount': '',
  'Charge Insurance Payments': '$0.00',
  'Charge Total Adjustments w/o Transfers': '$10.00',
  'Charge Balance Due Pat': '$240.00',
  'Charge Primary Payer Name': 'Beacon Carelon',
};

test('maps all 14 columns and splits PHI out of the non-PHI projection', () => {
  const [row] = mapReportRows([baseRow]);
  assert.ok(row);
  assert.equal(row.charge_from_date, '03/14/2026');
  assert.equal(row.cpt_code, '90853');
  assert.equal(row.revenue_code, '0915');
  assert.equal(row.facility, 'Saddleback / 12');
  assert.equal(row.charge_amount, '$250.00');
  assert.equal(row.insurance_payments, '$0.00');
  assert.equal(row.adjustments, '$10.00');
  assert.equal(row.patient_balance_due, '$240.00');
  assert.equal(row.primary_payer, 'Beacon Carelon');
  // blanks normalize to null
  assert.equal(row.payment_received, null);
  assert.equal(row.allowed_amount, null);
  // PHI lives only under .phi
  assert.equal(row.phi.patient_name, 'DOE, JANE');
  assert.equal(row.phi.member_id_raw, 'PGE081');
  assert.equal(row.phi.group_number, 'GRP-7');
  // the non-PHI projection drops .phi and contains no patient identifiers
  const [nonPhi] = toNonPhi([row]);
  assert.ok(nonPhi);
  assert.ok(!('phi' in nonPhi));
  assert.ok(!JSON.stringify(nonPhi).includes('JANE'));
  assert.ok(!JSON.stringify(nonPhi).includes('PGE081'));
  assert.equal(row.rowId.length, 64);
});

test('rowId is deterministic and PHI-sensitive (different patient ⇒ different id)', () => {
  const [a] = mapReportRows([baseRow]);
  const [b] = mapReportRows([baseRow]);
  assert.ok(a && b);
  assert.equal(a.rowId, b.rowId); // deterministic for identical content
  const [c] = mapReportRows([{ ...baseRow, 'Patient Full Name': 'ROE, JOHN' }]);
  assert.ok(c);
  assert.notEqual(a.rowId, c.rowId); // a PHI change flips the fingerprint
});
