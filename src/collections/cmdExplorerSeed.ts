/**
 * CMD Collections Explorer SEED — local Derek-14-column CSVs → collections.cmd_explorer_rows.
 *
 *   tsx src/collections/cmdExplorerSeed.ts                 # DRY-RUN (parse + map, NO DB)
 *   tsx src/collections/cmdExplorerSeed.ts --commit        # load (cmd_rollup_writer)
 *   tsx src/collections/cmdExplorerSeed.ts --dir=/path     # override CMD_EXPLORER_SEED_DIR
 *
 * WHY: one-shot historical backfill for the DB-backed Collections Explorer
 * (migration 0019). It reads every Derek-14-column CSV in CMD_EXPLORER_SEED_DIR,
 * maps + fingerprints + encrypts each charge line, and idempotently upserts. The
 * daily cron (cmdExplorerCron.ts, next gate) keeps it current from the live API.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the CSV is per-charge-line PHI. The three
 * identifiers (patient name / member id / group number) are encrypted IN-PROCESS via
 * src/collections/phiCrypto.ts (libsodium, nonce‖ciphertext) BEFORE insert — no
 * plaintext PHI ever touches the DB. The dedup key row_fingerprint is a SHA-256 over
 * the NORMALIZED PLAINTEXT 14 fields, computed before encryption (so it is stable
 * across re-pulls even though the ciphertext is not). Logs carry COUNTS, filenames,
 * and column-label header diffs ONLY — never a cell value, never a normalizer "reason"
 * (those embed the raw value). The source dir is gitignored and never echoed verbatim.
 *
 * Idempotency: ON CONFLICT (row_fingerprint) DO NOTHING. Re-running, or overlapping a
 * later cron pull, inserts only genuinely new content snapshots. Rows are also
 * de-duplicated by fingerprint IN-PROCESS across all files (first occurrence wins).
 *
 * SECURITY: writes as the least-privilege cmd_rollup_writer role
 * (CMD_ROLLUP_WRITER_DATABASE_URL) over verify-full TLS — NOT claims_admin, NOT the
 * service role, NEVER rejectUnauthorized:false (docs/CLAUDE.md §2). DRY-RUN opens no
 * DB connection at all. Secrets come from env only and are never logged.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mapReportRows } from './cmdExplorer.js';
import type { CmdExplorerFullRow } from './cmdExplorer.js';
import { parseReportCsv } from './cmdPayer.js';
import { normalizeDate, normalizeMoney, type Coerced } from './normalize.js';
import { normalizeMemberId } from '../queries/identity.js';
import { encryptPhi, fingerprintRow } from './phiCrypto.js';
import { makeClient } from './db.js';

/**
 * The exact 14 headers of Derek's CMD batch export. A file whose header set does not
 * match these EXACTLY (no missing, no extra) is skipped — we never partially map a
 * report of an unknown shape into PHI rows.
 */
export const EXPECTED_HEADERS = [
  'Charge From Date',
  'Payment Received',
  'Charge CPT Code',
  'Revenue Code',
  'Patient Full Name',
  'Claim Primary Member ID',
  'Primary Group Number',
  'Charge/Debit Amount',
  'Payment Allowed Amount',
  'Charge Insurance Payments',
  'Charge Total Adjustments w/o Transfers',
  'Charge Balance Due Pat',
  'Charge Primary Payer Name',
  'Facility Name',
] as const;

/**
 * row_fingerprint field ORDER — LOCKED. The dedup key is SHA-256 over these 14
 * normalized plaintext values in EXACTLY this order, which mirrors the real CMD
 * report's 14-column order (Facility Name is the LAST/14th column). Changing the order
 * or the normalization silently breaks idempotency (re-pulls would no longer dedup), so
 * do not reorder without a deliberate re-seed. Normalization: dates → ISO; money →
 * fixed-2-decimal string; member_id → normalizeMemberId (identity.ts: upper, strip
 * leading '-'); every other string → trimmed + lower-cased; null/blank → ''.
 *   1 charge_from_date  2 payment_received  3 cpt_code  4 revenue_code
 *   5 patient_name(PHI) 6 member_id(PHI)    7 group_number(PHI)
 *   8 charge_amount     9 allowed_amount   10 insurance_payments  11 adjustments
 *  12 patient_balance_due  13 primary_payer  14 facility
 */

/** Columns for the INSERT — order matches buildInsertParams() exactly. */
const INSERT_COLS = [
  'charge_date', 'payment_received', 'cpt_code', 'revenue_code', 'facility',
  'patient_name', 'member_id', 'group_number', 'charge_amount', 'allowed_amount',
  'insurance_payments', 'adjustments', 'patient_balance_due', 'primary_payer',
  'source_file', 'row_fingerprint',
] as const;

const BATCH = 500;

/** A fully-validated, typed row ready for fingerprinting + (at insert) encryption.
 *  PHI fields hold PLAINTEXT here; they are encrypted only at the insert boundary.
 *  Exported so the cron (cmdExplorerCron.ts) reuses the exact same row shape. */
export interface PlainRow {
  charge_date: string; //               ISO date (required)
  payment_received: string | null; //   ISO date
  cpt_code: string; //                  required
  revenue_code: string | null;
  facility: string; //                  required
  patient_name: string; //              PHI plaintext (required)
  member_id: string; //                 PHI plaintext (required)
  group_number: string | null; //       PHI plaintext
  charge_amount: string; //             numeric decimal string (required)
  allowed_amount: string | null;
  insurance_payments: string | null;
  adjustments: string | null;
  patient_balance_due: string | null;
  primary_payer: string | null;
  source_file: string;
  row_fingerprint: string;
}

type MapResult = { ok: true; row: PlainRow } | { ok: false; label: string };

/** Accept M/D/YYYY (via the claims date parser) OR ISO YYYY-MM-DD → ISO string.
 *  CMD reports emit both formats (see cmdPayer.parseServiceYearMonth). Blank → null. */
function toIsoDate(raw: string): Coerced<string | null> {
  const t = raw.trim();
  if (t === '') return { ok: true, value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const probe = new Date(`${t}T00:00:00Z`);
    if (!Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === t) {
      return { ok: true, value: t };
    }
    return { ok: false, reason: 'invalid ISO date' };
  }
  return normalizeDate(t); // M/D/YYYY with calendar validation
}

/**
 * Map one parsed report row to a typed PlainRow + fingerprint, or a skip label.
 * Required fields (charge_date, cpt_code, facility, patient_name, member_id,
 * charge_amount) that are blank → skip (the column is NOT NULL). Any non-blank but
 * unparseable money/date → skip (never silently null real-but-malformed data, per the
 * claims-ingest philosophy). Blank optionals → null. Labels carry NO cell values.
 */
export function mapRow(full: CmdExplorerFullRow, sourceFile: string): MapResult {
  const chargeDate = toIsoDate(full.charge_from_date ?? '');
  if (!chargeDate.ok) return { ok: false, label: 'charge_date: invalid' };
  if (chargeDate.value === null) return { ok: false, label: 'charge_date: missing' };

  const paymentReceived = toIsoDate(full.payment_received ?? '');
  if (!paymentReceived.ok) return { ok: false, label: 'payment_received: invalid' };

  // Required text/PHI: blank cell arrives as null from mapReportRows; guard '' too.
  const cpt = full.cpt_code;
  if (cpt === null || cpt.trim() === '') return { ok: false, label: 'cpt_code: missing' };
  const facility = full.facility;
  if (facility === null || facility.trim() === '') return { ok: false, label: 'facility: missing' };

  const charge = normalizeMoney(full.charge_amount ?? '', 'phi');
  if (!charge.ok) return { ok: false, label: 'charge_amount: invalid' };
  if (charge.value === null) return { ok: false, label: 'charge_amount: missing' };

  const allowed = normalizeMoney(full.allowed_amount ?? '', 'phi');
  if (!allowed.ok) return { ok: false, label: 'allowed_amount: invalid' };
  const insurance = normalizeMoney(full.insurance_payments ?? '', 'phi');
  if (!insurance.ok) return { ok: false, label: 'insurance_payments: invalid' };
  const adjustments = normalizeMoney(full.adjustments ?? '', 'phi');
  if (!adjustments.ok) return { ok: false, label: 'adjustments: invalid' };
  const balance = normalizeMoney(full.patient_balance_due ?? '', 'phi');
  if (!balance.ok) return { ok: false, label: 'patient_balance_due: invalid' };

  const patientName = full.phi.patient_name;
  if (patientName === null || patientName.trim() === '') return { ok: false, label: 'patient_name: missing' };
  const memberId = full.phi.member_id_raw;
  if (memberId === null || memberId.trim() === '') return { ok: false, label: 'member_id: missing' };
  const groupNumber = full.phi.group_number; // null when blank (already trimmed)

  const revenue = full.revenue_code;
  const payer = full.primary_payer;

  // LOCKED fingerprint field order — see the comment block above. Mirrors the real
  // CMD report's 14-column order exactly (Facility Name is the last/14th column).
  const fingerprint = fingerprintRow([
    chargeDate.value, //                          1  Charge From Date
    paymentReceived.value ?? '', //               2  Payment Received
    cpt.toLowerCase(), //                          3  Charge CPT Code
    (revenue ?? '').toLowerCase(), //              4  Revenue Code
    patientName.toLowerCase(), //                  5  Patient Full Name (PHI plaintext)
    normalizeMemberId(memberId), //                6  Claim Primary Member ID (PHI, identity.ts norm)
    (groupNumber ?? '').toLowerCase(), //          7  Primary Group Number (PHI plaintext)
    charge.value, //                               8  Charge/Debit Amount
    allowed.value ?? '', //                        9  Payment Allowed Amount
    insurance.value ?? '', //                     10  Charge Insurance Payments
    adjustments.value ?? '', //                   11  Charge Total Adjustments w/o Transfers
    balance.value ?? '', //                       12  Charge Balance Due Pat
    (payer ?? '').toLowerCase(), //               13  Charge Primary Payer Name
    facility.toLowerCase(), //                    14  Facility Name
  ]);

  return {
    ok: true,
    row: {
      charge_date: chargeDate.value,
      payment_received: paymentReceived.value,
      cpt_code: cpt,
      revenue_code: revenue,
      facility,
      patient_name: patientName,
      member_id: memberId,
      group_number: groupNumber,
      charge_amount: charge.value,
      allowed_amount: allowed.value,
      insurance_payments: insurance.value,
      adjustments: adjustments.value,
      patient_balance_due: balance.value,
      primary_payer: payer,
      source_file: sourceFile,
      row_fingerprint: fingerprint,
    },
  };
}

/** Read just the first line of a file (≤64KB) to validate the header WITHOUT parsing
 *  a possibly-huge non-matching file (e.g. a stray multi-MB dump in the seed dir). */
function peekHeaderLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytes);
    const nl = text.search(/\r?\n/);
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/** Split a simple (unquoted) CSV header line into trimmed column names. The verified
 *  CMD report headers contain no commas/quotes, so a plain split is exact here. */
function headerColumns(line: string): string[] {
  return line.split(',').map((h) => h.trim().replace(/^"(.*)"$/, '$1'));
}

/** Set equality check → the missing/extra column names (safe to log; not PHI). */
export function headerDiff(actual: string[]): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const expected = new Set<string>(EXPECTED_HEADERS);
  return {
    missing: [...expected].filter((h) => !a.has(h)),
    extra: [...a].filter((h) => !expected.has(h)),
  };
}

interface FileOutcome {
  rows: PlainRow[];
  dataRows: number;
  skipsByLabel: Map<string, number>;
}

/** Validate + parse + map one CSV file. Throws only on unreadable file (caller skips). */
function processFile(path: string): { ok: true; outcome: FileOutcome } | { ok: false; reason: string } {
  const header = headerColumns(peekHeaderLine(path));
  const diff = headerDiff(header);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    const parts: string[] = [];
    if (diff.missing.length) parts.push(`missing [${diff.missing.join(', ')}]`);
    if (diff.extra.length) parts.push(`extra [${diff.extra.join(', ')}]`);
    return { ok: false, reason: `header mismatch — ${parts.join('; ')}` };
  }

  const parsed = parseReportCsv(readFileSync(path, 'utf8'));
  if (parsed.length === 0) return { ok: false, reason: 'no data rows' };

  const source = basename(path);
  const rows: PlainRow[] = [];
  const skipsByLabel = new Map<string, number>();
  for (const full of mapReportRows(parsed)) {
    const result = mapRow(full, source);
    if (result.ok) rows.push(result.row);
    else skipsByLabel.set(result.label, (skipsByLabel.get(result.label) ?? 0) + 1);
  }
  return { ok: true, outcome: { rows, dataRows: parsed.length, skipsByLabel } };
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Encrypt the 3 PHI fields and assemble one row's positional params (INSERT_COLS order). */
async function buildInsertParams(row: PlainRow): Promise<unknown[]> {
  const [patient, member, group] = await Promise.all([
    encryptPhi(row.patient_name),
    encryptPhi(row.member_id),
    row.group_number === null ? Promise.resolve(null) : encryptPhi(row.group_number),
  ]);
  return [
    row.charge_date, row.payment_received, row.cpt_code, row.revenue_code, row.facility,
    patient, member, group, row.charge_amount, row.allowed_amount,
    row.insurance_payments, row.adjustments, row.patient_balance_due, row.primary_payer,
    row.source_file, row.row_fingerprint,
  ];
}

/** Batched, parameterized, idempotent upsert. Returns the count actually inserted
 *  (ON CONFLICT DO NOTHING skips fingerprints already in the table). Exported so the
 *  cron reuses the identical encrypt + batch-upsert path (same INSERT_COLS, same SQL). */
export async function insertRows(db: ReturnType<typeof makeClient>, rows: PlainRow[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(rows, BATCH)) {
    const paramRows = await Promise.all(batch.map(buildInsertParams));
    const params: unknown[] = [];
    const tuples = paramRows.map((vals) => {
      const base = params.length;
      params.push(...vals);
      return `(${vals.map((_, i) => `$${base + i + 1}`).join(', ')})`;
    });
    const sql =
      `insert into collections.cmd_explorer_rows (${INSERT_COLS.join(', ')}) ` +
      `values ${tuples.join(', ')} on conflict (row_fingerprint) do nothing`;
    const res = await db.query(sql, params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// --- env + CLI --------------------------------------------------------------

/** Minimal non-overriding .env loader (the project convention is to export env, but
 *  this makes the one-shot CLI self-contained). An already-exported value always wins;
 *  values may be optionally quoted. No dotenv dependency. */
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  } catch {
    return; // no .env file — rely on the exported environment
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
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

function parseArgs(argv: string[]): { commit: boolean; dir?: string } {
  let commit = false;
  let dir: string | undefined;
  for (const arg of argv.slice(2)) {
    if (arg === '--commit') commit = true;
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
  }
  return { commit, dir };
}

async function main(): Promise<void> {
  const { commit, dir: dirArg } = parseArgs(process.argv);
  loadDotEnvIfPresent();

  const dir = (dirArg ?? process.env.CMD_EXPLORER_SEED_DIR ?? '').trim();
  if (!dir) {
    throw new Error('CMD_EXPLORER_SEED_DIR not set (or pass --dir=/path/to/csvs)');
  }
  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();
  if (commit && !writerUrl) {
    throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit; never hardcode or log it)');
  }
  // Validate the PHI key up front (both modes) so a misconfigured key fails fast,
  // before --commit reaches the DB. Probe value is non-PHI.
  await encryptPhi('seed-key-probe');

  let csvFiles: string[];
  try {
    csvFiles = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.csv'))
      .map((e) => e.name)
      .sort();
  } catch {
    throw new Error(`Could not read CMD_EXPLORER_SEED_DIR (does it exist?): ${dir}`);
  }

  console.log(`CMD Explorer seed — ${commit ? 'COMMIT' : 'DRY-RUN'} — dir: ${dir}`);
  console.log(`  ${csvFiles.length} .csv file(s) found`);

  // De-dup across ALL files by fingerprint (first occurrence wins).
  const byFingerprint = new Map<string, PlainRow>();
  const skipsByLabel = new Map<string, number>();
  const skippedFiles: string[] = [];
  let processedFiles = 0;
  let totalDataRows = 0;
  let totalValid = 0;
  let inSetDuplicates = 0;

  for (const name of csvFiles) {
    const path = join(dir, name);
    let result: ReturnType<typeof processFile>;
    try {
      result = processFile(path);
    } catch {
      skippedFiles.push(`${name} (could not read/parse)`);
      continue;
    }
    if (!result.ok) {
      skippedFiles.push(`${name} (${result.reason})`);
      continue;
    }
    processedFiles += 1;
    totalDataRows += result.outcome.dataRows;
    for (const [label, n] of result.outcome.skipsByLabel) {
      skipsByLabel.set(label, (skipsByLabel.get(label) ?? 0) + n);
    }
    for (const row of result.outcome.rows) {
      totalValid += 1;
      if (byFingerprint.has(row.row_fingerprint)) inSetDuplicates += 1;
      else byFingerprint.set(row.row_fingerprint, row);
    }
  }

  const distinct = [...byFingerprint.values()];
  const totalSkippedRows = [...skipsByLabel.values()].reduce((a, b) => a + b, 0);

  console.log(`  files processed: ${processedFiles}; skipped: ${skippedFiles.length}`);
  for (const f of skippedFiles) console.log(`    - ${f}`);
  console.log(`  data rows: ${totalDataRows}; mapped valid: ${totalValid}; skipped: ${totalSkippedRows}`);
  for (const [label, n] of [...skipsByLabel.entries()].sort()) console.log(`    - ${label}: ${n}`);
  console.log(`  in-set duplicates collapsed: ${inSetDuplicates}`);
  console.log(`  distinct fingerprints to insert: ${distinct.length}`);

  if (!commit) {
    console.log('DRY-RUN — no database connection made. Re-run with --commit to load.');
    return;
  }

  const db = makeClient(writerUrl!); // verify-full TLS (src/ssl.ts) via makeClient
  try {
    const inserted = await insertRows(db, distinct);
    console.log(
      `COMMIT — inserted ${inserted}; ` +
        `already in DB (skipped by ON CONFLICT): ${distinct.length - inserted}.`,
    );
  } finally {
    await db.end();
  }
}

// Only run the CLI when invoked directly (never when imported by a test).
if (process.argv[1] && /cmdExplorerSeed\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    // Message only — never the CSV contents or any cell value (PHI).
    console.error('CMD Explorer seed failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
