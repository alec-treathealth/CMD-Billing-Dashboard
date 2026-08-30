/**
 * COMMITTED READ-ONLY KIPU DIAGNOSTIC. Tracked on purpose; runs only when you run it.
 *
 * ⚠ THIS FILE USED TO SAY "THROWAWAY — DO NOT COMMIT" while being tracked in git. It was
 * written as a one-shot topology probe, then earned a second job and never had its header
 * rewritten. Corrected 2026-08-26. What it actually is now:
 *
 *   1. TOPOLOGY PROBE (--live) — the original job. Answers whether one credential reaches
 *      every Treat company as a location, or whether each company is its own instance.
 *   2. AUTH DISCRIMINATOR (--diagnose) — six contrasting single calls (A-F) plus one
 *      census scope check, separating causes of a Kipu 403 that are indistinguishable
 *      from any one call. One call each, no retries.
 *
 * IT IS OUTSIDE THE FIVE-COMMAND GATE, DELIBERATELY. Every mode makes live network calls
 * against a third-party API, so it can never run in `npm test`. The one part that IS
 * gate-covered is the part that must never drift: `kipuSignature` / `kipuCanonicalString`
 * and `interpretDiagnosis` are exported and pinned by `test/kipuSignature.test.ts`, which
 * is hermetic and asserts the published worked-example vector bit for bit.
 *
 * ⚠ AN AUTH ATTEMPT IS NOT FREE. --diagnose spends six authentications plus one census
 * call, and a client many consecutive failures deep can enter a lockout that is
 * indistinguishable from a wrong key. There is no retry loop anywhere in this file and
 * none should be added: a 403 here is never transient. Prefer re-reading a recorded run
 * over re-running — that is why the verdict lives in a pure, unit-tested function.
 *
 * ROUTES IT CALLS. The two probe routes are NON-PHI config routes:
 *   GET /api/locations    -> location_id, location_name, enabled   (the facility roster)
 *   GET /api/care_levels  -> care_level_name, hours, days_of_the_week, billable,
 *                            consider_as, selected_billing_code, locations[]
 *                            (this is the mock's hardcoded LOC_CONFIG, owned by Kipu)
 *
 * --diagnose ADDS ONE PHI-BEARING ROUTE, AND IT IS GUARDED IN CODE:
 *   GET /api/patients/census?phi_level=high  -> the exact route Kipu documents its own
 *                            signing against. It is called ONLY under --diagnose, and only
 *                            to prove whether the credential works somewhere while
 *                            /locations does not.
 *
 * ⚠ CENSUS RETURNS PHI, AND ITS BODY IS WITHHELD AT EVERY STATUS. `censusScopeCheck` reads
 * the raw bytes and reports only the LENGTH — there is no `.text()` and no `toString()`
 * anywhere in that function, so no status can put a patient field on stdout.
 *
 * An earlier version decoded non-200 bodies, reasoning that Kipu's error bodies are small
 * and non-PHI. That reasoning is wrong and was removed: a status code is not evidence about
 * a body's CONTENTS, and a 4xx/5xx from a PHI-bearing endpoint can echo a query, an upstream
 * trace, or a partial payload. If you edit that function, DO NOT reintroduce a PRINT of the
 * body at any status.
 *
 * A non-200 body IS decoded into a local and matched against `KNOWN_KIPU_ERRORS`, a fixed
 * allowlist of strings we have already observed, and then discarded — only the matched LABEL
 * is printed. That is what restores this route's actual purpose: telling whether census
 * fails the SAME way as control A (credential-level) or a DIFFERENT way (per-route
 * disabling), which a status code alone cannot distinguish because both are 403. An
 * unrecognised body prints nothing about its contents.
 *
 * WHAT IT DOES NOT DO:
 *   - No database connection of ANY kind. Not a read, not a temp table, not a transaction.
 *   - No episode/evaluation/group-session call, and no PHI body is ever printed or parsed.
 *   - No writes to Kipu. GET only. There is no POST/PATCH path in this file.
 *   - No secret, no access_id, and no full app_id ever reaches stdout — including the
 *     deliberately-corrupted copies the --diagnose controls build.
 *
 * PHI DISCIPLINE: stdout carries facility names, level-of-care names, billing codes and
 * counts. Those are business identifiers, not patient identifiers. If a future edit makes
 * this script parse an episode route, it stops being safe to run casually — write a new
 * probe instead of widening this one.
 *
 * ⚠ THAT INSTRUCTION WAS FOLLOWED, AND IT IS WHY SEVEN HELPERS BELOW ARE `export`ed.
 * `scripts/probe-kipu-group-sessions.ts` (added 2026-08-30) probes the PHI-BEARING
 * `/api/group_sessions` route, so it is a SEPARATE file rather than a mode of this one —
 * exactly as the paragraph above demands. It imports `creds`, `signedUri`, `signedGet`,
 * `maskUri`, `fingerprint`, `explainStatus` and `classifyKnownError` from here so there is
 * ONE signer, ONE credential validator and ONE redactor in the repo. The export keywords
 * are load-bearing for that import; they are not leftovers, and removing one silently
 * breaks a sibling that `npm test` does not run. The signer itself stays pinned by the
 * hermetic `test/kipuSignature.test.ts`, which is what makes sharing it safe.
 *
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts          # dry run, no network
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts --live   # the two GETs
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts --live --json
 *   npx tsx --env-file=.env scripts/probe-kipu-locations.ts --diagnose  # 6-call 403 discriminator + census
 *
 * `--env-file=.env` is REQUIRED: root scripts do not auto-load .env, and without it the
 * probe exits on missing env. `tsx` is not on PATH in this repo — go through `npx`.
 *
 * Reads KIPU_TREAT_ACCESS_ID, KIPU_TREAT_SECRET_KEY and KIPU_TREAT_APP_ID — the names
 * carried in .env as of 2026-08-26, when the credential was re-issued as a matched triple.
 * Each falls back to the pre-rename unprefixed name (KIPU_ACCESS_ID / KIPU_SECRET_KEY /
 * KIPU_APP_API / KIPU_APP_ID) so an older .env still probes. Kipu calls the app id value
 * `app_id` / `recipient_id`; see the ENV NAMING note at the bottom of this file.
 *
 * The KIPU_TREAT_ prefix scopes the triple to a Kipu INSTANCE, not to a company — one
 * instance holds every Treat location, and mixing halves of two instances is what caused
 * the 403s this file was built to diagnose. Read the bottom note before touching the env.
 */
import { createHmac, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://api.kipuapi.com';

/**
 * The Authorization scheme. `api_auth` reads the DIGEST ALGORITHM out of this prefix —
 * bare `APIAuth` means SHA-1 — so this is load-bearing, not decoration. One constant so the
 * value that is SENT and the value that is DISPLAYED cannot drift apart.
 */
const AUTH_SCHEME = 'APIAuth-HMAC-SHA256';

/** Schemes we will ever print. A value not on this list is shown as a placeholder, never echoed. */
const KNOWN_SCHEMES: readonly string[] = [AUTH_SCHEME, 'APIAuth', 'APIAuth-HMAC-SHA1'];
const LIVE = process.argv.includes('--live');
const AS_JSON = process.argv.includes('--json');
const DIAGNOSE = process.argv.includes('--diagnose');
const EXPLAIN = process.argv.includes('--explain');

export type Creds = { accessId: string; secretKey: string; appId: string };

/**
 * Resolve the FIRST of `names` that is set, returning the NAME alongside the value.
 *
 * ⚠ THE NAME AND THE VALUE MUST TRAVEL TOGETHER (Qodo finding 3). Validation errors name a
 * variable for an operator to go and edit. Reporting the canonical `KIPU_TREAT_*` name for
 * a value that actually came from a legacy fallback sends them to a variable that is not
 * set, while the one carrying the stray newline sits untouched in the same file — the error
 * does not merely fail to help, it actively misdirects the fix.
 *
 * Pure and env-injected so it is testable without touching process.env.
 */
export function pickEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { name: string; value: string | undefined; tried: readonly string[] } {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined) return { name: n, value: v, tried: names };
  }
  return { name: names[0]!, value: undefined, tried: names };
}

export function creds(): Creds {
  // KIPU_TREAT_* is the current per-INSTANCE spelling; the unprefixed names are the
  // pre-2026-08-26 globals, kept as a fallback so an older .env still probes.
  // ⚠ All three must come from the SAME Kipu instance. A triple assembled from two
  // instances 403s with the same body as a disabled client — see the bottom note.
  // ⚠ RESOLVE THE NAME ALONGSIDE THE VALUE (Qodo finding 3). Every message below must name
  // the variable that ACTUALLY supplied the value. Reporting the canonical KIPU_TREAT_* name
  // for a value that came from a legacy fallback sends an operator to edit a variable that
  // is not set, while the one with the stray newline sits untouched in the same file — the
  // error actively misdirects the fix. `pick` returns the name and the value together so
  // they cannot drift apart.
  const pick = (...names: string[]) => pickEnv(process.env, names);

  // KIPU_TREAT_* is the current per-INSTANCE spelling; the unprefixed names are the
  // pre-2026-08-26 globals, kept as a fallback so an older .env still probes.
  // ⚠ All three must come from the SAME Kipu instance. A triple assembled from two
  // instances 403s with the same body as a disabled client — see the bottom note.
  //
  // Kipu's own name for the third is app_id (aka recipient_id); the retired global .env
  // spelled it KIPU_APP_API, so every spelling is accepted.
  const accessId = pick('KIPU_TREAT_ACCESS_ID', 'KIPU_ACCESS_ID');
  const secretKey = pick('KIPU_TREAT_SECRET_KEY', 'KIPU_SECRET_KEY');
  const appId = pick('KIPU_TREAT_APP_ID', 'KIPU_APP_API', 'KIPU_APP_ID');

  const missing = [accessId, secretKey, appId]
    .filter((e) => e.value === undefined)
    .map((e) => `${e.tried[0]} (or ${e.tried.slice(1).join(' / ')})`);
  if (missing.length) {
    // Never echo a value — only which name is absent.
    throw new Error(`Missing env: ${missing.join(', ')} (set in .env; never hardcode or log it)`);
  }

  // ⚠ SHAPE VALIDATION. `creds()` did none, so a value carrying a stray newline out of
  // `.env` flowed straight into the Authorization header and into every redactor that
  // assumed a well-formed shape.
  //
  // Surrounding whitespace is TRIMMED — a trailing newline is an ordinary `.env` artifact and
  // failing the run over it helps nobody. Anything left that would break the header's
  // `scheme access_id:signature` grammar is REJECTED loudly. Only the variable NAME is ever
  // named in the error; the value is never echoed, not even a fragment of it.
  //
  // This is defence in depth, NOT the fix: `authHeaderDisplay` no longer reads the access_id
  // at all, so a malformed value cannot leak through the display even if validation is
  // removed. Two independent barriers, deliberately.
  const triple = [
    { ...accessId, value: accessId.value!.trim(), isSecret: false },
    { ...secretKey, value: secretKey.value!.trim(), isSecret: true },
    { ...appId, value: appId.value!.trim(), isSecret: false },
  ];
  for (const { name, value, isSecret } of triple) {
    if (value.length === 0) throw new Error(`${name} is empty after trimming (never hardcode or log it)`);
    if (/[\s\u0000-\u001f]/.test(value)) {
      throw new Error(`${name} contains whitespace or a control character inside the value — refusing to send it`);
    }
    if (!isSecret && value.includes(':')) {
      throw new Error(`${name} contains ':' which would break the Authorization header grammar`);
    }
  }
  return { accessId: triple[0]!.value, secretKey: triple[1]!.value, appId: triple[2]!.value };
}

/**
 * The canonical string Kipu signs for a GET: `,,{request_uri},{RFC1123 date}` — TWO
 * leading commas, the empty content-type and content-MD5 slots.
 *
 * EXPORTED SO IT CAN BE PINNED BY A HERMETIC TEST. `test/kipuSignature.test.ts` asserts
 * this pair reproduces Kipu's own published worked example bit for bit, using Kipu's
 * placeholder secret. That test is the artifact that stops the signing being
 * re-litigated every time a 403 appears — a 403 is an identity verdict, and the signature
 * question is closed by the vector, not by re-reading this function.
 */
export function kipuCanonicalString(requestUri: string, date: string): string {
  return `,,${requestUri},${date}`;
}

/**
 * HMAC-SHA256 of the canonical string, base64.
 *
 * `secretKey` is normally the secret STRING, hashed as raw UTF-8 bytes — that is what the
 * published vector pins. It accepts a Buffer so the --diagnose controls can test whether
 * Kipu instead keys on the DECODED bytes of a base64 secret, a question the vector cannot
 * answer (Kipu's placeholder secret is plain ASCII, not base64).
 */
export function kipuSignature(secretKey: string | Buffer, requestUri: string, date: string): string {
  return createHmac('sha256', secretKey).update(kipuCanonicalString(requestUri, date)).digest('base64');
}

/**
 * Sign an ALREADY-BUILT request_uri. The signed string and the sent string MUST be
 * byte-identical, so the caller owns the query text verbatim — including its parameter
 * ORDER. Do not switch this to URLSearchParams at call time; a reordered param is a 401,
 * and a 401 here is never retryable.
 *
 * `signatureOverride` exists ONLY for the --diagnose discriminator, which needs to send a
 * deliberately-wrong signature. It is never used on a normal call.
 */
export interface SignOpts {
  /** Send this signature instead of the computed one (control B). */
  signatureOverride?: string;
  /** HMAC with this key material instead of the secret string (controls D and F). */
  keyOverride?: string | Buffer;
  /**
   * Authorization access_id (control E). NOTE: access_id is NOT part of the canonical
   * string, so overriding it leaves the signature valid for exactly the bytes sent — which
   * is what makes E a clean identity control rather than a second signature control.
   */
  accessIdOverride?: string;
}

export function signedUri(c: Creds, requestUri: string, acceptVersion: 3 | 4, opts: SignOpts = {}) {
  const date = new Date().toUTCString(); // RFC 1123, e.g. "Thu, 21 Aug 2026 04:35:00 GMT"
  const signature = opts.signatureOverride ?? kipuSignature(opts.keyOverride ?? c.secretKey, requestUri, date);
  const accessId = opts.accessIdOverride ?? c.accessId;
  return {
    url: BASE_URL + requestUri,
    requestUri,
    date,
    signature,
    headers: {
      Accept: `application/vnd.kipusystems+json; version=${acceptVersion}`,
      Authorization: `${AUTH_SCHEME} ${accessId}:${signature}`,
      Date: date,
    } as Record<string, string>,
  };
}

export function signedGet(c: Creds, path: string, extraQuery: string[], acceptVersion: 3 | 4) {
  const query = [`app_id=${encodeURIComponent(c.appId)}`, ...extraQuery].join('&');
  return signedUri(c, `${path}?${query}`, acceptVersion);
}

/**
 * A short, non-reversible fingerprint so two credential sets can be told apart across runs
 * (and compared against another integration's) WITHOUT any value reaching stdout.
 * app_id is an identifier that travels in the clear as a query param, not a secret like
 * secret_key — but it still does not belong in a shared terminal or a pasted log.
 */
export function fingerprint(v: string): string {
  return `len=${v.length} last4=…${v.slice(-4)} md5_8=${createHash('md5').update(v).digest('hex').slice(0, 8)}`;
}

/** Mask the app_id value inside a request_uri before it is ever printed. */
export function maskUri(uri: string): string {
  const masked = uri.replace(/app_id=[^&]*/g, 'app_id=[REDACTED]');
  // ⚠ FAIL CLOSED, because String.replace FAILS OPEN. It returns its input UNCHANGED when
  // the pattern does not match, so a URI whose app_id is shaped unexpectedly would be
  // printed verbatim by a function whose whole job is to redact it. Verify the invariant
  // rather than trusting the substitution: if any app_id= survives with a value, withhold
  // the entire string. A withheld URI costs a diagnostic; a leaked one costs an identifier.
  if (/app_id=(?!\[REDACTED\])/.test(masked)) return '[URI WITHHELD — app_id could not be masked]';
  return masked;
}

/**
 * The Authorization header as it is SAFE to display — CONSTRUCTED from fields we already
 * hold, never parsed back out of the assembled header.
 *
 * ⚠ THIS REPLACES A FAIL-OPEN REGEX MASK (Qodo finding 2). The previous version ran
 * `.replace(/^(\S+)\s+([^:]+):(.*)$/, …)` over the assembled header. `String.replace`
 * returns its input UNCHANGED when the pattern does not match, so any access_id that broke
 * the pattern — a trailing newline out of `.env` is enough, and `creds()` did no shape
 * validation — printed the FULL access ID and signature, under a comment promising neither
 * would ever reach stdout. A redactor that emits its input on the unhappy path is worse
 * than none, because it is trusted.
 *
 * The access_id is not read here AT ALL, so no input shape can leak it. The scheme is
 * echoed only when it matches a fixed allowlist — the printed value is chosen from a table,
 * never taken from the header.
 */
export function authHeaderDisplay(headerValue: string, signature: string): string {
  const scheme = KNOWN_SCHEMES.find((k) => headerValue.startsWith(k + ' ')) ?? '[UNRECOGNISED SCHEME]';
  const sig = typeof signature === 'string' && signature.length > 0
    ? `${signature.slice(0, 8)}…`
    : '[SIGNATURE UNAVAILABLE]';
  return `${scheme} [ACCESS_ID REDACTED]:${sig}`;
}

/**
 * The Kipu error bodies we have actually OBSERVED, matched exactly and reported by LABEL.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN PRINTING THE BODY. The census route is PHI-bearing, so its
 * body must never reach stdout at any status. But withholding it entirely also destroyed the
 * one signal that route was added to produce: whether census fails the SAME way as control A
 * (credential-level) or a DIFFERENT way (per-route disabling). A status code alone cannot
 * tell those apart — both are 403.
 *
 * So the body is decoded into a local, compared against this fixed list, and DISCARDED. Only
 * the matched label is printed. An unrecognised body prints nothing about its contents — the
 * allowlist can only ever confirm a string we already knew, never reveal a new one.
 */
const KNOWN_KIPU_ERRORS: readonly { needle: string; label: string }[] = [
  { needle: 'API Client app failed to authenticate', label: 'credential rejected — same body as control A' },
  { needle: 'Invalid or Missing Recipient', label: 'unknown app_id — same body as control C' },
  { needle: 'API Client app not found', label: 'unknown access_id — same body as control E' },
];

/** Matched label, or null when the body is not one we have seen. NEVER returns body text. */
export function classifyKnownError(body: string): string | null {
  for (const k of KNOWN_KIPU_ERRORS) if (body.includes(k.needle)) return k.label;
  return null;
}

export function explainStatus(status: number): string {
  if (status === 200) return 'OK';
  if (status === 401) return 'SIGNING — the signed request_uri did not match what was sent (never retry; fix the canonical string)';
  if (status === 403)
    return (
      'AUTHENTICATION FAILED — and it is NOT necessarily an identity problem. FOUR causes look ' +
      'identical in the body: (a) CLIENT-SIDE SIGNATURE/SCHEME MISMATCH — check this FIRST, it is ' +
      'the cheapest to rule out and it is what actually bit us on 2026-08-30; (b) the triple is ' +
      'mixed across API clients/instances; (c) the app_id is not enabled as an active API client ' +
      'on this instance; (d) the EMR user behind the key lacks access to this resource. Uniform ' +
      '403s on every route point at (a), (b) or (c); per-route 403s point at (d).\n' +
      '      ⚠ (a) IS THE ONE THIS SCRIPT USED TO MISS. The Authorization scheme is not decoration: ' +
      'api_auth reads the DIGEST ALGORITHM out of the prefix. Bare `APIAuth` means SHA-1, so a ' +
      'correctly-computed SHA-256 signature sent under it is verified against the wrong algorithm ' +
      'and fails every time, with a body that reads like a provisioning failure. The scheme must be ' +
      '`APIAuth-HMAC-SHA256`. Run --explain to print the scheme actually being sent.'
    );
  if (status === 404) return 'BAD URI or unsupported for this method';
  if (status === 410) return 'ENDPOINT DISABLED for this Kipu instance — stop calling it';
  if (status === 422) return 'UNPROCESSABLE';
  if (status === 502) return 'Kipu is down or upgrading — back off hard';
  if (status === 503 || status === 504) return 'TRANSIENT — retry with backoff';
  return 'unexpected';
}

type LocationRow = { location_id: number; location_name: string; enabled: boolean };
type CareLevelRow = {
  care_level_id: number;
  care_level_name: string;
  hours?: string;
  billable?: string;
  consider_as?: string;
  days_of_the_week?: Record<string, string>;
  place_of_service?: string;
  selected_billing_code?: Record<string, string>;
  claim_format?: string;
  locations?: { id: number; name: string }[];
};

async function call(label: string, req: ReturnType<typeof signedGet>): Promise<unknown | null> {
  const started = Date.now();
  const res = await fetch(req.url, { method: 'GET', headers: req.headers });
  const ms = Date.now() - started;
  console.log(`\n[${label}] HTTP ${res.status} ${explainStatus(res.status)}  (${ms}ms)`);
  const text = await res.text();
  if (res.status !== 200) {
    // Error bodies from Kipu are small and non-PHI on these two config routes.
    console.log(`  body: ${text.slice(0, 400)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.log(`  ⚠ non-JSON body (first 200 chars): ${text.slice(0, 200)}`);
    return null;
  }
}

/* ══════════════════ THE THREE-WAY 403 DISCRIMINATOR (--diagnose) ══════════════════
 *
 * A 403 from Kipu is an IDENTITY verdict with at least three causes that look identical
 * in the body. Our signing is not one of them: `test/kipuSignature.test.ts` pins it to
 * Kipu's own published vector. So the remaining question is which Kipu-side condition we
 * are in, and one probe cannot answer it — three CONTRASTING probes can.
 *
 *   A  real app_id, real signature          (the call that fails today)
 *   B  real app_id, CORRUPTED signature     (what "bad signature" looks like here)
 *   C  CORRUPTED app_id, valid signature over the corrupted URI
 *
 * B and C are the controls. A is only interpretable next to them:
 *   A == C, both != B  -> Kipu does not RECOGNISE this app_id. Provisioning: the record
 *                         is Active in the UI but the app is not enabled on the API tier.
 *   A == B             -> Kipu is rejecting our SIGNATURE. Given the pinned vector, that
 *                         means the SECRET VALUE is wrong, not the algorithm.
 *   all three equal    -> the response is indiscriminate. It tells us nothing; say so.
 *
 * ONE call each. No retries — a 403 is not transient, and a retry loop against an auth
 * endpoint is how an integration gets rate-limited or locked.
 */

/**
 * Flip the FIRST character to a different one from the same alphabet. First, not last, so
 * a base64 signature never has its `=` padding mutated (which would change the failure
 * mode from "wrong signature" to "malformed header"). The mutated value is a local copy
 * and is NEVER printed or logged.
 */
function flipOne(v: string): string {
  if (!v) return v;
  const repl = v[0] === 'A' ? 'B' : 'A';
  return repl + v.slice(1);
}

interface CallResult { label: string; status: number; body: string; ms: number; transportError?: boolean }

/** One GET. Prints status, body VERBATIM, elapsed ms. Nothing else. */
async function oneCall(label: string, req: ReturnType<typeof signedUri>): Promise<CallResult> {
  const t0 = Date.now();
  let status = 0;
  let body = '';
  let transportError = false;
  try {
    const res = await fetch(req.url, { headers: req.headers, method: 'GET' });
    status = res.status;
    body = (await res.text()).trim();
  } catch (e) {
    // ⚠ A TRANSPORT FAILURE IS NOT A VERDICT. It is flagged rather than left as a bare
    // status 0, because two failed calls would otherwise compare EQUAL to each other and
    // the interpreter would read a network outage as "these controls agree".
    transportError = true;
    body = `network error: ${e instanceof Error ? e.message : 'unknown'}`;
  }
  const ms = Date.now() - t0;
  console.log(`\n[${label}]`);
  console.log(`  uri    : ${maskUri(req.requestUri)}`);
  console.log(`  status : ${transportError ? 'n/a (transport error)' : status}`);
  console.log(`  body   : ${body}`);
  console.log(`  ms     : ${ms}`);
  return { label, status, body, ms, transportError };
}

async function diagnose(c: Creds): Promise<void> {
  const PATH = '/api/locations';
  const V = 3 as const;
  // ONE Accept version across all three so the only variable is the credential material.
  const realUri = `${PATH}?app_id=${encodeURIComponent(c.appId)}&include_buildings=false`;
  const corruptUri = `${PATH}?app_id=${encodeURIComponent(flipOne(c.appId))}&include_buildings=false`;

  console.log('\n=== THREE-WAY 403 DISCRIMINATOR ===');
  console.log(`  endpoint: GET ${PATH} (Accept version=${V}) — one call each, no retries`);

  const a = await oneCall('A  real app_id, real signature', signedUri(c, realUri, V));

  // B: sign correctly, then corrupt the signature we send. The mutated signature is never printed.
  const bReq = signedUri(c, realUri, V);
  const b = await oneCall(
    'B  real app_id, CORRUPTED signature',
    signedUri(c, realUri, V, { signatureOverride: flipOne(bReq.signature) }),
  );

  // C: corrupt the app_id, then sign THAT uri, so the signature is internally valid for
  // exactly the bytes we send. This isolates "unknown app_id" from "bad signature".
  const cRes = await oneCall('C  CORRUPTED app_id, valid signature over it', signedUri(c, corruptUri, V));

  /* ── Second wave: separate "wrong access_id" from "wrong key material" ──────────
   * A == B told us the signature is being rejected; it did NOT tell us why, because
   * Kipu looks the secret up BY access_id and both a bad access_id and a bad secret
   * surface as the same failed-to-authenticate body. D and F test the key material
   * (the vector cannot: Kipu's placeholder secret is plain ASCII, ours is padded
   * base64 decoding to 64 bytes). E tests the identity half.
   */
  const d = await oneCall(
    'D  secret base64-DECODED to 64 raw bytes as HMAC key',
    signedUri(c, realUri, V, { keyOverride: Buffer.from(c.secretKey, 'base64') }),
  );
  const e = await oneCall(
    'E  CORRUPTED access_id, everything else real',
    signedUri(c, realUri, V, { accessIdOverride: flipOne(c.accessId) }),
  );
  const f = await oneCall(
    "F  secret with '==' padding stripped, as a string key",
    signedUri(c, realUri, V, { keyOverride: c.secretKey.replace(/=+$/, '') }),
  );

  console.log('\n=== INTERPRETATION ===');
  for (const line of interpretDiagnosis({ a, b, c: cRes, d, e, f })) console.log(line);
}

/** The minimum a control result needs for the verdict. */
export interface ProbeOutcome {
  status: number;
  body: string;
  /** True when the request never completed. Such a result is NOT an authentication verdict. */
  transportError?: boolean;
}

/**
 * The only statuses that are an ANSWER to "did this credential authenticate".
 *
 * ⚠ EVERYTHING ELSE IS NOT A VERDICT AND MUST NOT BE COMPARED. The six controls are
 * independent sequential calls, so a partial outage can mix real 403s with synthetic
 * failures — and because the interpreter works by EQUALITY, two failed calls would compare
 * equal to each other and manufacture agreement out of an outage. A 502, a 410, a 404 or a
 * transport error each say something about the ENDPOINT, not about the credential.
 */
const AUTH_INTERPRETABLE: ReadonlySet<number> = new Set([200, 401, 403]);

function isInterpretable(r: ProbeOutcome): boolean {
  return r.transportError !== true && AUTH_INTERPRETABLE.has(r.status);
}

/**
 * The whole verdict, as a PURE function so it can be asserted against a recorded matrix
 * without spending another authentication attempt. That matters here specifically: this
 * client is many consecutive failed auths deep, and re-running --diagnose to check a
 * wording change would itself be a cost. See test/kipuSignature.test.ts.
 */
export function interpretDiagnosis(r: {
  a: ProbeOutcome; b: ProbeOutcome; c: ProbeOutcome;
  d: ProbeOutcome; e: ProbeOutcome; f: ProbeOutcome;
}): string[] {
  const same = (x: ProbeOutcome, y: ProbeOutcome) => x.status === y.status && x.body === y.body;
  const out: string[] = [];

  // ── VALIDITY GATE. Runs before any equality comparison. ────────────────────────────
  // A control that did not return an authentication verdict cannot participate in one.
  // Reporting INDETERMINATE here is the whole point: a half-answered matrix that still
  // prints "SIGNATURE" or "IDENTITY CONFIRMED" is worse than no matrix, because both
  // conclusions would rest on comparisons against a result that means nothing.
  const LABELS: Record<string, string> = {
    a: 'A (real/real)',
    b: 'B (corrupted signature)',
    c: 'C (corrupted app_id)',
    d: 'D (decoded 64-byte key)',
    e: 'E (corrupted access_id)',
    f: 'F (padding-stripped key)',
  };
  const unusable = (Object.keys(LABELS) as (keyof typeof r)[]).filter((k) => !isInterpretable(r[k]));
  if (unusable.length > 0) {
    out.push('  > INDETERMINATE — THE MATRIX IS INCOMPLETE, SO NO VERDICT IS DERIVED.');
    for (const k of unusable) {
      const x = r[k];
      out.push(
        `    ${LABELS[k]}: ${x.transportError ? 'transport error' : `HTTP ${x.status}`} — not an authentication verdict`,
      );
    }
    out.push('    These controls answer for the ENDPOINT, not the credential. Comparing them by');
    out.push('    equality would let an outage masquerade as agreement between controls.');
    out.push('    Re-run --diagnose once the endpoint is reachable; do not read the rows above.');
    return out;
  }

  const ab = same(r.a, r.b), ac = same(r.a, r.c);

  out.push(`  A == B ? ${ab ? 'YES' : 'no'}      A == C ? ${ac ? 'YES' : 'no'}      B == C ? ${same(r.b, r.c) ? 'YES' : 'no'}`);

  if (ab && ac) {
    out.push('  > INDETERMINATE. All three responses are identical, so this endpoint does not');
    out.push('    discriminate a bad signature from an unknown app_id. Read nothing into it.');
  } else if (ac && !ab) {
    out.push('  > PROVISIONING. A matches C (a bogus app_id) and both differ from B (a bad');
    out.push('    signature). Kipu does not RECOGNISE our app_id. Kipu-side action, not code.');
  } else if (ab && !ac) {
    out.push('  > SIGNATURE. A matches B (a deliberately corrupted signature), so Kipu is');
    out.push('    rejecting what we signed — while our app_id IS recognised (C differs).');
    out.push('    ⚠ CHECK THE AUTHORIZATION SCHEME FIRST (run --explain). The published vector in');
    out.push('    test/kipuSignature.test.ts pins our HMAC MATH, but it says nothing about the');
    out.push('    scheme we send it under, and api_auth reads the digest algorithm from that');
    out.push('    prefix: bare `APIAuth` = SHA-1, so a perfect SHA-256 signature still fails.');
    out.push('    That was the real cause on 2026-08-30. Only after the scheme is confirmed');
    out.push('    `APIAuth-HMAC-SHA256` does the variable become KEY MATERIAL or the secret VALUE.');
  } else {
    out.push('  > UNEXPECTED SHAPE. A differs from both controls. Read the bodies directly.');
  }

  out.push('');
  out.push('  --- key material and identity controls ---');
  const tag = (x: ProbeOutcome) =>
    same(x, r.a) ? 'same as A' : same(x, r.c) ? 'same as C (unknown app_id)' : 'DISTINCT';
  const mark = (x: ProbeOutcome) => (x.status === 200 ? '*** HTTP 200 ***' : `HTTP ${x.status}`);
  out.push(`  D (decoded 64-byte key)  : ${mark(r.d)} ${tag(r.d)}`);
  out.push(`  E (corrupted access_id)  : ${mark(r.e)} ${tag(r.e)}`);
  out.push(`  F (padding-stripped key) : ${mark(r.f)} ${tag(r.f)}`);
  out.push('');

  if (r.d.status === 200 || r.f.status === 200) {
    out.push('  > KEY MATERIAL WAS THE BUG. A control returned 200 — the secret VALUE is fine');
    out.push('    and our derivation was wrong. Change the derivation; do not re-pull.');
    return out;
  }

  const keyAxisExhausted = same(r.d, r.a) && same(r.f, r.a);

  // ⚠ ONE CONTROL PER HALF, AND NEITHER SPEAKS FOR THE OTHER.
  //
  // E (a bogus access_id) can only ever discriminate the ACCESS_ID; C (a bogus app_id) can
  // only ever discriminate the APP_ID. This used to claim BOTH halves off E alone, and its
  // own sentence asserted the app_id half — "and so does a bogus app_id" — without testing
  // it. On a provisioning matrix (A == C, E distinct) that produced two contradictory
  // verdicts in one report: PROVISIONING above saying the app_id is unrecognised, and
  // IDENTITY CONFIRMED below saying it is.
  const accessIdRecognised = !same(r.e, r.a);
  const appIdRecognised = !same(r.c, r.a);

  if (accessIdRecognised && appIdRecognised) {
    out.push('  > IDENTITY IS CONFIRMED ON BOTH HALVES. A bogus access_id answers differently');
    out.push(`    from ours (${mark(r.e)}), and so does a bogus app_id (${mark(r.c)}). Kipu knows`);
    out.push('    this client. Identity is NOT the problem.');
  } else if (accessIdRecognised && !appIdRecognised) {
    out.push('  > ACCESS_ID RECOGNISED, APP_ID NOT. A bogus access_id answers differently from');
    out.push(`    ours (${mark(r.e)}), but a bogus app_id answers the SAME as ours — so Kipu`);
    out.push('    does not recognise the app_id. This agrees with the PROVISIONING verdict above.');
  } else if (!accessIdRecognised && appIdRecognised) {
    out.push('  > APP_ID RECOGNISED, ACCESS_ID INCONCLUSIVE. A bogus app_id answers differently');
    out.push('    from ours, but a bogus access_id does not, so this matrix cannot separate a');
    out.push('    wrong access_id from a wrong secret.');
  } else {
    out.push('  > IDENTITY INCONCLUSIVE ON BOTH HALVES. Neither a bogus access_id nor a bogus');
    out.push('    app_id is distinguishable from the real one here, so neither control can');
    out.push('    separate a wrong identity from a wrong secret.');
  }

  if (keyAxisExhausted) {
    out.push('');
    out.push('  STOP. Every key derivation we can construct (raw string, decoded bytes,');
    out.push('  padding-stripped) produces the SAME rejection as A. The key-material axis is');
    out.push('  exhausted and the matrix has stopped yielding signal. This client is now many');
    out.push('  consecutive failed auths deep, and an undocumented lockout would be');
    out.push('  INDISTINGUISHABLE from a wrong key from here on.');
    out.push('  DO NOT WIDEN THE MATRIX. Escalate to Kipu with these results.');
  }
  return out;
}



/* ─────────────────── endpoint-scope check: Kipu's OWN worked-example route ───────────
 * If /locations and /care_levels were individually disabled on this instance while the
 * credential is otherwise fine, census is where that shows: it is the exact route Kipu
 * documents its signing against.
 *
 * ⚠ CENSUS RETURNS PHI. The 200 branch below never decodes the body to text — it reads
 * the raw bytes and reports only the LENGTH. There is no code path on a 200 that can put
 * a patient field, or any count derived from patient records, on stdout. Error bodies are
 * small and non-PHI, so the non-200 branch may print them.
 */
async function censusScopeCheck(c: Creds): Promise<void> {
  // Parameter order mirrors Kipu's published example exactly: phi_level THEN app_id.
  const uri = `/api/patients/census?phi_level=high&app_id=${encodeURIComponent(c.appId)}`;
  const req = signedUri(c, uri, 3);
  console.log('\n=== ENDPOINT-SCOPE CHECK: GET /api/patients/census (Kipu\'s own example route) ===');
  console.log(`  uri    : ${maskUri(req.requestUri)}`);
  const t0 = Date.now();
  try {
    const res = await fetch(req.url, { headers: req.headers, method: 'GET' });
    const raw = await res.arrayBuffer();
    const bytes = raw.byteLength;
    const ms = Date.now() - t0;
    // A 200 body is the PHI payload itself and is NEVER decoded. A non-200 body is decoded
    // into a local ONLY to be matched against the known-error allowlist, then discarded —
    // `decoded` is not printed, returned, or logged on any path.
    const known =
      res.status === 200 ? null : classifyKnownError(Buffer.from(raw).toString('utf8'));
    // ⚠ PHI GUARD, AND IT COVERS EVERY STATUS. The body is NEVER decoded on this route —
    // there is no `.text()` and no `toString()` anywhere in this function, at any status.
    //
    // An earlier version withheld only the 200 body and printed non-200 bodies verbatim,
    // on the theory that Kipu's error bodies are small and non-PHI. That reasoning does not
    // hold: a status code is not evidence about a body's CONTENTS. A 4xx/5xx from a
    // PHI-bearing endpoint can carry an echoed query, an upstream trace, or a partially
    // rendered payload, and by the time you have decoded it to check, it is already in the
    // process and one console.log from a transcript.
    //
    // What survives is everything diagnostically useful and nothing risky: the status, the
    // byte length, the elapsed time, and a classification drawn ONLY from a fixed
    // status-code allowlist (`explainStatus`) that never reads the response.
    console.log(`  status : ${res.status}`);
    console.log(`  body   : [WITHHELD — census is PHI-bearing at every status] bytes=${bytes}`);
    console.log(`  class  : ${explainStatus(res.status)}`);
    if (res.status !== 200) {
      console.log(`  match  : ${known ?? 'UNRECOGNISED — contents withheld, nothing inferred'}`);
    }
    console.log(`  ms     : ${ms}`);
    if (res.status === 200) {
      console.log('  ▶ census WORKS while /locations does not => the credential is fine and');
      console.log('    /locations + /care_levels are disabled for this instance (per-route).');
    }
  } catch (e) {
    console.log(`  network error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

/* ── --explain: emit exactly what this client constructs, without sending it ──────────
 * No network. Prints the five things that decide whether a signature can verify at all.
 *
 * This exists because the 403 that motivated it was invisible from the outside: the HMAC
 * math was correct and its golden-vector test passed, while the Authorization SCHEME told
 * the server to verify with a different algorithm. Nothing short of printing the
 * constructed header would have shown that, so it is kept rather than deleted.
 *
 * ⚠ ONE DEVIATION FROM "print the exact URL": the app_id is masked. This file's own
 * standing rule is that no full app_id reaches stdout, and the question --explain exists to
 * answer — "are the signed and sent strings byte-identical?" — is answered better by
 * comparing them programmatically than by eyeballing two 43-char base64 blobs. The
 * comparison below is exact; only the display is masked.
 */
function explainOneCall(c: Creds): void {
  const PATH = '/api/locations';
  const query = [`app_id=${encodeURIComponent(c.appId)}`, 'include_buildings=false'].join('&');
  const requestUri = `${PATH}?${query}`;
  const req = signedUri(c, requestUri, 3);

  // What the URL would look like if app_id were NOT percent-encoded.
  const rawQuery = [`app_id=${c.appId}`, 'include_buildings=false'].join('&');
  const rawUri = `${PATH}?${rawQuery}`;

  console.log('=== STEP 2 — what the probe constructs (no network) ===\n');

  console.log('1. CANONICAL STRING (the bytes that are HMAC-ed; secret is NOT part of it)');
  console.log(`   raw    : ${JSON.stringify(maskUri(kipuCanonicalString(req.requestUri, req.date)))}`);
  console.log(`   shape  : ,,{request_uri},{date}   leading commas = 2`);
  console.log(`   length : ${kipuCanonicalString(req.requestUri, req.date).length} chars\n`);

  console.log('2. AUTHORIZATION HEADER (signature truncated to 8)');
  const auth = req.headers['Authorization'] ?? '';
  // Built from the scheme constant and the signature signedUri already returned — the
  // assembled header is never parsed apart, so no access_id shape can leak. See
  // authHeaderDisplay.
  const shown = authHeaderDisplay(auth, req.signature);
  const scheme = KNOWN_SCHEMES.find((k) => auth.startsWith(k + ' ')) ?? '[UNRECOGNISED SCHEME]';
  console.log(`   raw    : ${JSON.stringify(shown)}`);
  console.log(`   scheme : ${JSON.stringify(scheme)}   <-- compare to the working curl`);
  console.log(`   scheme is the SHA-256 one ? ${scheme === AUTH_SCHEME}\n`);

  console.log('3. URL PASSED TO fetch()');
  console.log(`   raw    : ${JSON.stringify(maskUri(req.url))}`);
  console.log(`   signed request_uri === sent path+query ? ${req.url.endsWith(req.requestUri)}`);
  console.log(`   app_id percent-encoded in sent URL ?     ${req.url.includes(encodeURIComponent(c.appId)) && encodeURIComponent(c.appId) !== c.appId}`);
  console.log(`   encodeURIComponent CHANGES the app_id ?  ${encodeURIComponent(c.appId) !== c.appId}`);
  console.log(`   encoded-vs-raw uri byte-identical ?      ${requestUri === rawUri}`);
  console.log(`   param order (signed)                   : ${requestUri.split('?')[1]?.split('&').map((kv) => kv.split('=')[0]).join(',')}`);
  console.log(`   param order (sent)                     : ${(req.url.split('?')[1] ?? '').split('&').map((kv) => kv.split('=')[0]).join(',')}\n`);

  console.log('4. DIGEST ALGORITHM ACTUALLY USED');
  // Function names first, line numbers second: the names survive drift, the numbers do not.
  console.log(`   HMAC   : createHmac('sha256', …).digest('base64')  in kipuSignature()   (~line 143)`);
  console.log(`   SCHEME : Authorization prefix written             in signedUri()       (~line 179)\n`);

  console.log('5. DATE HEADER — one formatting call, reused?');
  console.log(`   canonical date === header Date ? ${kipuCanonicalString(req.requestUri, req.date).endsWith(req.headers['Date'] ?? '')}`);
  console.log(`   Date header    : ${JSON.stringify(req.headers['Date'] ?? '')}`);
}

async function main() {
  const c = creds();
  const appIdShape = fingerprint(c.appId);

  // NOTE: the v4 spec documents /locations with `Accept: …; version=3` (not 4) — same
  // oddity as /insurances/latest. We try 3 first, then fall back to 4, and report which
  // one the instance actually honored. That answer is worth keeping.
  const locV3 = signedGet(c, '/api/locations', ['include_buildings=false'], 3);
  const locV4 = signedGet(c, '/api/locations', ['include_buildings=false'], 4);
  const careLevels = signedGet(c, '/api/care_levels', [], 4); // app_id only; no phi_level

  console.log('=== Kipu topology probe ===');
  console.log(`mode        : ${LIVE ? 'LIVE (2–3 GETs)' : 'DRY RUN (no network)'}`);
  console.log(`access_id   : ${fingerprint(c.accessId)}`);
  console.log(`secret_key  : [set, ${c.secretKey.length} chars, not fingerprinted]`);
  console.log(`app_id      : ${appIdShape}`);
  console.log('              ▶ all three MUST come from the same Kipu API client. A triple');
  console.log('                mixed across instances authenticates as nobody → flat 403.');
  console.log(`plan        : GET ${maskUri(locV3.requestUri)}   (Accept version=3, then 4 on failure)`);
  console.log(`              GET ${maskUri(careLevels.requestUri)}   (Accept version=4)`);
  console.log('canonical   : ,,{request_uri},{RFC1123 Date}   — two leading commas, GET form');

  if (EXPLAIN) {
    explainOneCall(c);
    return;
  }

  if (DIAGNOSE) {
    // --diagnose is inherently live: it exists to contrast three real responses. It does
    // NOT fall through to the ordinary probe — 4 calls total, then stop.
    await diagnose(c);
    await censusScopeCheck(c);
    return;
  }

  if (!LIVE) {
    console.log('\nDry run only. Re-run with --live to make the calls.');
    return;
  }

  let locations = (await call('locations v3', locV3)) as { locations?: LocationRow[] } | null;
  // `honored` stays null unless a call actually returned 200 — the earlier version of this
  // script reported the LAST version TRIED, which read as evidence when both had failed.
  let honoredVersion: 3 | 4 | null = locations ? 3 : null;
  if (!locations) {
    locations = (await call('locations v4', locV4)) as { locations?: LocationRow[] } | null;
    if (locations) honoredVersion = 4;
  }

  const levels = (await call('care_levels v4', careLevels)) as { care_levels?: CareLevelRow[] } | null;

  if (AS_JSON) {
    console.log('\n--- RAW JSON ---');
    console.log(JSON.stringify({ honoredVersion, locations, levels }, null, 2));
    return;
  }

  console.log('\n=== LOCATIONS (the facility roster this credential can see) ===');
  const rows = locations?.locations ?? [];
  if (!rows.length) console.log('  (none returned)');
  for (const l of rows) {
    console.log(`  ${String(l.location_id).padStart(6)}  ${l.enabled ? 'on ' : 'OFF'}  ${l.location_name}`);
  }
  console.log(
    `  total: ${rows.length} location(s); /locations Accept version honored: ` +
      `${honoredVersion ?? 'NONE — every attempt failed, so the v3-vs-v4 question is still open'}`,
  );
  // The ONE-INSTANCE-vs-ONE-PER-COMPANY fork this block used to pose is CLOSED (resolved
  // 2026-08-27 out of band, from Kipu API Management and the webhook location picker: one
  // instance, 11 locations, one app_id). What is still OPEN is narrower and only this call
  // can answer it — whether THIS API client is scoped to all 11, and whether Kipu's 11
  // locations are the same eleven as the 11 labels in src/kipu/locations.ts. See the
  // "TWO ELEVENS" note at the bottom of this file.
  console.log('  ▶ TOPOLOGY IS ALREADY KNOWN: one instance, 11 locations, one app_id');
  console.log('    (Kipu API Management, 2026-08-27). This call answers the NARROWER');
  console.log('    question: is this API client scoped to all 11, and do those 11 match the');
  console.log('    11 labels in src/kipu/locations.ts? Those labels came from a NINE-export');
  console.log('    corpus, so a location listed above with no label there is UNMAPPED and');
  console.log('    will throw in assertKnownLabels the first time it produces a session.');

  console.log('\n=== CARE LEVELS (this replaces the mock\'s hardcoded LOC_CONFIG) ===');
  const lv = levels?.care_levels ?? [];
  if (!lv.length) console.log('  (none returned)');
  for (const l of lv) {
    const days = l.days_of_the_week
      ? Object.entries(l.days_of_the_week).filter(([, v]) => v && v !== 'false').map(([k]) => k).join('/')
      : '—';
    const code = l.selected_billing_code
      ? Object.entries(l.selected_billing_code).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')
      : '—';
    const locs = l.locations?.map((x) => x.id).join(',') ?? '—';
    console.log(
      `  ${String(l.care_level_id).padStart(6)}  ${l.care_level_name}\n` +
        `          hours=${l.hours ?? '—'}  billable=${l.billable ?? '—'}  consider_as=${l.consider_as ?? '—'}\n` +
        `          days=${days}  pos=${l.place_of_service ?? '—'}  code=${code}  claim_format=${l.claim_format ?? '—'}\n` +
        `          locations=[${locs}]`,
    );
  }
  console.log(`  total: ${lv.length} care level(s)`);
  console.log('  ▶ Compare `hours` and `days_of_the_week` against the mock\'s LOC_CONFIG');
  console.log('    (capDays / minHours) and check whether "MH OP 4 Adult" resolves via');
  console.log('    `consider_as` — that is the mock\'s own ⚠ UNRESOLVED question.');
}

// Run ONLY when executed directly. test/kipuSignature.test.ts imports the signer from this
// module, and an unguarded main() would call creds(), throw on missing env, and
// process.exit(1) out of the test runner. Same guard shape as scripts/check-context-map.ts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Never print the error object raw — a stack could carry a signed URL containing app_id.
    console.error(`probe failed: ${err instanceof Error ? err.message : 'error'}`);
    process.exit(1);
  });
}

/*
 * ENV NAMING (current as of 2026-08-27):
 *   KIPU_TREAT_ACCESS_ID / KIPU_TREAT_SECRET_KEY / KIPU_TREAT_APP_ID
 *
 * `creds()` reads these first and falls back to the unprefixed KIPU_ACCESS_ID /
 * KIPU_SECRET_KEY / KIPU_APP_API / KIPU_APP_ID so an older .env still probes. Drop the
 * fallbacks once no environment carries them — check Vercel before deleting.
 *
 * VERCEL CARRIES NO KIPU VARIABLE AT ALL, measured 2026-08-27 (`vercel env ls`, 73 rows,
 * zero case-insensitive `kipu` matches in ANY spelling — prefixed or retired). Two
 * consequences. (1) Nothing deployed depends on the unprefixed fallbacks, so they are
 * droppable whenever the last local .env is renamed; the only remaining consumer is an
 * older checkout on another machine. (2) KIPU IS LOCAL-ONLY TODAY — there is no deployed
 * Kipu code path, so shipping the poller means adding the triple to Vercel as a NEW
 * secret, not re-pointing an existing one. Do not assume it is already there.
 *
 * WHY THE PREFIX EXISTS, because it is not cosmetic: an unprefixed triple belonging to a
 * DIFFERENT Kipu instance sat in .env and was assumed to be Treat's. The app_id was
 * Treat's, the access_id and secret were not, and the mixed triple produced a week of
 * 403s that read as a provisioning failure. KIPU_TREAT_ scopes to the INSTANCE, so a
 * second instance's credentials can never be mistaken for these.
 *
 * ⚠ THAT MISMATCH IS WHAT THE A–F MATRIX WAS MEASURING, and it is why the matrix looked
 * contradictory. A == B says the SIGNATURE is rejected; C and E each answer differently
 * from A, which says Kipu recognises our app_id AND our access_id. Read as one instance
 * that is the paradox the commit message called "identity is not the problem." Read as
 * TWO instances it is simply consistent: each half was a real credential, so each was
 * recognised on its own, and the HMAC could never verify because the secret belonged to
 * the other instance. The matrix was right; the single-instance premise was wrong.
 *
 * PER-INSTANCE, NOT PER-COMPANY. The topology fork is resolved: ONE Kipu instance holds
 * every Treat location (11 as of 2026-08-27, confirmed from API Management and the
 * webhook location picker), all under one app_id. So one triple covers all of them, and
 * per-location scoping is a location_id allowlist — see src/kipu/locations.ts. Do NOT
 * introduce KIPU_TREAT_CA_* / _TX_* style per-company variables; that was a contingency
 * for a fork that did not happen.
 *
 * ⚠ THE TWO ELEVENS ARE NOT KNOWN TO BE THE SAME ELEVEN. Kipu's API Management shows 11
 * LOCATIONS. src/kipu/locations.ts holds 11 session-container LABELS — a different kind
 * of thing, measured from a NINE-export corpus, and its own header says two of them
 * ("Scott & Jenny Group Session TX", "Group Session 1") are containers rather than
 * locations and that there are "nine locations." The registry is explicitly N:1, so the
 * counts matching is not evidence the sets match. If Kipu has 11 locations and we have
 * observed 9 exports, up to two locations may never have appeared in our corpus — and
 * `assertKnownLabels` THROWS on an unmapped label, so the first session either of them
 * produces stops the pipeline by design. Only a successful GET /api/locations closes
 * this, which is exactly what the 403 has been blocking. Do not reconcile the two
 * numbers by editing either one.
 *
 * Kipu calls the app_id value `app_id`, aka `recipient_id`. .env.example carries the
 * three names with no values, so a fresh clone knows they are required.
 */
