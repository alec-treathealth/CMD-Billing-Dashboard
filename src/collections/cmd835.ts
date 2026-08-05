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
 * trap — are written up in `veris-data-notes.md`, "CMD 835 download — contract
 * caveats". That ledger is the winning authority per CLAUDE.md; read it before
 * scheduling this or reconciling its output. Deliberately NOT duplicated here.
 *
 * WHY THE RETURN TYPE IS A UNION: an empty day and an undecodable body are
 * different events that used to look identical. Both produced `[]`, so a wrong
 * contract guess (base64 body, an HTML error page served with HTTP 200, a
 * truncated download) read as "no remittances today" and the run logged success.
 * The two states are separated HERE, at the transport boundary, by a THREE-WAY
 * DIGEST-ANCHORED classification (see KNOWN_EMPTY_DAY_DIGESTS):
 *   - ZIP magic bytes                    → { kind: 'zip' }
 *   - sha256 in the proven allowlist     → { kind: 'empty' }   (normal, not an error)
 *   - anything else                      → throws CmdEra835Error
 * `read835Files` deliberately still returns `[]` rather than throwing on content it
 * cannot parse — alarming there would fire on every genuinely quiet day.
 *
 * ⚠️ CLASSIFICATION IS BY EXACT DIGEST, NOT BY PROSE — and not by Content-Type.
 * The original implementation matched a DOCUMENTED sentence, which CMD does not
 * actually send: its live no-data body is worded differently, so EVERY QUIET DAY
 * COUNTED AS A HARD FAILURE (found 2026-07-31; the empty path had never once been
 * exercised successfully in a live pull). CMD also serves that text body as
 * Content-Type: application/zip, so the header cannot be trusted either. The prose
 * matcher survives as a DIAGNOSTIC FLAG ONLY (marker_matched) and must never again
 * decide classification. Do not replace the allowlist with a "short + printable ⇒
 * empty" heuristic — the reasoning is on KNOWN_EMPTY_DAY_DIGESTS and it matters.
 *
 * PHI DISCIPLINE (root CLAUDE.md, "Standing rules"): the 835 body is patient-level
 * PHI. This module moves BYTES only — it never parses, logs, or throws a value
 * carrying EDI content. Errors name the endpoint label, the HTTP status, a structural
 * classification, a byte count and a sha256 digest only; never the URL, the body, or
 * the credentials. Hashing and length are the ONLY operations performed on an
 * unrecognized body — no previews, no debug excerpts, ever (see bodyDigest).
 *
 * SECRETS: env-free by design (composition-root pattern). The caller reads CMD_* from
 * the server environment and injects them via CmdEra835Config; secrets never reach the
 * browser and are never logged.
 */
import { createHash } from 'node:crypto';
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
  /**
   * TEST SEAM ONLY — replaces KNOWN_EMPTY_DAY_DIGESTS for this call.
   *
   * Needed because the production digest's PREIMAGE IS DELIBERATELY NOT STORED ANYWHERE
   * (zero-disclosure: we keep the hash, never the body), so a hermetic test cannot
   * synthesize a body that hashes into the real allowlist. Tests inject their own set to
   * exercise the empty-day path — which had never once been exercised, and is precisely
   * the defect this classification fixes.
   *
   * DO NOT set this in production code or wire it to an env var. Allowlisting a real
   * digest is a deliberate one-line source change to KNOWN_EMPTY_DAY_DIGESTS, so that
   * "we now treat this body as no-data" goes through review like any other money-
   * affecting decision.
   */
  knownEmptyDayDigests?: ReadonlySet<string>;
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
  /**
   * HTTP 200 with a SHORT PRINTABLE-TEXT body whose sha256 is not in
   * KNOWN_EMPTY_DAY_DIGESTS. This is the drift bucket: it is what a quiet day lands in
   * if CMD edits its no-data wording. The error carries the new digest, so resolving it
   * is a one-line addition to the allowlist — not another multi-session investigation.
   * It is deliberately a FAILURE and not `empty`: see the note on KNOWN_EMPTY_DAY_DIGESTS.
   */
  | 'unrecognized_short_text'
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
  /**
   * sha256 (hex) of the FULL body. A one-way derived value, not content — and the
   * operational point of it: paste it into KNOWN_EMPTY_DAY_DIGESTS to resolve a wording
   * drift. Set for the unrecognized-body buckets only.
   */
  readonly digest?: string | undefined;
  /** Byte length of the body. A count, never content. */
  readonly byteLength?: number | undefined;
  /**
   * DIAGNOSTIC ONLY — whether the legacy prose substring matched. It does NOT and MUST
   * NOT influence classification (see isEmptyDayBody). `true` here alongside
   * 'unrecognized_short_text' is the strong signal that CMD reworded its quiet-day
   * message and this digest should be allowlisted.
   */
  readonly markerMatched?: boolean | undefined;

  constructor(
    code: CmdEra835ErrorCode,
    message: string,
    status?: number,
    shape?: Era835BodyShape,
    details?: { digest?: string; byteLength?: number; markerMatched?: boolean },
  ) {
    super(message);
    this.name = 'CmdEra835Error';
    this.code = code;
    this.status = status;
    this.shape = shape;
    this.digest = details?.digest;
    this.byteLength = details?.byteLength;
    this.markerMatched = details?.markerMatched;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The DOCUMENTED no-files wording. Retained as a DIAGNOSTIC SIGNAL ONLY — it no longer
 * decides anything (see isEmptyDayBody + KNOWN_EMPTY_DAY_DIGESTS). CMD's live wording
 * differs from this, which is exactly why the prose matcher failed every quiet day.
 */
const EMPTY_BODY_MARKER = 'no 835 era files were received';

/**
 * sha256 digests of body payloads PROVEN to mean "no 835 ERAs for this customer on this
 * date". A quiet day is classified `empty` if and only if its digest is in this set.
 *
 * ┌─ WHY AN EXACT DIGEST ALLOWLIST AND NOT A STRUCTURAL HEURISTIC ─────────────────────┐
 * │ The tempting rule is "short + printable + not a ZIP ⇒ empty". DO NOT IMPLEMENT     │
 * │ THAT. It trades a loud bug for a silent one: any genuine service error CMD happens │
 * │ to serve with HTTP 200 and a short text body would be swallowed as a quiet day,    │
 * │ and "no upcoming payments today" becomes indistinguishable from "the feed broke".  │
 * │ On a money feed that is the worst possible failure mode — it looks like good news. │
 * │                                                                                    │
 * │ An exact allowlist is loud on drift BY CONSTRUCTION. If CMD edits its wording,     │
 * │ quiet days start failing in the 'unrecognized_short_text' bucket with the NEW      │
 * │ digest printed in the error, and the fix is one line added here.                   │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * OBSERVED ENTRIES:
 *
 *   83b3fc6a77ef99a73263d6b1632b4e05edaf32197cc60327ef057e951728f290
 *     44-byte printable-ASCII body, BYTE-IDENTICAL across 2 customers x 4 dates
 *     (FRCA 10032340 and TBH 10029105, 2026-07-28..2026-07-31): 8/8 calls, ONE digest.
 *     Observed 2026-07-31 via scripts/probe-era-coverage.ts (read-only probe, no DB).
 *     CMD serves it with Content-Type: application/zip, which is a MISLABEL — the body
 *     carries no PK\x03\x04 and isZip() correctly rejects it. This is the response the
 *     documented-prose matcher never matched, so every quiet day counted as a hard
 *     failure. Coincidentally the documented sentinel is also 44 bytes; length is not
 *     evidence of anything, which is a further reason the match is on the digest.
 */
export const KNOWN_EMPTY_DAY_DIGESTS: ReadonlySet<string> = new Set([
  '83b3fc6a77ef99a73263d6b1632b4e05edaf32197cc60327ef057e951728f290',
]);

/**
 * Longest body we will treat as "short text" FOR FAILURE-BUCKETING PURPOSES ONLY.
 * Never used to classify anything as `empty`.
 */
const SHORT_TEXT_MAX_BYTES = 512;

/**
 * sha256 (hex) of the FULL body.
 *
 * ┌─ ZERO DISCLOSURE — DO NOT RELAX THIS ──────────────────────────────────────────────┐
 * │ Hashing and measuring length are the ONLY things this module ever does with an     │
 * │ unrecognized body. The raw body is NEVER printed, logged, thrown, returned,        │
 * │ persisted, or previewed. Do NOT add a debug flag, a `preview` field, a first-N-    │
 * │ bytes excerpt, or a "just while we investigate" escape hatch — an 835 body is      │
 * │ patient-level PHI, and the same constraint is already enforced in                  │
 * │ scripts/probe-era-coverage.ts. A digest is a one-way derived value and is safe to  │
 * │ log; the body is not, at any length, for any reason.                               │
 * │                                                                                    │
 * │ (Note: a digest of a SHORT templated service message is guessable by hashing       │
 * │ candidate wordings — that is how the entry above was characterized, and it is      │
 * │ acceptable precisely because such bodies are templated and carry no patient data.  │
 * │ It is still strictly safer than emitting the bytes.)                              │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 */
export function bodyDigest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** True when every byte is printable ASCII or ordinary whitespace (tab/CR/LF). */
function isPrintableAscii(buf: Buffer): boolean {
  for (const b of buf) {
    const ok = (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d;
    if (!ok) return false;
  }
  return true;
}

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

/**
 * DIAGNOSTIC ONLY — does the body contain the DOCUMENTED quiet-day prose?
 *
 * This function MUST NOT decide classification, and no caller may branch on it to
 * produce `{ kind: 'empty' }`. It exists solely so an 'unrecognized_short_text' failure
 * can report marker_matched alongside the digest: `true` means "this reads like a
 * quiet-day message but its digest is not allowlisted", i.e. CMD reworded — allowlist
 * the digest. Promoting this back to a classifier would restore the silent-swallow risk
 * the digest allowlist exists to remove.
 *
 * The decoded prefix is used for one substring test and then discarded — never logged,
 * returned, or thrown.
 */
function matchesDocumentedMarker(buf: Buffer): boolean {
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

    // --- THREE-WAY CLASSIFICATION (order matters) ----------------------------------
    // 1. ZIP magic bytes  → real data. Content-Type is NOT consulted: CMD serves the
    //    quiet-day text body as application/zip, so the header lies.
    if (isZip(bytes)) return { kind: 'zip', bytes };

    // 2. Digest in the proven allowlist → a genuine quiet day. EXACT match only; no
    //    structural heuristic may reach this branch (see KNOWN_EMPTY_DAY_DIGESTS).
    const digest = bodyDigest(bytes);
    if ((cfg.knownEmptyDayDigests ?? KNOWN_EMPTY_DAY_DIGESTS).has(digest)) return { kind: 'empty' };

    // 3. Everything else FAILS, loudly and typed. The old code handed these to
    //    read835Files, which filtered them to [] — indistinguishable from a quiet day.
    //    Reported with the DERIVED digest, byte count, shape tag and the prose-marker
    //    diagnostic ONLY — never a byte of the body.
    const markerMatched = matchesDocumentedMarker(bytes);
    const shape = classifyBodyShape(bytes);
    // The drift bucket is deliberately NARROW: non-empty, short, printable, and of
    // UNIDENTIFIED shape. An HTML session-expired page or a JSON error envelope is a
    // service fault, NOT a reworded no-data message, and must not land here — this bucket
    // is a review queue whose implied action is "consider allowlisting this digest as
    // empty", so admitting error pages would train exactly the wrong reflex and let a
    // 200-with-an-error be promoted to "no remittances". Those go to 'unrecognized_body'.
    if (
      bytes.length > 0 &&
      bytes.length <= SHORT_TEXT_MAX_BYTES &&
      isPrintableAscii(bytes) &&
      shape === 'unknown'
    ) {
      // The drift bucket. A short printable body that is not an allowlisted digest is
      // most likely CMD having reworded its no-data message — but it could equally be a
      // service error served with HTTP 200, and those two MUST NOT be conflated. So this
      // is a failure, and the operator decides: if marker_matched is true (or the wording
      // is otherwise recognisable), add the digest to KNOWN_EMPTY_DAY_DIGESTS.
      throw new CmdEra835Error(
        'unrecognized_short_text',
        `CMD download-835: HTTP 200 with a short text body that is not an allowlisted ` +
          `empty-day payload (shape=${shape}, ${bytes.length} bytes, sha256=${digest}, ` +
          `documented_marker_matched=${markerMatched}). If this IS a quiet-day message, ` +
          'add that digest to KNOWN_EMPTY_DAY_DIGESTS in src/collections/cmd835.ts. ' +
          'It is NOT treated as empty until you do — deliberately, so a 200-with-an-error ' +
          'can never masquerade as "no remittances".',
        200,
        shape,
        { digest, byteLength: bytes.length, markerMatched },
      );
    }
    throw new CmdEra835Error(
      'unrecognized_body',
      `CMD download-835: HTTP 200 with an unrecognized body (shape=${shape}, ${bytes.length} bytes, ` +
        `sha256=${digest}; not a ZIP and not an allowlisted empty-day payload)`,
      200,
      shape,
      { digest, byteLength: bytes.length, markerMatched },
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
