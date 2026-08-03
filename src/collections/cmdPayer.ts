/**
 * CollaborateMD (CMD) Web API reader — per-payer monthly gap as a non-PHI summary.
 *
 * WHY: the dashboard's "By Payer" chart normally reads claims.mv_payer_gap (built
 * from the Google-Sheets ingest), but that matview is missing complete 2026
 * Apr–May data. CMD is the source of truth for 2026 payer payments, so the
 * past-2026-month payer view sources from the CMD batch-reporting endpoint instead.
 *
 * ✓ VERIFIED against CollaborateMD Web API V1 + Batch Reporting v1.0 docs AND a
 * live probe (npm run probe:cmd). The contract is a TWO-STEP ASYNC flow that
 * returns a base64-encoded .zip of CSV(s) — NOT a synchronous JSON rows array:
 *   1. POST /v1/customer/{customer}/reports/{reportSeq}/filter/{filterSeq}/run
 *      → GenericResponse { Status, StatusMessage, Identifier }. NO request body;
 *        the date window is baked into the saved filter (filterSeq), not passed
 *        per request. Identifier is the requestSeq used to poll for results.
 *   2. POST /v1/customer/{customer}/reports/results/{requestSeq}
 *      → ReportResponse { Status, StatusMessage, Data }. Data is base64 → a .zip
 *        of CSV file(s). "REPORT RUNNING" until ready; "REPORT TIMED OUT" at 20m.
 * Auth is HTTP Basic (username:password, base64). Confirmed live: the run-step
 * envelope is PascalCase { Status, StatusMessage, Identifier:number }.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the report CSV contains patient-level rows.
 * This module aggregates to PAYER TOTALS in-process and returns ONLY the non-PHI
 * `PayerGapSummary` shape (payer name + dollar totals — both allowlisted). It
 * never logs the response body, the decoded zip, CSV cell values, or credentials.
 * The HTTP/parse error paths surface a status code or a generic label only.
 *
 * SECRETS: env-free by design (composition-root pattern). The caller
 * (app/lib/server.ts) reads CMD_* from the server environment and injects them via
 * `CmdApiConfig`; secrets never reach the browser and are never logged.
 *
 * NOTE (window): because the API window is fixed by the saved filter, the
 * per-month view filters rows client-side on the service-date column before
 * aggregating, so cmdPayerGapForMonth is correct for any filter whose window
 * covers the requested month.
 */
import { inflateRawSync } from 'node:zlib';
import type { PayerGapRow, PayerGapSummary } from '../queries/types.js';

/** Connection + report identity + credentials, injected by the composition root. */
export interface CmdApiConfig {
  /** API origin, e.g. 'https://webapi.collaboratemd.com'. */
  baseUrl: string;
  /** CMD customer/account id (BXR/CMD = '10027973'). */
  customerId: string;
  /** Saved report id ('10091828' — the payer payments report). */
  reportId: string;
  /** Saved filter id ('10147241'). The filter defines the report's date window. */
  filterId: string;
  /**
   * HTTP Basic credentials (what CMD documents). A token mode is accepted for
   * forward-compat with the composition root, but CMD's Batch Reporting API only
   * supports Basic auth today.
   */
  auth:
    | { kind: 'token'; token: string }
    | { kind: 'basic'; username: string; password: string };
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Poll budget overrides (results step). Defaults: 40 attempts × 15s = ~10min. */
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  /**
   * Consecutive SUCCESS-with-empty-Data polls tolerated before concluding the report is
   * genuinely empty (0 rows) rather than still materializing. CMD returns SUCCESS with no
   * Data BOTH transiently (report accepted, CSV not attached yet) AND permanently (the
   * account has no rows in the window); only elapsed time tells them apart. Defaults to 4.
   */
  emptyGraceAttempts?: number;
}

/** CMD status envelope values (run + results). */
type CmdStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'NOT FOUND'
  | 'INVALID CRITERIA'
  | 'REPORT RUNNING'
  | 'REPORT TIMED OUT';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 40; // 40 × 15s = 10 min (< CMD's 20-min server timeout)
const DEFAULT_EMPTY_GRACE_ATTEMPTS = 4; // consecutive SUCCESS-empty polls before "genuinely empty"
const RUN_TIMEOUT_MS = 60_000;
const RESULTS_TIMEOUT_MS = 60_000;

function authHeaders(auth: CmdApiConfig['auth']): Record<string, string> {
  if (auth.kind === 'token') return { Authorization: `Bearer ${auth.token}` };
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}` };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Read a value across PascalCase / camelCase variants of a CMD envelope key. */
function envField(body: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (body[n] !== undefined && body[n] !== null) return body[n];
  return undefined;
}

/**
 * Bounded fetch with an explicit timeout. Throws a PHI-safe Error (endpoint label
 * + HTTP status only — never the URL, body, or credentials).
 */
async function postCmd(
  cfg: CmdApiConfig,
  label: string,
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      // No request body: the run takes only path/query params; the window lives in
      // the saved filter. Accept JSON (CMD defaults to XML when Accept is absent).
      headers: { Accept: 'application/json', ...authHeaders(cfg.auth) },
    });
    if (!res.ok) throw new Error(`CMD ${label} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CMD ')) throw err;
    // Network/abort/timeout/parse — generic, never leaks URL/body/creds.
    throw new Error(`CMD ${label} request failed`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step 1 — fire the saved report run for the configured filter. Returns the
 * requestSeq (Identifier) used to poll for results. If a report is already
 * running (one-at-a-time per partner), CMD returns that report's identifier, so
 * we poll it rather than failing. Throws (status only) when no identifier comes
 * back. The window is fixed by filterId — there is no date parameter.
 */
export async function cmdRunReport(cfg: CmdApiConfig): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url =
    `${base}/v1/customer/${encodeURIComponent(cfg.customerId)}` +
    `/reports/${encodeURIComponent(cfg.reportId)}/filter/${encodeURIComponent(cfg.filterId)}/run`;
  const body = await postCmd(cfg, 'report.run', url, RUN_TIMEOUT_MS);
  const status = envField(body, 'Status', 'status') as CmdStatus | undefined;
  const identifier = envField(body, 'Identifier', 'identifier', 'requestSeq');
  if (identifier === undefined || `${identifier}` === '') {
    // statusMessage can echo filter criteria — never propagate it verbatim.
    throw new Error(`CMD report.run returned no identifier (status: ${status ?? 'unknown'})`);
  }
  return String(identifier);
}

/**
 * One results poll:
 *   - non-empty base64 Data            → decoded zip bytes (done)
 *   - REPORT RUNNING                   → 'RUNNING'  (report is computing; poll again)
 *   - SUCCESS/other with empty Data    → 'EMPTY'    (accepted but no CSV attached — see below)
 *   - REPORT TIMED OUT                 → 'TIMED_OUT'
 *
 * 'EMPTY' is deliberately NOT an error: CMD returns SUCCESS with the Data field empty/absent
 * BOTH transiently (the just-fired report hasn't materialized its CSV yet — observed live on a
 * slow morning where a single poll-1 SUCCESS-empty aborted every customer) AND permanently (the
 * account genuinely has no rows in the filter window). The caller (cmdRunReportToZip) decides
 * which by polling through EMPTY for a short grace window before concluding "genuinely empty".
 */
export async function cmdFetchResults(
  cfg: CmdApiConfig,
  requestSeq: string,
): Promise<Buffer | 'RUNNING' | 'TIMED_OUT' | 'EMPTY'> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url =
    `${base}/v1/customer/${encodeURIComponent(cfg.customerId)}` +
    `/reports/results/${encodeURIComponent(requestSeq)}`;
  const body = await postCmd(cfg, 'report.results', url, RESULTS_TIMEOUT_MS);
  const status = envField(body, 'Status', 'status') as CmdStatus | undefined;
  const data = envField(body, 'Data', 'data');
  // Success is signalled by non-empty base64 Data, regardless of the status string.
  if (typeof data === 'string' && data.length > 0) return Buffer.from(data, 'base64');
  if (status === 'REPORT RUNNING') return 'RUNNING';
  if (status === 'REPORT TIMED OUT') return 'TIMED_OUT';
  return 'EMPTY';
}

/**
 * Step 1+2 — run the report and poll to completion. Returns the raw zip bytes, or `null` when
 * the report is GENUINELY EMPTY (SUCCESS with no Data for `emptyGraceAttempts` consecutive polls
 * — the account has no rows in the window). Bounded by maxPollAttempts × pollIntervalMs.
 *
 * A transient SUCCESS-empty (CSV not materialized yet) is ridden out: consecutive EMPTY polls
 * are counted, and a RUNNING or Data poll resets that streak, so a busy report that briefly
 * reports EMPTY still resolves to its data instead of being mistaken for empty. Throws only on
 * TIMED_OUT or budget exhaustion (still RUNNING), so a stuck report fails closed to the caller.
 */
export async function cmdRunReportToZip(cfg: CmdApiConfig): Promise<Buffer | null> {
  const requestSeq = await cmdRunReport(cfg);
  const interval = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = cfg.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const emptyGrace = Math.min(cfg.emptyGraceAttempts ?? DEFAULT_EMPTY_GRACE_ATTEMPTS, maxAttempts);
  let emptyStreak = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await cmdFetchResults(cfg, requestSeq);
    if (out instanceof Buffer) return out;
    if (out === 'TIMED_OUT') throw new Error('CMD report timed out');
    if (out === 'EMPTY') {
      if (++emptyStreak >= emptyGrace) return null; // genuinely empty — non-fatal, 0 rows
    } else {
      emptyStreak = 0; // 'RUNNING' — report is active; don't count it toward the empty grace
    }
    if (attempt < maxAttempts) await sleep(interval);
  }
  throw new Error('CMD report still running after poll budget exhausted');
}

// --- ZIP reader (dependency-free; STORE + DEFLATE via the central directory) ---
// Mirrors the proven reader in src/cmd_batch_pull.ts. ZIP64 is explicitly rejected.
interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZip(buf: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LF_SIG = 0x04034b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('CMD report payload is not a ZIP (no EOCD record)');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) throw new Error('CMD ZIP64 not supported');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('CMD ZIP: corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('CMD ZIP64 entry not supported');
    }
    if (name.endsWith('/')) continue; // directory entry

    if (buf.readUInt32LE(localOffset) !== LF_SIG) throw new Error('CMD ZIP: corrupt local header');
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw new Error(`CMD ZIP: unsupported compression method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}

// --- CSV parsing (RFC-4180-ish: quoted fields, embedded commas/quotes/newlines) -
/** Parse one CSV string into header + row arrays. Whole-cell PHI — never logged. */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      // Skip blank lines (e.g. a trailing newline) — don't emit empty records.
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (record.length > 1 || record[0] !== '') records.push(record);
  }
  const header = records.shift() ?? [];
  return { header: header.map((h) => h.trim()), rows: records };
}

/** Row object keyed by trimmed header column name. */
export type CmdReportRow = Record<string, string>;

/** Parse one CSV string into row objects keyed by trimmed header name. Shared by
 * the zip reader (live API path) and the local-file ingest (cmdPayerIngest.ts) so
 * both apply identical parsing. Whole-cell PHI — never logged. */
export function parseReportCsv(text: string): CmdReportRow[] {
  const { header, rows } = parseCsv(text);
  const out: CmdReportRow[] = [];
  for (const cells of rows) {
    const obj: CmdReportRow = {};
    for (let c = 0; c < header.length; c++) obj[header[c]!] = cells[c] ?? '';
    out.push(obj);
  }
  return out;
}

/** Raw unzip of a CMD payload → per-entry filename + bytes. Exposed so the 835 ERA
 *  download path (src/collections/cmd835.ts) reuses the SAME dependency-free reader
 *  (STORE + DEFLATE, ZIP64 rejected) instead of a second copy. */
export type CmdZipEntry = { name: string; data: Buffer };
export function readZipEntries(zip: Buffer): CmdZipEntry[] {
  return readZip(zip);
}

/** Unzip a CMD report payload and parse every .csv entry into row objects. */
export function readReportRows(zip: Buffer): CmdReportRow[] {
  const entries = readZip(zip);
  const csvs = entries.filter((e) => /\.csv$/i.test(e.name));
  const chosen = csvs.length > 0 ? csvs : entries; // fall back to any text entry
  const out: CmdReportRow[] = [];
  for (const entry of chosen) out.push(...parseReportCsv(entry.data.toString('utf8')));
  return out;
}

/** Run the report end-to-end and return parsed CSV rows (run → poll → unzip). A genuinely
 *  empty report (no Data after the poll grace) yields `[]` — an empty window is not an error. */
export async function cmdReportRows(cfg: CmdApiConfig): Promise<CmdReportRow[]> {
  const zip = await cmdRunReportToZip(cfg);
  return zip === null ? [] : readReportRows(zip);
}

/**
 * Pull ONE report across MANY CMD customer accounts and concatenate the rows.
 *
 * WHY THIS EXISTS: CMD scopes every report by customer, and one customer == one facility.
 * A single `cmdReportRows` call therefore returns ONE facility's slice. The payer rollup
 * (collections.cmd_payer_facility_monthly) and the By Payer chart are WHOLE-BOOK figures, so
 * both must loop the roster. Pulling one account against a whole-book table understates the
 * month by roughly an order of magnitude (measured 2026-08-02: one BXR account returned
 * $1.4M for 2026-05 against the book's $11.4M).
 *
 * ALL-OR-NOTHING — the reason this is a helper and not an inline loop. `writeRollup` DELETEs
 * per (month × tenant) across ALL facilities and re-INSERTs from the tuples it is handed, so a
 * partially-fetched book would delete a complete month and write back only the accounts that
 * answered. That is silent data loss with a 200 response. Any account that throws aborts the
 * whole pull, so the caller writes nothing. A hard platform timeout mid-loop is safe for the
 * same reason: the write only runs after every account has answered.
 *
 * SEQUENTIAL by contract: CMD permits one running report at a time per partner, matching
 * cmdExplorerCron / cmdCensusCron. Deliberately NO budget guard — the other two crons are
 * per-facility idempotent so partial progress is fine and resumes next run, but a truncated
 * pull here is destructive. Failing the run is the correct outcome; the next scheduled run
 * retries the whole book.
 *
 * `fetchOne` is injected rather than calling cmdReportRows directly so the ordering and the
 * all-or-nothing guarantee stay hermetically testable (no network in `npm test`).
 * customerIds are CMD account numbers — not PHI, safe in an error message.
 */
export async function collectRowsAcrossCustomers(
  customerIds: readonly string[],
  fetchOne: (customerId: string) => Promise<CmdReportRow[]>,
): Promise<CmdReportRow[]> {
  if (customerIds.length === 0) {
    // Fail closed. An empty roster would yield zero tuples, and zero tuples means writeRollup
    // deletes nothing — but it would also report a successful no-op run forever. A roster that
    // came back empty is a config fault, not a quiet success.
    throw new Error('collectRowsAcrossCustomers: empty customer roster — refusing to pull an empty book');
  }
  const out: CmdReportRow[] = [];
  for (const customerId of customerIds) {
    let rows: CmdReportRow[];
    try {
      rows = await fetchOne(customerId);
    } catch (err) {
      throw new Error(
        `collectRowsAcrossCustomers: customer ${customerId} failed — refusing to write a partial book`,
        { cause: err },
      );
    }
    // Push in a loop rather than spreading: a whole-book pull is tens of thousands of rows and
    // `out.push(...rows)` passes every row as an argument, which blows the call-stack arg limit.
    for (const row of rows) out.push(row);
  }
  return out;
}

/**
 * PHI-safe structural description of a report zip: per-entry filename, parsed
 * column names, and row count. Returns NO cell values — used by the probe to
 * reveal the report shape without emitting any patient-level data.
 */
export function describeReportZip(
  zip: Buffer,
): Array<{ name: string; columns: string[]; rowCount: number }> {
  return readZip(zip).map((entry) => {
    if (!/\.csv$/i.test(entry.name)) {
      return { name: entry.name, columns: [], rowCount: 0 };
    }
    const { header, rows } = parseCsv(entry.data.toString('utf8'));
    return { name: entry.name, columns: header, rowCount: rows.length };
  });
}

// --- Response mapping (column names VERIFIED from the live report CSV header) ---
// ✓ VERIFIED against the CMD report CSV (report 10091729 / filter 10147241) via
// `npm run probe:cmd`: the "Derek Batch Export.csv" header is, exactly —
//   Charge From Date | Payment Received | Charge CPT Code | Revenue Code |
//   Facility Name/ID | Patient Full Name | Claim Primary Member ID |
//   Primary Group Number | Charge/Debit Amount | Payment Allowed Amount |
//   Charge Insurance Payments | Charge Total Adjustments w/o Transfers |
//   Charge Balance Due Pat | Charge Primary Payer Name
// The grain is per CHARGE LINE (so claim_count is charge-line count). Patient
// Full Name / Member ID / Group Number are PHI and are never read here. One alias
// kept per field for resilience to minor report-label edits.
// 'Charge Current Payer Name' is report 10093971's label (the 2026-08-02 rebuild that replaced the
// lost 10091828/10147241 pair). Appended LAST so any report still emitting the 'Primary' forms keeps
// its existing mapping — pick() returns the first candidate present.
const PAYER_KEYS = ['Charge Primary Payer Name', 'Primary Payer Name', 'Charge Current Payer Name'];
// 'Facility Name/ID' is a REQUIRED fallback here — do NOT remove. The shipped payer
// rollup pulls a DIFFERENT CMD report (report 10091729 / filter 10147241) that emits
// the older 'Facility Name/ID' header; dropping the fallback silently nulls facility
// attribution on the next rollup cron. The Collections Explorer standardized on the
// bare 'Facility Name' (cmdExplorer.ts / cmdExplorerSeed.ts) — that cleanup is
// Explorer-scoped and does NOT apply to this payer-rollup path. Guarded by
// test/cmdPayer.test.ts ('FACILITY_KEYS keeps the Facility Name/ID fallback').
const FACILITY_KEYS = ['Facility Name', 'Facility Name/ID'];
const CHARGE_KEYS = ['Charge/Debit Amount', 'Charge Amount'];
const ALLOWED_KEYS = ['Payment Allowed Amount', 'Allowed Amount'];
// 'Payment Total Paid' is report 10093971's label for insurance paid. Appended LAST, so a report
// emitting BOTH the charge-grain 'Charge Insurance Payments' and this one still resolves to the
// charge-grain column and no existing pull changes value.
const PAID_KEYS = ['Charge Insurance Payments', 'Insurance Payment Amount', 'Payment Total Paid'];
const DATE_KEYS = ['Charge From Date', 'Date Of Service'];

/** Case-insensitive field read across a small set of candidate header names. */
function pick(row: CmdReportRow, candidates: readonly string[]): string | undefined {
  for (const c of candidates) if (c in row) return row[c];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Money/number coercion: accepts numbers or '$1,234.56'/'(123.45)' strings; else 0. */
export function toAmount(value: string | undefined): number {
  if (value === undefined) return 0;
  const neg = /^\(.*\)$/.test(value.trim());
  const n = Number(value.replace(/[$,()\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function toPayerName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Parse a service-date cell to { year, month }. Accepts MM/DD/YYYY, M/D/YYYY, and
 * YYYY-MM-DD (the formats CMD reports emit); returns null for anything else.
 */
export function parseServiceYearMonth(
  value: string | undefined,
): { year: number; month: number } | null {
  if (!value) return null;
  const t = value.trim();
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (slash) return { year: Number(slash[3]), month: Number(slash[1]) };
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  return null;
}

/** True when a service-date cell falls inside the requested [year, month]. */
function inMonth(value: string | undefined, year: number, month: number): boolean {
  const ym = parseServiceYearMonth(value);
  return ym !== null && ym.year === year && ym.month === month;
}

/** Per-charge-line fields the rollup ingest needs (no PHI columns). Service date
 * resolved to { year, month }; null when the date cell is unparseable (the ingest
 * counts and skips those). Facility/payer are trimmed to null when blank. */
export interface CmdLineFields {
  payer: string | null;
  facility: string | null;
  year: number;
  month: number;
  charge: number;
  allowed: number;
  paid: number;
}

/**
 * Extract the non-PHI rollup fields from one report row using the SAME field
 * mapping as the live payer-gap path (single source of truth for column-name
 * resilience). Returns null when the service date is missing/unparseable.
 */
export function extractLineFields(row: CmdReportRow): CmdLineFields | null {
  const ym = parseServiceYearMonth(pick(row, DATE_KEYS));
  if (ym === null) return null;
  return {
    payer: toPayerName(pick(row, PAYER_KEYS)),
    facility: toPayerName(pick(row, FACILITY_KEYS)),
    year: ym.year,
    month: ym.month,
    charge: toAmount(pick(row, CHARGE_KEYS)),
    allowed: toAmount(pick(row, ALLOWED_KEYS)),
    paid: toAmount(pick(row, PAID_KEYS)),
  };
}

/**
 * Map CMD report CSV rows to the non-PHI `PayerGapSummary`, aggregating by payer.
 * When `window` is given, rows are filtered to that calendar month on the
 * service-date column first (the API window is fixed by the saved filter, so the
 * month scope is applied here). Throws if no payer totals can be derived, so a
 * field/shape mismatch fails closed to the caller's matview fallback.
 */
export function mapCmdReportToPayerGap(
  rows: CmdReportRow[],
  window?: { year: number; month: number },
): PayerGapSummary {
  const byPayer = new Map<string, PayerGapRow>();
  for (const row of rows) {
    if (window && !inMonth(pick(row, DATE_KEYS), window.year, window.month)) continue;
    const payer = toPayerName(pick(row, PAYER_KEYS));
    const charge = toAmount(pick(row, CHARGE_KEYS));
    const allowed = toAmount(pick(row, ALLOWED_KEYS));
    const paid = toAmount(pick(row, PAID_KEYS));
    const key = payer ?? '__null_payer__';
    const acc =
      byPayer.get(key) ??
      {
        payer_name: payer,
        claim_count: 0,
        total_charge: 0,
        total_allowed: 0,
        total_paid: 0,
        avg_collection_rate: null,
        total_write_down: 0,
        total_collection_gap: 0,
      };
    acc.claim_count += 1;
    acc.total_charge += charge;
    acc.total_allowed += allowed;
    acc.total_paid += paid;
    byPayer.set(key, acc);
  }

  const by_payer: PayerGapRow[] = [...byPayer.values()].map((r) => ({
    ...r,
    total_write_down: r.total_charge - r.total_allowed,
    total_collection_gap: r.total_charge - r.total_paid,
    avg_collection_rate: r.total_charge > 0 ? r.total_paid / r.total_charge : null,
  }));

  const anyMoney = by_payer.some((r) => r.total_charge !== 0 || r.total_paid !== 0);
  if (by_payer.length === 0 || !anyMoney) {
    throw new Error('CMD report mapping produced no payer totals (field mapping mismatch?)');
  }

  const rows_analyzed = by_payer.reduce((n, r) => n + r.claim_count, 0);
  return { rows_analyzed, by_payer };
}

/**
 * Per-payer gap for one calendar month, sourced from CMD (non-PHI summary).
 * Runs the saved report (async two-step), parses the CSV, filters to the month,
 * and aggregates to payer totals server-side; no patient-level data leaves here.
 */
export async function cmdPayerGapForMonth(
  year: number,
  month: number,
  cfg: CmdApiConfig,
  customerIds?: readonly string[],
): Promise<PayerGapSummary> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year must be an integer in [2000, 2100]');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('month must be an integer in [1, 12]');
  }
  // `customerIds` omitted == cfg.customerId's single account (the original one-facility behavior,
  // still what the probe/CLI paths want). Supplied == WHOLE BOOK: this is a by-payer total, so a
  // one-account answer is not a smaller correct answer, it is a wrong one. See
  // collectRowsAcrossCustomers for why a partial pull throws instead of returning what it has.
  const rows =
    customerIds === undefined
      ? await cmdReportRows(cfg)
      : await collectRowsAcrossCustomers(customerIds, (customerId) =>
          cmdReportRows({ ...cfg, customerId }),
        );
  return mapCmdReportToPayerGap(rows, { year, month });
}
