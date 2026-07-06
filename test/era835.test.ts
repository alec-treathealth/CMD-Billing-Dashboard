import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDelimiters,
  parseCasSegment,
  parseEra835,
} from '../src/ingest/era835Parser.js';
import {
  era835Fingerprint,
  expandDateRange,
  mapTransactionsToRows,
  type Era835IngestRow,
  type Era835SkipCounts,
} from '../src/ingest/era_ingest.js';
import type { CmdCustomer } from '../src/collections/cmdCustomers.js';

/**
 * Hermetic tests for the 835 ERA parser + ingest mapping. The fixture uses FAKE
 * names/ids (DOE JANE / MEM123) — it is NOT real PHI. No DB, no network.
 */

/** Build a spec-exact 106-byte ISA: element sep '*', component ':', terminator '~'. */
function isaSegment(): string {
  const els = [
    'ISA', '00', ''.padEnd(10), '00', ''.padEnd(10), 'ZZ', 'SUBMITTER'.padEnd(15),
    'ZZ', 'RECEIVER'.padEnd(15), '060331', '1215', '^', '00501', '000000905', '0', 'T', ':',
  ];
  return els.join('*') + '~';
}

/** A small but structurally complete 835: 1 payment, 2 claims, claim + line CAS. */
function sampleEra835(): string {
  const isa = isaSegment();
  assert.equal(isa.length, 106, 'ISA must be exactly 106 bytes');
  return (
    isa +
    'GS*HP*SENDER*RECEIVER*20260630*1215*905*X*005010X221A1~' +
    'ST*835*0001~' +
    // BPR16 (element 16) = 20260630; BPR04 = ACH; BPR02 = 1250.00
    'BPR*I*1250.00*C*ACH*CCP*01*999988880*DA*123456*1512345678**01*999988880*DA*98765*20260630~' +
    'TRN*1*CHK123456*1999999999~' +
    'N1*PR*ACME HEALTH PLAN*XV*12345~' +
    'N1*PE*TREAT MENTAL HEALTH*XX*1999999999~' +
    'LX*1~' +
    // Claim A: charge 500 / paid 400 / pt resp 50 / payer ICN PAYER-ICN-1
    'CLP*CLAIM-A*1*500.00*400.00*50.00*12*PAYER-ICN-1*11~' +
    'NM1*QC*1*DOE*JANE~' +
    'NM1*IL*1*DOE*JANE****MI*MEM123~' +
    'CAS*CO*45*50.00~' + //          claim-level contractual (qty omitted)
    'CAS*OA*94*-10.00~' + //         claim-level, negative amount (sign preserved)
    'SVC*HC:90837*300.00*250.00**1~' +
    'DTM*472*20260615~' +
    'CAS*CO*45*30.00*1~' + //        line 1 CO-45
    'CAS*PR*2*20.00~' + //           line 1 PR-2 (coinsurance)
    'REF*6R*LINEA1~' +
    'LQ*HE*N130~' + //              remark (RARC) — counted, not a triplet
    'SVC*HC:90834*200.00*150.00**1~' +
    'DTM*472*20260616~' +
    'CAS*CO*45*50.00~' + //          line 2 CO-45
    // Claim B: paid in full, NO adjustments → yields zero rows
    'CLP*CLAIM-B*1*100.00*100.00*0*12*PAYER-ICN-2*11~' +
    'NM1*QC*1*ROE*RICHARD~' +
    'SVC*HC:H0015*100.00*100.00**1~' +
    'DTM*472*20260617~' +
    'SE*20*0001~' +
    'GE*1*905~' +
    'IEA*1*000000905~'
  );
}

const BE = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const CUSTOMER: CmdCustomer = { customerId: '10027973', facilityCode: 'CAMH', businessEntityId: BE };

test('detectDelimiters reads the ISA control segment', () => {
  const d = detectDelimiters(sampleEra835());
  assert.deepEqual(d, { element: '*', segment: '~', component: ':' });
});

test('detectDelimiters falls back to defaults on a non-ISA payload', () => {
  assert.deepEqual(detectDelimiters('not an edi file'), { element: '*', segment: '~', component: ':' });
});

test('parseCasSegment extracts every triplet, preserves sign, tolerates missing qty', () => {
  // group CO, two triplets: (45,30.00,1) and (253,-20.00, none)
  const adjs = parseCasSegment(['CAS', 'CO', '45', '30.00', '1', '253', '-20.00'], 'LINE');
  assert.equal(adjs.length, 2);
  assert.deepEqual(adjs[0], { level: 'LINE', groupCode: 'CO', reasonCode: '45', amount: 30, quantity: 1 });
  assert.deepEqual(adjs[1], { level: 'LINE', groupCode: 'CO', reasonCode: '253', amount: -20, quantity: null });
});

test('parseCasSegment skips triplets with a blank reason code', () => {
  const adjs = parseCasSegment(['CAS', 'PR', '', '10.00', '1'], 'CLAIM');
  assert.equal(adjs.length, 0);
});

test('parseEra835: envelope, claims, service lines, CAS levels, remark count', () => {
  const r = parseEra835(sampleEra835());
  assert.equal(r.claimCount, 2);
  assert.equal(r.adjustmentCount, 5); // 2 claim-level + 2 line-1 + 1 line-2
  assert.equal(r.remarkCount, 1);
  assert.equal(r.transactions.length, 1);

  const [tx] = r.transactions;
  assert.equal(tx!.payment.payerName, 'ACME HEALTH PLAN');
  assert.equal(tx!.payment.paymentMethod, 'ACH');
  assert.equal(tx!.payment.paymentAmount, 1250);
  assert.equal(tx!.payment.paymentDate, '2026-06-30');
  assert.equal(tx!.payment.traceNumber, 'CHK123456');
  assert.equal(tx!.payment.eraControlNumber, '0001');

  const [a, b] = tx!.claims;
  assert.equal(a!.patientControlNumber, 'CLAIM-A');
  assert.equal(a!.payerClaimControlNumber, 'PAYER-ICN-1');
  assert.equal(a!.totalChargeAmount, 500);
  assert.equal(a!.totalPaidAmount, 400);
  assert.equal(a!.patientResponsibilityAmount, 50);
  assert.equal(a!.patientName, 'DOE JANE'); // PHI (fake)
  assert.equal(a!.memberId, 'MEM123'); //     PHI (fake)
  assert.equal(a!.claimLevelAdjustments.length, 2);
  assert.equal(a!.claimLevelAdjustments[1]!.amount, -10); // sign preserved

  assert.equal(a!.serviceLines.length, 2);
  const line1 = a!.serviceLines[0]!;
  assert.equal(line1.procedureCode, '90837');
  assert.equal(line1.serviceDate, '2026-06-15');
  assert.equal(line1.lineItemControlNumber, 'LINEA1');
  assert.equal(line1.adjustments.length, 2);
  assert.deepEqual(line1.remarkCodes, ['N130']);

  // Claim B fully paid, no CAS → no adjustment rows downstream.
  assert.equal(b!.claimLevelAdjustments.length, 0);
  assert.equal(b!.serviceLines[0]!.adjustments.length, 0);
});

test('mapTransactionsToRows: one row per CAS triplet, facility/entity resolved, sign preserved', () => {
  const r = parseEra835(sampleEra835());
  const skips: Era835SkipCounts = { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 };
  const rows = mapTransactionsToRows(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, skips);

  assert.equal(rows.length, 5); // claim B contributes none
  for (const row of rows) {
    assert.equal(row.business_entity_id, BE);
    assert.equal(row.facility_code, 'CAMH');
    assert.equal(row.cmd_customer_id, '10027973');
    assert.equal(row.carc_type, 'CARC');
    assert.ok(['CLAIM', 'LINE'].includes(row.cas_level));
  }
  const claimLevel = rows.filter((r2) => r2.cas_level === 'CLAIM');
  assert.equal(claimLevel.length, 2);
  assert.ok(claimLevel.every((r2) => r2.service_line_number === 0));
  // Money is a fixed-2 decimal STRING at the DB boundary; sign preserved.
  assert.ok(claimLevel.some((r2) => r2.adjustment_amount === '-10.00'));
  assert.ok(rows.every((r2) => /^-?\d+\.\d{2}$/.test(r2.adjustment_amount)));

  const line1Rows = rows.filter((r2) => r2.service_line_number === 1);
  assert.equal(line1Rows.length, 2);
  assert.ok(line1Rows.every((r2) => r2.procedure_code === '90837'));
  assert.ok(line1Rows.every((r2) => r2.service_date === '2026-06-15'));
  assert.ok(line1Rows.every((r2) => r2.line_item_control_number === 'LINEA1'));
  // adjustment_index disambiguates the two triplets on line 1.
  assert.deepEqual(line1Rows.map((r2) => r2.adjustment_index).sort(), [0, 1]);
});

test('parseEra835 + map: multi-ST/SE interchange keeps the in-flight line of a non-final set', () => {
  // Two transaction sets in one interchange. tx0's ONLY claim ends in a service line with
  // a line-level CAS immediately before the next ST — the regression the ST-flush fixes.
  const edi =
    isaSegment() +
    'ST*835*0001~' +
    'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*15*01*9*DA*1*20260630~' +
    'N1*PR*ACME~' +
    'CLP*TX0-CLAIM*1*100.00*80.00*0*12*ICN-0*11~' +
    'SVC*HC:90837*100.00*80.00**1~' +
    'DTM*472*20260615~' +
    'CAS*CO*45*20.00~' + //  <-- line-level CAS on tx0's last line; must NOT be dropped
    'SE*7*0001~' +
    'ST*835*0002~' +
    'BPR*I*50.00*C*ACH*CCP*01*9*DA*1*15*01*9*DA*1*20260630~' +
    'N1*PR*ACME~' +
    'CLP*TX1-CLAIM*1*50.00*50.00*0*12*ICN-1*11~' +
    'SVC*HC:90834*50.00*50.00**1~' +
    'DTM*472*20260616~' +
    'SE*6*0002~';
  const r = parseEra835(edi);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0]!.claims[0]!.serviceLines.length, 1); // was 0 before the fix
  assert.equal(r.adjustmentCount, 1);

  const rows = mapTransactionsToRows(
    r.transactions,
    { customer: CUSTOMER, sourceFile: 'multi.835' },
    { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.carc_code, '45');
  assert.equal(rows[0]!.adjustment_amount, '20.00');
  assert.equal(rows[0]!.patient_control_number, 'TX0-CLAIM');
});

test('mapTransactionsToRows skips an out-of-range CAS amount rather than aborting', () => {
  const edi =
    isaSegment() +
    'ST*835*0003~' +
    'BPR*I*0*C*ACH*CCP*01*9*DA*1*15*01*9*DA*1*20260630~' +
    'N1*PR*ACME~' +
    'CLP*C1*1*10.00*0*10.00*12*ICN*11~' +
    'CAS*CO*45*99999999999.99~' + // exceeds numeric(12,2) → skipped, not a batch-aborting error
    'SE*5*0003~';
  const r = parseEra835(edi);
  const skips: Era835SkipCounts = { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 };
  const rows = mapTransactionsToRows(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, skips);
  assert.equal(rows.length, 0);
  assert.equal(skips.amount_out_of_range, 1);
});

test('era835Fingerprint is deterministic, unique per triplet, and PHI-free-stable', () => {
  const r = parseEra835(sampleEra835());
  const skips: Era835SkipCounts = { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 };
  const rows1 = mapTransactionsToRows(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, skips);
  const rows2 = mapTransactionsToRows(parseEra835(sampleEra835()).transactions, { customer: CUSTOMER, sourceFile: 'DIFFERENT.835' }, { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 });

  // 64 lowercase hex, unique across the 5 triplets.
  const fps = new Set(rows1.map((r2) => r2.row_fingerprint));
  assert.equal(fps.size, 5);
  for (const fp of fps) assert.match(fp, /^[0-9a-f]{64}$/);

  // Re-parsing the same 835 (even from a different source filename — not in the
  // fingerprint) yields identical fingerprints ⇒ idempotent re-download.
  assert.deepEqual(rows2.map((r2) => r2.row_fingerprint).sort(), rows1.map((r2) => r2.row_fingerprint).sort());

  // Fingerprint recomputed from the row equals the stored value (no hidden state).
  for (const row of rows1) assert.equal(era835Fingerprint(row), row.row_fingerprint);
});

test('mapTransactionsToRows skips out-of-spec group codes and blank CARCs (counted)', () => {
  const edi =
    isaSegment() +
    'ST*835*0002~' +
    'BPR*I*10.00*C*ACH*CCP*01*9*DA*1*15*01*9*DA*1*20260630~' +
    'N1*PR*ACME~' +
    'CLP*C1*1*10.00*0*10.00*12*ICN*11~' +
    'CAS*ZZ*45*10.00~' + //   invalid group code ZZ → skipped
    'SVC*HC:90837*10.00*0**1~' +
    'CAS*CO**5.00~' + //      blank CARC → skipped
    'SE*6*0002~';
  const r = parseEra835(edi);
  const skips: Era835SkipCounts = { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 };
  const rows = mapTransactionsToRows(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, skips);
  assert.equal(rows.length, 0);
  assert.equal(skips.invalid_group_code, 1);
  // blank CARC is dropped by the parser (blank reason) before mapping, so the map-level
  // missing_carc_code guard is defense-in-depth; assert the parser dropped it:
  assert.equal(r.adjustmentCount, 1); // only the ZZ triplet parsed; blank-CARC never emitted
});

test('expandDateRange yields inclusive ISO days', () => {
  assert.deepEqual(expandDateRange('2026-01-01', '2026-01-03'), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(expandDateRange('2026-06-30', '2026-06-30'), ['2026-06-30']);
  assert.throws(() => expandDateRange('2026-01-03', '2026-01-01'), /on or after/);
});
