/**
 * AR Management — the snapshot WRITER. Takes the mapper's plaintext rows (arSnapshotMap.ts) and
 * upserts them into claims.ar_* as the least-privilege claims_audit_writer, every statement inside
 * a withTenant() transaction (0049's GUC-scoped writer policies RAISE on an unscoped write).
 *
 * PHI DISCIPLINE: the patient trio (name / DOB / member id) and every note body are libsodium-
 * encrypted IN-PROCESS, OUTSIDE any transaction (never hold a pooled connection across crypto),
 * before the INSERT. Blind indexes come from the ingest-SAFE variant (a missing INDEX_HMAC_KEY
 * yields null tokens rather than breaking the run). Nothing here logs a cell value.
 *
 * IDEMPOTENT + CONVERGENT: patients / claims / charges / remits / status events are
 * `INSERT … ON CONFLICT (business_entity_id, <cmd id>) DO UPDATE` so a re-pull converges on the
 * latest snapshot; the ingest's own `last_seen_at` / `last_run_id` bump lets the STALE MARK at the
 * end flip `in_latest_snapshot` off for rows the snapshot no longer carries (a claim CMD deleted)
 * without ever deleting history. Notes are APPEND-ONLY: existing cmd_note_ids are pre-read and only
 * genuinely new notes are encrypted and inserted (`ON CONFLICT … DO NOTHING` as the backstop).
 *
 * Batches are bounded so a statement never nears Postgres's 65,535-parameter ceiling
 * (claims: 51 columns × 250 rows = 12,750).
 */
import type pg from 'pg';
import type { Db } from '../collections/db.js';
import { encryptPhi } from '../collections/phiCrypto.js';
import { auditBlindIndexesForRowSafe } from '../collections/blindIndex.js';
import { withTenant } from '../veris/withTenant.js';
import type { ArMapped, ArClaimPlain, ArChargePlain, ArNotePlain, ArPatientPlain, ArRemitPlain, ArStatusEventPlain } from './arSnapshotMap.js';

export interface ArWriteContext {
  businessEntityId: string;
  cmdCustomerId: string;
  facilityCode: string;
  /** ar_snapshot_run.id of the run doing the writing — stamped on every claim as last_run_id. */
  runId: number;
  /** ISO instant the run started — charges last seen before it are marked not-in-latest. */
  runStartedAt: string;
}

export interface ArWriteStats {
  patients: number;
  claims: number;
  charges: number;
  remits: number;
  statusEvents: number;
  notesInserted: number;
  claimsMarkedStale: number;
  chargesMarkedStale: number;
}

interface Col {
  name: string;
  /** Optional `::type` suffix on the placeholder (jsonb / text[] / timestamptz). */
  cast?: string;
}

function chunk<T>(a: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** One batched upsert statement. Returns the number of rows the statement touched. */
async function upsertBatch(
  client: pg.PoolClient,
  table: string,
  cols: readonly Col[],
  conflictKey: string,
  updateCols: readonly string[],
  rows: readonly unknown[][],
  extraSet: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const params: unknown[] = [];
  const tuples = rows.map((vals) => {
    const base = params.length;
    params.push(...vals);
    return `(${cols.map((c, i) => `$${base + i + 1}${c.cast ?? ''}`).join(', ')})`;
  });
  const sets = [...updateCols.map((c) => `${c} = excluded.${c}`), extraSet].filter((s) => s !== '').join(', ');
  const sql =
    `insert into ${table} (${cols.map((c) => c.name).join(', ')}) values ${tuples.join(', ')} ` +
    `on conflict (${conflictKey}) do update set ${sets} returning id`;
  const res = await client.query(sql, params);
  return res.rowCount ?? res.rows.length;
}

// --- column specs -----------------------------------------------------------------------------

const PATIENT_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_customer_id' }, { name: 'cmd_patient_id' },
  { name: 'patient_name_enc' }, { name: 'patient_name_bidx' }, { name: 'patient_name_pfx3_bidx' },
  { name: 'patient_dob_enc' }, { name: 'member_id_enc' }, { name: 'member_id_bidx' }, { name: 'member_id_pfx3_bidx' },
  { name: 'primary_payer_name' },
];
const PATIENT_UPDATE = PATIENT_COLS.map((c) => c.name).filter((n) => !['business_entity_id', 'cmd_patient_id'].includes(n));

const CLAIM_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_customer_id' }, { name: 'facility_code' }, { name: 'facility_name' },
  { name: 'cmd_claim_id' }, { name: 'cmd_patient_id' }, { name: 'claim_type' }, { name: 'claim_frequency' },
  { name: 'type_of_bill' }, { name: 'admit_date', cast: '::date' }, { name: 'discharge_date', cast: '::date' },
  { name: 'dos_from', cast: '::date' }, { name: 'dos_to', cast: '::date' }, { name: 'entered_at', cast: '::timestamptz' },
  { name: 'first_bill_date', cast: '::date' }, { name: 'last_bill_date', cast: '::date' },
  { name: 'line_count' }, { name: 'open_line_count' },
  { name: 'total_charges' }, { name: 'ins_paid' }, { name: 'pat_paid' }, { name: 'adjustments' }, { name: 'balance' },
  { name: 'balance_due_to' }, { name: 'primary_payer_name' }, { name: 'current_payer_name' }, { name: 'current_payer_level' },
  { name: 'payer_type' }, { name: 'cmd_status_text' }, { name: 'status_raw' }, { name: 'status_category' }, { name: 'status_payer' },
  { name: 'auth_number' }, { name: 'payer_claim_control_no' }, { name: 'cmd_followup_date', cast: '::date' },
  { name: 'cpt_codes', cast: '::text[]' }, { name: 'rev_codes', cast: '::text[]' },
  { name: 'last_835_status' }, { name: 'last_835_date', cast: '::date' }, { name: 'last_activity_date', cast: '::date' },
  { name: 'last_error_code' }, { name: 'last_error_message' }, { name: 'last_error_at', cast: '::timestamptz' }, { name: 'last_error_receiver' },
  { name: 'denial_summary', cast: '::jsonb' }, { name: 'has_denial' }, { name: 'cmd_note_count' }, { name: 'last_cmd_note_at', cast: '::timestamptz' },
  { name: 'ins_last_payment_date', cast: '::date' }, { name: 'in_latest_snapshot' }, { name: 'last_run_id' },
];
const CLAIM_UPDATE = CLAIM_COLS.map((c) => c.name).filter((n) => !['business_entity_id', 'cmd_claim_id'].includes(n));

const CHARGE_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_customer_id' }, { name: 'cmd_charge_id' }, { name: 'cmd_claim_id' }, { name: 'cmd_patient_id' },
  { name: 'dos_from', cast: '::date' }, { name: 'dos_to', cast: '::date' }, { name: 'cpt_code' }, { name: 'modifiers' }, { name: 'rev_code' },
  { name: 'units' }, { name: 'charge_amount' }, { name: 'allowed' }, { name: 'ins_paid' }, { name: 'pat_paid' }, { name: 'adjustments' }, { name: 'balance' },
  { name: 'balance_due_to' }, { name: 'bill_to' }, { name: 'cmd_status_text' }, { name: 'status_raw' }, { name: 'status_category' }, { name: 'status_payer' },
  { name: 'first_bill_date', cast: '::date' }, { name: 'last_bill_date', cast: '::date' }, { name: 'ins_last_payment_date', cast: '::date' },
  { name: 'entered_at', cast: '::timestamptz' }, { name: 'in_latest_snapshot' },
];
const CHARGE_UPDATE = CHARGE_COLS.map((c) => c.name).filter((n) => !['business_entity_id', 'cmd_charge_id'].includes(n));

const REMIT_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_remit_id' }, { name: 'cmd_claim_id' }, { name: 'cmd_charge_id' }, { name: 'kind' },
  { name: 'group_code' }, { name: 'code' }, { name: 'amount' }, { name: 'is_denial' }, { name: 'is_adjustment' },
  { name: 'payer_name' }, { name: 'payer_level' }, { name: 'received_date', cast: '::date' },
];
const REMIT_UPDATE = REMIT_COLS.map((c) => c.name).filter((n) => !['business_entity_id', 'cmd_remit_id'].includes(n));

const STATUS_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_status_id' }, { name: 'cmd_claim_id' }, { name: 'status_type' },
  { name: 'status_date', cast: '::timestamptz' }, { name: 'status_code' }, { name: 'status_message' }, { name: 'action_code' },
  { name: 'action_message' }, { name: 'receiver_name' }, { name: 'err_fixed' },
];
const STATUS_UPDATE = STATUS_COLS.map((c) => c.name).filter((n) => !['business_entity_id', 'cmd_status_id'].includes(n));

const NOTE_COLS: readonly Col[] = [
  { name: 'business_entity_id' }, { name: 'cmd_customer_id' }, { name: 'cmd_claim_id' }, { name: 'cmd_patient_id' }, { name: 'source' }, { name: 'cmd_note_id' },
  { name: 'author_label' }, { name: 'author_user_id' }, { name: 'note_enc' }, { name: 'note_type' }, { name: 'noted_at', cast: '::timestamptz' },
];

// --- row builders -------------------------------------------------------------------------------

async function patientParams(p: ArPatientPlain, ctx: ArWriteContext): Promise<unknown[]> {
  const [nameEnc, dobEnc, memberEnc] = await Promise.all([
    encryptPhi(p.patientName),
    p.patientDob === null ? Promise.resolve(null) : encryptPhi(p.patientDob),
    p.memberId === null ? Promise.resolve(null) : encryptPhi(p.memberId),
  ]);
  const bidx = auditBlindIndexesForRowSafe(p.patientName, p.memberId);
  return [
    ctx.businessEntityId, ctx.cmdCustomerId, p.cmdPatientId,
    nameEnc, bidx.patient_name_bidx, bidx.patient_name_pfx3_bidx,
    dobEnc, memberEnc, bidx.member_id_bidx, bidx.member_id_pfx3_bidx,
    p.primaryPayerName,
  ];
}

function claimParams(c: ArClaimPlain, ctx: ArWriteContext, facilityName: string | null): unknown[] {
  return [
    ctx.businessEntityId, ctx.cmdCustomerId, ctx.facilityCode, facilityName,
    c.cmdClaimId, c.cmdPatientId, c.claimType, c.claimFrequency,
    c.typeOfBill, c.admitDate, c.dischargeDate,
    c.dosFrom, c.dosTo, c.enteredAt,
    c.firstBillDate, c.lastBillDate,
    c.lineCount, c.openLineCount,
    c.totalCharges, c.insPaid, c.patPaid, c.adjustments, c.balance,
    c.balanceDueTo, c.primaryPayerName, c.currentPayerName, c.currentPayerLevel,
    c.payerType, c.cmdStatusText, c.statusRaw, c.statusCategory, c.statusPayer,
    c.authNumber, c.payerClaimControlNo, c.cmdFollowupDate,
    c.cptCodes, c.revCodes,
    c.last835Status, c.last835Date, c.lastActivityDate,
    c.lastErrorCode, c.lastErrorMessage, c.lastErrorAt, c.lastErrorReceiver,
    JSON.stringify(c.denialSummary), c.hasDenial, c.cmdNoteCount, c.lastCmdNoteAt,
    c.insLastPaymentDate, true, ctx.runId,
  ];
}

function chargeParams(c: ArChargePlain, ctx: ArWriteContext): unknown[] {
  return [
    ctx.businessEntityId, ctx.cmdCustomerId, c.cmdChargeId, c.cmdClaimId, c.cmdPatientId,
    c.dosFrom, c.dosTo, c.cptCode, c.modifiers, c.revCode,
    c.units, c.chargeAmount, c.allowed, c.insPaid, c.patPaid, c.adjustments, c.balance,
    c.balanceDueTo, c.billTo, c.cmdStatusText, c.statusRaw, c.statusCategory, c.statusPayer,
    c.firstBillDate, c.lastBillDate, c.insLastPaymentDate,
    c.enteredAt, true,
  ];
}

function remitParams(r: ArRemitPlain, ctx: ArWriteContext): unknown[] {
  return [
    ctx.businessEntityId, r.cmdRemitId, r.cmdClaimId, r.cmdChargeId, r.kind,
    r.groupCode, r.code, r.amount, r.isDenial, r.isAdjustment,
    r.payerName, r.payerLevel, r.receivedDate,
  ];
}

function statusParams(e: ArStatusEventPlain, ctx: ArWriteContext): unknown[] {
  return [
    ctx.businessEntityId, e.cmdStatusId, e.cmdClaimId, e.statusType,
    e.statusDate, e.statusCode, e.statusMessage, e.actionCode,
    e.actionMessage, e.receiverName, e.errFixed,
  ];
}

async function noteParams(n: ArNotePlain, ctx: ArWriteContext): Promise<unknown[]> {
  const enc = await encryptPhi(n.message);
  return [
    ctx.businessEntityId, ctx.cmdCustomerId, n.cmdClaimId, n.cmdPatientId, 'cmd', n.cmdNoteId,
    n.authorLabel.slice(0, 120), null, enc, n.noteType, n.notedAt ?? ctx.runStartedAt,
  ];
}

// --- the writer -------------------------------------------------------------------------------

/**
 * Write one customer's mapped snapshot. Each batch is its own short tenant-scoped transaction, so
 * a mid-run failure leaves earlier batches committed and the next run converges (idempotent).
 */
export async function writeArSnapshot(db: Db, mapped: ArMapped, ctx: ArWriteContext): Promise<ArWriteStats> {
  const stats: ArWriteStats = { patients: 0, claims: 0, charges: 0, remits: 0, statusEvents: 0, notesInserted: 0, claimsMarkedStale: 0, chargesMarkedStale: 0 };
  const ent = ctx.businessEntityId;

  // 1. Patients (PHI encrypted outside the transaction).
  for (const batch of chunk(mapped.patients, 200)) {
    const rows = await Promise.all(batch.map((p) => patientParams(p, ctx)));
    stats.patients += await withTenant(db, ent, (client) =>
      upsertBatch(client, 'claims.ar_patient', PATIENT_COLS, 'business_entity_id, cmd_patient_id', PATIENT_UPDATE, rows, 'last_seen_at = now()'),
    );
  }
  // 2. Claims.
  for (const batch of chunk(mapped.claims, 250)) {
    const rows = batch.map((c) => claimParams(c, ctx, mapped.facilityName));
    stats.claims += await withTenant(db, ent, (client) =>
      upsertBatch(client, 'claims.ar_claim', CLAIM_COLS, 'business_entity_id, cmd_claim_id', CLAIM_UPDATE, rows, 'last_seen_at = now()'),
    );
  }
  // 3. Charges.
  for (const batch of chunk(mapped.charges, 400)) {
    const rows = batch.map((c) => chargeParams(c, ctx));
    stats.charges += await withTenant(db, ent, (client) =>
      upsertBatch(client, 'claims.ar_charge', CHARGE_COLS, 'business_entity_id, cmd_charge_id', CHARGE_UPDATE, rows, 'last_seen_at = now()'),
    );
  }
  // 4. Remits.
  for (const batch of chunk(mapped.remits, 500)) {
    const rows = batch.map((r) => remitParams(r, ctx));
    stats.remits += await withTenant(db, ent, (client) =>
      upsertBatch(client, 'claims.ar_remit', REMIT_COLS, 'business_entity_id, cmd_remit_id', REMIT_UPDATE, rows, ''),
    );
  }
  // 5. Status events.
  for (const batch of chunk(mapped.statusEvents, 500)) {
    const rows = batch.map((e) => statusParams(e, ctx));
    stats.statusEvents += await withTenant(db, ent, (client) =>
      upsertBatch(client, 'claims.ar_claim_status_event', STATUS_COLS, 'business_entity_id, cmd_status_id', STATUS_UPDATE, rows, ''),
    );
  }
  // 6. Notes — append-only: pre-read what exists, encrypt + insert only the new ones.
  if (mapped.notes.length > 0) {
    const existing = await withTenant(db, ent, async (client) => {
      const res = await client.query<{ cmd_note_id: string }>(
        `select cmd_note_id from claims.ar_claim_note where business_entity_id = $1 and cmd_customer_id = $2 and source = 'cmd'`,
        [ent, ctx.cmdCustomerId],
      );
      return new Set(res.rows.map((r) => r.cmd_note_id));
    });
    const fresh = mapped.notes.filter((n) => !existing.has(n.cmdNoteId));
    for (const batch of chunk(fresh, 200)) {
      const rows = await Promise.all(batch.map((n) => noteParams(n, ctx)));
      stats.notesInserted += await withTenant(db, ent, async (client) => {
        const params: unknown[] = [];
        const tuples = rows.map((vals) => {
          const base = params.length;
          params.push(...vals);
          return `(${NOTE_COLS.map((c, i) => `$${base + i + 1}${c.cast ?? ''}`).join(', ')})`;
        });
        const res = await client.query(
          `insert into claims.ar_claim_note (${NOTE_COLS.map((c) => c.name).join(', ')}) values ${tuples.join(', ')} ` +
            `on conflict (business_entity_id, cmd_note_id) where cmd_note_id is not null do nothing returning id`,
          params,
        );
        return res.rowCount ?? res.rows.length;
      });
    }
  }
  // 7. Stale mark — rows this customer's snapshot no longer carries leave the live queue but keep
  //    their history.
  await withTenant(db, ent, async (client) => {
    const c = await client.query(
      `update claims.ar_claim set in_latest_snapshot = false ` +
        `where business_entity_id = $1 and cmd_customer_id = $2 and in_latest_snapshot and last_run_id is distinct from $3`,
      [ent, ctx.cmdCustomerId, ctx.runId],
    );
    stats.claimsMarkedStale = c.rowCount ?? 0;
    const ch = await client.query(
      `update claims.ar_charge set in_latest_snapshot = false ` +
        `where business_entity_id = $1 and cmd_customer_id = $2 and in_latest_snapshot and last_seen_at < $3::timestamptz`,
      [ent, ctx.cmdCustomerId, ctx.runStartedAt],
    );
    stats.chargesMarkedStale = ch.rowCount ?? 0;
  });
  return stats;
}
