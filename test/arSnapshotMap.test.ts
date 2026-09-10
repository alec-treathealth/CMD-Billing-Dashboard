/**
 * Hermetic tests for the snapshot → AR mapper (src/billingAudit/arSnapshotMap.ts) on a fully
 * synthetic fixture. These pin the status derivation CMD's reports use (verified against the live
 * audit_row vocabulary 2026-09-09), the claim aggregation, and every filtering rule.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveChargeStatus, mapSnapshot, summarizeDenials } from '../src/billingAudit/arSnapshotMap.js';
import { snapshotTablesFrom, type SnapshotTable } from '../src/billingAudit/snapshotParse.js';
import { buildFixture, FX } from './fixtures/arSnapshotFixture.js';

const mapped = mapSnapshot(buildFixture());
const claim = (id: string) => {
  const c = mapped.claims.find((x) => x.cmdClaimId === id);
  assert.ok(c, `claim ${id} missing`);
  return c;
};

test('deriveChargeStatus: the precedence table', () => {
  const at = (o: Partial<Parameters<typeof deriveChargeStatus>[0]>) =>
    deriveChargeStatus({ customStatusText: null, balance: 100, balanceDueTo: 'I', currentPayerName: 'ALPHA HEALTH PLAN', currentPayerLevel: 1, ...o });
  assert.equal(at({ customStatusText: 'Needs Renegotiating' }).statusRaw, 'NEEDS RENEGOTIATING');
  assert.equal(at({ customStatusText: 'Needs Renegotiating' }).statusCategory, 'NEEDS_RENEGOTIATING');
  assert.equal(at({ balance: 0 }).statusRaw, 'PAID');
  assert.equal(at({ balance: 0.004 }).statusRaw, 'PAID');
  assert.equal(at({ balanceDueTo: 'P' }).statusRaw, 'BALANCE DUE PATIENT');
  assert.deepEqual(at({}), { statusRaw: 'CLAIM AT ALPHA HEALTH PLAN', statusCategory: 'AT_PAYER', statusPayer: 'ALPHA HEALTH PLAN' });
  const sec = at({ currentPayerLevel: 2, currentPayerName: 'Beta Mutual' });
  assert.equal(sec.statusRaw, 'CLAIM AT BETA MUTUAL - SECONDARY');
  assert.equal(sec.statusCategory, 'AT_PAYER');
  assert.equal(sec.statusPayer, 'BETA MUTUAL'); // normalizeStatus strips the suffix into the payer
  assert.equal(at({ currentPayerName: null }).statusRaw, 'CLAIM AT UNKNOWN PAYER');
  assert.equal(at({ balanceDueTo: 'O' }).statusRaw, 'BALANCE DUE OTHER');
  assert.equal(at({ balanceDueTo: 'O' }).statusCategory, 'OTHER');
  assert.equal(at({ balanceDueTo: null }).statusRaw, 'BALANCE DUE OTHER');
});

test('claims kept / dropped: deleted claim and unnamed-patient claim are dropped and counted', () => {
  const ids = mapped.claims.map((c) => c.cmdClaimId).sort();
  assert.deepEqual(ids, [FX.claimA, FX.claimB, FX.claimC, FX.claimD, FX.claimE, FX.claimF]);
  assert.equal(mapped.skips['claim: deleted'], 1);
  assert.equal(mapped.skips['claim: patient unnamed'], 1);
  assert.equal(mapped.skips['patient: name missing'], 1);
  assert.equal(mapped.skips['charge: deleted'], 1);
  assert.equal(mapped.skips['charge: trantype'], 1);
  assert.equal(mapped.skips['charge: claim missing'], 1, 'the deleted claim\'s charge');
  // No charge/remit/note of a dropped claim survives.
  assert.equal(mapped.charges.some((c) => c.cmdClaimId === FX.claimDel || c.cmdClaimId === FX.claimNoName), false);
  assert.equal(mapped.remits.some((r) => r.cmdClaimId === FX.claimDel), false);
  assert.equal(mapped.skips['remit: claim not kept'], 1);
  assert.equal(mapped.skips['note: claim not kept'], 1);
});

test('claim A: aggregation, primary-payer status from the largest open line, ICLAIM + claim fields', () => {
  const a = claim(FX.claimA);
  assert.equal(a.lineCount, 2);
  assert.equal(a.openLineCount, 1);
  assert.equal(a.totalCharges, '5000.00');
  assert.equal(a.insPaid, '600.00');
  assert.equal(a.adjustments, '400.00');
  assert.equal(a.balance, '4000.00');
  assert.equal(a.statusRaw, 'CLAIM AT ALPHA HEALTH PLAN');
  assert.equal(a.statusCategory, 'AT_PAYER');
  assert.equal(a.currentPayerName, 'ALPHA HEALTH PLAN');
  assert.equal(a.currentPayerLevel, 1);
  assert.equal(a.primaryPayerName, 'ALPHA HEALTH PLAN');
  assert.equal(a.payerType, '5');
  assert.equal(a.dosFrom, '2026-03-01');
  assert.equal(a.dosTo, '2026-03-05');
  assert.equal(a.firstBillDate, '2026-03-06');
  assert.equal(a.lastBillDate, '2026-05-06');
  assert.equal(a.insLastPaymentDate, '2026-04-01');
  assert.deepEqual(a.cptCodes, ['H0018']);
  assert.deepEqual(a.revCodes, ['1001']);
  assert.equal(a.typeOfBill, '863');
  assert.equal(a.admitDate, '2026-03-01');
  assert.equal(a.dischargeDate, '2026-03-05');
  assert.equal(a.authNumber, 'AUTH-1');
  assert.equal(a.payerClaimControlNo, 'CTRL1');
  assert.equal(a.cmdFollowupDate, '2026-10-01');
  assert.equal(a.claimType, 'I');
  assert.equal(a.claimFrequency, null);
  // 835: the activity carrying RSTATUS=1 dated 04/01
  assert.equal(a.last835Status, '1');
  assert.equal(a.last835Date, '2026-04-01');
  assert.equal(a.lastActivityDate, '2026-03-20'); // the deleted 02/01 secondary submission is ignored
  // No ERROR/WARNING → no last error
  assert.equal(a.lastErrorCode, null);
});

test('claim A: denial summary groups by (group, CARC), sums signed amounts, excludes PR and remarks, ignores deleted', () => {
  const a = claim(FX.claimA);
  assert.equal(a.hasDenial, true);
  assert.deepEqual(a.denialSummary, [
    { g: 'CO', c: '197', amt: '3900.00', n: 2 }, // 4000 + (-100)
    { g: 'CO', c: '45', amt: '400.00', n: 1 },   // the deleted 9.00 row is excluded
  ]);
  // Remits list carries the remark row (kind R) and the PR row, but not deleted or not-kept rows.
  const remitsA = mapped.remits.filter((r) => r.cmdClaimId === FX.claimA).map((r) => r.cmdRemitId).sort();
  assert.deepEqual(remitsA, ['400000001', '400000002', '400000003', '400000004', '400000005']);
  const remark = mapped.remits.find((r) => r.cmdRemitId === '400000003')!;
  assert.equal(remark.kind, 'R');
  assert.equal(remark.amount, null);
  assert.equal(remark.groupCode, null);
});

test('claim B: latest E/P/F submission to the secondary → "- SECONDARY"; a T activity does not count', () => {
  const b = claim(FX.claimB);
  assert.equal(b.statusRaw, 'CLAIM AT BETA MUTUAL - SECONDARY');
  assert.equal(b.statusPayer, 'BETA MUTUAL');
  assert.equal(b.currentPayerLevel, 2);
  assert.equal(b.payerType, '6');
  assert.equal(b.claimFrequency, '7');
  assert.equal(b.lastActivityDate, '2026-05-15');
  assert.equal(b.last835Status, '1');
  assert.equal(b.last835Date, '2026-05-01');
});

test('claim C: a hand-applied CMD status wins over the money derivation', () => {
  const c = claim(FX.claimC);
  assert.equal(c.statusRaw, 'NEEDS RENEGOTIATING');
  assert.equal(c.statusCategory, 'NEEDS_RENEGOTIATING');
  assert.equal(c.cmdStatusText, 'NEEDS RENEGOTIATING');
  assert.equal(c.statusPayer, null);
});

test('claims D / E: patient balance and other balance', () => {
  assert.equal(claim(FX.claimD).statusRaw, 'BALANCE DUE PATIENT');
  assert.equal(claim(FX.claimD).statusCategory, 'BALANCE_DUE_PATIENT');
  const e = claim(FX.claimE);
  assert.equal(e.statusRaw, 'BALANCE DUE OTHER');
  assert.equal(e.lineCount, 1, 'deleted + non-H charges are not lines');
  assert.equal(e.balance, '300.00');
});

test('claim F: fully paid → PAID; latest ERROR is the last error; notes counted; status events kept', () => {
  const f = claim(FX.claimF);
  assert.equal(f.statusRaw, 'PAID');
  assert.equal(f.statusCategory, 'PAID');
  assert.equal(f.openLineCount, 0);
  assert.equal(f.hasDenial, false);
  assert.equal(f.lastErrorCode, '16');
  assert.equal(f.lastErrorMessage, 'Claim lacks information needed for adjudication.');
  assert.equal(f.lastErrorAt, '2026-01-05T08:00:00');
  assert.equal(f.lastErrorReceiver, 'BETA MUTUAL');
  assert.equal(f.cmdNoteCount, 2);
  assert.equal(f.lastCmdNoteAt, '2026-06-20T10:00:00');
  // Kept status events for F: the ERROR row + the latest INFO row (RA); the first INFO is dropped.
  const evF = mapped.statusEvents.filter((e) => e.cmdClaimId === FX.claimF).map((e) => e.cmdStatusId).sort();
  assert.deepEqual(evF, ['300000002', '300000003']);
  // Claim A's only status row is kept as its latest; its 400-char message is truncated to 300.
  const evA = mapped.statusEvents.find((e) => e.cmdClaimId === FX.claimA)!;
  assert.equal(evA.statusMessage?.length, 300);
});

test('notes: claim-level AND patient-level kept; deleted / not-kept dropped; author + time mapped; message verbatim (plaintext for the writer to encrypt)', () => {
  assert.equal(mapped.notes.length, 3);
  const patientLevel = mapped.notes.find((x) => x.cmdNoteId === '200000005')!;
  assert.equal(patientLevel.cmdClaimId, null);
  assert.equal(patientLevel.cmdPatientId, FX.pat1);
  assert.equal(patientLevel.noteType, '0');
  assert.equal(mapped.skips['note: patient not kept'], 1, 'the unnamed patient\'s note');
  // A patient-level note counts toward EVERY claim of that patient (A, C, D are pat1's).
  assert.equal(claim(FX.claimA).cmdNoteCount, 1);
  assert.equal(claim(FX.claimA).lastCmdNoteAt, '2026-07-01T09:30:00');
  assert.equal(claim(FX.claimC).cmdNoteCount, 1);
  assert.equal(claim(FX.claimB).cmdNoteCount, 0);
  const n = mapped.notes.find((x) => x.cmdNoteId === '200000002')!;
  assert.equal(n.cmdClaimId, FX.claimF);
  assert.equal(n.authorLabel, 'jt');
  assert.equal(n.noteType, '2');
  assert.equal(n.notedAt, '2026-06-20T10:00:00');
  assert.equal(n.message, 'Synthetic follow-up note two.');
  assert.equal(mapped.skips['note: deleted'], 1);
});

test('patients: only referenced + named patients; INS_POLICIES priority-1 active policy wins over B_PATIENT.INSID1', () => {
  const ids = mapped.patients.map((p) => p.cmdPatientId).sort();
  assert.deepEqual(ids, [FX.pat1, FX.pat2]);
  const p1 = mapped.patients.find((p) => p.cmdPatientId === FX.pat1)!;
  assert.equal(p1.patientName, 'TESTLAST, ALEX');
  assert.equal(p1.patientDob, '1990-01-02');
  assert.equal(p1.memberId, 'ZZZ111POL');
  assert.equal(p1.groupNumber, 'GPOL');
  assert.equal(p1.primaryPayerName, 'ALPHA HEALTH PLAN');
  const p2 = mapped.patients.find((p) => p.cmdPatientId === FX.pat2)!;
  assert.equal(p2.patientName, 'SAMPLE, JORDAN');
  assert.equal(p2.patientDob, null);
  assert.equal(p2.memberId, null, 'the inactive policy is ignored and INSID1 is blank');
});

test('snapshotAsOf is the max charge LASTUPDATE (including deleted rows); facility name from B_PRACTICE', () => {
  assert.equal(mapped.snapshotAsOf, '2026-06-01T10:00:00');
  assert.equal(mapped.facilityName, 'SYNTHETIC MENTAL HEALTH LLC');
});

test('summarizeDenials: PR-only remits are not a denial unless CMD flags DENIAL; top six by |amount|', () => {
  const base = { cmdClaimId: '1', cmdChargeId: '1', kind: 'A' as const, isAdjustment: true, payerName: null, payerLevel: 1, receivedDate: null };
  assert.deepEqual(summarizeDenials([{ ...base, cmdRemitId: '1', groupCode: 'PR', code: '1', amount: '100.00', isDenial: false }]), { items: [], hasDenial: false });
  const flagged = summarizeDenials([{ ...base, cmdRemitId: '1', groupCode: 'PR', code: '204', amount: '100.00', isDenial: true }]);
  assert.equal(flagged.hasDenial, true);
  assert.deepEqual(flagged.items, [{ g: 'PR', c: '204', amt: '100.00', n: 1 }]);
  const many = summarizeDenials(Array.from({ length: 9 }, (_, i) => ({ ...base, cmdRemitId: String(i), groupCode: 'CO', code: String(100 + i), amount: `${(i + 1) * 10}.00`, isDenial: false })));
  assert.equal(many.items.length, 6);
  assert.equal(many.items[0]!.c, '108');
});

test('mapSnapshot REFUSES a snapshot missing a core table — a broken export must not read as an empty book', () => {
  const t = buildFixture();
  const noCharges = new Map<string, SnapshotTable>([['B_CLAIM', t.require('B_CLAIM')], ['B_PAYOR', t.require('B_PAYOR')]]);
  assert.throws(() => mapSnapshot(snapshotTablesFrom(noCharges)), /B_CHARGE is missing/);
  const noClaims = new Map<string, SnapshotTable>([['B_CHARGE', t.require('B_CHARGE')]]);
  assert.throws(() => mapSnapshot(snapshotTablesFrom(noClaims)), /B_CLAIM is missing/);
});

test('mapSnapshot tolerates missing optional tables (a tiny snapshot with no notes/remits/statuses)', () => {
  const t = buildFixture();
  const minimal = new Map<string, SnapshotTable>();
  for (const name of ['B_CHARGE', 'B_CLAIM', 'B_PATIENT', 'B_PAYOR']) minimal.set(name, t.require(name));
  const m = mapSnapshot(snapshotTablesFrom(minimal));
  assert.equal(m.claims.length, 6);
  assert.equal(m.notes.length, 0);
  assert.equal(m.remits.length, 0);
  assert.equal(m.facilityName, null);
  // With no activity table the primary payer is the fallback.
  assert.equal(m.claims.find((c) => c.cmdClaimId === FX.claimB)!.statusRaw, 'CLAIM AT ALPHA HEALTH PLAN');
});

test('summarizeDenials: a CO/PI/OA adjustment is NOT a denial — only CMD\'s DENIAL flag is', () => {
  const base = { cmdClaimId: '1', cmdChargeId: '1', kind: 'A' as const, isAdjustment: true, payerName: null, payerLevel: 1, receivedDate: null };
  // CO*45 rides on essentially every remitted OON claim. Before 2026-09-10 it set hasDenial, so the
  // red "Denied" tile silently meant "has ever been remitted" — always red, therefore ignored.
  const co = summarizeDenials([{ ...base, cmdRemitId: '1', groupCode: 'CO', code: '45', amount: '500.00', isDenial: false }]);
  assert.equal(co.hasDenial, false, 'a contractual write-off is not a denial');
  assert.deepEqual(co.items, [{ g: 'CO', c: '45', amt: '500.00', n: 1 }], 'but it IS still in the adjustments roll-up the drawer shows');
  for (const g of ['PI', 'OA'] as const) {
    assert.equal(summarizeDenials([{ ...base, cmdRemitId: '2', groupCode: g, code: '97', amount: '10.00', isDenial: false }]).hasDenial, false, `${g} alone is not a denial`);
  }
  // The flag is the whole signal, whatever the group code is.
  const flagged = summarizeDenials([
    { ...base, cmdRemitId: '3', groupCode: 'CO', code: '45', amount: '500.00', isDenial: false },
    { ...base, cmdRemitId: '4', groupCode: 'CO', code: '29', amount: '25.00', isDenial: true },
  ]);
  assert.equal(flagged.hasDenial, true);
  assert.equal(flagged.items.length, 2, 'both adjustments still summarised');
});

test('assertSnapshotShape: a RENAMED money column fails the parse instead of zeroing the book', () => {
  // The catastrophic silent case: B_CHARGE.BALANCE renamed => every cmdMoney() falls back to '0.00'
  // => deriveChargeStatus calls the book PAID => the queue reports $0 open AR for all 19 facilities,
  // while the run records status='ok' and the 20h freshness cursor blocks a re-pull.
  const t = buildFixture();
  const charge = t.require('B_CHARGE');
  const renamed: SnapshotTable = {
    name: 'B_CHARGE',
    columns: charge.columns.map((c) => (c === 'BALANCE' ? 'BAL_AMT' : c)),
    rows: charge.rows.map((r) => { const { BALANCE, ...rest } = r as Record<string, string>; return { ...rest, BAL_AMT: BALANCE ?? '' }; }),
  };
  assert.throws(() => mapSnapshot(buildFixture({ B_CHARGE: renamed })), /shape changed/);
  // The error names the table and the column, and NOTHING else — it reaches the cron's logger.
  try {
    mapSnapshot(buildFixture({ B_CHARGE: renamed }));
    assert.fail('expected a throw');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /B_CHARGE: missing BALANCE/);
    for (const row of charge.rows) {
      for (const v of Object.values(row)) {
        if (String(v).length > 3) assert.ok(!msg.includes(String(v)), `the message must not carry a cell value (${String(v)})`);
      }
    }
  }
});

test('assertSnapshotShape: an ABSENT secondary table stays lenient — a small account may have no remits', () => {
  // Deliberately NOT promoted to a hard require: a customer with no remittances or no notes can
  // legitimately ship without the table, and failing that would break the small accounts.
  const t = buildFixture();
  const kept = new Map<string, SnapshotTable>();
  for (const n of t.names()) if (n !== 'B_REMITTANCE' && n !== 'B_PATNOTES') kept.set(n, t.require(n));
  const mapped = mapSnapshot(snapshotTablesFrom(kept));
  assert.ok(mapped.claims.length > 0, 'still maps a full book');
  assert.equal(mapped.remits.length, 0);
  assert.equal(mapped.notes.length, 0);
});

test('assertSnapshotShape: a PRESENT secondary table with a renamed key column DOES fail', () => {
  const t = buildFixture();
  const rem = t.require('B_REMITTANCE');
  const renamed: SnapshotTable = { name: 'B_REMITTANCE', columns: rem.columns.map((c) => (c === 'CLAIM' ? 'CLAIM_ID' : c)), rows: rem.rows };
  assert.throws(() => mapSnapshot(buildFixture({ B_REMITTANCE: renamed })), /B_REMITTANCE: missing CLAIM/);
});
