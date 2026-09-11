/**
 * SYNTHETIC snapshot fixture for the AR Management mapper tests. Every id, name, payer and amount
 * here is invented; nothing is copied from a real CMD export. Shapes mirror the real .DAT headers
 * (only the columns the mapper reads are populated).
 */
import { snapshotTablesFrom, type SnapshotRow, type SnapshotTable, type SnapshotTables } from '../../src/billingAudit/snapshotParse.js';

function table(name: string, rows: Array<Record<string, string>>): SnapshotTable {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { name, columns, rows: rows as SnapshotRow[] };
}

export const FX = {
  claimA: '900000001', // two lines: one paid, one open at primary
  claimB: '900000002', // one line open at SECONDARY (activity prio S)
  claimC: '900000003', // custom status NEEDS RENEGOTIATING
  claimD: '900000004', // balance due patient
  claimE: '900000005', // balance due other, plus a deleted charge and a non-H trantype charge
  claimF: '900000006', // fully paid; carries an ERROR status event and a note
  claimDel: '900000007', // deleted claim — dropped with its charge
  claimNoName: '900000008', // patient has no name — dropped
  pat1: '80000001',
  pat2: '80000002',
  pat3: '80000003',
  payerAlpha: '70000001',
  payerBeta: '70000002',
  statusNeg: '10093246',
} as const;

export function buildFixture(overrides: Partial<Record<string, SnapshotTable>> = {}): SnapshotTables {
  const t = new Map<string, SnapshotTable>();
  t.set('B_CHARGESTATUS', table('B_CHARGESTATUS', [
    { STATUS: FX.statusNeg, DISPLAY_TEXT: 'Needs Renegotiating', DELETED: 'N', DUETO: 'I' },
    { STATUS: '10062963', DISPLAY_TEXT: 'WRITE OFF', DELETED: 'Y', DUETO: 'O' },
  ]));
  t.set('B_PAYOR', table('B_PAYOR', [
    { SEQNO: FX.payerAlpha, PAYOR: 'ALPHA HEALTH PLAN', PAYORTYPE: '5', DELETED: '0' },
    { SEQNO: FX.payerBeta, PAYOR: 'BETA MUTUAL', PAYORTYPE: '6', DELETED: '0' },
  ]));
  t.set('B_PATIENT', table('B_PATIENT', [
    { PACCTNO: FX.pat1, PLAST: 'TESTLAST', PFIRST: 'ALEX', PBDATE: '01/02/1990', INSID1: 'ZZZ111', GROUPNO1: 'G1', DELETED: '0' },
    { PACCTNO: FX.pat2, PLAST: 'SAMPLE', PFIRST: 'JORDAN', PBDATE: '', INSID1: '', GROUPNO1: '', DELETED: '0' },
    { PACCTNO: FX.pat3, PLAST: '', PFIRST: '', PBDATE: '', INSID1: '', GROUPNO1: '', DELETED: '0' },
  ]));
  t.set('INS_POLICIES', table('INS_POLICIES', [
    { PATIENT: FX.pat1, PAYER: FX.payerAlpha, PRIORITY: '1', MEMBER_ID: 'ZZZ111POL', GROUP_NO: 'GPOL', INACTIVE: '0' },
    { PATIENT: FX.pat2, PAYER: FX.payerBeta, PRIORITY: '1', MEMBER_ID: 'YYY222', GROUP_NO: '', INACTIVE: '1' }, // inactive → ignored
  ]));
  t.set('B_CLAIM', table('B_CLAIM', [
    { SEQNO: FX.claimA, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'I', FREQUENCY: '', AUTHNO1: 'AUTH-1', CTRLNO1: 'CTRL1', FOLLOWUP: '10/01/2026', FROMDATE: '03/01/2026', TODATE: '03/05/2026', ENTERED: '03/06/2026 09:00:00' },
    { SEQNO: FX.claimB, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: FX.payerBeta, DELETED: '0', CLAIMTYPE: 'I', FREQUENCY: '7', AUTHNO1: '', CTRLNO1: '', FOLLOWUP: '', FROMDATE: '04/10/2026', TODATE: '04/12/2026', ENTERED: '04/13/2026 09:00:00' },
    { SEQNO: FX.claimC, PATIENT: FX.pat1, PAYOR1: FX.payerBeta, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'P', FREQUENCY: '', ENTERED: '05/01/2026 09:00:00' },
    { SEQNO: FX.claimD, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'I', ENTERED: '05/02/2026 09:00:00' },
    { SEQNO: FX.claimE, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'I', ENTERED: '05/03/2026 09:00:00' },
    { SEQNO: FX.claimF, PATIENT: FX.pat2, PAYOR1: FX.payerBeta, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'I', ENTERED: '01/03/2026 09:00:00' },
    { SEQNO: FX.claimDel, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', DELETED: '1', CLAIMTYPE: 'I', ENTERED: '01/03/2026 09:00:00' },
    { SEQNO: FX.claimNoName, PATIENT: FX.pat3, PAYOR1: FX.payerAlpha, PAYOR2: '0', DELETED: '0', CLAIMTYPE: 'I', ENTERED: '01/03/2026 09:00:00' },
  ]));
  t.set('ICLAIM', table('ICLAIM', [
    { SEQNO: FX.claimA, BILLTYPE: '863', ADMITDATE: '03/01/2026', DISCHARGEDATE: '03/05/2026' },
  ]));
  t.set('B_CHARGE', table('B_CHARGE', [
    // claim A: line 1 paid, line 2 open at insurance (primary)
    { TRANID: '600000001', CLAIMID: FX.claimA, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '03/01/2026', TODATE: '03/01/2026', CPT: 'H0018', MOD1: '', MOD2: '', MOD3: '', MOD4: '', REVCODE: '1001', UNITS: '1', AMOUNT: '1000.00', ALLOWED: '600.00', INSPAID: '600.00', PATPAID: '0', ADJMENTS: '400.00', BALANCE: '0.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', FIRSTBILLDATE: '03/06/2026', LASTBILLDATE: '03/06/2026', INS_LAST_PAYMENT_DATE: '04/01/2026', ENTERED: '03/06/2026 09:00:00', LASTUPDATE: '04/01/2026 10:00:00' },
    { TRANID: '600000002', CLAIMID: FX.claimA, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '03/02/2026', TODATE: '03/05/2026', CPT: 'H0018', MOD1: 'HE', MOD2: '', MOD3: '', MOD4: '', REVCODE: '1001', UNITS: '4', AMOUNT: '4000.00', ALLOWED: '', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '4000.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', FIRSTBILLDATE: '03/06/2026', LASTBILLDATE: '05/06/2026', INS_LAST_PAYMENT_DATE: '', ENTERED: '03/06/2026 09:00:00', LASTUPDATE: '05/06/2026 10:00:00' },
    // claim B: open at secondary
    { TRANID: '600000003', CLAIMID: FX.claimB, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: FX.payerBeta, PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '04/10/2026', TODATE: '04/12/2026', CPT: 'H2036', REVCODE: '0158', UNITS: '3', AMOUNT: '3000.00', INSPAID: '1200.00', PATPAID: '0', ADJMENTS: '0', BALANCE: '1800.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '04/13/2026 09:00:00', LASTUPDATE: '06/01/2026 10:00:00' },
    // claim C: custom status wins even with balance and BALDUETO I
    { TRANID: '600000004', CLAIMID: FX.claimC, PATIENT: FX.pat1, PAYOR1: FX.payerBeta, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '05/01/2026', TODATE: '05/01/2026', CPT: 'H0017', REVCODE: '0158', UNITS: '1', AMOUNT: '2500.00', INSPAID: '500.00', PATPAID: '0', ADJMENTS: '0', BALANCE: '2000.00', BALDUETO: 'I', BILLTO: '3', STATUS: FX.statusNeg, ENTERED: '05/01/2026 09:00:00', LASTUPDATE: '05/20/2026 10:00:00' },
    // claim D: balance due patient
    { TRANID: '600000005', CLAIMID: FX.claimD, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '05/02/2026', TODATE: '05/02/2026', CPT: 'H2018', REVCODE: '0905', UNITS: '1', AMOUNT: '300.00', INSPAID: '200.00', PATPAID: '0', ADJMENTS: '0', BALANCE: '100.00', BALDUETO: 'P', BILLTO: '3', STATUS: '', ENTERED: '05/02/2026 09:00:00', LASTUPDATE: '05/02/2026 10:00:00' },
    // claim E: balance due other + a deleted charge + a non-H trantype charge
    { TRANID: '600000006', CLAIMID: FX.claimE, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '05/03/2026', TODATE: '05/03/2026', CPT: 'H2018', REVCODE: '0905', UNITS: '1', AMOUNT: '300.00', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '300.00', BALDUETO: 'O', BILLTO: 'Z', STATUS: '', ENTERED: '05/03/2026 09:00:00', LASTUPDATE: '05/03/2026 10:00:00' },
    { TRANID: '600000007', CLAIMID: FX.claimE, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '1', TRANTYPE: 'H', FROMDATE: '05/03/2026', TODATE: '05/03/2026', CPT: 'H2018', REVCODE: '0905', UNITS: '1', AMOUNT: '300.00', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '300.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '05/03/2026 09:00:00', LASTUPDATE: '05/03/2026 10:00:00' },
    { TRANID: '600000008', CLAIMID: FX.claimE, PATIENT: FX.pat2, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'D', FROMDATE: '05/03/2026', TODATE: '05/03/2026', CPT: 'H2018', REVCODE: '0905', UNITS: '1', AMOUNT: '300.00', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '300.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '05/03/2026 09:00:00', LASTUPDATE: '05/03/2026 10:00:00' },
    // claim F: fully paid (PAID), old DOS
    { TRANID: '600000009', CLAIMID: FX.claimF, PATIENT: FX.pat2, PAYOR1: FX.payerBeta, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '01/02/2026', TODATE: '01/02/2026', CPT: 'H0019', REVCODE: '0100', UNITS: '1', AMOUNT: '5795.00', INSPAID: '5795.00', PATPAID: '0', ADJMENTS: '0', BALANCE: '0.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '01/03/2026 09:00:00', LASTUPDATE: '02/01/2026 10:00:00' },
    // deleted claim's charge
    { TRANID: '600000010', CLAIMID: FX.claimDel, PATIENT: FX.pat1, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '01/02/2026', TODATE: '01/02/2026', CPT: 'H0019', REVCODE: '0100', UNITS: '1', AMOUNT: '10.00', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '10.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '01/03/2026 09:00:00', LASTUPDATE: '01/03/2026 10:00:00' },
    // unnamed patient's charge
    { TRANID: '600000011', CLAIMID: FX.claimNoName, PATIENT: FX.pat3, PAYOR1: FX.payerAlpha, PAYOR2: '0', PAYOR3: '0', DELETED: '0', TRANTYPE: 'H', FROMDATE: '01/02/2026', TODATE: '01/02/2026', CPT: 'H0019', REVCODE: '0100', UNITS: '1', AMOUNT: '10.00', INSPAID: '0', PATPAID: '0', ADJMENTS: '0', BALANCE: '10.00', BALDUETO: 'I', BILLTO: '3', STATUS: '', ENTERED: '01/03/2026 09:00:00', LASTUPDATE: '01/03/2026 10:00:00' },
  ]));
  t.set('B_ACTIVITY', table('B_ACTIVITY', [
    { TRANID: '500000001', CLAIMID: FX.claimA, PAYOR: FX.payerAlpha, TRANTYPE: 'E', PAYER_PRIORITY: 'P', RSTATUS: '', RDATE: '', ENTERED: '03/06/2026 12:00:00', DELETED: '0' },
    { TRANID: '500000002', CLAIMID: FX.claimA, PAYOR: FX.payerAlpha, TRANTYPE: 'E', PAYER_PRIORITY: 'P', RSTATUS: '1', RDATE: '04/01/2026', ENTERED: '03/20/2026 12:00:00', DELETED: '0' },
    { TRANID: '500000003', CLAIMID: FX.claimB, PAYOR: FX.payerAlpha, TRANTYPE: 'E', PAYER_PRIORITY: 'P', RSTATUS: '1', RDATE: '05/01/2026', ENTERED: '04/13/2026 12:00:00', DELETED: '0' },
    { TRANID: '500000004', CLAIMID: FX.claimB, PAYOR: FX.payerBeta, TRANTYPE: 'E', PAYER_PRIORITY: 'S', RSTATUS: '', RDATE: '', ENTERED: '05/15/2026 12:00:00', DELETED: '0' },
    { TRANID: '500000005', CLAIMID: FX.claimB, PAYOR: FX.payerAlpha, TRANTYPE: 'T', PAYER_PRIORITY: '', RSTATUS: '', RDATE: '', ENTERED: '06/15/2026 12:00:00', DELETED: '0' }, // not a submission
    { TRANID: '500000006', CLAIMID: FX.claimA, PAYOR: FX.payerBeta, TRANTYPE: 'E', PAYER_PRIORITY: 'S', RSTATUS: '', RDATE: '', ENTERED: '02/01/2026 12:00:00', DELETED: '1' }, // deleted
  ]));
  t.set('B_REMITTANCE', table('B_REMITTANCE', [
    { SEQNO: '400000001', CLAIM: FX.claimA, CHARGE: '600000001', CREDIT: '1', CODE: '45', TYPE: 'A', GROUP_CODE: 'CO', AMOUNT: '400.00', DENIAL: 'N', ADJUSTMENT: 'Y', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '04/01/2026', DELETED: '0' },
    { SEQNO: '400000002', CLAIM: FX.claimA, CHARGE: '600000002', CREDIT: '2', CODE: '197', TYPE: 'A', GROUP_CODE: 'CO', AMOUNT: '4000.00', DENIAL: 'Y', ADJUSTMENT: 'Y', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/01/2026', DELETED: '0' },
    { SEQNO: '400000003', CLAIM: FX.claimA, CHARGE: '600000002', CREDIT: '2', CODE: 'N54', TYPE: 'R', GROUP_CODE: '', AMOUNT: '', DENIAL: 'N', ADJUSTMENT: 'N', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/01/2026', DELETED: '0' },
    { SEQNO: '400000004', CLAIM: FX.claimA, CHARGE: '600000002', CREDIT: '2', CODE: '2', TYPE: 'A', GROUP_CODE: 'PR', AMOUNT: '50.00', DENIAL: 'N', ADJUSTMENT: 'N', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/01/2026', DELETED: '0' },
    { SEQNO: '400000005', CLAIM: FX.claimA, CHARGE: '600000002', CREDIT: '2', CODE: '197', TYPE: 'A', GROUP_CODE: 'CO', AMOUNT: '-100.00', DENIAL: 'N', ADJUSTMENT: 'Y', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/02/2026', DELETED: '0' },
    { SEQNO: '400000006', CLAIM: FX.claimA, CHARGE: '600000002', CREDIT: '2', CODE: '45', TYPE: 'A', GROUP_CODE: 'CO', AMOUNT: '9.00', DENIAL: 'N', ADJUSTMENT: 'Y', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/02/2026', DELETED: '1' }, // deleted
    { SEQNO: '400000007', CLAIM: FX.claimDel, CHARGE: '600000010', CREDIT: '3', CODE: '45', TYPE: 'A', GROUP_CODE: 'CO', AMOUNT: '9.00', DENIAL: 'N', ADJUSTMENT: 'Y', PAYOR: FX.payerAlpha, PAYORLEVEL: '1', RECEIVED: '05/02/2026', DELETED: '0' }, // claim not kept
  ]));
  t.set('B_CLAIMSTATUS', table('B_CLAIMSTATUS', [
    { SEQNO: '300000001', CLAIM: FX.claimF, STATUS_TYPE: 'INFO', STATUS_DATE: '01/04/2026 08:00:00', STATUS_CODE: 'A1', STATUS_MESSAGE: 'Acknowledgement/Receipt', ACTION_CODE: '', ACTION_MESSAGE: '', RECEIVER_NAME: '277 DATA FILE', ERR_FIXED: 'X' },
    { SEQNO: '300000002', CLAIM: FX.claimF, STATUS_TYPE: 'ERROR', STATUS_DATE: '01/05/2026 08:00:00', STATUS_CODE: '16', STATUS_MESSAGE: 'Claim lacks information needed for adjudication.', ACTION_CODE: 'C', ACTION_MESSAGE: 'Correct and resubmit.', RECEIVER_NAME: 'BETA MUTUAL', ERR_FIXED: 'F' },
    { SEQNO: '300000003', CLAIM: FX.claimF, STATUS_TYPE: 'INFO', STATUS_DATE: '02/01/2026 08:00:00', STATUS_CODE: 'RA', STATUS_MESSAGE: 'RECEIVED REMITTANCE ADVICE FROM PAYER.', ACTION_CODE: '', ACTION_MESSAGE: '', RECEIVER_NAME: 'EPS', ERR_FIXED: 'X' },
    { SEQNO: '300000004', CLAIM: FX.claimA, STATUS_TYPE: 'INFO', STATUS_DATE: '03/07/2026 08:00:00', STATUS_CODE: 'A1', STATUS_MESSAGE: 'x'.repeat(400), ACTION_CODE: '', ACTION_MESSAGE: '', RECEIVER_NAME: '277 DATA FILE', ERR_FIXED: 'X' },
    // claimB's only error is one CMD has already RESOLVED (ERR_FIXED='T'). It must stay OUT of the
    // last_error_* roll-up the queue renders as an open problem, while remaining IN statusEvents so
    // the drawer's history is complete. Both halves are asserted in arSnapshotMap.test.ts.
    { SEQNO: '300000005', CLAIM: FX.claimB, STATUS_TYPE: 'ERROR', STATUS_DATE: '04/01/2026 08:00:00', STATUS_CODE: '27', STATUS_MESSAGE: 'Expenses incurred prior to coverage.', ACTION_CODE: 'C', ACTION_MESSAGE: 'Correct and resubmit.', RECEIVER_NAME: 'BETA MUTUAL', ERR_FIXED: 'T' },
  ]));
  t.set('B_PATNOTES', table('B_PATNOTES', [
    { SEQNO: '200000001', CUSTNO: '10099999', PATIENT: FX.pat2, USERNAME: 'jt', MESSAGE: 'Synthetic follow-up note one.', DELETED: '0', TYPE: '0', SUBMITTED: '06/17/2026 10:00:00', CLAIM: FX.claimF },
    { SEQNO: '200000002', CUSTNO: '10099999', PATIENT: FX.pat2, USERNAME: 'jt', MESSAGE: 'Synthetic follow-up note two.', DELETED: '0', TYPE: '2', SUBMITTED: '06/20/2026 10:00:00', CLAIM: FX.claimF },
    { SEQNO: '200000003', CUSTNO: '10099999', PATIENT: FX.pat2, USERNAME: 'jt', MESSAGE: 'Deleted note.', DELETED: '1', TYPE: '0', SUBMITTED: '06/21/2026 10:00:00', CLAIM: FX.claimF },
    { SEQNO: '200000004', CUSTNO: '10099999', PATIENT: FX.pat1, USERNAME: '', MESSAGE: 'Note on a claim that is not kept.', DELETED: '0', TYPE: '2', SUBMITTED: '06/21/2026 10:00:00', CLAIM: FX.claimDel },
    { SEQNO: '200000005', CUSTNO: '10099999', PATIENT: FX.pat1, USERNAME: 'cb', MESSAGE: 'Synthetic PATIENT-level follow-up (CLAIM = 0).', DELETED: '0', TYPE: '0', SUBMITTED: '07/01/2026 09:30:00', CLAIM: '0' },
    { SEQNO: '200000006', CUSTNO: '10099999', PATIENT: FX.pat3, USERNAME: 'cb', MESSAGE: 'Patient-level note on an unnamed patient.', DELETED: '0', TYPE: '0', SUBMITTED: '07/01/2026 09:30:00', CLAIM: '0' },
  ]));
  t.set('B_PRACTICE', table('B_PRACTICE', [
    { SEQNO: '1', NAME: 'SYNTHETIC MENTAL HEALTH LLC', INACTIVE: 'N', DELETED: '0' },
  ]));
  for (const [k, v] of Object.entries(overrides)) if (v) t.set(k, v);
  return snapshotTablesFrom(t);
}
