import { test } from 'node:test';
import assert from 'node:assert/strict';

// Throwaway test key (obvious dummy) — the insert-path tests exercise buildInsertParams,
// which encrypts the two PHI fields. Same convention as test/billingAudit.test.ts. Never
// a real key; nothing here touches a database.
//
// This assignment sits among the imports, which ESM HOISTS above it — that is safe here
// only because phiCrypto reads LIBSODIUM_KEY lazily inside encryptPhi() rather than at
// module load. If that ever becomes a load-time read, this must move to a dynamic
// `await import()` (which is exactly why billingAudit.test.ts uses one).
process.env.LIBSODIUM_KEY = 'b'.repeat(64);
// Throwaway blind-index key, DISTINCT from LIBSODIUM_KEY above — key separation is the
// whole point of INDEX_HMAC_KEY, and reusing one value in tests would quietly normalize
// the wrong habit. blindIndex.ts reads it lazily inside getKey(), so placement is safe.
process.env.INDEX_HMAC_KEY = 'c'.repeat(64);

import {
  detectDelimiters,
  parseCasSegment,
  parseEra835,
} from '../src/ingest/era835Parser.js';
import {
  era835Fingerprint,
  era835MemberIdBidx,
  era835PaymentFingerprint,
  expandDateRange,
  insertEra835Transactions,
  mapTransactions,
  mapTransactionsToRows,
  type Era835IngestRow,
  type Era835SkipCounts,
} from '../src/ingest/era_ingest.js';
import type { CmdCustomer } from '../src/collections/cmdCustomers.js';
import type { Db } from '../src/collections/db.js';

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

  // Claim B fully paid, no CAS → no ADJUSTMENT rows downstream. That is correct and
  // unchanged. What must NOT follow from it is the remit being dropped: the BPR02 lands
  // on staging.era_835_payment regardless. See 'mapTransactions: a remit with ZERO CAS
  // adjustments still yields exactly one payment row' below — the regression test for
  // the truncation defect the two-table split fixed.
  assert.equal(b!.claimLevelAdjustments.length, 0);
  assert.equal(b!.serviceLines[0]!.adjustments.length, 0);
});

test('parseEra835 captures TRN03 (the field that qualifies the payer-scoped TRN02)', () => {
  const r = parseEra835(sampleEra835());
  const p = r.transactions[0]!.payment;
  assert.equal(p.traceNumber, 'CHK123456'); //                TRN02
  assert.equal(p.traceOriginatingCompanyId, '1999999999'); // TRN03
  // BPR02 is captured both parsed and verbatim; the raw form is what keeps two
  // unrepresentable amounts distinguishable in the remit fingerprint.
  assert.equal(p.paymentAmount, 1250);
  assert.equal(p.paymentAmountRaw, '1250.00');
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

  // …and the remit STILL LANDS. Skipping every triplet must never drop the payment row:
  // that combination (filtered-to-zero triplets) was one of the two ways a remit used to
  // disappear entirely under the old single-table shape.
  const mapped = mapTransactions(
    r.transactions,
    { customer: CUSTOMER, sourceFile: 'f.835' },
    { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 },
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]!.adjustments.length, 0);
  // BPR02 was '0' — a real zero-dollar (denial-only) remit, landed in full.
  assert.equal(mapped[0]!.payment.payment_amount, '0.00');
  assert.equal(mapped[0]!.payment.payment_amount_raw, '0');
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

// =============================================================================
// Payment grain (staging.era_835_payment) — the two-table split
// =============================================================================

/** A remit whose EVERY claim adjudicated clean: no CAS anywhere. Under the old
 *  single-table shape this produced zero rows and its $900 vanished completely. */
function cleanPaidEra835(): string {
  return (
    isaSegment() +
    'ST*835*0007~' +
    'BPR*I*900.00*C*ACH*CCP*01*9*DA*1*15**01*9*DA*1*20260731~' +
    'TRN*1*CLEAN999*1888888888~' +
    'N1*PR*ACME HEALTH PLAN*XV*12345~' +
    'CLP*CLEAN-A*1*500.00*500.00*0*12*ICN-CLEAN-A*11~' +
    'SVC*HC:90837*500.00*500.00**1~' +
    'DTM*472*20260701~' +
    'CLP*CLEAN-B*1*400.00*400.00*0*12*ICN-CLEAN-B*11~' +
    'SVC*HC:H0015*400.00*400.00**1~' +
    'DTM*472*20260702~' +
    'SE*10*0007~'
  );
}

const NO_SKIPS = (): Era835SkipCounts => ({
  invalid_group_code: 0,
  missing_carc_code: 0,
  amount_out_of_range: 0,
});

test('mapTransactions: a remit with ZERO CAS adjustments still yields exactly one payment row', () => {
  // THE regression test for the truncation defect. A clean-paid remit has no CAS
  // triplets, so it contributes no adjustment rows — and under the old single-table
  // design that meant its BPR02 was never persisted at all. Clean-paid remits carry the
  // most money. If this test ever fails, upcoming-payment totals are silently short.
  const r = parseEra835(cleanPaidEra835());
  assert.equal(r.adjustmentCount, 0, 'fixture must have no CAS at all');

  const mapped = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: 'clean.835' }, NO_SKIPS());

  assert.equal(mapped.length, 1, 'exactly one payment row');
  assert.equal(mapped[0]!.adjustments.length, 0, 'and zero adjustment rows');

  const p = mapped[0]!.payment;
  assert.equal(p.payment_amount, '900.00'); //         the money that would have been lost
  assert.equal(p.payment_amount_raw, '900.00');
  assert.equal(p.payment_date, '2026-07-31');
  assert.equal(p.check_eft_trace_number, 'CLEAN999');
  assert.equal(p.trace_originating_company_id, '1888888888');
  assert.equal(p.payer_name, 'ACME HEALTH PLAN');
  assert.equal(p.payer_id, '12345');
  assert.equal(p.business_entity_id, BE);
  assert.equal(p.facility_code, 'CAMH');
  assert.equal(p.cmd_customer_id, '10027973');
  assert.ok(p.row_fingerprint.length > 0);
});

test('payment grain: BPR02 appears exactly once for a multi-claim, multi-adjustment remit', () => {
  // The inflation defect, stated as a test. The sample remit is $1,250.00 and carries 5
  // CAS triplets. Summing the payment grain gives 1250.00; the old shape would have
  // reported 5 x 1250.00 = 6250.00 for the same remit.
  const r = parseEra835(sampleEra835());
  const mapped = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS());

  assert.equal(mapped.length, 1, 'one remit');
  assert.equal(mapped[0]!.adjustments.length, 5, 'five triplets');

  const total = mapped.reduce((s, t) => s + Number(t.payment.payment_amount ?? 0), 0);
  assert.equal(total, 1250, 'sum over payment grain == BPR02, once');
  assert.notEqual(total, 1250 * 5, 'and NOT multiplied by the triplet count');
});

test('adjustment rows carry NO payment_amount and NO trace number (the columns are gone)', () => {
  // Structural guard: if either field is ever re-added to Era835IngestRow, the wrong sum
  // becomes writable again. Keys are asserted absent, not merely null/undefined.
  const r = parseEra835(sampleEra835());
  const rows = mapTransactionsToRows(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS());
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal('payment_amount' in row, false, 'payment_amount must not exist on an adjustment row');
    assert.equal('check_eft_trace_number' in row, false, 'trace number belongs to the payment grain');
    // The kept filter context is still there.
    assert.equal(row.payment_date, '2026-06-30');
    assert.equal(row.payer_name, 'ACME HEALTH PLAN');
    assert.equal(row.payment_method, 'ACH');
  }
});

test('era835PaymentFingerprint: stable across re-pull, and IGNORES the download-time filename', () => {
  // era_source_file is deliberately excluded from the remit key. For a raw payload the
  // ingest passes `${cid}_${date}` as the filename, literally embedding the pull date —
  // so hashing it would make the SAME remit re-pulled on another date insert twice and
  // double-count BPR02. This test is what keeps that exclusion honest.
  const r = parseEra835(sampleEra835());
  const first = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: '10027973_2026-06-30' }, NO_SKIPS());
  const later = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: '10027973_2026-07-14' }, NO_SKIPS());

  assert.equal(
    first[0]!.payment.row_fingerprint,
    later[0]!.payment.row_fingerprint,
    'a re-pull under a different filename must dedup, not double-count',
  );
  // Provenance is still recorded, it just does not participate in identity.
  assert.notEqual(first[0]!.payment.era_source_file, later[0]!.payment.era_source_file);
  // Recomputed from the row == stored value (no hidden state).
  assert.equal(era835PaymentFingerprint(first[0]!.payment), first[0]!.payment.row_fingerprint);
});

test('era835PaymentFingerprint: NULL, "0.00" and "" amounts are three DISTINCT digests', () => {
  // Regression test for the 2026-07-30 review finding. Coalescing a NULL amount to ''
  // made "absent" and "blank" the same digest input. An absent BPR02 and a real $0.00
  // denial-only remit must never be confused, and neither may collide with a blank.
  const base = mapTransactions(
    parseEra835(sampleEra835()).transactions,
    { customer: CUSTOMER, sourceFile: 'f.835' },
    NO_SKIPS(),
  )[0]!.payment;

  const withAmount = (payment_amount: string | null, payment_amount_raw: string | null) =>
    era835PaymentFingerprint({ ...base, payment_amount, payment_amount_raw });

  const digests = [
    withAmount(null, null), //     BPR02 absent entirely
    withAmount('0.00', '0'), //    a real zero-dollar (denial-only) remit
    withAmount('', ''), //         blank — distinct from absent, not merged into it
  ];
  assert.equal(new Set(digests).size, 3, 'NULL / "0.00" / "" must be three distinct digests');
});

test('era835PaymentFingerprint: two DIFFERENT out-of-range BPR02 values stay distinct', () => {
  // The live half of the same finding, and the reason an ABSENT token alone is not
  // enough. Both amounts exceed numeric(12,2) so payment_amount is NULL for both; only
  // payment_amount_raw still separates them. Without it these two remits — and an
  // absent-BPR02 third — hashed identically and ON CONFLICT DO NOTHING silently dropped
  // two of the three while reporting success.
  const mk = (edi: string) =>
    mapTransactions(parseEra835(edi).transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS())[0]!.payment;

  const a = mk(sampleEra835().replace('BPR*I*1250.00*', 'BPR*I*99999999999.99*'));
  const b = mk(sampleEra835().replace('BPR*I*1250.00*', 'BPR*I*88888888888.88*'));
  const absent = mk(sampleEra835().replace('BPR*I*1250.00*', 'BPR*I**'));

  // Precondition: all three really are unrepresentable / absent, so the numeric is NULL.
  assert.equal(a.payment_amount, null);
  assert.equal(b.payment_amount, null);
  assert.equal(absent.payment_amount, null);
  // …but the raw element survives and keeps them apart.
  assert.equal(a.payment_amount_raw, '99999999999.99');
  assert.equal(b.payment_amount_raw, '88888888888.88');
  assert.equal(absent.payment_amount_raw, null);

  const digests = [a.row_fingerprint, b.row_fingerprint, absent.row_fingerprint];
  assert.equal(new Set(digests).size, 3, 'three different remits must not share one digest');
});

test('era835PaymentFingerprint: an absent field hashes as the token, never as blank', () => {
  // Guards the ''-overload class generally, not just for the amount: a NULL trace number
  // and a blank trace number must not be the same identity.
  const base = mapTransactions(
    parseEra835(sampleEra835()).transactions,
    { customer: CUSTOMER, sourceFile: 'f.835' },
    NO_SKIPS(),
  )[0]!.payment;
  assert.notEqual(
    era835PaymentFingerprint({ ...base, check_eft_trace_number: null }),
    era835PaymentFingerprint({ ...base, check_eft_trace_number: '' }),
  );
  assert.notEqual(
    era835PaymentFingerprint({ ...base, payer_id: null }),
    era835PaymentFingerprint({ ...base, payer_id: '' }),
  );
});

test('era835PaymentFingerprint: genuinely different remits do NOT collide', () => {
  const base = parseEra835(sampleEra835());
  const mine = mapTransactions(base.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS())[0]!.payment;

  // Same payer, same date, same amount — differing only by trace number. This is the
  // per-NPI-split / reissued-check case that made (payer + BPR16 + BPR02) unsound.
  const otherTrace = parseEra835(sampleEra835().replace('CHK123456', 'CHK999999'));
  const theirs = mapTransactions(otherTrace.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS())[0]!.payment;
  assert.notEqual(mine.row_fingerprint, theirs.row_fingerprint);

  // Same remit bytes, different FACILITY (cmd_customer_id) — must not collapse.
  const otherCustomer: CmdCustomer = { customerId: '10029999', facilityCode: 'OTHER', businessEntityId: BE };
  const elsewhere = mapTransactions(base.transactions, { customer: otherCustomer, sourceFile: 'f.835' }, NO_SKIPS())[0]!.payment;
  assert.notEqual(mine.row_fingerprint, elsewhere.row_fingerprint);
});

test('insertEra835Transactions: payment row is written first and its id lands on every triplet', () => {
  // Hermetic fake pool — asserts the FK wiring and the write ORDER without a DB.
  const sql: string[] = [];
  const adjustmentParams: unknown[][] = [];
  const fakeClient = {
    query: async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (text.startsWith('insert into staging.era_835_payment')) {
        return { rows: [{ id: 4242 }], rowCount: 1 };
      }
      if (text.startsWith('insert into staging.era_835_adjustment')) {
        adjustmentParams.push(params ?? []);
        return { rows: [], rowCount: 5 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const fakeDb = { connect: async () => fakeClient } as unknown as Db;

  const r = parseEra835(sampleEra835());
  const mapped = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS());

  return insertEra835Transactions(fakeDb, BE, mapped, 'test').then((counts) => {
    assert.deepEqual(counts, {
      payments: 1,
      adjustments: 5,
      payments_duplicate: 0,
      adjustments_duplicate: 0,
    });

    // Write order: tenant GUC, then the payment row, then the adjustments.
    const payIdx = sql.findIndex((s) => s.startsWith('insert into staging.era_835_payment'));
    const adjIdx = sql.findIndex((s) => s.startsWith('insert into staging.era_835_adjustment'));
    assert.ok(sql[0]!.includes('begin'));
    assert.ok(sql.some((s) => s.includes('app.business_entity_id')));
    assert.ok(payIdx !== -1 && adjIdx !== -1 && payIdx < adjIdx, 'payment must be inserted before its triplets');
    assert.ok(sql.some((s) => s.includes('commit')));

    // payment_id is the FIRST positional column, so every 37-param tuple starts with 4242.
    assert.equal(adjustmentParams.length, 1);
    const flat = adjustmentParams[0]!;
    const perRow = flat.length / 5;
    assert.equal(Number.isInteger(perRow), true, 'params must divide evenly across 5 rows');
    for (let i = 0; i < 5; i++) {
      assert.equal(flat[i * perRow], 4242, `triplet ${i} must carry the payment_id`);
    }

    // Neither table's INSERT may mention the removed column.
    assert.ok(!sql.some((s) => s.startsWith('insert into staging.era_835_adjustment') && s.includes('payment_amount')));
  });
});

test('insertEra835Transactions: a re-pull re-reads the existing payment id instead of duplicating', () => {
  // ON CONFLICT DO NOTHING RETURNING id yields NO row when the remit is already present,
  // so the ingest falls back to SELECT ... WHERE row_fingerprint = $1. Idempotency test.
  const sql: string[] = [];
  const fakeClient = {
    query: async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (text.startsWith('insert into staging.era_835_payment')) {
        return { rows: [], rowCount: 0 }; //  conflict → DO NOTHING → no RETURNING row
      }
      if (text.startsWith('select id from staging.era_835_payment')) {
        return { rows: [{ id: 777 }], rowCount: 1 };
      }
      if (text.startsWith('insert into staging.era_835_adjustment')) {
        assert.equal(params?.[0], 777, 'triplets attach to the pre-existing payment row');
        return { rows: [], rowCount: 0 }; // triplets already present too
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const fakeDb = { connect: async () => fakeClient } as unknown as Db;

  const r = parseEra835(sampleEra835());
  const mapped = mapTransactions(r.transactions, { customer: CUSTOMER, sourceFile: 'f.835' }, NO_SKIPS());

  return insertEra835Transactions(fakeDb, BE, mapped, 'test').then((counts) => {
    // THE SILENT PATH, NOW COUNTED. This whole-remit re-pull writes nothing, and before
    // migration 022 it reported nothing either — the 2026-08-02 production run swallowed
    // 73 of 112 parsed remits exactly here. inserted=0 alongside duplicate>0 is what makes
    // 013's duplicate-remit detector ("a re-pull MUST report payments_inserted = 0")
    // checkable after the fact instead of only in a live console.
    assert.deepEqual(
      counts,
      { payments: 0, adjustments: 0, payments_duplicate: 1, adjustments_duplicate: 5 },
      're-pull inserts nothing AND says so',
    );
    assert.ok(sql.some((s) => s.startsWith('select id from staging.era_835_payment')));
    assert.ok(sql.some((s) => s.includes('commit')));
  });
});

test('expandDateRange yields inclusive ISO days', () => {
  assert.deepEqual(expandDateRange('2026-01-01', '2026-01-03'), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(expandDateRange('2026-06-30', '2026-06-30'), ['2026-06-30']);
  assert.throws(() => expandDateRange('2026-01-03', '2026-01-01'), /on or after/);
});

// =============================================================================
// member_id_bidx PIN TEST (migration 021) — the gate that must not be weak
// =============================================================================
// TWO functions named normalizeMemberId exist with DIFFERENT semantics:
//   src/collections/normalize.ts → strips ALL internal whitespace + ALL leading hyphens
//   src/normalize.ts            → KEEPS internal whitespace, strips ONE leading hyphen
// Every LIVE member_id_bidx token is minted by src/collections/blindIndex.ts, which imports
// the COLLECTIONS one. If the 835 ingest ever normalizes with the other, it emits
// valid-looking 64-hex tokens that NEVER match the collections-side index: a zero-row join
// with no error and no diagnostic. These tests are what make that unshippable.

const { createHmac } = await import('node:crypto');
const { memberIdBlindIndex } = await import('../src/collections/blindIndex.js');
const { normalizeMemberId: collectionsNormalize } = await import('../src/collections/normalize.js');
const { normalizeMemberId: queriesNormalize } = await import('../src/normalize.js');

/** Inputs chosen for exactly one reason: they are where the two normalizers DIVERGE. */
const DIVERGENT_MEMBER_IDS = [
  'AB 123', //      internal whitespace  → collections 'AB123' vs queries 'AB 123'
  '-XYZ789', //     ONE leading hyphen   → both strip it (control for the case below)
  '--XYZ789', //    TWO leading hyphens  → collections 'XYZ789' vs queries '-XYZ789'
  '  A B  C ', //   whitespace everywhere
  '- QR 456', //    hyphen AND whitespace, the compound case
];

test('PIN: the two normalizeMemberId implementations REALLY diverge on these inputs', () => {
  // Anti-vacuity guard. If this fails, the divergence has been resolved upstream and the
  // byte-match test below has stopped discriminating — do not just delete it; re-derive
  // which normalizer is canonical and re-pin against that.
  const diverging = DIVERGENT_MEMBER_IDS.filter(
    (raw) => collectionsNormalize(raw).norm !== queriesNormalize(raw).norm,
  );
  assert.ok(
    diverging.length >= 3,
    `expected the fixtures to expose real divergence; only ${diverging.length} differ`,
  );
  // Spell out the headline case so the failure message is self-explanatory.
  assert.equal(collectionsNormalize('AB 123').norm, 'AB123');
  assert.equal(queriesNormalize('AB 123').norm, 'AB 123');
});

test('PIN: era835MemberIdBidx is BYTE-IDENTICAL to the collections blind-index path', () => {
  for (const raw of DIVERGENT_MEMBER_IDS) {
    assert.equal(
      era835MemberIdBidx(raw),
      memberIdBlindIndex(raw),
      `835 token must byte-match the collections token for ${JSON.stringify(raw)}`,
    );
  }
  // A token really was produced (not two matching nulls — that would pass vacuously).
  for (const raw of DIVERGENT_MEMBER_IDS) {
    assert.match(era835MemberIdBidx(raw) ?? '', /^[0-9a-f]{64}$/);
  }
});

test('PIN: a token built over the WRONG normalizer does NOT match — the test discriminates', () => {
  // Proof the assertion above has teeth: HMAC the queries-plane normalization with the same
  // key and show it differs for the divergent inputs. If someone swaps the import in
  // era_ingest.ts, the byte-match test fails rather than silently passing.
  const key = Buffer.from(process.env.INDEX_HMAC_KEY!, 'hex');
  for (const raw of DIVERGENT_MEMBER_IDS) {
    const wrongNorm = queriesNormalize(raw).norm;
    if (wrongNorm === null || wrongNorm === collectionsNormalize(raw).norm) continue;
    const wrongToken = createHmac('sha256', key).update(wrongNorm, 'utf8').digest('hex');
    assert.notEqual(
      era835MemberIdBidx(raw),
      wrongToken,
      `${JSON.stringify(raw)}: the 835 token must NOT equal the wrong-normalizer token`,
    );
  }
});

test('PIN: equal member ids share a token; different ones do not (blind-index invariant)', () => {
  assert.equal(era835MemberIdBidx('MEM123'), era835MemberIdBidx('mem123'), 'case-insensitive');
  assert.equal(era835MemberIdBidx('MEM123'), era835MemberIdBidx(' MEM123 '), 'trim-insensitive');
  assert.notEqual(era835MemberIdBidx('MEM123'), era835MemberIdBidx('MEM124'));
});

test('era835MemberIdBidx: absent member id yields null, never a token over empty string', () => {
  assert.equal(era835MemberIdBidx(null), null);
  assert.equal(era835MemberIdBidx(''), null);
  assert.equal(era835MemberIdBidx('   '), null);
});

test('era835MemberIdBidx is INGEST-SAFE: a missing INDEX_HMAC_KEY yields null, never a throw', () => {
  // A misconfigured SEARCH key must never break the MONEY-path ingest (defect-2 lesson:
  // never let a secondary concern drop remittance rows). Contrast LIBSODIUM_KEY, which
  // DOES throw — storing PHI is not optional.
  const saved = process.env.INDEX_HMAC_KEY;
  try {
    delete process.env.INDEX_HMAC_KEY;
    assert.equal(era835MemberIdBidx('MEM123'), null, 'null token, not an exception');
  } finally {
    if (saved === undefined) delete process.env.INDEX_HMAC_KEY;
    else process.env.INDEX_HMAC_KEY = saved;
  }
});
