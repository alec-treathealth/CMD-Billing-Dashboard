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
 * the two PHI identifiers in-process, computes a stable row_fingerprint, and
 * idempotently upserts into staging.era_835_adjustment (ON CONFLICT DO NOTHING).
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
import { cmdDownload835, read835Files, type CmdEra835Config, type Era835File } from '../collections/cmd835.js';
import { encryptPhi, fingerprintRow } from '../collections/phiCrypto.js';
import { makeClient, type Db } from '../collections/db.js';
import { parseEra835, type Era835Claim, type Era835Transaction } from './era835Parser.js';

const ALLOWED_GROUP_CODES = new Set(['CO', 'PR', 'OA', 'PI', 'CR']);
const BATCH = 500;
const MAX_RANGE_DAYS = 400; // guard against a runaway --from/--to

/**
 * One fully-mapped adjustment row (PHI held as PLAINTEXT here; encrypted only at the
 * insert boundary). Column set mirrors staging.era_835_adjustment (migration 013).
 */
export interface Era835IngestRow {
  business_entity_id: string;
  facility_code: string;
  cmd_customer_id: string;
  payer_name: string | null;
  payer_id: string | null;
  era_control_number: string | null;
  check_eft_trace_number: string | null;
  payment_method: string | null;
  // Money is a FIXED-2 DECIMAL STRING at the DB boundary (docs/CLAUDE.md §2, normalize.ts):
  // never a raw JS float (which node-postgres would toString() into float artifacts /
  // scientific notation for a numeric(12,2) column, and which could diverge from the
  // fingerprinted value). null when the source field is absent / out of numeric(12,2) range.
  payment_amount: string | null;
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

/** Positional INSERT columns — order MUST match buildInsertParams() exactly. */
const INSERT_COLS = [
  'business_entity_id', 'facility_code', 'cmd_customer_id', 'payer_name', 'payer_id',
  'era_control_number', 'check_eft_trace_number', 'payment_method', 'payment_amount', 'payment_date',
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

/** Skip counts (labels are field names only — never a cell value). */
export interface Era835SkipCounts {
  invalid_group_code: number;
  missing_carc_code: number;
  amount_out_of_range: number;
}

/**
 * Flatten ONE customer's parsed transactions into adjustment rows. Emits one row per
 * CAS triplet (claim-level → service_line_number 0; line-level → the line's number),
 * denormalizing payment/claim/line context. Skips (and counts) triplets with an
 * out-of-spec group code or blank CARC. PHI stays plaintext in the row; fingerprint
 * uses non-PHI keys.
 */
export function mapTransactionsToRows(
  transactions: Era835Transaction[],
  ctx: { customer: CmdCustomer; sourceFile: string },
  skips: Era835SkipCounts,
): Era835IngestRow[] {
  const rows: Era835IngestRow[] = [];
  for (const tx of transactions) {
    for (const claim of tx.claims) {
      const base = {
        business_entity_id: ctx.customer.businessEntityId,
        facility_code: ctx.customer.facilityCode,
        cmd_customer_id: ctx.customer.customerId,
        payer_name: tx.payment.payerName,
        payer_id: tx.payment.payerId,
        era_control_number: tx.payment.eraControlNumber,
        check_eft_trace_number: tx.payment.traceNumber,
        payment_method: tx.payment.paymentMethod,
        payment_amount: ctxMoney(tx.payment.paymentAmount),
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
  }
  return rows;
}

/** Encrypt the 2 PHI fields and assemble one row's positional params (INSERT_COLS order). */
async function buildInsertParams(row: Era835IngestRow, ingestedBy: string): Promise<unknown[]> {
  const [patient, member] = await Promise.all([
    row.patient_name === null ? Promise.resolve(null) : encryptPhi(row.patient_name),
    row.member_id === null ? Promise.resolve(null) : encryptPhi(row.member_id),
  ]);
  return [
    row.business_entity_id, row.facility_code, row.cmd_customer_id, row.payer_name, row.payer_id,
    row.era_control_number, row.check_eft_trace_number, row.payment_method, row.payment_amount, row.payment_date,
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

/**
 * Insert rows for ONE tenant on a single checked-out client inside a transaction,
 * with app.business_entity_id SET LOCAL (required by the RLS WITH CHECK on the
 * cmd_rollup_writer policy). Batched, parameterized, ON CONFLICT (row_fingerprint)
 * DO NOTHING. Returns the count actually inserted. Rolls back the whole batch on error.
 */
export async function insertEra835Rows(
  db: Db,
  businessEntityId: string,
  rows: Era835IngestRow[],
  ingestedBy: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const client = await db.connect();
  let inserted = 0;
  try {
    await client.query('begin');
    // SET LOCAL for this transaction so the writer RLS policy sees the tenant.
    await client.query(`select set_config('app.business_entity_id', $1, true)`, [businessEntityId]);
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const paramRows = await Promise.all(batch.map((r) => buildInsertParams(r, ingestedBy)));
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
      inserted += res.rowCount ?? 0;
    }
    await client.query('commit');
    return inserted;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface Era835IngestDeps {
  /** CMD customer accounts to pull (one report per customer per date). Each carries its
   *  own businessEntityId — the tenant is resolved PER CUSTOMER, never a global constant. */
  customers: ReadonlyArray<CmdCustomer>;
  /** ISO dates to ingest. */
  dates: string[];
  ingestedBy: string;
  /** Download + normalize the 835 file(s) for ONE customer + date. Injected. */
  download: (customerId: string, date: string) => Promise<Era835File[]>;
  /** Least-privilege writer pool; omit for DRY-RUN (no DB connection). */
  writeDb?: Db;
  /** Monotonic clock for the wall-clock guard (tests). Default Date.now. */
  now?: () => number;
  /** Wall-clock budget before new (date,customer) pulls stop launching. */
  budgetMs?: number;
}

/** Non-PHI run summary — safe to log and return to the (authed) caller. */
export interface Era835IngestStats {
  dates: number;
  customers: number;
  pulls_attempted: number;
  pulls_failed: number;
  pulls_skipped_budget: number;
  files_parsed: number;
  claims: number;
  adjustments_mapped: number;
  rows_skipped: Era835SkipCounts;
  remark_codes_seen: number;
  in_set_duplicates: number;
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
    pulls_skipped_budget: 0,
    files_parsed: 0,
    claims: 0,
    adjustments_mapped: 0,
    rows_skipped: { invalid_group_code: 0, missing_carc_code: 0, amount_out_of_range: 0 },
    remark_codes_seen: 0,
    in_set_duplicates: 0,
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
        const files = await deps.download(customer.customerId, date);
        const byFingerprint = new Map<string, Era835IngestRow>();
        for (const file of files) {
          const parsed = parseEra835(file.edi);
          stats.files_parsed += 1;
          stats.claims += parsed.claimCount;
          stats.remark_codes_seen += parsed.remarkCount;
          const rows = mapTransactionsToRows(
            parsed.transactions,
            { customer, sourceFile: file.name },
            stats.rows_skipped,
          );
          stats.adjustments_mapped += rows.length;
          for (const row of rows) {
            if (byFingerprint.has(row.row_fingerprint)) stats.in_set_duplicates += 1;
            else byFingerprint.set(row.row_fingerprint, row);
          }
        }
        if (deps.writeDb) {
          // Per-customer tenant: each customer's rows are scoped to ITS businessEntityId
          // (RLS WITH CHECK sees the GUC set to this value inside insertEra835Rows).
          stats.rows_inserted += await insertEra835Rows(
            deps.writeDb,
            customer.businessEntityId,
            [...byFingerprint.values()],
            deps.ingestedBy,
          );
        }
      } catch (err) {
        stats.pulls_failed += 1;
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
      `pulls ${stats.pulls_attempted} (failed ${stats.pulls_failed}, budget-skipped ${stats.pulls_skipped_budget}); ` +
      `files ${stats.files_parsed}, claims ${stats.claims}, adjustments ${stats.adjustments_mapped}, ` +
      `remarks ${stats.remark_codes_seen}; in-set dups ${stats.in_set_duplicates}; inserted ${stats.rows_inserted}`,
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

/** Build the live CMD 835 download config from env (composition-root pattern). */
function cmdEra835ConfigFor(customerId: string): CmdEra835Config {
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

  const download = async (cid: string, date: string): Promise<Era835File[]> => {
    const bytes = await cmdDownload835(cmdEra835ConfigFor(cid), { date });
    return read835Files(bytes, `${cid}_${date}`);
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
      console.log(`COMMIT — inserted ${stats.rows_inserted} new adjustment rows.`);
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
