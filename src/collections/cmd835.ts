/**
 * CollaborateMD (CMD) Web API — 835 ERA download for one customer + one date.
 *
 * WHY separate from cmdPayer.ts: the batch-report path is a two-step async
 * run→poll→base64-zip flow; the 835 path is a direct GET download. Same HTTP-Basic
 * auth envelope and PHI-safe error posture, a different endpoint and response.
 *
 * THE CONTRACT (documented; supersedes the guesses this module shipped with):
 *   GET /v1/customer/{customer}/payment/download-835?date=YYYY-MM-DD
 *   - ONE `date` param. Ranges are the CALLER's job — era_ingest.ts already loops
 *     days via expandDateRange. The previous startDate/endDate pair was wrong and
 *     failed SILENTLY: CMD ignores unknown params, so it returned the WRONG DAY
 *     (whatever the endpoint defaults to) rather than erroring.
 *   - Success  → application/zip of the non-deleted 835s reported/received that day.
 *   - No files → HTTP **200** with a short text body ("No 835 ERA files were
 *     received on that date."). Not 204, not 404.
 *   - Requires the CMD **Payment** role on the credential.
 *
 * TWO CONTRACT CAVEATS WITH OPERATIONAL CONSEQUENCES — the receipt-date axis (and the
 * cron lookback it forces) and the full-day-snapshot / deleted-835 reconciliation
 * trap — are written up in `docs/veris-data-notes.md`, "CMD 835 download — contract
 * caveats". That ledger is the winning authority per CLAUDE.md; read it before
 * scheduling this or reconciling its output. Deliberately NOT duplicated here.
 *
 * WHY THE RETURN TYPE IS A UNION: an empty day and an undecodable body are
 * different events that used to look identical. Both produced `[]`, so a wrong
 * contract guess (base64 body, an HTML error page served with HTTP 200, a
 * truncated download) read as "no remittances today" and the run logged success.
 * The two states are now separated HERE, at the transport boundary:
 *   - the documented empty-day sentinel  → { kind: 'empty' }   (normal, not an error)
 *   - a ZIP                              → { kind: 'zip' }
 *   - anything else                      → throws CmdEra835Error
 * `read835Files` deliberately still returns `[]` rather than throwing on content it
 * cannot parse — alarming there would fire on every genuinely quiet day.
 *
 * PHI DISCIPLINE (root CLAUDE.md, "Standing rules"): the 835 body is patient-level
 * PHI. This module moves BYTES only — it never parses, logs, or throws a value
 * carrying EDI content. Errors name the endpoint label, the HTTP status, and a
 * structural classification only; never the URL, the body, or the credentials.
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
  /** HTTP Basic (what CMD documents) or a forward-compat token. Needs the Payment role. */
  auth: CmdApiConfig['auth'];
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Max bytes to buffer from the response. Default MAX_RESPONSE_BYTES. */
  maxBytes?: number;
}

/**
 * The date to download. ONE day per call — the endpoint takes a single `date`.
 * Multi-day pulls loop at the caller (see expandDateRange in era_ingest.ts).
 */
export interface Era835DownloadParams {
  /** ISO 'YYYY-MM-DD' — the ERA RECEIPT date at CMD, not the payment/BPR16 date. */
  date: string;
}

/**
 * The outcome of one download. `empty` is a NORMAL result (CMD had no ERAs that
 * day), not a failure — callers should count it, not alarm on it.
 */
export type Era835Download =
  | { kind: 'zip'; bytes: Buffer }
  | { kind: 'empty' };

/** Why a download failed. Structural only — no code here ever carries body content. */
export type CmdEra835ErrorCode =
  /** The caller passed a date that is not ISO YYYY-MM-DD (never reached the wire). */
  | 'invalid_date'
  /** Non-2xx from CMD. `status` is set. 401/403 name the credential/role path explicitly. */
  | 'http_status'
  /** HTTP 200 whose body is neither a ZIP nor the documented empty-day sentinel. */
  | 'unrecognized_body'
  /** The response exceeded the byte cap and was cut off mid-transfer. */
  | 'response_too_large'
  /** Network failure, abort, or timeout. */
  | 'request_failed';

/**
 * A DERIVED, non-PHI hint at what an unrecognized body was, computed from the leading
 * bytes only. This is a CLASSIFICATION, never content — the tag set is closed and
 * fixed, so it can be logged and thrown freely. It exists so a cron log says "CMD
 * returned an HTML page" instead of "something went wrong", without ever emitting a
 * byte of the body.
 */
export type Era835BodyShape =
  | 'looks_like_edi'
  | 'looks_like_html'
  | 'looks_like_json'
  | 'unknown';

/**
 * A PHI-safe, typed transport failure. The message is assembled from the endpoint
 * label + status + code + (for an unrecognized body) the derived shape tag and byte
 * count ONLY. Never put a body excerpt, a URL, or a credential in it.
 */
export class CmdEra835Error extends Error {
  readonly code: CmdEra835ErrorCode;
  readonly status?: number | undefined;
  /** Set only for 'unrecognized_body'. A closed enum, never body content. */
  readonly shape?: Era835BodyShape | undefined;

  constructor(
    code: CmdEra835ErrorCode,
    message: string,
    status?: number,
    shape?: Era835BodyShape,
  ) {
    super(message);
    this.name = 'CmdEra835Error';
    this.code = code;
    this.status = status;
    this.shape = shape;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The documented no-files response body. Matched case-insensitively on a
 * whitespace-normalized prefix so trivial punctuation/casing drift at CMD does not
 * turn a quiet day into a hard failure.
 */
const EMPTY_BODY_MARKER = 'no 835 era files were received';

/**
 * How much of a non-ZIP body to decode for CLASSIFICATION. Bounded on purpose: if a
 * body ever turns out to be EDI after all, we must not materialize the whole of it
 * as a string. The decoded text is used for one substring test and never logged,
 * returned, or thrown.
 */
const CLASSIFY_PREFIX_BYTES = 512;

/**
 * Hard ceiling on how much of a response we will buffer. Sized from the largest
 * PLAUSIBLE payload, then given a wide margin:
 *
 *   - This endpoint is per-CUSTOMER (one call == one customer == one facility), so
 *     the unit to size is a single customer's single day, not the whole roster.
 *   - Book scale is ~320k claims across 2024–2026, i.e. order 10–30 claims per
 *     customer per day. An 835 carrying 30 claims is ~30–100 KB of EDI, and EDI
 *     deflates ~8–10:1, so a normal day's ZIP is TENS OF KILOBYTES.
 *   - Pathological-but-real case: a payer releasing a quarter's backlog for one
 *     facility on one day, ~3,000 claims ≈ 6 MB of EDI ≈ under 1 MB zipped.
 *
 * 32 MiB is ~40x that pathological case, so it will not trip in operation — while
 * still bounding a hostile, mis-routed, or infinitely-chunked body to a fast cheap
 * failure well inside a 1 GB / 300 s function. Override per-call via cfg.maxBytes.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Classify an unrecognized body from its LEADING BYTES ONLY. Returns a fixed tag; the
 * decoded prefix is used for these comparisons and then discarded — never returned,
 * logged, or thrown.
 */
export function classifyBodyShape(buf: Buffer): Era835BodyShape {
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('ISA')) return 'looks_like_edi';
  if (head.startsWith('<')) return 'looks_like_html'; // <html, <!DOCTYPE, <?xml
  if (head.startsWith('{') || head.startsWith('[')) return 'looks_like_json';
  return 'unknown';
}

/**
 * Read a response body under a byte cap, WITHOUT materializing it first.
 *
 * Streams and aborts the moment the cap is crossed, so an unbounded or hostile body
 * can never be fully buffered. Content-Length is consulted as a cheap early reject
 * only — headers lie, so the streaming count is the authority (the same reason
 * classification is by magic bytes rather than Content-Type).
 *
 * Falls back to arrayBuffer() only when the response exposes no stream (some fetch
 * implementations and test doubles); the cap is still enforced after the fact there,
 * which is weaker but never weaker than the previous unconditional buffering.
 */
async function readBodyCapped(res: Response, cap: number): Promise<Buffer> {
  const tooLarge = (bytes: number | string) =>
    new CmdEra835Error(
      'response_too_large',
      `CMD download-835: response exceeds the ${cap}-byte cap (${bytes} bytes); refusing to buffer it`,
    );

  const declared = Number(res.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) throw tooLarge(declared);

  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw tooLarge(buf.length);
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) throw tooLarge(`>${cap}`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Stop the transfer on both the cap-exceeded and the happy path.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function authHeaders(auth: CmdApiConfig['auth']): Record<string, string> {
  if (auth.kind === 'token') return { Authorization: `Bearer ${auth.token}` };
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}` };
}

/** ISO date guard — the ONLY value we interpolate into the query string. */
function assertIsoDate(v: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new CmdEra835Error('invalid_date', 'CMD download-835: date must be ISO YYYY-MM-DD');
  }
}

/** ZIP local-file-header magic 'PK\x03\x04'. */
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** True when a non-ZIP body is CMD's documented "no ERAs that day" response. */
function isEmptyDayBody(buf: Buffer): boolean {
  const prefix = buf.subarray(0, CLASSIFY_PREFIX_BYTES).toString('utf8');
  return prefix.replace(/\s+/g, ' ').trim().toLowerCase().includes(EMPTY_BODY_MARKER);
}

/**
 * Download the 835 payload for one customer on one date.
 *
 * Returns `{ kind: 'empty' }` for the documented no-files day and
 * `{ kind: 'zip', bytes }` for a real payload. Throws a PHI-safe CmdEra835Error for
 * everything else — including an HTTP 200 whose body is neither, which is precisely
 * the case that used to be swallowed as "no remittances".
 */
export async function cmdDownload835(
  cfg: CmdEra835Config,
  params: Era835DownloadParams,
): Promise<Era835Download> {
  const { date } = params;
  assertIsoDate(date);

  const base = cfg.baseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({ date }).toString();
  const url =
    `${base}/v1/customer/${encodeURIComponent(cfg.customerId)}/payment/download-835?${qs}`;

  const doFetch = cfg.fetchImpl ?? fetch;
  const cap = cfg.maxBytes ?? MAX_RESPONSE_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/zip, application/octet-stream, text/plain, */*',
        ...authHeaders(cfg.auth),
      },
    });
    if (!res.ok) {
      // 401/403 must never read as a generic fault in a cron log: the overwhelmingly
      // likely cause is the credential lacking the CMD **Payment** role this endpoint
      // requires, which is an access-provisioning fix, not a retry. Names the ENV VAR,
      // never the credential value.
      if (res.status === 401 || res.status === 403) {
        throw new CmdEra835Error(
          'http_status',
          `CMD download-835 failed: HTTP ${res.status} — the CMD credential was rejected or ` +
            'lacks the Payment role this endpoint requires. This is a credential/role problem ' +
            '(check the CMD user behind CMD_API_TOKEN / CMD_API_USERNAME), NOT a network fault; ' +
            'retrying will not fix it.',
          res.status,
        );
      }
      throw new CmdEra835Error(
        'http_status',
        `CMD download-835 failed: HTTP ${res.status}`,
        res.status,
      );
    }
    const bytes = await readBodyCapped(res, cap);
    if (isZip(bytes)) return { kind: 'zip', bytes };
    if (isEmptyDayBody(bytes)) return { kind: 'empty' };
    // HTTP 200, but the body is neither a ZIP nor the empty-day sentinel. The old code
    // handed this straight to read835Files, which filtered it to [] — indistinguishable
    // from a quiet day. Fail loudly instead, naming the DERIVED SHAPE and the byte count
    // only (never a body excerpt).
    const shape = classifyBodyShape(bytes);
    throw new CmdEra835Error(
      'unrecognized_body',
      `CMD download-835: HTTP 200 with an unrecognized body (shape=${shape}, ${bytes.length} bytes; ` +
        'not a ZIP and not the documented empty-day response)',
      200,
      shape,
    );
  } catch (err) {
    if (err instanceof CmdEra835Error) throw err;
    // Network/abort/timeout — generic, never leaks URL/body/creds.
    throw new CmdEra835Error('request_failed', 'CMD download-835 request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** One 835 file to parse (filename for provenance + EDI text). */
export interface Era835File {
  name: string;
  edi: string;
}

/**
 * Normalize a download payload into 835 EDI files. If it is a ZIP, every entry is
 * decoded as UTF-8; otherwise the whole payload is treated as one raw EDI file. Only
 * entries whose content starts with an ISA control segment are returned (a stray
 * manifest/readme in the zip is skipped). Never logs content.
 *
 * Deliberately does NOT throw on unparseable content: the empty-vs-undecodable
 * distinction is made upstream in cmdDownload835, and raising here would alarm on
 * every quiet day. An empty result from a `kind: 'zip'` payload therefore means "the
 * archive held no ISA segments", which the caller counts but does not treat as fatal.
 */
export function read835Files(buf: Buffer, fallbackName = 'download-835'): Era835File[] {
  const raw: Era835File[] = isZip(buf)
    ? readZipEntries(buf).map((e) => ({ name: e.name, edi: e.data.toString('utf8') }))
    : [{ name: fallbackName, edi: buf.toString('utf8') }];
  return raw.filter((f) => f.edi.trimStart().slice(0, 3) === 'ISA');
}
