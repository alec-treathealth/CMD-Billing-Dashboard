/**
 * THROWAWAY READ-ONLY ERA COVERAGE PROBE — NOT AN ARTIFACT. DO NOT COMMIT.
 *
 * PURPOSE: measure what fraction of incoming money is visible via 835 ERAs, per facility
 * and per effective-entry date (BPR16), so we can decide whether "upcoming payments" is an
 * Overview headline or a Collections secondary panel. A tile that shows 40% of the money
 * and reads as 100% is worse than no tile.
 *
 * WHAT IT DOES NOT DO:
 *   - No database connection of ANY kind. Not a read, not a temp table, not a transaction.
 *     The collections.* side of the comparison is pulled separately via Supabase MCP and
 *     joined by hand against this script's JSON output. That is what makes "no writes"
 *     structurally true rather than a promise.
 *   - No CMD call at all unless --live is passed AND the clock is inside the :41-:59 quiet
 *     window (the CMD partner session runs one report at a time; an ad-hoc call during a
 *     cron tick can consume a production cron's results poll — this has happened before).
 *   - No re-implementation of the transport or the parser. Both are imported as-is.
 *
 * PHI DISCIPLINE: stdout carries AGGREGATES ONLY — counts, sums, rates, facility codes,
 * payer names, dates. Never a member id, a patient name, a claim id, an 835 filename (they
 * can embed identifiers), or a byte of EDI. Payer names and facility codes are business
 * identifiers, not patient identifiers, and are safe.
 *
 *   tsx scripts/probe-era-coverage.ts                     # dry run — prints the call matrix
 *   tsx scripts/probe-era-coverage.ts --live              # live, default 240s budget
 *   tsx scripts/probe-era-coverage.ts --live --budget-ms 900000
 *   tsx scripts/probe-era-coverage.ts --live --start 2026-07-14 --days 7
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CmdEra835Error,
  cmdDownload835,
  read835Files,
  type CmdEra835Config,
} from '../src/collections/cmd835.js';
import { parseEra835 } from '../src/ingest/era835Parser.js';
import { ALL_CMD_CUSTOMERS, BXR_CUSTOMERS, type CmdCustomer } from '../src/collections/cmdCustomers.js';

/**
 * BXR's customer ids, DERIVED from the single roster source of truth
 * (src/collections/cmdCustomers.ts) — never a second hardcoded copy, which is exactly
 * the kind of list that drifts when a facility is added or retired.
 */
const BXR_CUSTOMER_IDS: readonly string[] = BXR_CUSTOMERS.map((c) => c.customerId);

// --- env (non-overriding; mirrors the repo CLIs) -----------------------------
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    text = readFileSync(join(here, '..', '.env'), 'utf8');
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

// --- args --------------------------------------------------------------------
interface Args {
  live: boolean;
  start?: string;
  days: number;
  budgetMs: number;
  delayMs: number;
  /** Explicit customer-id allowlist. Defaults to BXR_CUSTOMER_IDS, never the full roster. */
  customers: readonly string[];
}

function parseArgs(argv: string[]): Args {
  const a = argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    if (i >= 0 && a[i + 1]) return a[i + 1];
    const pre = a.find((x) => x.startsWith(`${flag}=`));
    return pre ? pre.slice(flag.length + 1) : undefined;
  };
  const start = val('--start');
  if (start !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    throw new Error('--start must be ISO YYYY-MM-DD');
  }
  // BXR-only is the DEFAULT roster for this script. Indigo (32 more customers) requires an
  // explicit --customers list — a 47-customer sweep is what tripped CMD's throttle on
  // 2026-07-30 (197 calls in 56s -> 60 failures -> hard 401), so the wide run is now opt-in.
  const rawCustomers = val('--customers');
  const customers = rawCustomers
    ? rawCustomers.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : BXR_CUSTOMER_IDS;
  if (customers.length === 0) throw new Error('--customers was passed but resolved to an empty list');

  return {
    live: a.includes('--live'),
    ...(start === undefined ? {} : { start }),
    days: Number(val('--days') ?? 4),
    budgetMs: Number(val('--budget-ms') ?? 240_000),
    // 1500ms, NOT the original 150ms. At 150ms the 2026-07-30 run issued ~3.5 req/s and CMD
    // throttled it into a 401. Do not lower this without evidence the API tolerates it.
    delayMs: Number(val('--delay-ms') ?? 1500),
    customers,
  };
}

// --- dates -------------------------------------------------------------------
const DAY_MS = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Default window: 7 days ending 3 days before today. The 3-day tail-cut is deliberate —
 * ERAs land late (BPR16 is the effective entry date, `date` is the CMD RECEIPT date), so a
 * window running to yesterday would show artificially thin coverage on its trailing edge and
 * read as a false negative.
 */
function windowDates(args: Args): string[] {
  const end = args.start
    ? new Date(`${args.start}T00:00:00Z`).getTime() + (args.days - 1) * DAY_MS
    : Date.now() - 3 * DAY_MS;
  const startMs = args.start ? new Date(`${args.start}T00:00:00Z`).getTime() : end - (args.days - 1) * DAY_MS;
  const out: string[] = [];
  for (let i = 0; i < args.days; i++) out.push(iso(new Date(startMs + i * DAY_MS)));
  return out;
}

// --- money in integer cents (never float-accumulate dollars) -----------------
const cents = (n: number | null): number => (n === null ? 0 : Math.round(n * 100));
const fmt = (c: number): string => (c / 100).toFixed(2);

interface Bucket {
  remits: number;
  posAchCents: number;
  posAchCount: number;
  posChkCents: number;
  posChkCount: number;
  posOtherCents: number;
  posOtherCount: number;
  zeroCount: number;
  negCents: number;
  negCount: number;
}

const emptyBucket = (): Bucket => ({
  remits: 0,
  posAchCents: 0,
  posAchCount: 0,
  posChkCents: 0,
  posChkCount: 0,
  posOtherCents: 0,
  posOtherCount: 0,
  zeroCount: 0,
  negCents: 0,
  negCount: 0,
});

function addRemit(b: Bucket, amountCents: number, method: string | null): void {
  b.remits += 1;
  if (amountCents === 0) {
    b.zeroCount += 1;
    return;
  }
  if (amountCents < 0) {
    b.negCents += amountCents;
    b.negCount += 1;
    return;
  }
  const m = (method ?? '').trim().toUpperCase();
  if (m === 'ACH') {
    b.posAchCents += amountCents;
    b.posAchCount += 1;
  } else if (m === 'CHK') {
    b.posChkCents += amountCents;
    b.posChkCount += 1;
  } else {
    b.posOtherCents += amountCents;
    b.posOtherCount += 1;
  }
}

/**
 * Per-request timeout. SINGLE SOURCE OF TRUTH — consumed both by cfgFor (the actual
 * AbortController deadline) and by the window-deadline math below, which must reserve
 * exactly this much time for a last in-flight request to finish. Two independent literals
 * here would drift, and the failure mode of that drift is a CMD call still in flight when
 * the :00 cron fires — the precise collision the quiet window exists to prevent.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** Extra headroom on top of the request timeout when backing off the window deadline. */
const WINDOW_SAFETY_MS = 2_000;

/**
 * `obs`, when passed, installs the observing fetch wrapper so a failure can be bucketed by
 * what actually happened on the wire. It records headers and error tokens only — see the
 * failure-instrumentation block below. Transport behaviour is otherwise identical.
 */
function cfgFor(customerId: string, obs?: Observation): CmdEra835Config {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdEra835Config['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else throw new Error('CMD credentials not configured (CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)');
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId,
    auth,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...(obs === undefined ? {} : { fetchImpl: observingFetch(obs) }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- failure instrumentation -------------------------------------------------
//
// WHY THIS EXISTS: two runs failed at 30% (47 customers, ~3.5 req/s) and 42% (15 BXR,
// ~0.55 req/s). Gentler pacing produced a HIGHER failure rate, so throttling is ruled out.
// A single `failed` counter cannot tell 401 from 5xx from timeout from "HTTP 200 whose body
// we did not recognize" — and that last case is the prime suspect, because CMD's documented
// empty-day response is PROSE, and a prose body that does not match the sentinel string
// becomes `unrecognized_body`, i.e. a genuinely quiet day counted as a hard failure.
//
// WHAT WE CAN AND CANNOT SEE FROM HERE. cmd835.ts is deliberately NOT modified in this pass
// (fixing the sentinel is a separate follow-up). CmdEra835Error exposes { code, status,
// shape } but not the body, its length, or the underlying socket error — `request_failed`
// flattens timeout and connection reset into one opaque code. Two probe-local seams recover
// the difference WITHOUT touching committed source and WITHOUT reading a body byte:
//
//   1. cfg.fetchImpl (a documented test seam) wraps fetch to record response HEADERS ONLY
//      (status, content-type, content-length) and, on throw, the sanitized low-level error
//      name/code — before cmd835 flattens it. The response object is passed through
//      untouched; the body is never read, cloned, or buffered here.
//   2. the byte count is parsed out of the transport's OWN unrecognized_body message, which
//      it builds from `bytes.length`. That is a message-format dependency and is marked as
//      such; it degrades to `len=?` rather than lying if the wording changes.
//
// PHI: headers, HTTP status codes, and syscall error tokens are not patient data. No body is
// read at this layer, so no EDI can reach this path even in principle. Error tokens are
// allowlist-shaped before printing so an unexpected string can never be echoed verbatim.

/** Response/error metadata for ONE call, filled by the observing fetch wrapper. */
interface Observation {
  status?: number;
  contentType?: string;
  contentLength?: string;
  /** Sanitized `err.name` from the fetch layer, e.g. 'AbortError', 'TypeError'. */
  netName?: string;
  /** Sanitized `err.code` / `err.cause.code`, e.g. 'ECONNRESET', 'UND_ERR_SOCKET'. */
  netCode?: string;
  /** False when the discriminator declined to look (real ZIP, or over the cap). */
  bodyInspected?: boolean;
  /** Exact body length in bytes, from the buffer itself — not parsed from any message. */
  bodyLen?: number;
  /** True iff EVERY byte is tab/LF/CR or 0x20-0x7E. One bit. Reveals nothing else. */
  bodyAscii?: boolean;
  /** SHA-256 hex of the raw bytes. A digest, not content — proves byte-constancy. */
  bodySha256?: string;
}

/**
 * ============================ ZERO-DISCLOSURE DISCRIMINATOR ============================
 *
 * PERMANENT PROPERTY OF THIS SEAM — NOT A ONE-OFF. DO NOT RELAX IT.
 *
 * The raw response body MUST NOT be printed, logged, written to disk, returned, or held in
 * any variable that outlives `inspectSmallBody`. Exactly three values escape this function:
 * a byte LENGTH, one BOOLEAN (all-printable-ASCII or not), and a SHA-256 DIGEST. None of
 * the three can be inverted to recover content.
 *
 * DO NOT, LATER, "HELPFULLY" ADD:
 *   - a --verbose / --debug flag that prints the body
 *   - a "first N bytes" preview, hex dump, or decoded-string sample
 *   - the buffer on the Observation, the FailureRecord, or any returned value
 * If a future failure mode genuinely needs more detail, that is a SEPARATE decision with its
 * own PHI gate and its own approval. This seam stays zero-disclosure by construction, so that
 * "does the probe ever expose a body?" has a permanent, auditable answer of NO.
 *
 * WHAT THIS CHANGE COST, STATED PLAINLY. Before it, the seam provably never read a body byte.
 * It now must, because the fetch wrapper runs BEFORE cmd835 decides whether a response is a
 * ZIP, the empty-day sentinel, or unrecognized — so "only inspect unrecognized bodies" is not
 * knowable here. Three guards keep the exposure minimal, in order:
 *   1. non-2xx and body-less responses are never touched (cmd835 throws before reading them);
 *   2. a declared Content-Length above the cap skips inspection entirely — a real ERA ZIP is
 *      KBs-to-MBs and is therefore never inspected when CMD declares its size;
 *   3. otherwise the stream is tee'd and read with a hard cap, bailing IMMEDIATELY on the
 *      `PK\x03\x04` ZIP magic in the first chunk, and on exceeding the cap.
 * Net effect: at most DISCRIMINATOR_CAP_BYTES of a NON-ZIP body is ever accumulated, and a
 * real ERA payload is dropped after at most its first chunk, unhashed and unretained.
 * ======================================================================================
 */

/**
 * Ceiling on bytes the discriminator will accumulate. Far above the observed 44-byte constant
 * and far below any real ERA payload, so the two cannot be confused and a genuine remittance
 * is never held.
 */
export const DISCRIMINATOR_CAP_BYTES = 4096;

/** One bit: is every byte printable ASCII (plus tab/LF/CR)? Never reveals WHICH bytes. */
export function isPrintableAscii(buf: Buffer): boolean {
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b >= 0x20 && b <= 0x7e) continue;
    return false;
  }
  return true;
}

/** ZIP local-file-header magic `PK\x03\x04` — the signal to stop looking immediately. */
function startsWithZipMagic(v: Uint8Array): boolean {
  return v.length >= 4 && v[0] === 0x50 && v[1] === 0x4b && v[2] === 0x03 && v[3] === 0x04;
}

/**
 * PEEK AND REPLAY. Reads the head of the response under a hard cap, records ONLY
 * {length, ascii-ness, digest} when the body is small and non-ZIP, then returns a Response
 * whose stream replays the peeked chunks followed by the untouched remainder.
 *
 * WHY NOT `tee()`: cancelling one branch of a tee'd stream does not settle while the other
 * branch is unconsumed — it deadlocks the request. A tee'd first draft hung on the very
 * first call. Peek-and-replay has no second branch and cancels nothing, so there is no
 * such stall, and cmd835's own streaming byte cap still governs the full read.
 *
 * Bytes live only in `seen`, and only long enough to be handed back to the transport that
 * was always going to read them. Nothing here decodes, prints, stores, or returns them —
 * see the block comment above.
 */
export async function inspectAndReplay(res: Response, obs: Observation): Promise<Response> {
  const reader = res.body!.getReader();
  const seen: Uint8Array[] = [];
  let total = 0;
  let inspect = true;
  let exhausted = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      seen.push(value);
      // A real ZIP is never inspected and never hashed — bail on the first chunk.
      if (total === 0 && startsWithZipMagic(value)) {
        inspect = false;
        break;
      }
      total += value.byteLength;
      if (total > DISCRIMINATOR_CAP_BYTES) {
        inspect = false;
        break;
      }
    }
  } catch {
    inspect = false;
  }

  if (inspect && exhausted) {
    const buf = Buffer.concat(seen.map((v) => Buffer.from(v)));
    obs.bodyInspected = true;
    obs.bodyLen = buf.length;
    obs.bodyAscii = isPrintableAscii(buf);
    obs.bodySha256 = createHash('sha256').update(buf).digest('hex');
    // `buf` dies here. Nothing downstream can reach the bytes.
  } else {
    obs.bodyInspected = false;
  }

  const replay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = seen.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      if (exhausted) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      // cmd835 cancels when ITS cap trips; propagate so the transfer actually stops.
      return reader.cancel(reason);
    },
  });

  return new Response(replay, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Allowlist shape for any low-level token we print. Anything else is dropped, not echoed. */
const SAFE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;
const safeToken = (v: unknown): string | undefined =>
  typeof v === 'string' && SAFE_TOKEN_RE.test(v) ? v : undefined;

/** Content-Type reduced to bare `type/subtype`; parameters and anything odd are dropped. */
function safeContentType(v: string | null): string | undefined {
  if (v === null) return undefined;
  const m = v.trim().match(/^[\w.+-]+\/[\w.+-]+/);
  return m ? m[0].toLowerCase() : undefined;
}

/**
 * fetch wrapper that records metadata into `obs` and otherwise changes NOTHING —
 * the Response is returned by reference (never cloned, never read) and errors are
 * re-thrown untouched so cmd835's own classification is unaffected.
 */
export function observingFetch(obs: Observation): typeof fetch {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    try {
      const res = await fetch(input, init);
      obs.status = res.status;
      obs.contentType = safeContentType(res.headers.get('content-type'));
      obs.contentLength = res.headers.get('content-length') ?? undefined;

      // Guard 1: cmd835 throws on non-2xx before reading, so an error body is never touched.
      if (!res.ok || !res.body) return res;
      // Guard 2: a declared size above the cap means a real payload — decline to look at all.
      const declared = Number(obs.contentLength ?? Number.NaN);
      if (Number.isFinite(declared) && declared > DISCRIMINATOR_CAP_BYTES) {
        obs.bodyInspected = false;
        return res;
      }
      // Guard 3: peek the head under a cap (bailing on ZIP magic), then replay everything to
      // cmd835. Awaited so the record is complete before classification runs; bounded, so it
      // cannot stall on a large body.
      return await inspectAndReplay(res, obs);
    } catch (err) {
      // undici wraps socket faults as `TypeError: fetch failed` with the real code on .cause.
      const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
      obs.netName = safeToken(e?.name);
      obs.netCode = safeToken(e?.code) ?? safeToken(e?.cause?.code);
      throw err;
    }
  };
}

/** Buckets that always render, even at zero, so the table is a checklist not a surprise. */
const FIXED_BUCKETS = [
  'timeout',
  'network_error',
  'unrecognized_response',
  'response_too_large',
  'invalid_date',
  'request_failed_after_headers',
  'other_unknown',
] as const;

const BUCKET_LABELS: Record<string, string> = {
  timeout: 'timeout',
  network_error: 'network_error',
  // Labelled EXACTLY this everywhere it is printed — this bucket is the hypothesis under
  // test, and collapsing it into a generic "other" is the failure mode we are correcting.
  unrecognized_response: 'unrecognized_response (possible empty-day misclassification)',
  response_too_large: 'response_too_large',
  invalid_date: 'invalid_date',
  request_failed_after_headers: 'request_failed_after_headers',
  other_unknown: 'other/unknown',
};

interface FailureRecord {
  customerId: string;
  facility: string;
  date: string;
  bucket: string;
  /** Closed-enum shape tag from the transport (unrecognized_response only). */
  shape?: string;
  /** Exact body length from the buffer at the seam. `undefined` = inspection declined. */
  bodyBytes?: number;
  /** One bit from the discriminator: every byte printable ASCII? */
  bodyAscii?: boolean;
  /** SHA-256 hex digest of the body. A digest, never content. */
  sha256?: string;
  contentType?: string;
  status?: number;
  code?: string;
  netToken?: string;
}

/**
 * Put one failure in exactly one bucket. HTTP failures bucket by EXACT status
 * (`http_401`, `http_500`) — never by range, because 401-vs-403 and 429-vs-503 imply
 * completely different causes and collapsing them is how the current blindness happened.
 */
function classifyFailure(
  err: unknown,
  obs: Observation,
  c: CmdCustomer,
  date: string,
): FailureRecord {
  const base = { customerId: c.customerId, facility: c.facilityCode, date };
  const ct = obs.contentType === undefined ? {} : { contentType: obs.contentType };

  if (err instanceof CmdEra835Error) {
    const withStatus = err.status === undefined ? {} : { status: err.status };
    switch (err.code) {
      case 'http_status':
        return {
          ...base,
          ...ct,
          ...withStatus,
          code: err.code,
          bucket: `http_${err.status ?? 'unknown'}`,
        };
      case 'unrecognized_body': {
        // Length/ascii/digest come from the discriminator at the fetch seam, which had the
        // actual bytes in hand — no dependency on the transport's message wording.
        return {
          ...base,
          ...ct,
          ...withStatus,
          code: err.code,
          bucket: 'unrecognized_response',
          ...(err.shape === undefined ? {} : { shape: err.shape }),
          ...(obs.bodyLen === undefined ? {} : { bodyBytes: obs.bodyLen }),
          ...(obs.bodyAscii === undefined ? {} : { bodyAscii: obs.bodyAscii }),
          ...(obs.bodySha256 === undefined ? {} : { sha256: obs.bodySha256 }),
        };
      }
      case 'response_too_large':
        return { ...base, ...ct, ...withStatus, code: err.code, bucket: 'response_too_large' };
      case 'invalid_date':
        return { ...base, code: err.code, bucket: 'invalid_date' };
      case 'request_failed': {
        // The transport collapses abort/timeout/network into one code. The wrapper saw the
        // real cause first, so split it back apart here.
        if (obs.netName === 'AbortError') {
          return { ...base, ...ct, code: err.code, bucket: 'timeout', netToken: obs.netName };
        }
        if (obs.netCode !== undefined || obs.netName !== undefined) {
          return {
            ...base,
            ...ct,
            code: err.code,
            bucket: 'network_error',
            netToken: obs.netCode ?? obs.netName!,
          };
        }
        // Headers arrived, then the body read failed — the wrapper never saw the throw.
        // Most likely the request timeout firing mid-transfer. Kept distinct rather than
        // guessed into `timeout`.
        if (obs.status !== undefined) {
          return {
            ...base,
            ...ct,
            status: obs.status,
            code: err.code,
            bucket: 'request_failed_after_headers',
          };
        }
        return { ...base, ...ct, code: err.code, bucket: 'network_error' };
      }
    }
  }
  // Not a transport error at all — a parser throw, or a bug in this script. If this bucket
  // is non-empty after this change, that is itself the finding.
  const name = safeToken((err as { name?: unknown })?.name);
  return {
    ...base,
    ...ct,
    bucket: 'other_unknown',
    ...(name === undefined ? {} : { netToken: name }),
  };
}

/** Fixed rows first (always, at zero if unseen), then observed http_* by numeric status. */
function orderedBuckets(tally: Map<string, number>): string[] {
  const http = [...tally.keys()]
    .filter((k) => k.startsWith('http_'))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  return [...http, ...FIXED_BUCKETS];
}

function printFailureBreakdown(tally: Map<string, number>, records: readonly FailureRecord[]): void {
  const total = [...tally.values()].reduce((a, n) => a + n, 0);
  console.log(`\n--- FAILURE BREAKDOWN (${total} total) ---`);
  const keys = orderedBuckets(tally);
  const width = Math.max(...keys.map((k) => (BUCKET_LABELS[k] ?? k).length));
  for (const k of keys) {
    const n = tally.get(k) ?? 0;
    const label = BUCKET_LABELS[k] ?? k;
    const suspect = k === 'unrecognized_response' && n > 0 ? '   <- the suspect bucket' : '';
    console.log(`  ${(label + ':').padEnd(width + 1)} ${String(n).padStart(5)}${suspect}`);
  }
  if (total === 0) console.log('  (all zero — no failures recorded)');

  // Per (facility, date) detail, unrecognized_response ONLY. shape + byte length +
  // Content-Type together are enough to tell CMD's short no-ERA prose (unknown shape,
  // tens of bytes, text/plain) from an HTML error page (looks_like_html, hundreds+ of
  // bytes, text/html) WITHOUT reading the body.
  const unrec = records.filter((r) => r.bucket === 'unrecognized_response');
  console.log(
    `\n  unrecognized_response detail (${unrec.length} row(s)) — no body content, metadata only:`,
  );
  if (unrec.length === 0) {
    console.log('    (none)');
  } else {
    for (const r of unrec) {
      const len = r.bodyBytes === undefined ? '(not inspected)' : String(r.bodyBytes).padStart(6);
      const ascii = r.bodyAscii === undefined ? '?' : String(r.bodyAscii);
      const dig = r.sha256 === undefined ? '(none)' : `${r.sha256.slice(0, 12)}…`;
      console.log(
        `    ${r.facility.padEnd(15)} ${r.date}  len=${len}  ascii=${ascii.padEnd(5)} ` +
          `sha256=${dig.padEnd(14)} shape=${(r.shape ?? '?').padEnd(15)} ct=${r.contentType ?? '(none)'}`,
      );
    }
    const lens = unrec.map((r) => r.bodyBytes).filter((n): n is number => n !== undefined);
    if (lens.length > 0) {
      const uniq = [...new Set(lens)].sort((a, b) => a - b);
      console.log(
        `    distinct byte lengths: ${uniq.join(', ')}` +
          (uniq.length <= 2
            ? '  <- a tight cluster is consistent with ONE fixed response, not varied error pages'
            : ''),
      );
    }

    // Digest census. ONE distinct digest across many (customer,date) pairs proves the body is
    // a fixed constant and therefore cannot be carrying per-patient content. MORE than one
    // falsifies "constant" and changes the analysis, so each is listed with its count.
    const digestCounts = new Map<string, number>();
    for (const r of unrec) {
      if (r.sha256 === undefined) continue;
      digestCounts.set(r.sha256, (digestCounts.get(r.sha256) ?? 0) + 1);
    }
    if (digestCounts.size === 0) {
      console.log('    distinct response digests: 0  (no body was inspected)');
    } else if (digestCounts.size === 1) {
      const [d] = [...digestCounts.keys()];
      console.log(`    distinct response digests: 1  (${d})`);
    } else {
      console.log(
        `    distinct response digests: ${digestCounts.size}  ` +
          '<- NOT a constant body; the single-fixed-response reading does NOT hold',
      );
      for (const [d, n] of [...digestCounts.entries()].sort((x, y) => y[1] - x[1])) {
        console.log(`      ${d}  x${n}`);
      }
    }

    const asciiVals = new Set(unrec.map((r) => r.bodyAscii).filter((v) => v !== undefined));
    if (asciiVals.size === 1) {
      console.log(
        asciiVals.has(true)
          ? '    ascii=true for every row -> the body is TEXT. Consistent with drifted sentinel wording.'
          : '    ascii=false for every row -> the body is BINARY. Consistent with a degenerate ZIP variant.',
      );
    }
  }

  // Beyond the spec, additive: which facilities the failures land on. This is what actually
  // answers the FRCA/TBH 4-of-4 anomaly — a facility failing 100% into a single bucket is a
  // mapping/enrollment problem, not the same phenomenon as failures sprayed across the roster.
  if (records.length > 0) {
    const byFac = new Map<string, Map<string, number>>();
    for (const r of records) {
      if (!byFac.has(r.facility)) byFac.set(r.facility, new Map());
      const m = byFac.get(r.facility)!;
      m.set(r.bucket, (m.get(r.bucket) ?? 0) + 1);
    }
    console.log('\n  failures by facility:');
    for (const [fac, m] of [...byFac.entries()].sort()) {
      const parts = [...m.entries()].sort().map(([k, n]) => `${k}=${n}`);
      console.log(`    ${fac.padEnd(15)} ${parts.join('  ')}`);
    }
  }
}

/** Milliseconds until the current :41-:59 quiet window closes (end of :59). */
function msUntilWindowClose(now: Date): number {
  const end = new Date(now);
  end.setUTCMinutes(59, 59, 999);
  return end.getTime() - now.getTime();
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const args = parseArgs(process.argv);
  const dates = windowDates(args);

  // Filter the ONE roster source by the resolved customer allowlist. Unknown ids are surfaced
  // rather than silently dropped — a typo'd id that quietly shrinks the matrix would read as
  // "that facility had no remits", which is the same class of silent-zero this whole effort
  // exists to eliminate.
  const wanted = new Set(args.customers);
  const roster: readonly CmdCustomer[] = ALL_CMD_CUSTOMERS.filter((c) => wanted.has(c.customerId));
  const found = new Set(roster.map((c) => c.customerId));
  const unknown = args.customers.filter((id) => !found.has(id));
  const isBxrDefault = args.customers === BXR_CUSTOMER_IDS;
  const matrix = roster.length * dates.length;

  console.log('=== ERA COVERAGE PROBE (read-only, no DB, no writes) ===');
  console.log(`mode          : ${args.live ? 'LIVE' : 'DRY RUN (pass --live to pull)'}`);
  console.log(`window        : ${dates[0]} .. ${dates[dates.length - 1]}  (${dates.length} days)`);
  console.log(
    `roster        : ${roster.length} of ${ALL_CMD_CUSTOMERS.length} customers ` +
      `(${isBxrDefault ? 'BXR default' : '--customers override'})`,
  );
  if (unknown.length > 0) console.log(`  !! UNKNOWN ids ignored: ${unknown.join(', ')}`);
  console.log(`call matrix   : ${matrix} (customer,date) pairs`);
  console.log(`budget        : ${args.budgetMs} ms, ${args.delayMs} ms inter-call delay`);

  if (roster.length === 0) {
    console.log('\nNo customers matched — nothing to do. No network call made.');
    return;
  }

  if (!args.live) {
    console.log('\n--- planned calls (dry run; no network) ---');
    for (const c of roster) {
      console.log(`  ${c.customerId}  ${c.facilityCode.padEnd(12)}  ${dates[0]}..${dates[dates.length - 1]}`);
    }
    console.log(`\nDRY RUN — ${matrix} calls planned, none made. Re-run with --live inside :41-:59.`);
    // Render the failure table against an empty tally. This is the scaffolding check: it
    // proves the buckets initialize, the labels resolve, and the layout holds BEFORE the
    // table is trusted to characterize real failures.
    printFailureBreakdown(new Map(FIXED_BUCKETS.map((b) => [b, 0])), []);
    console.log('  (scaffolding check — dry run makes no calls, so every bucket is 0 by construction)');
    return;
  }

  // --- quiet-window gate ----------------------------------------------------
  const now = new Date();
  const min = now.getUTCMinutes();
  if (min < 41) {
    console.log(`\nHOLD: outside the :41-:59 CMD quiet window (now :${String(min).padStart(2, '0')} UTC).`);
    console.log(`      ${41 - min} minute(s) until it opens. No network call made.`);
    return;
  }

  const startedAt = Date.now();
  // Stop launching new calls at whichever comes first: the budget, or the window close.
  //
  // The window deadline is backed off by a full REQUEST_TIMEOUT_MS (+ margin) because the
  // loop guard only prevents STARTING a call late — it cannot stop one already in flight.
  // Without this, a call issued at :59:59.5 runs its 60s timeout to :00:59.5, straight
  // across the :00 cmd-explorer cron tick. Reserving the timeout means the last call
  // issued has time to complete or abort before the window actually closes.
  const budgetDeadline = startedAt + args.budgetMs;
  const windowDeadline = startedAt + msUntilWindowClose(now) - REQUEST_TIMEOUT_MS - WINDOW_SAFETY_MS;
  const deadline = Math.min(budgetDeadline, windowDeadline);
  const deadlineReason = budgetDeadline <= windowDeadline ? 'budget' : 'window-close';

  // Started so late that even one request could not finish inside the window.
  if (windowDeadline <= startedAt) {
    console.log(
      `\nHOLD: only ${Math.round(msUntilWindowClose(now) / 1000)}s left in the :41-:59 window — ` +
        `less than one ${REQUEST_TIMEOUT_MS / 1000}s request timeout plus margin.`,
    );
    console.log('      Starting now risks a call still in flight at :00. No network call made.');
    return;
  }

  console.log(
    `deadline      : ${Math.round((deadline - startedAt) / 1000)}s from now (${deadlineReason}) ` +
      `— budget ${Math.round((budgetDeadline - startedAt) / 1000)}s, ` +
      `window ${Math.round((windowDeadline - startedAt) / 1000)}s ` +
      `(${msUntilWindowClose(now) / 1000}s to close, less ${(REQUEST_TIMEOUT_MS + WINDOW_SAFETY_MS) / 1000}s reserved)`,
  );
  console.log('');

  // The UPCOMING view. Collected into its OWN structure so the four audited aggregation maps
  // below are not touched. NOTE: unlike those maps, a row here carries facility + payer + date
  // together — see the header note on re-identification posture.
  const upcoming: Array<{
    facility: string;
    payer: string;
    bpr16: string;
    amountCents: number;
    method: string;
    /**
     * How many claims (CLP loops) this remit covers. A COUNT, never a claim id. Present to make
     * the residual re-identification risk VISIBLE rather than silent: a claims=1 row is a
     * single-patient payment amount, so a reader can choose not to repeat it in a wider-audience
     * view. Deliberately NOT a suppression rule — hiding a large single-claim remit would drop
     * real scheduled money from a report whose entire purpose is not missing incoming money.
     */
    claims: number;
  }> = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  const byFacilityDate = new Map<string, Bucket>();
  const byFacility = new Map<string, Bucket>();
  const byDate = new Map<string, Bucket>();
  const byPayer = new Map<string, Bucket>();
  let attempted = 0;
  let ok = 0;
  let empty = 0;
  let zeroFiles = 0;
  let failed = 0;
  let skipped = 0;
  let remitsNoBpr16 = 0;
  let stopReason = 'completed';

  // Categorized failure tally. `failed` above stays the grand total so the existing pulls
  // line is unchanged; these add the per-cause detail it was missing.
  const failTally = new Map<string, number>();
  for (const b of FIXED_BUCKETS) failTally.set(b, 0);
  const failRecords: FailureRecord[] = [];

  outer: for (const c of roster) {
    for (const date of dates) {
      if (Date.now() >= deadline) {
        skipped += 1;
        stopReason = deadlineReason;
        continue;
      }
      attempted += 1;
      // Fresh per call — never shared, so one call's metadata can never be attributed to
      // another's failure.
      const obs: Observation = {};
      try {
        const res = await cmdDownload835(cfgFor(c.customerId, obs), { date });
        if (res.kind === 'empty') {
          empty += 1;
          await sleep(args.delayMs);
          continue;
        }
        const files = read835Files(res.bytes, 'era'); // fallback name deliberately generic
        if (files.length === 0) {
          zeroFiles += 1;
          await sleep(args.delayMs);
          continue;
        }
        ok += 1;
        for (const f of files) {
          const parsed = parseEra835(f.edi);
          for (const tx of parsed.transactions) {
            const amt = cents(tx.payment.paymentAmount);
            const method = tx.payment.paymentMethod;
            const bpr16 = tx.payment.paymentDate;
            const payer = (tx.payment.payerName ?? '(unnamed payer)').trim().toUpperCase();

            for (const [map, key] of [
              [byFacility, c.facilityCode],
              [byPayer, payer],
            ] as const) {
              if (!map.has(key)) map.set(key, emptyBucket());
              addRemit(map.get(key)!, amt, method);
            }
            if (bpr16 === null) {
              remitsNoBpr16 += 1;
            } else {
              for (const [map, key] of [
                [byDate, bpr16],
                [byFacilityDate, `${c.facilityCode}|${bpr16}`],
              ] as const) {
                if (!map.has(key)) map.set(key, emptyBucket());
                addRemit(map.get(key)!, amt, method);
              }
              // Additive: money the payer has adjudicated but whose funds have not moved yet.
              // Zero-dollar (denial-only) and negative (reversal) remits are excluded — neither
              // is "money about to land".
              if (bpr16 > todayIso && amt > 0) {
                upcoming.push({
                  facility: c.facilityCode,
                  payer,
                  bpr16,
                  amountCents: amt,
                  method: (method ?? '').trim().toUpperCase() || 'UNKNOWN',
                  claims: tx.claims.length,
                });
              }
            }
          }
        }
      } catch (err) {
        // Record BEFORE the abort check, so the run that ends in a 401 still reports what the
        // preceding failures actually were — the exact detail both prior runs lost.
        const rec = classifyFailure(err, obs, c, date);
        failRecords.push(rec);
        failTally.set(rec.bucket, (failTally.get(rec.bucket) ?? 0) + 1);
        failed += 1;

        if (err instanceof CmdEra835Error && (err.status === 401 || err.status === 403)) {
          console.error(`\nABORT: ${err.message}`);
          console.error('Aborting the whole run rather than spraying failing calls.');
          stopReason = 'auth';
          break outer;
        }
      }
      await sleep(args.delayMs);
    }
  }

  // --- report ---------------------------------------------------------------
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const partial = skipped > 0 || stopReason === 'auth';
  console.log(`\n=== RESULT ${partial ? '(PARTIAL — see skipped)' : '(complete)'} ===`);
  console.log(`elapsed ${elapsed}s, stop reason: ${stopReason}`);
  console.log(
    `pulls: attempted ${attempted}/${matrix} — with-files ${ok}, empty-day ${empty}, ` +
      `zero-file zips ${zeroFiles}, failed ${failed}, SKIPPED ${skipped}`,
  );
  if (remitsNoBpr16 > 0) console.log(`remits with NO BPR16 (unbucketable by date): ${remitsNoBpr16}`);

  printFailureBreakdown(failTally, failRecords);

  const line = (label: string, b: Bucket) =>
    `  ${label.padEnd(24)} remits ${String(b.remits).padStart(4)} | ` +
    `ACH+ ${fmt(b.posAchCents).padStart(12)} (${b.posAchCount}) | ` +
    `CHK+ ${fmt(b.posChkCents).padStart(12)} (${b.posChkCount}) | ` +
    `other+ ${fmt(b.posOtherCents).padStart(10)} (${b.posOtherCount}) | ` +
    `zero ${String(b.zeroCount).padStart(4)} | ` +
    `neg ${fmt(b.negCents).padStart(12)} (${b.negCount})`;

  console.log('\n--- by facility ---');
  for (const [k, b] of [...byFacility.entries()].sort()) console.log(line(k, b));

  console.log('\n--- by BPR16 effective date ---');
  for (const [k, b] of [...byDate.entries()].sort()) console.log(line(k, b));

  console.log('\n--- by payer (who actually sends ERAs) ---');
  const payers = [...byPayer.entries()].sort(
    (x, y) => y[1].posAchCents + y[1].posChkCents + y[1].posOtherCents - (x[1].posAchCents + x[1].posChkCents + x[1].posOtherCents),
  );
  for (const [k, b] of payers) console.log(line(k.slice(0, 24), b));

  // --- UPCOMING: adjudicated, funds not yet moved ---------------------------
  console.log(`\n--- UPCOMING (BPR16 > ${todayIso}: scheduled but not yet landed) ---`);
  if (upcoming.length === 0) {
    console.log('  (none — every remit in this sample has a BPR16 on or before today)');
    console.log(
      '  NOTE: the default window ends 3 days back, which systematically excludes the freshest',
    );
    console.log(
      '        receipt dates — exactly where a future BPR16 would live. An empty result here is',
    );
    console.log('        expected with defaults and is NOT evidence that no money is scheduled.');
  } else {
    upcoming.sort((a, b) => a.bpr16.localeCompare(b.bpr16) || a.facility.localeCompare(b.facility));
    console.log('  facility        payer                     bpr16        amount     method  claims');
    let total = 0;
    let singleClaim = 0;
    for (const u of upcoming) {
      total += u.amountCents;
      if (u.claims === 1) singleClaim += 1;
      console.log(
        `  ${u.facility.padEnd(15)} ${u.payer.slice(0, 24).padEnd(25)} ${u.bpr16}  ` +
          `${fmt(u.amountCents).padStart(12)}  ${u.method.padEnd(7)} ${String(u.claims).padStart(5)}`,
      );
    }
    console.log(
      `  ${''.padEnd(15)} ${'TOTAL'.padEnd(25)} ${''.padEnd(10)}  ${fmt(total).padStart(12)}` +
        `  ${''.padEnd(7)} ${String(upcoming.reduce((a, u) => a + u.claims, 0)).padStart(5)}`,
    );
    if (singleClaim > 0) {
      console.log(
        `\n  NOTE: ${singleClaim} of ${upcoming.length} row(s) cover a SINGLE claim — those amounts are` +
          ' one patient\'s payment.\n        Not suppressed (that would hide real scheduled money);' +
          ' flagged so a wider-audience view can omit them.',
      );
    }
  }

  // Machine-readable, non-PHI, for joining against collections.daily_collections via MCP.
  console.log('\n--- JSON (facility, bpr16_date, positive/zero/negative) ---');
  const rows = [...byFacilityDate.entries()].map(([k, b]) => {
    const [facility, date] = k.split('|');
    return {
      facility,
      bpr16_date: date,
      remits: b.remits,
      positive_total: fmt(b.posAchCents + b.posChkCents + b.posOtherCents),
      ach: fmt(b.posAchCents),
      chk: fmt(b.posChkCents),
      other: fmt(b.posOtherCents),
      zero_count: b.zeroCount,
      negative_total: fmt(b.negCents),
    };
  });
  console.log(JSON.stringify(rows, null, 0));
  if (partial) {
    console.log(
      `\nWARNING: PARTIAL RUN — ${skipped} of ${matrix} (customer,date) pairs were never called. ` +
        'Coverage below is a FLOOR, not a rate. Re-run with a larger --budget-ms inside one window.',
    );
  }
}

await main();
