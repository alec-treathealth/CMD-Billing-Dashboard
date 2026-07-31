/**
 * 835 ERA ingest — backfill AND daily recurring, one script.
 *
 *   tsx src/ingest/era_ingest.ts --date 2026-06-30                 # DRY-RUN (parse, NO DB)
 *   tsx src/ingest/era_ingest.ts --date 2026-06-30 --commit        # load (cmd_rollup_writer)
 *   tsx src/ingest/era_ingest.ts --from 2026-01-01 --to 2026-06-30 # backfill a range (loops days)
 *   tsx src/ingest/era_ingest.ts --date 2026-06-30 --customer 10027973  # one facility account
 *
 * WHAT: downloads the 835 ERA(s) per CMD customer account (one customer == one
 * facility; src/collections/cmdCustomers.ts) for each requested date, parses the
 * X12 (ISA/GS/ST envelope discarded; Loop 2100 CLP; Loop 2110 SVC; every CAS
 * group/reason/amount/quantity triplet — src/ingest/era835Parser.ts), resolves
 * facility_code (from the customer) + business_entity_id (per-customer, from
 * cmdCustomers.ts — BXR or Indigo), encrypts
 * the two PHI identifiers in-process, computes stable fingerprints, and
 * idempotently upserts into TWO tables (ON CONFLICT DO NOTHING on each).
 *
 * TWO GRAINS, TWO TABLES (see SQL Schemas/013 for the full rationale):
 *   staging.era_835_payment    — ONE row per ST/SE set (the BPR/TRN envelope). The
 *                                AUTHORITATIVE source of remitted dollars; BPR02 is
 *                                summable here and ONLY here.
 *   staging.era_835_adjustment — one row per CAS triplet, FK'd to the payment row.
 *                                Has NO payment_amount column on purpose.
 *
 * The payment row is written UNCONDITIONALLY per parsed transaction, before and
 * independent of triplet mapping. A clean-paid remit has zero CAS triplets; under the
 * old single-table shape its BPR02 never landed at all. Never re-gate that write on
 * adjustments existing.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): patient name + member id are libsodium
 * ciphertext (nonce‖ct) via src/collections/phiCrypto.ts, encrypted only at the
 * INSERT boundary — no plaintext PHI ever touches the DB. Logs carry COUNTS, dates,
 * customer/facility ids ONLY — never a name, member id, EDI segment, or skip
 * "reason" that embeds a value. The row_fingerprint is SHA-256 over NON-PHI natural
 * keys (the 835 identifies a triplet by payer claim control number + line + code),
 * computed before encryption, so it is stable across re-downloads.
 *
 * SECURITY: --commit writes as the least-privilege cmd_rollup_writer role
 * (CMD_ROLLUP_WRITER_DATABASE_URL) over verify-full TLS (src/collections/db.ts →
 * src/ssl.ts) — NOT claims_admin, NOT the service role. DRY-RUN opens no DB
 * connection. Secrets come from env only and are never logged. Inserts run on a
 * single checked-out client inside a transaction with app.business_entity_id set
 * (SET LOCAL) so the RLS WITH CHECK on the writer policy is satisfied.
 *
 * LAYERING: runEra835Ingest(deps) is transport-agnostic (injected download + write
 * db + clock) so the Vercel cron (Step 2) and tests reuse it; main() is the CLI that
 * reads env and wires the live CMD download.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ALL_CMD_CUSTOMERS, type CmdCustomer } from '../collections/cmdCustomers.js';
import { CmdEra835Error, cmdDownload835, read835Files, type CmdEra835Config, type Era835File } from '../collections/cmd835.js';
import { encryptPhi, fingerprintRow } from '../collections/phiCrypto.js';
import { makeClient, type Db } from '../collections/db.js';
import { parseEra835, type Era835Claim, type Era835Transaction } from './era835Parser.js';

const ALLOWED_GROUP_CODES = new Set(['CO', 'PR', 'OA', 'PI', 'CR']);
const BATCH = 500;
const MAX_RANGE_DAYS = 400; // guard against a runaway --from/--to

/**
 * One remittance-envelope row — ONE PER ST/SE TRANSACTION SET. Mirrors
 * staging.era_835_payment (migration 013). Contains NO PHI: the BPR/TRN/N1*PR
 * envelope is payer-and-money only, so there is nothing here to encrypt.
 *
 * This is the AUTHORITATIVE money row. It is written unconditionally per parsed
 * transaction (see mapTransactions) — never gated on whether any CAS triplet
 * survived mapping, because a clean-paid remit has zero triplets and would
 * otherwise never land at all.
 */
export interface Era835PaymentRow {
  business_entity_id: string;
  facility_code: string;
  cmd_customer_id: string;
  payer_name: string | null;
  payer_id: string | null;
  era_control_number: string | null;
  check_eft_trace_number: string | null;
  trace_originating_company_id: string | null;
  payment_method: string | null;
  // Money is a FIXED-2 DECIMAL STRING at the DB boundary (see the note on
  // Era835IngestRow). null when BPR02 is absent / out of numeric(12,2) range —
  // the remit still lands (a dropped remit is the defect this table fixes), and
  // the null is COUNTED in stats.payments_amount_out_of_range so it stays visible.
  payment_amount: string | null;
  /**
   * BPR02 verbatim from the EDI. The ONLY surviving record of the figure when
   * payment_amount had to go NULL, and a fingerprint input — without it, two
   * differently-malformed remits hash identically and one is silently dropped.
   */
  payment_amount_raw: string | null;
  payment_date: string | null;
  era_source_file: string | null;
  row_fingerprint: string;
}

/**
 * One fully-mapped adjustment row (PHI held as PLAINTEXT here; encrypted only at the
 * insert boundary). Column set mirrors staging.era_835_adjustment (migration 013).
 *
 * NOTE what is deliberately ABSENT: payment_amount and check_eft_trace_number. Both
 * moved to Era835PaymentRow / staging.era_835_payment. BPR02 denormalized onto every
 * triplet made sum() overstate each remit by its triplet count (10-100x, variable),
 * so the column does not exist here — the wrong sum is unwritable, not merely
 * discouraged. payment_date / payer_name / payer_id / payment_method DO stay: they
 * are low-cardinality filter dimensions and summing a date is not a failure mode.
 */
export interface Era835IngestRow {
  business_entity_id: string;
  facility_code: string;
  cmd_customer_id: string;
  payer_name: string | null;
  payer_id: string | null;
  era_control_number: string | null;
  payment_method: string | null;
  // Money is a FIXED-2 DECIMAL STRING at the DB boundary (docs/CLAUDE.md §2, normalize.ts):
  // never a raw JS float (which node-postgres would toString() into float artifacts /
  // scientific notation for a numeric(12,2) column, and which could diverge from the
  // fingerprinted value). null when the source field is absent / out of numeric(12,2) range.
  payment_date: string | null;
  patient_control_number: string | null;
  payer_claim_control_number: string | null;
  claim_status_code: string | null;
  claim_charge_amount: string | null;
  claim_paid_amount: string | null;
  patient_responsibility_amount: string | null;
  claim_filing_indicator: string | null;
  patient_name: string | null; // PHI plaintext
  member_id: string | null; //    PHI plaintext
  service_line_number: number;
  procedure_code: string | null;
  line_charge_amount: string | null;
  line_paid_amount: string | null;
  line_units: string | null;
  service_date: string | null;
  line_item_control_number: string | null;
  adjustment_index: number; // 0-based ordinal of the triplet within its claim/line list
  cas_level: 'CLAIM' | 'LINE';
  group_code: string;
  carc_code: string;
  carc_type: 'CARC' | 'RARC';
  adjustment_amount: string; //   fixed-2 string (grain value, never null)
  adjustment_quantity: string | null;
  era_source_file: string | null;
  row_fingerprint: string;
}

/** Positional INSERT columns for the PAYMENT table — order MUST match
 *  buildPaymentParams() exactly. */
const PAYMENT_INSERT_COLS = [
  'business_entity_id', 'facility_code', 'cmd_customer_id', 'payer_name', 'payer_id',
  'era_control_number', 'check_eft_trace_number', 'trace_originating_company_id',
  'payment_method', 'payment_amount', 'payment_amount_raw', 'payment_date',
  'era_source_file', 'source', 'row_fingerprint', 'ingested_by',
] as const;

/** Positional INSERT columns — order MUST match buildInsertParams() exactly.
 *  payment_id leads: it is the FK to the authoritative envelope row. */
const INSERT_COLS = [
  'payment_id',
  'business_entity_id', 'facility_code', 'cmd_customer_id', 'payer_name', 'payer_id',
  'era_control_number', 'payment_method', 'payment_date',
  'patient_control_number', 'payer_claim_control_number', 'claim_status_code', 'claim_charge_amount',
  'claim_paid_amount', 'patient_responsibility_amount', 'claim_filing_indicator',
  'patient_name_enc', 'member_id_enc',
  'service_line_number', 'procedure_code', 'line_charge_amount', 'line_paid_amount', 'line_units',
  'service_date', 'line_item_control_number',
  'adjustment_index', 'cas_level', 'group_code', 'carc_code', 'carc_type', 'adjustment_amount', 'adjustment_quantity',
  'era_source_file', 'source', 'row_fingerprint', 'ingested_by',
] as const;

/** numeric(12,2) range: |value| must be < 10^10 (10 integer digits + 2 decimals). */
const NUMERIC_12_2_MAX = 9_999_999_999.99;
export function fitsNumeric12_2(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= NUMERIC_12_2_MAX;
}

/** Context money → fixed-2 string; null when absent OR out of numeric(12,2) range
 *  (a garbage/huge context value must not abort the batch — it is denormalized context,
 *  not the authoritative grain amount, which is validated separately in mapTransactionsToRows). */
const ctxMoney = (n: number | null): string | null =>
  n === null || !fitsNumeric12_2(n) ? null : n.toFixed(2);

/**
 * LOCKED fingerprint field order — SHA-256 over these NON-PHI fields, in EXACTLY this
 * order, joined on \x1f (src/collections/phiCrypto.fingerprintRow). Same SHA-256 + \x1f
 * invariant as cmd_explorer_rows / query_log identity; the FIELD SET is 835-appropriate
 * (the 835 identifies a CAS triplet by payer claim control number + service line + line
 * control number + code — all non-PHI — so, unlike the charge-line CSV, no PHI is needed
 * to disambiguate).
 *
 * IDEMPOTENCY CONTRACT: both the field ORDER and each field's REPRESENTATION (money is a
 * fixed-2 string; the ingest builds the row's amount/quantity as strings, so the hashed
 * value == the stored numeric(12,2) value) are part of the key. line_item_control_number
 * (REF*6R) pins stable line identity when the payer sends it; adjustment_index keeps two
 * byte-identical triplets on one line distinct. A byte-identical re-download dedups; a
 * re-issued/reordered remit is intentionally retained as new history (append-only table).
 * Changing any of this silently breaks dedup — do not change without a deliberate re-ingest.
 *   1 cmd_customer_id  2 payer_claim_control_number  3 patient_control_number
 *   4 service_line_number  5 line_item_control_number  6 adjustment_index
 *   7 cas_level  8 group_code  9 carc_code  10 carc_type
 *  11 adjustment_amount(fixed-2 str)  12 adjustment_quantity(fixed-2 str)
 *  13 service_date(ISO)  14 procedure_code  15 payment_date(ISO)
 */
export function era835Fingerprint(row: Era835IngestRow): string {
  return fingerprintRow([
    row.cmd_customer_id.trim().toLowerCase(), //                    1
    (row.payer_claim_control_number ?? '').trim().toLowerCase(), // 2
    (row.patient_control_number ?? '').trim().toLowerCase(), //     3
    String(row.service_line_number), //                            4
    (row.line_item_control_number ?? '').trim().toLowerCase(), //   5
    String(row.adjustment_index), //                               6
    row.cas_level, //                                              7
    row.group_code.toUpperCase(), //                               8
    row.carc_code.trim().toLowerCase(), //                         9
    row.carc_type, //                                             10
    row.adjustment_amount, //                                     11 (already fixed-2 string)
    row.adjustment_quantity ?? '', //                             12 (already fixed-2 string)
    row.service_date ?? '', //                                    13
    (row.procedure_code ?? '').trim().toLowerCase(), //           14
    row.payment_date ?? '', //                                    15
  ]);
}

/**
 * Explicit ABSENT discriminator for nullable fingerprint fields.
 *
 * WHY NOT `?? ''`: an empty string is a REAL possible value for a text field, so
 * coalescing null to '' overloads one digest input with two meanings ("absent" and
 * "blank"). Worse, it erases information: every nullable field that goes null
 * contributes the same zero-information token, so two rows differing ONLY in fields
 * that both went null hash identically and the second is silently discarded by
 * ON CONFLICT DO NOTHING. \x00 cannot occur in X12 element text (str() trims, and the
 * EDI is 7-bit ASCII) nor in any fixed-2 decimal string, so it can never be confused
 * with a real value.
 */
const FP_ABSENT = '\x00absent';
const fpText = (v: string | null): string =>
  v === null ? FP_ABSENT : v.trim().toLowerCase();

/**
 * LOCKED remit-identity fingerprint — SHA-256 over these 8 NON-PHI fields, in EXACTLY
 * this order. This is the PER-REMIT key; era835Fingerprint above is the PER-TRIPLET key.
 * They are different grains and must never be interchanged.
 *   1 cmd_customer_id  2 payer_id  3 trace_originating_company_id (TRN03)
 *   4 check_eft_trace_number (TRN02)  5 payment_amount(fixed-2 str)
 *   6 payment_amount_raw (BPR02 verbatim)  7 payment_date(ISO)
 *   8 era_control_number (ST02)
 *
 * WHY BOTH payment_amount AND payment_amount_raw (the 2026-07-30 review finding):
 * payment_amount is NULL whenever BPR02 is absent OR outside numeric(12,2). Hashing
 * only the nullable numeric meant THREE genuinely different remits — BPR02
 * 99999999999.99, BPR02 88888888888.88, and BPR02 absent — produced ONE digest
 * (verified), so two of the three were silently dropped by ON CONFLICT DO NOTHING:
 * truncation returning through the same back door that excluding era_source_file
 * closed, except invisible because the insert reports success. An FP_ABSENT token
 * alone does NOT fix this (all three would share the token) — the distinguishing
 * information has to survive, which is what the raw element preserves.
 *
 * WHY NOT era_source_file — see the full rationale on
 * staging.era_835_payment.row_fingerprint in SQL Schemas/013. Short version:
 * era_source_file is a DOWNLOAD-TIME name (for a raw payload the ingest passes the
 * fallback `${cid}_${date}`, literally embedding the pull date; for a ZIP it is the
 * payer's entry name, which can vary between deliveries). Hashing it would make the
 * SAME remit re-pulled on a different date hash differently, insert twice, and
 * double-count BPR02 — reintroducing the exact inflation defect the two-table split
 * exists to eliminate. It is stored for provenance only.
 *
 * TRN02 is unique per PAYER, not globally, so it is qualified by payer_id + TRN03
 * (the X12 field for precisely this purpose) + cmd_customer_id (one customer == one
 * facility; two facilities can receive the same payer's trace number).
 *
 * STABILITY ASSUMPTION (full treatment in SQL Schemas/013's FINGERPRINT STABILITY
 * ASSUMPTIONS header block — read it before touching this function): era_control_number
 * (ST02) and payment_amount_raw both assume CMD re-serves a date's 835 BYTE-STABLY —
 * same transaction sets, same order, same ST02 assignment, same literal BPR02 text. ST02
 * is a per-file sequence number and payment_amount_raw is literal text ('100.00' vs
 * '100.0'), so if that breaks the same remit gets a new digest, inserts a SECOND payment
 * row, and BPR02 is double-counted. DETECTION: a re-pull of an already-ingested date must
 * report payments_inserted = 0; anything above zero there is the duplicate-remit
 * signature, not new data. Accepted deliberately — duplication is detectable and
 * correctable, truncation is not.
 *
 * KNOWN REDUNDANCY (not an oversight): payment_amount is a pure function of
 * payment_amount_raw, so field 5 adds no discriminating power over field 6. Kept because
 * it is harmless, self-documenting, and dropping it would force a full re-ingest for no
 * gain.
 *
 * Changing the field set or order silently breaks dedup — full re-ingest required.
 */
export function era835PaymentFingerprint(row: Era835PaymentRow): string {
  return fingerprintRow([
    row.cmd_customer_id.trim().toLowerCase(), //             1
    fpText(row.payer_id), //                                2
    fpText(row.trace_originating_company_id), //             3
    fpText(row.check_eft_trace_number), //                   4
    row.payment_amount ?? FP_ABSENT, //                      5 (fixed-2 string)
    fpText(row.payment_amount_raw), //                       6 (BPR02 verbatim)
    row.payment_date ?? FP_ABSENT, //                        7
    fpText(row.era_control_number), //                       8
  ]);
}

/** Skip counts (labels are field names only — never a cell value). */
export interface Era835SkipCounts {
  invalid_group_code: number;
  missing_carc_code: number;
  amount_out_of_range: number;
}

/** One parsed remittance, mapped to its authoritative envelope row plus whatever CAS
 *  triplets survived filtering. `adjustments` MAY be empty — that is the normal shape
 *  for a clean-paid remit, and the payment row still stands on its own. */
export interface Era835MappedTransaction {
  payment: Era835PaymentRow;
  adjustments: Era835IngestRow[];
}

/**
 * Map ONE parsed transaction's envelope to its payment row. Unconditional — called for
 * every ST/SE set regardless of CAS content. No PHI is read here.
 */
export function mapTransactionToPaymentRow(
  tx: Era835Transaction,
  ctx: { customer: CmdCustomer; sourceFile: string },
): Era835PaymentRow {
  const row: Era835PaymentRow = {
    business_entity_id: ctx.customer.businessEntityId,
    facility_code: ctx.customer.facilityCode,
    cmd_customer_id: ctx.customer.customerId,
    payer_name: tx.payment.payerName,
    payer_id: tx.payment.payerId,
    era_control_number: tx.payment.eraControlNumber,
    check_eft_trace_number: tx.payment.traceNumber,
    trace_originating_company_id: tx.payment.traceOriginatingCompanyId,
    payment_method: tx.payment.paymentMethod,
    payment_amount: ctxMoney(tx.payment.paymentAmount),
    payment_amount_raw: tx.payment.paymentAmountRaw,
    payment_date: tx.payment.paymentDate,
    era_source_file: ctx.sourceFile,
    row_fingerprint: '', // set below
  };
  row.row_fingerprint = era835PaymentFingerprint(row);
  return row;
}

/**
 * Map ONE customer's parsed transactions to {payment, adjustments} pairs.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO HOLD: every parsed transaction yields EXACTLY
 * ONE payment row, unconditionally, BEFORE and INDEPENDENT of CAS triplet mapping. A
 * remit whose claims all adjudicated clean has zero triplets; a remit whose only
 * triplets are filtered out (blank CARC / out-of-spec group code / out-of-range
 * amount) also ends with zero. In BOTH cases the payment row still lands, so its BPR02
 * is never lost. Triplet filtering is unchanged — those rows are still skipped and
 * counted — but skipping them no longer drops the remit.
 *
 * Adjustments are one row per CAS triplet (claim-level → service_line_number 0;
 * line-level → the line's number), with claim/line context and the low-cardinality
 * envelope filter fields denormalized. PHI stays plaintext in the row; both
 * fingerprints use non-PHI keys.
 */
export function mapTransactions(
  transactions: Era835Transaction[],
  ctx: { customer: CmdCustomer; sourceFile: string },
  skips: Era835SkipCounts,
): Era835MappedTransaction[] {
  const out: Era835MappedTransaction[] = [];
  for (const tx of transactions) {
    // Unconditional, and FIRST. Do not move this inside the claim loop or guard it on
    // rows.length — that is precisely the truncation defect.
    const payment = mapTransactionToPaymentRow(tx, ctx);
    const rows: Era835IngestRow[] = [];
    for (const claim of tx.claims) {
      const base = {
        business_entity_id: ctx.customer.businessEntityId,
        facility_code: ctx.customer.facilityCode,
        cmd_customer_id: ctx.customer.customerId,
        payer_name: tx.payment.payerName,
        payer_id: tx.payment.payerId,
        era_control_number: tx.payment.eraControlNumber,
        payment_method: tx.payment.paymentMethod,
        payment_date: tx.payment.paymentDate,
        patient_control_number: claim.patientControlNumber,
        payer_claim_control_number: claim.payerClaimControlNumber,
        claim_status_code: claim.claimStatusCode,
        claim_charge_amount: ctxMoney(claim.totalChargeAmount),
        claim_paid_amount: ctxMoney(claim.totalPaidAmount),
        patient_responsibility_amount: ctxMoney(claim.patientResponsibilityAmount),
        claim_filing_indicator: claim.claimFilingIndicator,
        patient_name: claim.patientName,
        member_id: claim.memberId,
        era_source_file: ctx.sourceFile,
      };
      const pushAdj = (
        level: 'CLAIM' | 'LINE',
        index: number,
        adj: { groupCode: string; reasonCode: string; amount: number; quantity: number | null },
        lineFields: {
          service_line_number: number;
          procedure_code: string | null;
          line_charge_amount: string | null;
          line_paid_amount: string | null;
          line_units: string | null;
          service_date: string | null;
          line_item_control_number: string | null;
        },
      ) => {
        const carc = adj.reasonCode.trim();
        if (carc === '') { skips.missing_carc_code += 1; return; }
        if (!ALLOWED_GROUP_CODES.has(adj.groupCode)) { skips.invalid_group_code += 1; return; }
        // adjustment_amount is the authoritative grain value (numeric(12,2) NOT NULL): an
        // out-of-range/NaN amount is a parse error, not a real adjustment — skip + count it
        // (do NOT let it 22003-abort the whole per-pull batch and drop every good row).
        if (!fitsNumeric12_2(adj.amount)) { skips.amount_out_of_range += 1; return; }
        const row: Era835IngestRow = {
          ...base,
          ...lineFields,
          adjustment_index: index,
          cas_level: level,
          group_code: adj.groupCode,
          carc_code: carc,
          carc_type: 'CARC', // CAS carries CARC; RARC (LQ) is counted, not stored here
          adjustment_amount: adj.amount.toFixed(2),
          adjustment_quantity: ctxMoney(adj.quantity),
          row_fingerprint: '', // set below
        };
        row.row_fingerprint = era835Fingerprint(row);
        rows.push(row);
      };

      const claimLineFields = {
        service_line_number: 0,
        procedure_code: null,
        line_charge_amount: null,
        line_paid_amount: null,
        line_units: null,
        service_date: null,
        line_item_control_number: null,
      };
      claim.claimLevelAdjustments.forEach((adj, i) => pushAdj('CLAIM', i, adj, claimLineFields));

      for (const sl of claim.serviceLines) {
        const lineFields = {
          service_line_number: sl.lineNumber,
          procedure_code: sl.procedureCode,
          line_charge_amount: ctxMoney(sl.chargeAmount),
          line_paid_amount: ctxMoney(sl.paidAmount),
          line_units: ctxMoney(sl.units),
          service_date: sl.serviceDate,
          line_item_control_number: sl.lineItemControlNumber,
        };
        sl.adjustments.forEach((adj, i) => pushAdj('LINE', i, adj, lineFields));
      }
    }
    out.push({ payment, adjustments: rows });
  }
  return out;
}

/**
 * Adjustment rows only, flattened across transactions — the original signature, kept
 * for callers/tests that care solely about the triplet grain. Anything that needs
 * remitted dollars must use mapTransactions() and the payment rows: a flat list of
 * adjustment rows cannot express a remit total, by design.
 */
export function mapTransactionsToRows(
  transactions: Era835Transaction[],
  ctx: { customer: CmdCustomer; sourceFile: string },
  skips: Era835SkipCounts,
): Era835IngestRow[] {
  return mapTransactions(transactions, ctx, skips).flatMap((t) => t.adjustments);
}

/** Assemble one payment row's positional params (PAYMENT_INSERT_COLS order). No PHI,
 *  so nothing to encrypt and no async work. */
function buildPaymentParams(row: Era835PaymentRow, ingestedBy: string): unknown[] {
  return [
    row.business_entity_id, row.facility_code, row.cmd_customer_id, row.payer_name, row.payer_id,
    row.era_control_number, row.check_eft_trace_number, row.trace_originating_company_id,
    row.payment_method, row.payment_amount, row.payment_amount_raw, row.payment_date,
    row.era_source_file, 'cmd_835_api', row.row_fingerprint, ingestedBy,
  ];
}

/** Encrypt the 2 PHI fields and assemble one row's positional params (INSERT_COLS order). */
async function buildInsertParams(
  row: Era835IngestRow,
  paymentId: number | string,
  ingestedBy: string,
): Promise<unknown[]> {
  const [patient, member] = await Promise.all([
    row.patient_name === null ? Promise.resolve(null) : encryptPhi(row.patient_name),
    row.member_id === null ? Promise.resolve(null) : encryptPhi(row.member_id),
  ]);
  return [
    paymentId,
    row.business_entity_id, row.facility_code, row.cmd_customer_id, row.payer_name, row.payer_id,
    row.era_control_number, row.payment_method, row.payment_date,
    row.patient_control_number, row.payer_claim_control_number, row.claim_status_code, row.claim_charge_amount,
    row.claim_paid_amount, row.patient_responsibility_amount, row.claim_filing_indicator,
    patient, member,
    row.service_line_number, row.procedure_code, row.line_charge_amount, row.line_paid_amount, row.line_units,
    row.service_date, row.line_item_control_number,
    row.adjustment_index, row.cas_level, row.group_code, row.carc_code, row.carc_type,
    row.adjustment_amount, row.adjustment_quantity,
    row.era_source_file, 'cmd_835_api', row.row_fingerprint, ingestedBy,
  ];
}

/** What one pull's insert actually wrote. */
export interface Era835InsertCounts {
  payments: number;
  adjustments: number;
}

/**
 * Insert one tenant's mapped transactions on a single checked-out client inside ONE
 * transaction, with app.business_entity_id SET LOCAL (required by the RLS WITH CHECK on
 * the cmd_rollup_writer policies). Rolls back everything on error.
 *
 * Per transaction: the PAYMENT row goes first (it is the FK target), then its adjustment
 * rows carry the resulting payment_id. Both tables use
 * ON CONFLICT (row_fingerprint) DO NOTHING, at their own grains.
 *
 * RESOLVING payment_id ON A RE-PULL: `DO NOTHING ... RETURNING id` returns NO ROW when
 * the payment already exists, so we fall back to a SELECT by fingerprint. That is why
 * cmd_rollup_writer holds a column-level SELECT on (id, row_fingerprint). The
 * alternative — `DO UPDATE SET ... RETURNING id` to force a return — would require
 * granting UPDATE and give up the strictly append-only posture; not worth it.
 *
 * One transaction spans both tables deliberately: era_835_adjustment.payment_id is NOT
 * NULL, so a partial commit could otherwise leave triplets with no envelope to point at.
 */
export async function insertEra835Transactions(
  db: Db,
  businessEntityId: string,
  mapped: Era835MappedTransaction[],
  ingestedBy: string,
): Promise<Era835InsertCounts> {
  const counts: Era835InsertCounts = { payments: 0, adjustments: 0 };
  if (mapped.length === 0) return counts;
  const client = await db.connect();
  try {
    await client.query('begin');
    // SET LOCAL for this transaction so the writer RLS policies see the tenant.
    await client.query(`select set_config('app.business_entity_id', $1, true)`, [businessEntityId]);

    for (const { payment, adjustments } of mapped) {
      // --- 1. the authoritative envelope row (always attempted) ---------------
      const payRes = await client.query(
        `insert into staging.era_835_payment (${PAYMENT_INSERT_COLS.join(', ')}) ` +
          `values (${PAYMENT_INSERT_COLS.map((_, i) => `$${i + 1}`).join(', ')}) ` +
          `on conflict (row_fingerprint) do nothing returning id`,
        buildPaymentParams(payment, ingestedBy),
      );
      let paymentId: number | string | undefined = payRes.rows[0]?.id;
      if (paymentId === undefined) {
        // Already present (idempotent re-pull) — read its id back to attach triplets.
        // ASSUMES A SINGLE WRITER: this insert-then-re-read seam is race-free only
        // because the 835 ingest is one cron running sequentially over disjoint customer
        // sets per tenant. If ingest is ever parallelised across workers sharing a
        // customer, revisit this (a concurrent inserter's uncommitted row is invisible
        // here, so both workers could take the insert path and one would 23505).
        const sel = await client.query<{ id: string }>(
          `select id from staging.era_835_payment where row_fingerprint = $1`,
          [payment.row_fingerprint],
        );
        paymentId = sel.rows[0]?.id;
        if (paymentId === undefined) {
          // Neither inserted nor findable: an RLS/grant misconfiguration, not a data
          // condition. Fail loudly rather than silently dropping this remit's triplets.
          throw new Error(
            'era-835 ingest: payment row neither inserted nor found by fingerprint ' +
              '(check cmd_rollup_writer SELECT grant on era_835_payment(id, row_fingerprint) ' +
              'and the writer SELECT policy)',
          );
        }
      } else {
        counts.payments += 1;
      }

      // --- 2. its CAS triplets (may legitimately be empty) --------------------
      for (let i = 0; i < adjustments.length; i += BATCH) {
        const batch = adjustments.slice(i, i + BATCH);
        const paramRows = await Promise.all(
          batch.map((r) => buildInsertParams(r, paymentId!, ingestedBy)),
        );
        const params: unknown[] = [];
        const tuples = paramRows.map((vals) => {
          const b = params.length;
          params.push(...vals);
          return `(${vals.map((_, j) => `$${b + j + 1}`).join(', ')})`;
        });
        const sql =
          `insert into staging.era_835_adjustment (${INSERT_COLS.join(', ')}) ` +
          `values ${tuples.join(', ')} on conflict (row_fingerprint) do nothing`;
        const res = await client.query(sql, params);
        counts.adjustments += res.rowCount ?? 0;
      }
    }

    await client.query('commit');
    return counts;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One pull's outcome, as the ingest loop needs to see it. `empty` (CMD's documented
 * no-ERAs response) and `files: []` (a real ZIP holding no ISA segments) are BOTH
 * zero-row outcomes but mean different things, so they cannot share a representation
 * — that collapse is exactly what hid the original silent failure.
 */
export type Era835DownloadResult =
  | { kind: 'empty' }
  | { kind: 'files'; files: Era835File[] };

export interface Era835IngestDeps {
  /** CMD customer accounts to pull (one report per customer per date). Each carries its
   *  own businessEntityId — the tenant is resolved PER CUSTOMER, never a global constant. */
  customers: ReadonlyArray<CmdCustomer>;
  /** ISO dates to ingest. */
  dates: string[];
  ingestedBy: string;
  /** Download + normalize the 835 file(s) for ONE customer + date. Injected. */
  download: (customerId: string, date: string) => Promise<Era835DownloadResult>;
  /** Least-privilege writer pool; omit for DRY-RUN (no DB connection). */
  writeDb?: Db;
  /** Monotonic clock for the wall-clock guard (tests). Default Date.now. */
  now?: () => number;
  /** Wall-clock budget before new (date,customer) pulls stop launching. */
  budgetMs?: number;
  /**
   * When a per-pull error matches, ABORT THE WHOLE RUN (rethrow) instead of counting it
   * and continuing. Intended for 401/403 credential/role failures: every remaining pull
   * would fail identically, and hammering CMD with a rejected credential helps nobody.
   * The partial stats line is logged (prefixed ABORTED) before the rethrow so the counts
   * survive. Default: absent — per-pull isolation, the pre-existing behavior.
   */
  fatal?: (err: unknown) => boolean;
}

/** Non-PHI run summary — safe to log and return to the (authed) caller. */
export interface Era835IngestStats {
  dates: number;
  customers: number;
  pulls_attempted: number;
  pulls_failed: number;
  /**
   * pulls_failed BROKEN OUT by CmdEra835Error.code ('http_status',
   * 'unrecognized_short_text', 'request_failed', …), with non-CmdEra835Error failures
   * under 'other'. Same taxonomy as the probe's failure buckets so cron logs and probe
   * reports read the same way. Exists because of finding 1 (2026-07-31): the root cause
   * of the observed 30%/42% failure episodes is UNKNOWN and the throttle theory is
   * FALSIFIED — an undifferentiated `failed` counter was exactly what made those
   * episodes undiagnosable. NO RETRIES by design until the real failure mode is known:
   * retry/backoff tuned to a wrong theory would just distort the signal.
   */
  pulls_failed_by_code: Record<string, number>;
  pulls_skipped_budget: number;
  /**
   * CMD returned its documented "no 835 ERA files were received on that date"
   * response. A NORMAL outcome, tracked separately so a quiet day is visibly distinct
   * from a failed one — the distinction the old transport could not express. If this
   * equals pulls_attempted across a whole run, suspect the credential's Payment role
   * or the date axis (ERA receipt date, not payment date) before concluding there was
   * genuinely no business.
   */
  pulls_empty: number;
  /**
   * CMD returned a REAL ZIP that parsed to zero 835 files — an archive with no ISA
   * segment in it. Distinct from pulls_empty on purpose: this should be ~never, so a
   * non-zero value is a SIGNAL (an archive of manifests/readmes, an encoding change, a
   * truncated download), not noise. It is deliberately not an error — see read835Files.
   */
  pulls_zero_files: number;
  files_parsed: number;
  claims: number;
  /** ST/SE transaction sets parsed — i.e. remits seen. One payment row each. */
  payments_mapped: number;
  /**
   * Remits whose BPR02 was absent or outside numeric(12,2) and therefore stored NULL.
   * The remit still LANDS (dropping it is the truncation defect this design removes),
   * but a non-zero count means real money is unquantified — investigate the source
   * file, never ignore it.
   */
  payments_amount_out_of_range: number;
  /**
   * Remits that mapped to ZERO surviving CAS triplets (all claims clean-paid, or every
   * triplet filtered). Tracked because under the OLD single-table shape these remits
   * vanished entirely — this counter is the visible proof they now land.
   */
  payments_without_adjustments: number;
  adjustments_mapped: number;
  rows_skipped: Era835SkipCounts;
  remark_codes_seen: number;
  in_set_duplicates: number;
  /** Same-pull duplicate REMITS collapsed by payment fingerprint (their triplets merge). */
  in_set_duplicate_payments: number;
  payments_inserted: number;
  rows_inserted: number;
}

/**
 * Core ingest — transport-agnostic. Loops date × customer, downloads + parses the
 * 835s, maps CAS triplets to rows, de-dups by fingerprint within each pull, and (when
 * writeDb is set) idempotently inserts per pull with per-pull isolation. Returns
 * non-PHI counts only. Per-pull failures are logged (label only) and skipped; a hard
 * DB failure still throws.
 */
export async function runEra835Ingest(deps: Era835IngestDeps): Promise<Era835IngestStats> {
  const now = deps.now ?? Date.now;
  const started = now();
  const stats: Era835IngestStats = {
    dates: deps.dates.length,
    customers: deps.customers.length,
    pulls_attempted: 0,
    pulls_failed: 0,
    pulls_failed_by_code: {},
    pulls_skipped_budget: 0,
    pulls_empty: 0,
    pulls_zero_files: 0,
    files_parsed: 0,
    claims: 0,
    payments_mapped: 0,
    payments_amount_out_of_range: 0,
    payments_without_adjustments: 0,
    adjustments_mapped: 0,
    rows_skipped: { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 },
    remark_codes_seen: 0,
    in_set_duplicates: 0,
    in_set_duplicate_payments: 0,
    payments_inserted: 0,
    rows_inserted: 0,
  };

  for (const date of deps.dates) {
    for (const customer of deps.customers) {
      if (deps.budgetMs !== undefined && now() - started > deps.budgetMs) {
        stats.pulls_skipped_budget += 1;
        continue;
      }
      stats.pulls_attempted += 1;
      try {
        const result = await deps.download(customer.customerId, date);
        // Two different zero-row outcomes, counted apart. 'empty' is CMD saying there
        // were no ERAs (normal). A real ZIP that yields no ISA files is a SIGNAL that
        // should be ~never — neither is a failure, and neither may be silently merged.
        const files = result.kind === 'empty' ? [] : result.files;
        if (result.kind === 'empty') stats.pulls_empty += 1;
        else if (files.length === 0) stats.pulls_zero_files += 1;
        // Dedup within the pull at BOTH grains: remits by payment fingerprint, and each
        // remit's triplets by triplet fingerprint. Keyed this way, the same remit
        // delivered twice in one zip collapses to one payment row and its triplets merge
        // under that one row rather than splitting across two.
        const byPayment = new Map<
          string,
          { payment: Era835PaymentRow; adjustments: Map<string, Era835IngestRow> }
        >();
        for (const file of files) {
          const parsed = parseEra835(file.edi);
          stats.files_parsed += 1;
          stats.claims += parsed.claimCount;
          stats.remark_codes_seen += parsed.remarkCount;
          const mapped = mapTransactions(
            parsed.transactions,
            { customer, sourceFile: file.name },
            stats.rows_skipped,
          );
          for (const { payment, adjustments } of mapped) {
            stats.payments_mapped += 1;
            if (payment.payment_amount === null) stats.payments_amount_out_of_range += 1;
            if (adjustments.length === 0) stats.payments_without_adjustments += 1;
            stats.adjustments_mapped += adjustments.length;

            let slot = byPayment.get(payment.row_fingerprint);
            if (slot === undefined) {
              slot = { payment, adjustments: new Map() };
              byPayment.set(payment.row_fingerprint, slot);
            } else {
              stats.in_set_duplicate_payments += 1;
            }
            for (const row of adjustments) {
              if (slot.adjustments.has(row.row_fingerprint)) stats.in_set_duplicates += 1;
              else slot.adjustments.set(row.row_fingerprint, row);
            }
          }
        }
        if (deps.writeDb) {
          // Per-customer tenant: each customer's rows are scoped to ITS businessEntityId
          // (RLS WITH CHECK sees the GUC set to this value inside
          // insertEra835Transactions).
          const written = await insertEra835Transactions(
            deps.writeDb,
            customer.businessEntityId,
            [...byPayment.values()].map(({ payment, adjustments }) => ({
              payment,
              adjustments: [...adjustments.values()],
            })),
            deps.ingestedBy,
          );
          stats.payments_inserted += written.payments;
          stats.rows_inserted += written.adjustments;
        }
      } catch (err) {
        // Fatal (e.g. 401/403 credential rejection): every remaining pull would fail the
        // same way. Log the partial counts so they survive, then abort the whole run.
        if (deps.fatal?.(err)) {
          console.error(
            `era-835 ingest ABORTED (fatal pull failure): pulls ${stats.pulls_attempted} ` +
              `(failed ${stats.pulls_failed}, empty ${stats.pulls_empty}); ` +
              `inserted ${stats.payments_inserted} payments + ${stats.rows_inserted} adjustments before abort`,
          );
          throw err;
        }
        stats.pulls_failed += 1;
        const code = err instanceof CmdEra835Error ? err.code : 'other';
        stats.pulls_failed_by_code[code] = (stats.pulls_failed_by_code[code] ?? 0) + 1;
        // Per-pull isolation: customer + date + message (non-PHI) only.
        console.error(
          `era-835 ingest: customer ${customer.customerId} (${customer.facilityCode}) date ${date} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  console.log(
    `era-835 ingest: dates ${stats.dates}, customers ${stats.customers}; ` +
      `pulls ${stats.pulls_attempted} (failed ${stats.pulls_failed}, empty ${stats.pulls_empty}, ` +
      `zero-file zips ${stats.pulls_zero_files}, budget-skipped ${stats.pulls_skipped_budget}); ` +
      `files ${stats.files_parsed}, claims ${stats.claims}, remits ${stats.payments_mapped} ` +
      `(no-adjustment ${stats.payments_without_adjustments}, unquantified BPR02 ${stats.payments_amount_out_of_range}), ` +
      `adjustments ${stats.adjustments_mapped}, remarks ${stats.remark_codes_seen}; ` +
      `in-set dups ${stats.in_set_duplicates} triplet / ${stats.in_set_duplicate_payments} remit; ` +
      `inserted ${stats.payments_inserted} payments + ${stats.rows_inserted} adjustments` +
      (stats.pulls_failed > 0 ? `; failed by code ${JSON.stringify(stats.pulls_failed_by_code)}` : ''),
  );
  return stats;
}

// --- CLI ---------------------------------------------------------------------

/** Inclusive ISO date range → list of ISO dates (UTC). Bounded to MAX_RANGE_DAYS. */
export function expandDateRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('--from/--to must be ISO YYYY-MM-DD');
  }
  if (end < start) throw new Error('--to must be on or after --from');
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > MAX_RANGE_DAYS) throw new Error(`date range exceeds ${MAX_RANGE_DAYS} days`);
  }
  return out;
}

interface CliArgs {
  dates: string[];
  commit: boolean;
  customerId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let commit = false;
  let customerId: string | undefined;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--commit') commit = true;
    else if (a === '--date') date = args[++i];
    else if (a.startsWith('--date=')) date = a.slice('--date='.length);
    else if (a === '--from') from = args[++i];
    else if (a.startsWith('--from=')) from = a.slice('--from='.length);
    else if (a === '--to') to = args[++i];
    else if (a.startsWith('--to=')) to = a.slice('--to='.length);
    else if (a === '--customer') customerId = args[++i];
    else if (a.startsWith('--customer=')) customerId = a.slice('--customer='.length);
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  let dates: string[];
  if (date) {
    if (!iso.test(date)) throw new Error('--date must be ISO YYYY-MM-DD');
    dates = [date];
  } else if (from && to) {
    dates = expandDateRange(from, to);
  } else {
    throw new Error('Provide --date <YYYY-MM-DD>, or --from <YYYY-MM-DD> --to <YYYY-MM-DD>');
  }
  return { dates, commit, customerId };
}

/** Minimal non-overriding .env loader (mirrors cmdExplorerSeed): an already-exported
 *  value always wins; path resolved via fileURLToPath+join (never a URL literal, which
 *  webpack would try to bundle). */
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    text = readFileSync(join(here, '..', '..', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

/** Build the live CMD 835 download config from env (composition-root pattern).
 *  Exported: app/lib/server.ts (the Vercel cron composition root) reuses it so the CLI
 *  and the cron share ONE env contract (CMD_API_TOKEN | CMD_API_USERNAME+PASSWORD,
 *  CMD_API_BASE_URL, CMD_ERA835_TIMEOUT_MS) instead of drifting apart. */
export function cmdEra835ConfigFor(customerId: string): CmdEra835Config {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdEra835Config['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else throw new Error('CMD API credentials not configured (CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)');
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId,
    auth,
    timeoutMs: Number(process.env.CMD_ERA835_TIMEOUT_MS) || 60_000,
  };
}

async function main(): Promise<void> {
  const { dates, commit, customerId } = parseArgs(process.argv);
  loadDotEnvIfPresent();

  // Tenant is resolved PER CUSTOMER from cmdCustomers.ts (customer.businessEntityId) —
  // NOT from a single CMD_BUSINESS_ENTITY_ID env, so a mixed BXR+Indigo run tags each
  // customer's rows to the correct tenant.
  const ingestedBy = process.env.INGEST_USER?.trim() || 'era_835_ingest';

  // Validate the PHI key up front (both modes) so a misconfigured key fails fast.
  await encryptPhi('era-835-key-probe');

  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();
  if (commit && !writerUrl) {
    throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit; never hardcode or log it)');
  }

  const customers = customerId
    ? ALL_CMD_CUSTOMERS.filter((c) => c.customerId === customerId)
    : ALL_CMD_CUSTOMERS;
  if (customers.length === 0) throw new Error(`--customer ${customerId} is not a known CMD customer account`);

  console.log(
    `835 ERA ingest — ${commit ? 'COMMIT' : 'DRY-RUN'} — dates ${dates[0]}..${dates.at(-1)} (${dates.length}), ` +
      `customers ${customers.length}`,
  );

  // Transport now distinguishes a genuinely quiet day from an undecodable body: 'empty'
  // is the documented no-ERAs response and maps to zero files, while anything
  // unrecognized throws a typed CmdEra835Error and is counted as a FAILED pull rather
  // than a silent zero. Do not collapse the two back together.
  const download = async (cid: string, date: string): Promise<Era835DownloadResult> => {
    const res = await cmdDownload835(cmdEra835ConfigFor(cid), { date });
    if (res.kind === 'empty') return { kind: 'empty' };
    return { kind: 'files', files: read835Files(res.bytes, `${cid}_${date}`) };
  };

  const writeDb = commit ? makeClient(writerUrl!) : undefined;
  try {
    const stats = await runEra835Ingest({
      customers,
      dates,
      ingestedBy,
      download,
      writeDb,
    });
    if (!commit) {
      console.log('DRY-RUN — no database connection made. Re-run with --commit to load.');
    } else {
      console.log(
        `COMMIT — inserted ${stats.payments_inserted} new payment rows ` +
          `+ ${stats.rows_inserted} new adjustment rows.`,
      );
    }
  } finally {
    if (writeDb) await writeDb.end();
  }
}

// Only run the CLI when invoked directly (never when imported by a test).
if (process.argv[1] && /era_ingest\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    // Message only — never EDI content or any cell value (PHI).
    console.error('835 ERA ingest failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
