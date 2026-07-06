/**
 * CollaborateMD (CMD) Web API — 835 ERA download for one customer + date window.
 *
 * WHY separate from cmdPayer.ts: the batch-report path is a two-step async
 * run→poll→base64-zip flow; the 835 path is a direct GET download. Same HTTP-Basic
 * auth envelope and PHI-safe error posture, a different endpoint and response.
 *
 * ⚠️ CONTRACT PARTIALLY UNVERIFIED. cmdPayer.ts was VERIFIED against a live probe;
 * this endpoint has NOT been (no CMD access from this environment). What is implemented:
 * a GET to /v1/customer/{customer}/payment/download-835 with a date-window query,
 * returning the raw response bytes. What MUST be probe-confirmed before the first
 * production run: (1) the exact query-param names for the date window; (2) whether the
 * body is a ZIP of .835/.edi files, base64, or raw EDI. read835Files() handles ZIP and
 * raw-EDI transparently; a base64 body would need one decode step added here. The
 * probe is `src/collections/cmdProbe.ts`-style (structure only, never cell values).
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): the 835 body is patient-level PHI. This module
 * moves BYTES only — it never parses, logs, or throws a value carrying EDI content.
 * Errors name the endpoint label + HTTP status only, never the URL/body/credentials.
 *
 * SECRETS: env-free by design (composition-root pattern). The caller reads CMD_* from
 * the server environment and injects them via CmdEra835Config; secrets never reach the
 * browser and are never logged.
 */
import { readZipEntries, type CmdApiConfig } from './cmdPayer.js';

/** Connection + credentials for the 835 download (subset of CmdApiConfig). */
export interface CmdEra835Config {
  /** API origin, e.g. 'https://webapi.collaboratemd.com'. */
  baseUrl: string;
  /** CMD customer/account id (one customer == one facility). */
  customerId: string;
  /** HTTP Basic (what CMD documents) or a forward-compat token. */
  auth: CmdApiConfig['auth'];
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 60s. */
  timeoutMs?: number;
}

/** The date window to download. A single --date maps to start == end. */
export interface Era835DownloadParams {
  /** ISO 'YYYY-MM-DD' — download 835s received/produced on this date. */
  date?: string;
  /** ISO range start (inclusive) — used when downloading a multi-day range. */
  from?: string;
  /** ISO range end (inclusive). */
  to?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function authHeaders(auth: CmdApiConfig['auth']): Record<string, string> {
  if (auth.kind === 'token') return { Authorization: `Bearer ${auth.token}` };
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}` };
}

/** ISO date guard — the ONLY values we interpolate into the query string. */
function assertIsoDate(label: string, v: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`CMD download-835: ${label} must be ISO YYYY-MM-DD`);
  }
}

/**
 * Download the raw 835 payload for one customer over a date window. Returns the
 * response bytes (read835Files unwraps a ZIP or reads raw EDI). Throws a PHI-safe
 * Error (endpoint label + HTTP status only) so the caller fails closed.
 */
export async function cmdDownload835(
  cfg: CmdEra835Config,
  params: Era835DownloadParams,
): Promise<Buffer> {
  const start = params.from ?? params.date;
  const end = params.to ?? params.date;
  if (!start || !end) throw new Error('CMD download-835: a date (or from+to) is required');
  assertIsoDate('start', start);
  assertIsoDate('end', end);

  const base = cfg.baseUrl.replace(/\/+$/, '');
  // Query-param NAMES are the unverified part — startDate/endDate is the CMD-conventional
  // pairing; override here once a live probe confirms the contract.
  const qs = new URLSearchParams({ startDate: start, endDate: end }).toString();
  const url =
    `${base}/v1/customer/${encodeURIComponent(cfg.customerId)}/payment/download-835?${qs}`;

  const doFetch = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/zip, application/octet-stream, */*', ...authHeaders(cfg.auth) },
    });
    if (!res.ok) throw new Error(`CMD download-835 failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CMD download-835')) throw err;
    // Network/abort/timeout — generic, never leaks URL/body/creds.
    throw new Error('CMD download-835 request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** One 835 file to parse (filename for provenance + EDI text). */
export interface Era835File {
  name: string;
  edi: string;
}

/** ZIP local-file-header magic 'PK\x03\x04'. */
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Normalize a download payload into 835 EDI files. If it is a ZIP, every entry is
 * decoded as UTF-8; otherwise the whole payload is treated as one raw EDI file. Only
 * entries whose content starts with an ISA control segment are returned (a stray
 * manifest/readme in the zip is skipped). Never logs content.
 */
export function read835Files(buf: Buffer, fallbackName = 'download-835'): Era835File[] {
  const raw: Era835File[] = isZip(buf)
    ? readZipEntries(buf).map((e) => ({ name: e.name, edi: e.data.toString('utf8') }))
    : [{ name: fallbackName, edi: buf.toString('utf8') }];
  return raw.filter((f) => f.edi.trimStart().slice(0, 3) === 'ISA');
}
