import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BXR_REPORT_COLUMNS,
  BXR_REPORT_COLUMNS_10094775,
  bxrExpectedColumnsFor,
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
  // TWO deliberate exceptions, for DIFFERENT reasons — do not collapse them into one list
  // without reading both:
  //
  //  · charge_to_date — PERMANENT. CMD retired 'Charge To Date' (it duplicated 'Charge From Date'
  //    on 2,579/2,579 rows) and nothing on this plane reads the column.
  //
  //  · employer_name — TRANSITIONAL, and it must be REMOVED from this list at cutover.
  //    BXR_REPORT_COLUMNS pins the report the cron runs RIGHT NOW (10093959), which carries no
  //    employer column. The replacement report (10094775) does, under the label
  //    'Primary Ins Emp Name'. Until CMD_EXPLORER_REPORT_ID is repointed and this set re-pinned,
  //    demanding an employer candidate here would assert a column the LIVE report does not have —
  //    and because the pin is enforced as SET EQUALITY, that would make the guard reject every
  //    BXR pull and freeze the ingest before a single write.
  //    Safe to except because employer is nullable end to end: pick() returns null for an absent
  //    column, mapRow coerces it, and the DB column is nullable — so a report without it maps
  //    cleanly rather than skipping rows.
  //    AT CUTOVER: re-pin BXR_REPORT_COLUMNS to 10094775's real column set, then delete
  //    'employer_name' from this filter so the guard starts enforcing it.
  const fields = Object.entries(HEADERS).filter(
    ([k]) => k !== 'charge_to_date' && k !== 'employer_name',
  );
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

// --- report 10094775 (the BXR replacement, 2026-08-15) ----------------------

test('10094775: every HEADERS field the mapper reads is satisfied — INCLUDING employer', () => {
  const pinned = new Set<string>(BXR_REPORT_COLUMNS_10094775);
  // No employer exception here, unlike the legacy set: this report DOES carry the column, so the
  // guard must enforce it. If CMD ever drops 'Primary Ins Emp Name' again this fails immediately
  // instead of silently nulling the whole Collections employer feature.
  const fields = Object.entries(HEADERS).filter(([k]) => k !== 'charge_to_date');
  for (const [field, candidates] of fields) {
    assert.ok(
      (candidates as readonly string[]).some((c) => pinned.has(c)),
      `HEADERS.${field} has no candidate in BXR_REPORT_COLUMNS_10094775`,
    );
  }
  for (const c of ['Check Payment', 'EFT Payment', 'Payment Received']) {
    assert.ok(pinned.has(c), `${c} feeds daily_collections and must be pinned`);
  }
  assert.equal(pinned.size, BXR_REPORT_COLUMNS_10094775.length, 'no duplicate column names');
  assert.equal(pinned.has('Charge To Date'), false, 'retired column must NOT be pinned');
});

test('10094775: the employer label is the EMPLOYER field, not a person', () => {
  const pinned = new Set<string>(BXR_REPORT_COLUMNS_10094775);
  // 'Primary Ins Emp Name' is the plan SPONSOR. The subscriber's own name is a SEPARATE pinned
  // column, and their coexistence is the evidence for the non-PHI ruling on employer. If a future
  // edit ever made these the same column, the ruling would no longer hold.
  assert.ok(pinned.has('Primary Ins Emp Name'));
  assert.ok(pinned.has('Patient Full Name'));
  assert.notEqual('Primary Ins Emp Name', 'Patient Full Name');
  assert.deepEqual(HEADERS.employer_name.filter((c) => pinned.has(c)), ['Primary Ins Emp Name']);
  assert.equal((HEADERS.patient_name as readonly string[]).includes('Primary Ins Emp Name'), false);
});

test('relabelled aliases resolve to the NEW label on 10094775 and the CANONICAL one on 10093959', () => {
  // The ordering invariant, asserted rather than trusted to comments. pick() takes the FIRST
  // candidate present, and 10093959 carries BOTH labels for insurance_payments and adjustments —
  // so a reordering would silently repoint two fingerprint fields on the LIVE report.
  const legacy = new Set<string>(BXR_REPORT_COLUMNS);
  const next = new Set<string>(BXR_REPORT_COLUMNS_10094775);
  const firstPresent = (cands: readonly string[], set: Set<string>) => cands.find((c) => set.has(c));

  assert.equal(firstPresent(HEADERS.insurance_payments, legacy), 'Charge Insurance Payments');
  assert.equal(firstPresent(HEADERS.insurance_payments, next), 'Insurance Paid Amount');
  assert.equal(firstPresent(HEADERS.adjustments, legacy), 'Charge Total Adjustments w/ Transfers');
  assert.equal(firstPresent(HEADERS.adjustments, next), 'Insurance Adjustment Amount');
  assert.equal(firstPresent(HEADERS.member_id_raw, legacy), 'Claim Primary Member ID');
  assert.equal(firstPresent(HEADERS.member_id_raw, next), 'Current Payer Member ID');
  assert.equal(firstPresent(HEADERS.charge_amount, legacy), 'Charge/Debit Amount');
  assert.equal(firstPresent(HEADERS.charge_amount, next), 'Charge Amount');
  assert.equal(firstPresent(HEADERS.revenue_code, legacy), 'Revenue Code');
  assert.equal(firstPresent(HEADERS.revenue_code, next), 'Charge Rev Code');
  assert.equal(firstPresent(HEADERS.group_number, legacy), 'Primary Group #');
  assert.equal(firstPresent(HEADERS.group_number, next), 'Current Payer Group #');

  // 'Patient Total Balance' stays REJECTED (0/85) — it must never be a candidate for anything.
  for (const cands of Object.values(HEADERS)) {
    assert.equal((cands as readonly string[]).includes('Patient Total Balance'), false);
  }
});

test('bxrExpectedColumnsFor: follows the report id, and an UNKNOWN id falls back to a guard', () => {
  assert.equal(bxrExpectedColumnsFor('10094775'), BXR_REPORT_COLUMNS_10094775);
  assert.equal(bxrExpectedColumnsFor(' 10094775 '), BXR_REPORT_COLUMNS_10094775, 'trims');
  assert.equal(bxrExpectedColumnsFor('10093959'), BXR_REPORT_COLUMNS);
  // The important one: an unrecognised id must NOT disable the guard. Returning undefined/[] here
  // would make the cron accept ANY projection from a report nobody has verified.
  const unknown = bxrExpectedColumnsFor('99999999');
  assert.equal(unknown, BXR_REPORT_COLUMNS);
  assert.ok(unknown.length > 0, 'never an empty set — that would silently disable set-equality');
});
