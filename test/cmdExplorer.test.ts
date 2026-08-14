import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BXR_REPORT_COLUMNS,
  HEADERS,
  mapReportRows,
  reportColumns,
  toNonPhi,
} from '../src/collections/cmdExplorer.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';

const baseRow: CmdReportRow = {
  'Charge From Date': '03/14/2026',
  'Payment Received': '',
  'Charge CPT Code': '90853',
  'Revenue Code': '0915',
  'Facility Name': 'Saddleback',
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
  assert.equal(row.facility, 'Saddleback');
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

// ---------------------------------------------------------------------------
// BXR_REPORT_COLUMNS must stay in step with what the mapper actually reads. These two can
// drift independently — someone adds a HEADERS alias for a renamed CMD column but forgets the
// pinned set (guard rejects a good report), or edits the pinned set without the alias (guard
// passes a report the mapper silently nulls). Both are caught here.
// ---------------------------------------------------------------------------
test('BXR_REPORT_COLUMNS: every field the mapper reads is satisfied by a listed column', () => {
  const pinned = new Set<string>(BXR_REPORT_COLUMNS);

  // HEADERS candidates are alternatives — at least ONE must be present per field.
  // TWO deliberate exceptions, both "the mapper can read a column the pinned set does not promise",
  // which is the SAFE direction (pick() → null; the guard still rejects any unexpected column):
  //  - charge_to_date: CMD retired 'Charge To Date' (it duplicated 'Charge From Date' on
  //    2,579/2,579 rows) and nothing on this plane reads the column.
  //  - employer_name: 'Primary Ins Emp Name' is PENDING on the cron's report. Probed live
  //    2026-08-14 — report 10093959 still projects 24 columns without it (the owner added it to the
  //    separate payments report 10050915). The mapper is ready; the pinned set must NOT list it
  //    until the live report does, or set-equality fails every BXR customer and freezes ingest.
  //    ⚠ When the owner adds it to 10093959: drop 'employer_name' from this exception list AND add
  //    'Primary Ins Emp Name' to BXR_REPORT_COLUMNS in the same commit — the two move together.
  const PENDING_OR_RETIRED = new Set(['charge_to_date', 'employer_name']);
  const fields = Object.entries(HEADERS).filter(([k]) => !PENDING_OR_RETIRED.has(k));
  for (const [field, candidates] of fields) {
    assert.ok(
      (candidates as readonly string[]).some((c) => pinned.has(c)),
      `HEADERS.${field} has no candidate in BXR_REPORT_COLUMNS — the guard would accept a report the mapper cannot read`,
    );
  }

  // The deposit columns are read directly by aggregateDailyDeposits, not through HEADERS.
  for (const c of ['Check Payment', 'EFT Payment', 'Payment Received']) {
    assert.ok(pinned.has(c), `${c} feeds daily_collections and must be pinned`);
  }

  assert.equal(
    pinned.size,
    BXR_REPORT_COLUMNS.length,
    'no duplicate column names (a duplicate silently weakens set-equality)',
  );
  assert.equal(pinned.has('Charge To Date'), false, 'retired column must NOT be pinned');
});

test('reportColumns: reads the header keys off row 0, and an empty pull yields no columns', () => {
  assert.deepEqual(reportColumns([{ b: '2', a: '1' }]), ['b', 'a'], 'insertion order preserved, not sorted');
  assert.deepEqual(reportColumns([]), [], 'empty pull ⇒ no columns (callers must skip the guard)');
});
