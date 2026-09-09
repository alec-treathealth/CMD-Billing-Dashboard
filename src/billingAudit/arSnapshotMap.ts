/**
 * CMD V2 snapshot tables → AR Management rows. PURE (no I/O, no env, no crypto): the writer
 * (arSnapshotWrite.ts) encrypts the PHI fields this module returns in plaintext.
 *
 * ── HOW CMD'S "CLAIM STATUS" IS DERIVED (verified 2026-09-09 against the live claims.audit_row
 *    vocabulary — the payer strings match exactly, e.g. `CLAIM AT ANTHEM BLUE CROSS CALIFORNIA`,
 *    `CLAIM AT BLUECARD PROGRAM OF WA - SECONDARY`) ─────────────────────────────────────────────
 * `B_CHARGE.STATUS` is a numeric FK to the customer's own `B_CHARGESTATUS` lookup and is set on
 * only ~5% of charges (the hand-applied statuses: NEEDS RENEGOTIATING, APPROVED FOR HIGHER PAYMENT,
 * WRITE OFF, MANAGER ESCALATION - …). Everything else CMD's reports show is DERIVED from money and
 * responsibility columns. The rule, in precedence order:
 *   1. custom status set            → that lookup's DISPLAY_TEXT
 *   2. BALANCE <= 0                 → PAID
 *   3. BALDUETO = 'P'               → BALANCE DUE PATIENT
 *   4. BALDUETO = 'I'               → CLAIM AT <payer the claim was last submitted to>
 *                                     + ' - SECONDARY' when that submission went to the secondary
 *   5. anything else (BALDUETO 'O') → BALANCE DUE OTHER
 * "Last submitted to" = the newest non-deleted B_ACTIVITY row of type E/P/F (electronic / paper /
 * fax submission) for the claim; when a claim has never been submitted the primary payer (PAYOR1)
 * is used. Three hypotheses were measured on CAMH + NASH (always-primary / primary-paid-then-
 * secondary / last-activity): they agree on >98% of open charges and differ only on the
 * ` - SECONDARY` suffix, which the activity's PAYER_PRIORITY resolves directly.
 *
 * The derived string is then classified by the SHARED taxonomy `normalizeStatus`
 * (src/collections/claimStatus.ts), so `status_category` here means the same thing it means on
 * claims.audit_row and collections.cmd_charge_census. Do not fork the taxonomy.
 *
 * ── GRAIN ───────────────────────────────────────────────────────────────────────────────────────
 * Charges are CMD's fact grain (one B_CHARGE row per service line). The queue works CLAIMS, so
 * every claim is aggregated here: sums over its kept charges, the status of the largest OPEN charge
 * (the one a biller would chase), distinct CPT / revenue codes, first/last DOS, and the denial /
 * error / note roll-ups. A claim with no kept charges is dropped (counted in `skips`).
 *
 * ── FILTERING (what "proper data filtering" means here) ─────────────────────────────────────────
 * Dropped: DELETED charges/claims/notes/remits/status rows; charges whose TRANTYPE is not 'H'
 * (13 of 13,001 at CAMH were 'D'); charges whose claim is missing; claims whose patient has no
 * name (the PHI column is NOT NULL); notes with no claim. Everything else is KEPT, including paid
 * claims, so "was open, now paid" is visible rather than silently gone — the read side filters to
 * open balances by default.
 *
 * PHI DISCIPLINE: skip labels name FIELDS only; nothing here logs or throws a cell value.
 */
import { normalizeStatus, type StatusCategory } from '../collections/claimStatus.js';
import {
  cmdDate,
  cmdMoney,
  cmdNumber,
  cmdText,
  cmdTimestamp,
  isCmdTrue,
  type SnapshotRow,
  type SnapshotTables,
} from './snapshotParse.js';

export interface ArPatientPlain {
  cmdPatientId: string;
  /** PHI plaintext — "LAST, FIRST". Encrypted by the writer. */
  patientName: string;
  /** PHI plaintext — ISO date. */
  patientDob: string | null;
  /** PHI plaintext. */
  memberId: string | null;
  /** PHI plaintext. */
  groupNumber: string | null;
  primaryPayerName: string | null;
}

export interface ArChargePlain {
  cmdChargeId: string;
  cmdClaimId: string;
  cmdPatientId: string;
  dosFrom: string | null;
  dosTo: string | null;
  cptCode: string | null;
  modifiers: string | null;
  revCode: string | null;
  units: string | null;
  chargeAmount: string;
  allowed: string | null;
  insPaid: string;
  patPaid: string;
  adjustments: string;
  balance: string;
  balanceDueTo: string | null;
  billTo: string | null;
  cmdStatusText: string | null;
  statusRaw: string;
  statusCategory: StatusCategory;
  statusPayer: string | null;
  firstBillDate: string | null;
  lastBillDate: string | null;
  insLastPaymentDate: string | null;
  enteredAt: string | null;
}

/** PHI-free denial roll-up item: adjustment GROUP (CO/PI/OA/PR), CARC code, summed amount, line count. */
export interface ArDenialSummaryItem {
  g: string | null;
  c: string;
  amt: string;
  n: number;
}

export interface ArClaimPlain {
  cmdClaimId: string;
  cmdPatientId: string;
  claimType: string | null;
  claimFrequency: string | null;
  typeOfBill: string | null;
  admitDate: string | null;
  dischargeDate: string | null;
  dosFrom: string | null;
  dosTo: string | null;
  enteredAt: string | null;
  firstBillDate: string | null;
  lastBillDate: string | null;
  lineCount: number;
  openLineCount: number;
  totalCharges: string;
  insPaid: string;
  patPaid: string;
  adjustments: string;
  balance: string;
  balanceDueTo: string | null;
  primaryPayerName: string | null;
  currentPayerName: string | null;
  currentPayerLevel: number | null;
  payerType: string | null;
  cmdStatusText: string | null;
  statusRaw: string;
  statusCategory: StatusCategory;
  statusPayer: string | null;
  authNumber: string | null;
  payerClaimControlNo: string | null;
  cmdFollowupDate: string | null;
  cptCodes: string[];
  revCodes: string[];
  last835Status: string | null;
  last835Date: string | null;
  lastActivityDate: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  lastErrorReceiver: string | null;
  denialSummary: ArDenialSummaryItem[];
  hasDenial: boolean;
  cmdNoteCount: number;
  lastCmdNoteAt: string | null;
  insLastPaymentDate: string | null;
}

export interface ArRemitPlain {
  cmdRemitId: string;
  cmdClaimId: string;
  cmdChargeId: string;
  kind: 'A' | 'R';
  groupCode: string | null;
  code: string;
  amount: string | null;
  isDenial: boolean;
  isAdjustment: boolean;
  payerName: string | null;
  payerLevel: number | null;
  receivedDate: string | null;
}

export interface ArStatusEventPlain {
  cmdStatusId: string;
  cmdClaimId: string;
  statusType: string;
  statusDate: string | null;
  statusCode: string | null;
  statusMessage: string | null;
  actionCode: string | null;
  actionMessage: string | null;
  receiverName: string | null;
  errFixed: string | null;
}

export interface ArNotePlain {
  cmdNoteId: string;
  /** null for a PATIENT-level note (B_PATNOTES.TYPE 0, CLAIM = 0) — the bulk of CMD's rep notes. */
  cmdClaimId: string | null;
  cmdPatientId: string;
  authorLabel: string;
  /** PHI plaintext — encrypted by the writer. */
  message: string;
  noteType: string | null;
  notedAt: string | null;
}

export interface ArMapped {
  facilityName: string | null;
  /** max(B_CHARGE.LASTUPDATE) — the snapshot's data as-of, naive ISO. */
  snapshotAsOf: string | null;
  patients: ArPatientPlain[];
  claims: ArClaimPlain[];
  charges: ArChargePlain[];
  remits: ArRemitPlain[];
  statusEvents: ArStatusEventPlain[];
  notes: ArNotePlain[];
  /** PHI-safe skip counts by FIELD label. */
  skips: Record<string, number>;
}

export interface DeriveStatusInput {
  customStatusText: string | null;
  balance: number;
  balanceDueTo: string | null;
  currentPayerName: string | null;
  currentPayerLevel: number | null;
}

/** The status derivation described in the header. Pure; never throws. */
export function deriveChargeStatus(input: DeriveStatusInput): {
  statusRaw: string;
  statusCategory: StatusCategory;
  statusPayer: string | null;
} {
  let raw: string;
  if (input.customStatusText !== null && input.customStatusText.trim() !== '') {
    raw = input.customStatusText.trim().toUpperCase();
  } else if (input.balance <= 0.005) {
    raw = 'PAID';
  } else if (input.balanceDueTo === 'P') {
    raw = 'BALANCE DUE PATIENT';
  } else if (input.balanceDueTo === 'I') {
    const payer = (input.currentPayerName ?? '').trim().toUpperCase();
    raw = payer === '' ? 'CLAIM AT UNKNOWN PAYER' : `CLAIM AT ${payer}${input.currentPayerLevel === 2 ? ' - SECONDARY' : ''}`;
  } else {
    raw = 'BALANCE DUE OTHER';
  }
  const n = normalizeStatus(raw);
  return { statusRaw: raw, statusCategory: n.category, statusPayer: n.statusPayer };
}

// ---------------------------------------------------------------------------------------------

const toCents = (money: string | null): number => (money === null ? 0 : Math.round(Number(money) * 100));
const fromCents = (cents: number): string => (cents / 100).toFixed(2);
const idSet = (v: string | undefined): boolean => {
  const t = (v ?? '').trim();
  return t !== '' && t !== '0';
};

function bump(skips: Record<string, number>, label: string): void {
  skips[label] = (skips[label] ?? 0) + 1;
}

function rowsOf(tables: SnapshotTables, name: string): readonly SnapshotRow[] {
  return tables.get(name)?.rows ?? [];
}

interface Activity {
  enteredAt: string;
  payorId: string;
  priority: string;
  rstatus: string | null;
  rdate: string | null;
}

/** Map one parsed snapshot to AR rows. See the header for every rule encoded here. */
export function mapSnapshot(tables: SnapshotTables): ArMapped {
  const skips: Record<string, number> = {};

  // Lookups ------------------------------------------------------------------------------------
  const statusText = new Map<string, string>();
  for (const r of rowsOf(tables, 'B_CHARGESTATUS')) {
    // Deleted lookup rows are KEPT: charges still reference them (WRITE OFF at CAMH is deleted=Y).
    const id = cmdText(r.STATUS);
    const text = cmdText(r.DISPLAY_TEXT);
    if (id && text) statusText.set(id, text.toUpperCase());
  }
  const payorName = new Map<string, string>();
  const payorType = new Map<string, string | null>();
  for (const r of rowsOf(tables, 'B_PAYOR')) {
    const id = cmdText(r.SEQNO);
    const name = cmdText(r.PAYOR);
    if (id && name) {
      payorName.set(id, name);
      payorType.set(id, cmdText(r.PAYORTYPE));
    }
  }
  const nameOf = (payorId: string | undefined): string | null => (idSet(payorId) ? payorName.get(payorId!.trim()) ?? null : null);

  const claimsById = new Map<string, SnapshotRow>();
  for (const r of rowsOf(tables, 'B_CLAIM')) {
    if (isCmdTrue(r.DELETED)) { bump(skips, 'claim: deleted'); continue; }
    const id = cmdText(r.SEQNO);
    if (!id) { bump(skips, 'claim: id missing'); continue; }
    claimsById.set(id, r);
  }

  const iclaimById = new Map<string, SnapshotRow>();
  for (const r of rowsOf(tables, 'ICLAIM')) {
    const id = cmdText(r.SEQNO);
    if (id) iclaimById.set(id, r);
  }

  // Latest submission per claim (E/P/F), and latest 835-bearing activity -----------------------
  const lastActivity = new Map<string, Activity>();
  const last835 = new Map<string, { status: string; date: string | null }>();
  for (const r of rowsOf(tables, 'B_ACTIVITY')) {
    if (isCmdTrue(r.DELETED)) continue;
    const kind = cmdText(r.TRANTYPE);
    if (kind !== 'E' && kind !== 'P' && kind !== 'F') continue;
    const claimId = cmdText(r.CLAIMID);
    const enteredAt = cmdTimestamp(r.ENTERED);
    if (!claimId || !enteredAt) continue;
    const act: Activity = {
      enteredAt,
      payorId: (r.PAYOR ?? '').trim(),
      priority: (r.PAYER_PRIORITY ?? '').trim().toUpperCase(),
      rstatus: cmdText(r.RSTATUS),
      rdate: cmdDate(r.RDATE),
    };
    const cur = lastActivity.get(claimId);
    if (!cur || act.enteredAt > cur.enteredAt) lastActivity.set(claimId, act);
    if (act.rstatus !== null) {
      const prev = last835.get(claimId);
      const when = act.rdate ?? act.enteredAt.slice(0, 10);
      if (!prev || (prev.date ?? '') <= when) last835.set(claimId, { status: act.rstatus, date: when });
    }
  }

  /** The payer a claim's insurance balance currently sits with, and at which level. */
  function currentPayer(claim: SnapshotRow, claimId: string): { name: string | null; level: number | null; id: string | null } {
    const act = lastActivity.get(claimId);
    if (act && idSet(act.payorId)) {
      const level = act.priority === 'S' || (idSet(claim.PAYOR2) && act.payorId === claim.PAYOR2!.trim()) ? 2
        : idSet(claim.PAYOR3) && act.payorId === claim.PAYOR3!.trim() ? 3 : 1;
      return { name: payorName.get(act.payorId) ?? null, level, id: act.payorId };
    }
    if (idSet(claim.PAYOR1)) return { name: nameOf(claim.PAYOR1), level: 1, id: claim.PAYOR1!.trim() };
    return { name: null, level: null, id: null };
  }

  // Charges ------------------------------------------------------------------------------------
  const charges: ArChargePlain[] = [];
  const chargesByClaim = new Map<string, ArChargePlain[]>();
  let snapshotAsOf: string | null = null;
  const payerCache = new Map<string, ReturnType<typeof currentPayer>>();
  for (const r of rowsOf(tables, 'B_CHARGE')) {
    const lu = cmdTimestamp(r.LASTUPDATE);
    if (lu && (snapshotAsOf === null || lu > snapshotAsOf)) snapshotAsOf = lu;
    if (isCmdTrue(r.DELETED)) { bump(skips, 'charge: deleted'); continue; }
    if ((r.TRANTYPE ?? '').trim() !== 'H') { bump(skips, 'charge: trantype'); continue; }
    const chargeId = cmdText(r.TRANID);
    const claimId = cmdText(r.CLAIMID);
    const patientId = cmdText(r.PATIENT);
    if (!chargeId) { bump(skips, 'charge: id missing'); continue; }
    if (!claimId || !claimsById.has(claimId)) { bump(skips, 'charge: claim missing'); continue; }
    if (!patientId) { bump(skips, 'charge: patient missing'); continue; }
    const claim = claimsById.get(claimId)!;
    let payer = payerCache.get(claimId);
    if (!payer) { payer = currentPayer(claim, claimId); payerCache.set(claimId, payer); }

    const balance = cmdMoney(r.BALANCE) ?? '0.00';
    const balanceDueTo = cmdText(r.BALDUETO)?.toUpperCase() ?? null;
    const customText = idSet(r.STATUS) ? statusText.get(r.STATUS!.trim()) ?? null : null;
    const st = deriveChargeStatus({
      customStatusText: customText,
      balance: Number(balance),
      balanceDueTo,
      currentPayerName: payer.name,
      currentPayerLevel: payer.level,
    });
    const mods = [r.MOD1, r.MOD2, r.MOD3, r.MOD4].map((m) => cmdText(m)).filter((m): m is string => m !== null);
    const charge: ArChargePlain = {
      cmdChargeId: chargeId,
      cmdClaimId: claimId,
      cmdPatientId: patientId,
      dosFrom: cmdDate(r.FROMDATE),
      dosTo: cmdDate(r.TODATE),
      cptCode: cmdText(r.CPT),
      modifiers: mods.length ? mods.join(' ') : null,
      revCode: cmdText(r.REVCODE),
      units: cmdNumber(r.UNITS) === null ? null : String(cmdNumber(r.UNITS)),
      chargeAmount: cmdMoney(r.AMOUNT) ?? '0.00',
      allowed: cmdMoney(r.ALLOWED),
      insPaid: cmdMoney(r.INSPAID) ?? '0.00',
      patPaid: cmdMoney(r.PATPAID) ?? '0.00',
      adjustments: cmdMoney(r.ADJMENTS) ?? '0.00',
      balance,
      balanceDueTo,
      billTo: cmdText(r.BILLTO),
      cmdStatusText: customText,
      statusRaw: st.statusRaw,
      statusCategory: st.statusCategory,
      statusPayer: st.statusPayer,
      firstBillDate: cmdDate(r.FIRSTBILLDATE),
      lastBillDate: cmdDate(r.LASTBILLDATE),
      insLastPaymentDate: cmdDate(r.INS_LAST_PAYMENT_DATE),
      enteredAt: cmdTimestamp(r.ENTERED),
    };
    charges.push(charge);
    const list = chargesByClaim.get(claimId);
    if (list) list.push(charge); else chargesByClaim.set(claimId, [charge]);
  }

  // Remits (CAS adjustments + remarks) ---------------------------------------------------------
  const remits: ArRemitPlain[] = [];
  const remitsByClaim = new Map<string, ArRemitPlain[]>();
  for (const r of rowsOf(tables, 'B_REMITTANCE')) {
    if (isCmdTrue(r.DELETED)) continue;
    const id = cmdText(r.SEQNO);
    const claimId = cmdText(r.CLAIM);
    const chargeId = cmdText(r.CHARGE);
    const code = cmdText(r.CODE);
    const kindRaw = (r.TYPE ?? '').trim().toUpperCase();
    if (!id || !claimId || !chargeId || !code) { bump(skips, 'remit: key missing'); continue; }
    if (!chargesByClaim.has(claimId)) { bump(skips, 'remit: claim not kept'); continue; }
    if (kindRaw !== 'A' && kindRaw !== 'R') { bump(skips, 'remit: type'); continue; }
    const remit: ArRemitPlain = {
      cmdRemitId: id,
      cmdClaimId: claimId,
      cmdChargeId: chargeId,
      kind: kindRaw,
      groupCode: cmdText(r.GROUP_CODE)?.toUpperCase() ?? null,
      code: code.toUpperCase(),
      amount: cmdMoney(r.AMOUNT),
      isDenial: isCmdTrue(r.DENIAL),
      isAdjustment: isCmdTrue(r.ADJUSTMENT),
      payerName: nameOf(r.PAYOR),
      payerLevel: cmdNumber(r.PAYORLEVEL),
      receivedDate: cmdDate(r.RECEIVED),
    };
    remits.push(remit);
    const list = remitsByClaim.get(claimId);
    if (list) list.push(remit); else remitsByClaim.set(claimId, [remit]);
  }

  // Status events: ERROR/WARNING rows + the latest row per kept claim ---------------------------
  const statusEvents: ArStatusEventPlain[] = [];
  const latestByClaim = new Map<string, ArStatusEventPlain>();
  const lastErrorByClaim = new Map<string, ArStatusEventPlain>();
  for (const r of rowsOf(tables, 'B_CLAIMSTATUS')) {
    const id = cmdText(r.SEQNO);
    const claimId = cmdText(r.CLAIM);
    if (!id || !claimId || !chargesByClaim.has(claimId)) continue;
    const type = (cmdText(r.STATUS_TYPE) ?? 'INFO').toUpperCase();
    const ev: ArStatusEventPlain = {
      cmdStatusId: id,
      cmdClaimId: claimId,
      statusType: type,
      statusDate: cmdTimestamp(r.STATUS_DATE),
      statusCode: cmdText(r.STATUS_CODE),
      statusMessage: cmdText(r.STATUS_MESSAGE)?.slice(0, 300) ?? null,
      actionCode: cmdText(r.ACTION_CODE),
      actionMessage: cmdText(r.ACTION_MESSAGE)?.slice(0, 200) ?? null,
      receiverName: cmdText(r.RECEIVER_NAME),
      errFixed: cmdText(r.ERR_FIXED),
    };
    const key = ev.statusDate ?? '';
    const latest = latestByClaim.get(claimId);
    if (!latest || key >= (latest.statusDate ?? '')) latestByClaim.set(claimId, ev);
    if (type === 'ERROR' || type === 'WARNING') {
      statusEvents.push(ev);
      const le = lastErrorByClaim.get(claimId);
      if (!le || key >= (le.statusDate ?? '')) lastErrorByClaim.set(claimId, ev);
    }
  }
  const eventIds = new Set(statusEvents.map((e) => e.cmdStatusId));
  for (const ev of latestByClaim.values()) if (!eventIds.has(ev.cmdStatusId)) statusEvents.push(ev);

  // Notes — two kinds, measured 2026-09-09: TYPE 2 rows carry a real claim id; TYPE 0 rows carry
  // CLAIM = 0 and are PATIENT-level follow-up notes (CAMH 1,535 of 1,567 live notes). Both are kept:
  // a patient-level note renders on every one of that patient's claims and counts toward each.
  const referencedPatients = new Set<string>();
  for (const [claimId, lines] of chargesByClaim) referencedPatients.add(cmdText(claimsById.get(claimId)!.PATIENT) ?? lines[0]!.cmdPatientId);
  const notes: ArNotePlain[] = [];
  const noteStatsByClaim = new Map<string, { n: number; last: string | null }>();
  const noteStatsByPatient = new Map<string, { n: number; last: string | null }>();
  const bumpStats = (m: Map<string, { n: number; last: string | null }>, key: string, at: string | null) => {
    const s = m.get(key) ?? { n: 0, last: null };
    s.n += 1;
    if (at && (s.last === null || at > s.last)) s.last = at;
    m.set(key, s);
  };
  for (const r of rowsOf(tables, 'B_PATNOTES')) {
    if (isCmdTrue(r.DELETED)) { bump(skips, 'note: deleted'); continue; }
    const id = cmdText(r.SEQNO);
    const message = cmdText(r.MESSAGE);
    if (!id) { bump(skips, 'note: id missing'); continue; }
    if (!message) { bump(skips, 'note: message blank'); continue; }
    const rawClaim = cmdText(r.CLAIM);
    const claimId = rawClaim !== null && rawClaim !== '0' ? rawClaim : null;
    let patientId: string | null;
    if (claimId !== null) {
      if (!chargesByClaim.has(claimId)) { bump(skips, 'note: claim not kept'); continue; }
      patientId = cmdText(claimsById.get(claimId)!.PATIENT) ?? cmdText(r.PATIENT);
    } else {
      patientId = cmdText(r.PATIENT);
      if (!patientId || !referencedPatients.has(patientId)) { bump(skips, 'note: patient not kept'); continue; }
    }
    if (!patientId) { bump(skips, 'note: patient missing'); continue; }
    const notedAt = cmdTimestamp(r.SUBMITTED);
    notes.push({
      cmdNoteId: id,
      cmdClaimId: claimId,
      cmdPatientId: patientId,
      authorLabel: cmdText(r.USERNAME) ?? 'CMD',
      message,
      noteType: cmdText(r.TYPE),
      notedAt,
    });
    if (claimId !== null) bumpStats(noteStatsByClaim, claimId, notedAt); else bumpStats(noteStatsByPatient, patientId, notedAt);
  }

  // Claims -------------------------------------------------------------------------------------
  const claims: ArClaimPlain[] = [];
  const patientIds = new Set<string>();
  for (const [claimId, claim] of claimsById) {
    const lines = chargesByClaim.get(claimId);
    if (!lines || lines.length === 0) { bump(skips, 'claim: no charges'); continue; }
    const patientId = cmdText(claim.PATIENT) ?? lines[0]!.cmdPatientId;
    let total = 0, ins = 0, pat = 0, adj = 0, bal = 0, open = 0;
    const cpts = new Set<string>();
    const revs = new Set<string>();
    let dosFrom: string | null = null;
    let dosTo: string | null = null;
    let firstBill: string | null = null;
    let lastBill: string | null = null;
    let insLastPaid: string | null = null;
    let lead: ArChargePlain | null = null; // the open charge with the largest balance
    for (const c of lines) {
      total += toCents(c.chargeAmount); ins += toCents(c.insPaid); pat += toCents(c.patPaid); adj += toCents(c.adjustments);
      const b = toCents(c.balance);
      bal += b;
      if (b > 0) {
        open += 1;
        if (!lead || b > toCents(lead.balance) || (b === toCents(lead.balance) && (c.dosFrom ?? '') > (lead.dosFrom ?? ''))) lead = c;
      }
      if (c.cptCode) cpts.add(c.cptCode);
      if (c.revCode) revs.add(c.revCode);
      if (c.dosFrom && (dosFrom === null || c.dosFrom < dosFrom)) dosFrom = c.dosFrom;
      const to = c.dosTo ?? c.dosFrom;
      if (to && (dosTo === null || to > dosTo)) dosTo = to;
      if (c.firstBillDate && (firstBill === null || c.firstBillDate < firstBill)) firstBill = c.firstBillDate;
      if (c.lastBillDate && (lastBill === null || c.lastBillDate > lastBill)) lastBill = c.lastBillDate;
      if (c.insLastPaymentDate && (insLastPaid === null || c.insLastPaymentDate > insLastPaid)) insLastPaid = c.insLastPaymentDate;
    }
    // Claim status: the largest open charge's status; all-paid → PAID, unless every line shares one
    // hand-applied status (a fully written-off claim still reads WRITE OFF).
    let statusRaw: string;
    let statusCategory: StatusCategory;
    let statusPayer: string | null;
    let cmdStatusText: string | null;
    if (lead) {
      ({ statusRaw, statusCategory, statusPayer, cmdStatusText } = lead);
    } else {
      const custom = new Set(lines.map((c) => c.cmdStatusText ?? ''));
      const only = custom.size === 1 ? [...custom][0]! : '';
      const st = deriveChargeStatus({ customStatusText: only === '' ? null : only, balance: 0, balanceDueTo: null, currentPayerName: null, currentPayerLevel: null });
      statusRaw = st.statusRaw; statusCategory = st.statusCategory; statusPayer = st.statusPayer; cmdStatusText = only === '' ? null : only;
    }
    const payer = payerCache.get(claimId) ?? currentPayer(claim, claimId);
    const ic = iclaimById.get(claimId);
    const act = lastActivity.get(claimId);
    const l835 = last835.get(claimId);
    const err = lastErrorByClaim.get(claimId);
    const claimRemits = remitsByClaim.get(claimId) ?? [];
    const denial = summarizeDenials(claimRemits);
    const nsClaim = noteStatsByClaim.get(claimId);
    const nsPatient = noteStatsByPatient.get(patientId);
    const noteCount = (nsClaim?.n ?? 0) + (nsPatient?.n ?? 0);
    const lastNote = [nsClaim?.last ?? null, nsPatient?.last ?? null].filter((x): x is string => x !== null).sort().pop() ?? null;
    patientIds.add(patientId);
    claims.push({
      cmdClaimId: claimId,
      cmdPatientId: patientId,
      claimType: cmdText(claim.CLAIMTYPE),
      claimFrequency: cmdText(claim.FREQUENCY),
      typeOfBill: ic ? cmdText(ic.BILLTYPE) : null,
      admitDate: ic ? cmdDate(ic.ADMITDATE) : null,
      dischargeDate: ic ? cmdDate(ic.DISCHARGEDATE) : null,
      dosFrom: dosFrom ?? cmdDate(claim.FROMDATE),
      dosTo: dosTo ?? cmdDate(claim.TODATE),
      enteredAt: cmdTimestamp(claim.ENTERED),
      firstBillDate: firstBill,
      lastBillDate: lastBill,
      lineCount: lines.length,
      openLineCount: open,
      totalCharges: fromCents(total),
      insPaid: fromCents(ins),
      patPaid: fromCents(pat),
      adjustments: fromCents(adj),
      balance: fromCents(bal),
      balanceDueTo: lead?.balanceDueTo ?? null,
      primaryPayerName: nameOf(claim.PAYOR1),
      currentPayerName: payer.name,
      currentPayerLevel: payer.level,
      payerType: payer.id ? payorType.get(payer.id) ?? null : null,
      cmdStatusText,
      statusRaw,
      statusCategory,
      statusPayer,
      authNumber: cmdText(claim.AUTHNO1) ?? cmdText(claim.PRIORAUTHNO),
      payerClaimControlNo: cmdText(claim.CTRLNO1),
      cmdFollowupDate: cmdDate(claim.FOLLOWUP),
      cptCodes: [...cpts].sort(),
      revCodes: [...revs].sort(),
      last835Status: l835?.status ?? null,
      last835Date: l835?.date ?? null,
      lastActivityDate: act ? act.enteredAt.slice(0, 10) : null,
      lastErrorCode: err?.statusCode ?? null,
      lastErrorMessage: err?.statusMessage ?? null,
      lastErrorAt: err?.statusDate ?? null,
      lastErrorReceiver: err?.receiverName ?? null,
      denialSummary: denial.items,
      hasDenial: denial.hasDenial && bal > 0,
      cmdNoteCount: noteCount,
      lastCmdNoteAt: lastNote,
      insLastPaymentDate: insLastPaid,
    });
  }

  // Patients (only those referenced by a kept claim) --------------------------------------------
  const policyByPatient = new Map<string, SnapshotRow>();
  for (const r of rowsOf(tables, 'INS_POLICIES')) {
    if (isCmdTrue(r.INACTIVE)) continue;
    const pid = cmdText(r.PATIENT);
    if (!pid || (r.PRIORITY ?? '').trim() !== '1') continue;
    if (!policyByPatient.has(pid)) policyByPatient.set(pid, r);
  }
  const patients: ArPatientPlain[] = [];
  const patientRows = new Map<string, SnapshotRow>();
  for (const r of rowsOf(tables, 'B_PATIENT')) {
    const id = cmdText(r.PACCTNO);
    if (id) patientRows.set(id, r);
  }
  const droppedPatients = new Set<string>();
  for (const pid of patientIds) {
    const r = patientRows.get(pid);
    const last = r ? cmdText(r.PLAST) : null;
    const first = r ? cmdText(r.PFIRST) : null;
    if (!r || (!last && !first)) { bump(skips, 'patient: name missing'); droppedPatients.add(pid); continue; }
    const pol = policyByPatient.get(pid);
    patients.push({
      cmdPatientId: pid,
      patientName: [last, first].filter((x): x is string => x !== null).join(', '),
      patientDob: cmdDate(r.PBDATE),
      memberId: (pol ? cmdText(pol.MEMBER_ID) : null) ?? cmdText(r.INSID1),
      groupNumber: (pol ? cmdText(pol.GROUP_NO) : null) ?? cmdText(r.GROUPNO1),
      primaryPayerName: pol ? nameOf(pol.PAYER) : null,
    });
  }
  // A claim whose patient has no name cannot be stored (patient_name_enc is NOT NULL) — drop it and
  // its lines, counted, rather than inventing a placeholder identity.
  const keptClaims = claims.filter((c) => !droppedPatients.has(c.cmdPatientId));
  const keptClaimIds = new Set(keptClaims.map((c) => c.cmdClaimId));
  const dropClaims = claims.length - keptClaims.length;
  if (dropClaims > 0) skips['claim: patient unnamed'] = dropClaims;
  const keptNotes = notes.filter((n) => (n.cmdClaimId !== null ? keptClaimIds.has(n.cmdClaimId) : !droppedPatients.has(n.cmdPatientId)));
  const dropNotes = notes.length - keptNotes.length;
  if (dropNotes > 0) skips['note: patient not kept'] = (skips['note: patient not kept'] ?? 0) + dropNotes;

  let facilityName: string | null = null;
  for (const r of rowsOf(tables, 'B_PRACTICE')) {
    if (isCmdTrue(r.INACTIVE) || isCmdTrue(r.DELETED)) continue;
    facilityName = cmdText(r.NAME);
    if (facilityName) break;
  }
  if (facilityName === null) {
    for (const r of rowsOf(tables, 'B_FACILITY')) { facilityName = cmdText(r.NAME); if (facilityName) break; }
  }

  return {
    facilityName,
    snapshotAsOf,
    patients,
    claims: keptClaims,
    charges: charges.filter((c) => keptClaimIds.has(c.cmdClaimId)),
    remits: remits.filter((r) => keptClaimIds.has(r.cmdClaimId)),
    statusEvents: statusEvents.filter((e) => keptClaimIds.has(e.cmdClaimId)),
    notes: keptNotes,
    skips,
  };
}

/**
 * Roll a claim's CAS adjustments into the PHI-free denial summary: group by (group code, CARC),
 * sum the signed amounts, count lines, keep the top six by absolute dollars. Patient-responsibility
 * (PR) adjustments are excluded — they are a patient balance, not a denial — unless CMD flagged the
 * row DENIAL. Remark codes (kind 'R') carry no money and are excluded here (they render in the
 * drawer's remit table instead).
 */
export function summarizeDenials(remits: readonly ArRemitPlain[]): { items: ArDenialSummaryItem[]; hasDenial: boolean } {
  const agg = new Map<string, { g: string | null; c: string; cents: number; n: number }>();
  let hasDenial = false;
  for (const r of remits) {
    if (r.kind !== 'A') continue;
    const denialGroup = r.groupCode === 'CO' || r.groupCode === 'PI' || r.groupCode === 'OA';
    if (!denialGroup && !r.isDenial) continue;
    if (r.isDenial || denialGroup) hasDenial = true;
    const key = `${r.groupCode ?? ''}|${r.code}`;
    const cur = agg.get(key) ?? { g: r.groupCode, c: r.code, cents: 0, n: 0 };
    cur.cents += toCents(r.amount);
    cur.n += 1;
    agg.set(key, cur);
  }
  const items = [...agg.values()]
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.c.localeCompare(b.c))
    .slice(0, 6)
    .map((x) => ({ g: x.g, c: x.c, amt: fromCents(x.cents), n: x.n }));
  return { items, hasDenial };
}
