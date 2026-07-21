/**
 * Billing Audit — report parsing + row mapping (CMD IP/OP batch audit reports →
 * claims.audit_row PlainAuditRow). Pure + env-free (composition-root pattern): no
 * network, no secrets, never logs a cell value; skip labels carry column names only.
 *
 * POSITIONAL PARSING (locked to the live probe, 2026-07-13, both under customer CAMH):
 * the OP report carries a DUPLICATE "Charge Status" header ([29] and [38], identical
 * values), which a Record<header,value> parse silently collapses — so BOTH scopes are
 * parsed positionally against a LOCKED header list. A file whose header does not match
 * its scope's list EXACTLY (order included) is rejected whole; we never guess columns
 * into PHI rows. IP = 46 columns (matches the session brief's locked reference); OP =
 * 39 columns (a different projection: member id at [30] "Current Payer Member ID", no
 * Charge Units, no diag descriptions, diags 1–5 only, + Provider Name/ID, Claim
 * Frequency, Charge Modifier 2).
 *
 * OPTION B FINGERPRINT (LOCKED — mirrors the 0049 migration header; Alec's ruling
 * 2026-07-13). sha-256 hex (fingerprintRow, \x1f-joined) over the STABLE-IDENTITY
 * fields in EXACTLY this order and normalization:
 *    1 audit_scope ('IP'|'OP' verbatim)
 *    2 cmd_claim_id (trimmed)          3 cmd_patient_id (trimmed)
 *    4 charge_from_date (ISO)          5 charge_to_date (ISO or '')
 *    6 stmt_from_date (ISO or '')      7 stmt_to_date (ISO or '')
 *    8 admission_date (ISO or '')      9 cpt_code (trim/lower or '')
 *   10 rev_code (trim/lower or '')    11 modifier_1 (trim/lower or '')
 *   12 modifier_2 (trim/lower or '')  13 units (canonical decimal string or '')
 *   14 type_of_bill (trim/lower or '') 15 charge_amount_cents (base-10 integer string)
 * PHI-free by construction (cmd ids pin identity). Volatile fields (status, notes,
 * payer, auth, diagnoses, provider/office labels) are NEVER hashed — they flow through
 * the ingest's ON CONFLICT DO UPDATE instead, so a status flip can never re-insert a
 * row or re-open a resolved flag. Changing this order or normalization silently breaks
 * idempotency — do not touch without a deliberate re-seed ruling.
 *
 * PAYER + MEMBER-ID EXCLUSION — EVIDENCE (D1 probe, CAMH IP+OP snapshot, 2026-07-13):
 * payer_name and member_id are OUT of the fingerprint and IN the volatile UPDATE set.
 *  - Control: on all 310 plain 'CLAIM AT <X>' rows the payer column == X.
 *  - On all 21 'CLAIM AT <X> - SECONDARY' rows the payer column holds a DIFFERENT
 *    payer than the status payer (column = the claim's primary; status = the secondary
 *    currently worked) — so the column is primary-stable across the claim's journey,
 *    but a single snapshot CANNOT prove the primary never changes on a charge line
 *    (rebill/crossover corrections). Conservative default per Alec's D1 ruling:
 *    payer stays OUT of the identity hash PENDING LONGITUDINAL EVIDENCE; identity is
 *    carried by the cmd ids, dates, codes/modifiers/units, TOB, and amount.
 *  - Member id is provably CURRENT-PAYER-RELATIVE: joining the same 1,592 charge
 *    lines across the IP and OP projections, OP 'Current Payer Member ID' differs
 *    from IP 'Claim Primary Member ID' on 1,282 of them — a value that volatile can
 *    never be identity.
 *  - Within each single-scope snapshot: 1,592 rows → 1,592 distinct fingerprints,
 *    zero multi-row identity groups, zero skips (both scopes) — no in-pull collisions.
 */
import { normalizeDate, normalizeMoney, type Coerced } from '../collections/normalize.js';
import { fingerprintRow } from '../collections/phiCrypto.js';
import type { AuditScope } from './auditConfig.js';
// Status taxonomy now lives in ONE shared module (src/collections/claimStatus.ts) so the
// collections CMD ingest and this audit plane share it. Imported for internal use (below) and
// RE-EXPORTED so this module's public surface — and test/billingAudit.test.ts — stay unchanged.
import { normalizeStatus, type StatusCategory, type NormalizedStatus } from '../collections/claimStatus.js';
export { normalizeStatus };
export type { StatusCategory, NormalizedStatus };

// --- locked headers (live-verified 2026-07-13) -------------------------------------

export const IP_HEADERS = [
  'Patient Full Name', 'Patient Birthday', 'Claim Billing Provider ID',
  'Claim Primary Member ID', 'Facility Address 1', 'Type of Bill',
  'Statement Covers From Date', 'Statement Covers To Date', 'Charge From Date',
  'Charge To Date', 'Charge CPT Code', 'Charge Rev Code', 'Charge Units',
  'Charge Modifier 1', 'Admission Date', 'Claim Primary Payer Name', 'Primary Auth #',
  'Claim Principal Diag', 'Claim Principal Diag POA', 'Claim Principal Diag Description',
  'Claim Admit Code',
  'Claim Diag 2', 'Claim Diag 2 POA', 'Claim Diag 2 Description',
  'Claim Diag 3', 'Claim Diag 3 POA', 'Claim Diag 3 Description',
  'Claim Diag 4', 'Claim Diag 4 POA', 'Claim Diag 4 Description',
  'Claim Diag 5', 'Claim Diag 5 POA', 'Claim Diag 5 Description',
  'Claim Diag 6', 'Claim Diag 6 POA', 'Claim Diag 6 Description',
  'Claim PPS', 'Charge Status', 'Last Public FU Note', 'Charge Claim ID',
  'Charge Patient ID', 'Claim Type', 'Charge Amount', 'Provider Full Name',
  'Office Name', 'Claim Admit Code Description',
] as const;

export const OP_HEADERS = [
  'Patient Full Name', 'Patient Birthday', 'Provider Name/ID', 'Facility Address 1',
  'Type of Bill', 'Claim Frequency', 'Statement Covers From Date',
  'Statement Covers To Date', 'Charge From Date', 'Charge To Date', 'Charge CPT Code',
  'Charge Rev Code', 'Charge Modifier 1', 'Charge Modifier 2', 'Admission Date',
  'Claim Primary Payer Name', 'Primary Auth #', 'Claim Principal Diag',
  'Claim Principal Diag POA', 'Claim Admit Code',
  'Claim Diag 2', 'Claim Diag 2 POA', 'Claim Diag 3', 'Claim Diag 3 POA',
  'Claim Diag 4', 'Claim Diag 4 POA', 'Claim Diag 5', 'Claim Diag 5 POA',
  'Claim PPS', 'Charge Status', 'Current Payer Member ID', 'Last Public FU Note',
  'Charge Claim ID', 'Charge Patient ID', 'Claim Type', 'Charge Amount',
  'Provider Full Name', 'Office Name', 'Charge Status',
] as const;

export function expectedHeaders(scope: AuditScope): readonly string[] {
  return scope === 'IP' ? IP_HEADERS : OP_HEADERS;
}

/** Exact positional header comparison → first mismatch (safe to log: labels only). */
export function headerMismatch(scope: AuditScope, actual: readonly string[]): string | null {
  const expected = expectedHeaders(scope);
  if (actual.length !== expected.length) {
    return `column count ${actual.length} != expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const got = (actual[i] ?? '').trim();
    if (got !== expected[i]) return `column ${i}: "${got}" != "${expected[i]}"`;
  }
  return null;
}

// --- positional CSV (RFC-4180-style quoting; duplicate headers preserved) ----------

export function parsePositionalCsv(text: string): { header: string[]; rows: string[][] } {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.length > 1 || cur[0] !== '') out.push(cur);
      cur = [];
    } else field += c;
  }
  if (field !== '' || cur.length > 0) { cur.push(field); out.push(cur); }
  const [header, ...rows] = out;
  return { header: header ?? [], rows };
}

// --- status normalization ------------------------------------------------------------
// The 24→7 taxonomy (StatusCategory / NormalizedStatus / normalizeStatus) moved VERBATIM to
// src/collections/claimStatus.ts and is imported + re-exported at the top of this file. Behavior
// unchanged; the call site below (mapAuditRow) uses the imported normalizeStatus.

// --- field coercion ------------------------------------------------------------------

/** M/D/YYYY or ISO → ISO 'YYYY-MM-DD'; blank → null; malformed → error. */
export function toIsoDate(raw: string): Coerced<string | null> {
  const t = raw.trim();
  if (t === '') return { ok: true, value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const probe = new Date(`${t}T00:00:00Z`);
    if (!Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === t) {
      return { ok: true, value: t };
    }
    return { ok: false, reason: 'invalid ISO date' };
  }
  return normalizeDate(t);
}

/** Money → integer CENTS (bigint column). Reuses normalizeMoney ('$'/','/'-' handling,
 *  fixed-2 output) then shifts the decimal exactly — never float math. Blank → null. */
export function toCents(raw: string): Coerced<number | null> {
  const money = normalizeMoney(raw, 'phi');
  if (!money.ok) return money;
  if (money.value === null) return { ok: true, value: null };
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(money.value);
  if (!m) return { ok: false, reason: 'unexpected money shape' };
  const cents = Number(`${m[1]}${m[2]}${m[3]}`);
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'amount out of range' };
  return { ok: true, value: cents };
}

/** Units → canonical decimal string (pg numeric). Blank → null; non-numeric → error. */
export function toUnits(raw: string): Coerced<string | null> {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return { ok: true, value: null };
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { ok: false, reason: 'invalid units' };
  return { ok: true, value: t };
}

/** One collapsed diagnosis: code + POA + (IP only) description + 1-based position. */
export interface DiagEntry {
  code: string;
  poa: string | null;
  desc: string | null;
  pos: number;
}

// --- the mapped row ------------------------------------------------------------------

/** Plaintext-PHI row ready for fingerprint + (at insert) encryption; mirrors
 *  claims.audit_row. Exported so the ingest + tests share the exact shape. */
export interface PlainAuditRow {
  audit_scope: AuditScope;
  cmd_claim_id: string;
  cmd_patient_id: string;
  claim_type: string | null;
  claim_frequency: string | null;
  office_name: string | null;
  provider_name: string | null;
  billing_provider_id: string | null;
  patient_name: string; //        PHI plaintext (required)
  patient_dob: string | null; //  PHI plaintext (verbatim; encrypted as-is)
  member_id: string | null; //    PHI plaintext
  charge_from_date: string;
  charge_to_date: string | null;
  stmt_from_date: string | null;
  stmt_to_date: string | null;
  admission_date: string | null;
  cpt_code: string | null;
  rev_code: string | null;
  modifier_1: string | null;
  modifier_2: string | null;
  units: string | null;
  type_of_bill: string | null;
  charge_amount_cents: number;
  payer_name: string | null;
  auth_number: string | null;
  charge_status_raw: string | null;
  status_category: StatusCategory;
  status_payer: string | null;
  principal_diag: string | null;
  diagnoses: DiagEntry[];
  last_fu_note: string | null;
  row_fingerprint: string;
}

export type AuditMapResult = { ok: true; row: PlainAuditRow } | { ok: false; label: string };

const opt = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};
const low = (v: string | null): string => (v ?? '').toLowerCase();

/** Positional cell reader bound to one scope's locked header list. */
function cell(row: string[], scope: AuditScope, name: string, dupIndex = 0): string {
  const headers = expectedHeaders(scope);
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === name) {
      if (seen === dupIndex) return row[i] ?? '';
      seen++;
    }
  }
  return '';
}

/** Collapse the scope's diag columns (IP 1–6 with descriptions, OP 1–5 without) into
 *  the ordered DiagEntry list. Blank codes are skipped; POA/desc ride along verbatim. */
export function collapseDiagnoses(row: string[], scope: AuditScope): DiagEntry[] {
  const out: DiagEntry[] = [];
  const maxDiag = scope === 'IP' ? 6 : 5;
  for (let pos = 1; pos <= maxDiag; pos++) {
    const base = pos === 1 ? 'Claim Principal Diag' : `Claim Diag ${pos}`;
    const code = opt(cell(row, scope, base));
    if (code === null) continue;
    out.push({
      code,
      poa: opt(cell(row, scope, `${base} POA`)),
      desc: scope === 'IP' ? opt(cell(row, scope, `${base} Description`)) : null,
      pos,
    });
  }
  return out;
}

/**
 * Map one positional data row to a PlainAuditRow, or a skip label (column names only —
 * NEVER a cell value). Required: Charge Claim ID, Charge Patient ID, Patient Full Name,
 * Charge From Date, Charge Amount. Non-blank-but-malformed money/dates/units → skip
 * (never silently null real data). member id is NULLABLE here (unlike collections).
 */
export function mapAuditRow(scope: AuditScope, row: string[]): AuditMapResult {
  const claimId = opt(cell(row, scope, 'Charge Claim ID'));
  if (claimId === null) return { ok: false, label: 'cmd_claim_id: missing' };
  const patientId = opt(cell(row, scope, 'Charge Patient ID'));
  if (patientId === null) return { ok: false, label: 'cmd_patient_id: missing' };
  const patientName = opt(cell(row, scope, 'Patient Full Name'));
  if (patientName === null) return { ok: false, label: 'patient_name: missing' };

  const chargeFrom = toIsoDate(cell(row, scope, 'Charge From Date'));
  if (!chargeFrom.ok) return { ok: false, label: 'charge_from_date: invalid' };
  if (chargeFrom.value === null) return { ok: false, label: 'charge_from_date: missing' };
  const chargeTo = toIsoDate(cell(row, scope, 'Charge To Date'));
  if (!chargeTo.ok) return { ok: false, label: 'charge_to_date: invalid' };
  const stmtFrom = toIsoDate(cell(row, scope, 'Statement Covers From Date'));
  if (!stmtFrom.ok) return { ok: false, label: 'stmt_from_date: invalid' };
  const stmtTo = toIsoDate(cell(row, scope, 'Statement Covers To Date'));
  if (!stmtTo.ok) return { ok: false, label: 'stmt_to_date: invalid' };
  const admission = toIsoDate(cell(row, scope, 'Admission Date'));
  if (!admission.ok) return { ok: false, label: 'admission_date: invalid' };

  const cents = toCents(cell(row, scope, 'Charge Amount'));
  if (!cents.ok) return { ok: false, label: 'charge_amount: invalid' };
  if (cents.value === null) return { ok: false, label: 'charge_amount: missing' };

  const units = scope === 'IP' ? toUnits(cell(row, scope, 'Charge Units')) : { ok: true as const, value: null };
  if (!units.ok) return { ok: false, label: 'units: invalid' };

  const cpt = opt(cell(row, scope, 'Charge CPT Code'));
  const rev = opt(cell(row, scope, 'Charge Rev Code'));
  const mod1 = opt(cell(row, scope, 'Charge Modifier 1'));
  const mod2 = scope === 'OP' ? opt(cell(row, scope, 'Charge Modifier 2')) : null;
  const tob = opt(cell(row, scope, 'Type of Bill'));

  const statusRaw = opt(cell(row, scope, 'Charge Status')); // OP dup: [29] wins; [38] is identical (probe-verified)
  const status = normalizeStatus(statusRaw);

  const memberId = scope === 'IP'
    ? opt(cell(row, scope, 'Claim Primary Member ID'))
    : opt(cell(row, scope, 'Current Payer Member ID'));

  const diagnoses = collapseDiagnoses(row, scope);

  // LOCKED Option-B stable-identity fingerprint — order + normalization per the module
  // header and the 0049 migration. Volatile fields are deliberately absent.
  const fingerprint = fingerprintRow([
    scope,
    claimId,
    patientId,
    chargeFrom.value,
    chargeTo.value ?? '',
    stmtFrom.value ?? '',
    stmtTo.value ?? '',
    admission.value ?? '',
    low(cpt),
    low(rev),
    low(mod1),
    low(mod2),
    units.value ?? '',
    low(tob),
    String(cents.value),
  ]);

  return {
    ok: true,
    row: {
      audit_scope: scope,
      cmd_claim_id: claimId,
      cmd_patient_id: patientId,
      claim_type: opt(cell(row, scope, 'Claim Type')),
      claim_frequency: scope === 'OP' ? opt(cell(row, scope, 'Claim Frequency')) : null,
      office_name: opt(cell(row, scope, 'Office Name')),
      provider_name: opt(cell(row, scope, 'Provider Full Name')),
      billing_provider_id: scope === 'IP'
        ? opt(cell(row, scope, 'Claim Billing Provider ID'))
        : opt(cell(row, scope, 'Provider Name/ID')),
      patient_name: patientName,
      patient_dob: opt(cell(row, scope, 'Patient Birthday')),
      member_id: memberId,
      charge_from_date: chargeFrom.value,
      charge_to_date: chargeTo.value,
      stmt_from_date: stmtFrom.value,
      stmt_to_date: stmtTo.value,
      admission_date: admission.value,
      cpt_code: cpt,
      rev_code: rev,
      modifier_1: mod1,
      modifier_2: mod2,
      units: units.value,
      type_of_bill: tob,
      charge_amount_cents: cents.value,
      payer_name: opt(cell(row, scope, 'Claim Primary Payer Name')),
      auth_number: opt(cell(row, scope, 'Primary Auth #')),
      charge_status_raw: statusRaw,
      status_category: status.category,
      status_payer: status.statusPayer,
      principal_diag: opt(cell(row, scope, 'Claim Principal Diag')),
      diagnoses,
      last_fu_note: opt(cell(row, scope, 'Last Public FU Note')),
      row_fingerprint: fingerprint,
    },
  };
}
