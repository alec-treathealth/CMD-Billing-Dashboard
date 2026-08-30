/**
 * GOLDEN VECTOR — Kipu request signing, pinned to Kipu's OWN published worked example.
 *
 * WHY THIS FILE EXISTS. A Kipu 403 says "Access Denied - API Client app failed to
 * authenticate", which reads like a signing failure and is not one. Every time that body
 * appears, the cheapest-looking move is to re-audit the canonical string — and that audit
 * has already been done exhaustively: five other canonical orderings, SHA-1, and a
 * base64-decoded key were each tried and each produces a DIFFERENT signature. This test
 * makes that result permanent, so a 403 can be read as the identity verdict it is instead
 * of restarting the same investigation.
 *
 * NO REAL CREDENTIAL IS INVOLVED. The secret below is Kipu's published placeholder
 * ("test_secret_key") and the app_id is the one printed in their documentation. Nothing
 * here is sensitive and nothing here touches the network — the signer is a pure function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { kipuCanonicalString, kipuSignature } from '../scripts/probe-kipu-locations.js';

// ── Kipu's published worked example, verbatim ────────────────────────────────────────
const SECRET = 'test_secret_key';
const URI = '/api/patients/census?phi_level=high&app_id=OFZdZaTiCgy5gZnjnpo-Y7pFNoQvgsLJvtQSPJpWJNM';
const DATE = 'Thu, 07 Nov 2019 20:08:59 GMT';
const EXPECTED = 'boYgaBORoufqIwn+yNU/+r6rS1Hww1UAk2JYf/JWKN8=';

test('GET canonical string is ,,{request_uri},{date} — TWO leading commas', () => {
  // The two empty slots are content-type and content-MD5, absent on a GET.
  assert.equal(kipuCanonicalString(URI, DATE), `,,${URI},${DATE}`);
});

test("reproduces Kipu's published worked-example signature bit for bit", () => {
  assert.equal(kipuSignature(SECRET, URI, DATE), EXPECTED);
});

// ── Negative controls: pin the CHOICES, not just the output ──────────────────────────
// Each of these was a real candidate during the investigation. Asserting they do NOT
// produce the vector is what stops them being re-proposed.

test('ONE leading comma does not produce the vector', () => {
  const oneComma = createHmac('sha256', SECRET).update(`,${URI},${DATE}`).digest('base64');
  assert.notEqual(oneComma, EXPECTED);
});

test('THREE leading commas do not produce the vector', () => {
  const threeComma = createHmac('sha256', SECRET).update(`,,,${URI},${DATE}`).digest('base64');
  assert.notEqual(threeComma, EXPECTED);
});

test('SHA-1 does not produce the vector — the digest is SHA-256', () => {
  const sha1 = createHmac('sha1', SECRET).update(kipuCanonicalString(URI, DATE)).digest('base64');
  assert.notEqual(sha1, EXPECTED);
});

test('a base64-DECODED key does not produce the vector — the secret is raw UTF-8 bytes', () => {
  const decoded = createHmac('sha256', Buffer.from(SECRET, 'base64'))
    .update(kipuCanonicalString(URI, DATE))
    .digest('base64');
  assert.notEqual(decoded, EXPECTED);
});

test('hex output does not produce the vector — the encoding is base64', () => {
  const hex = createHmac('sha256', SECRET).update(kipuCanonicalString(URI, DATE)).digest('hex');
  assert.notEqual(hex, EXPECTED);
});

// ── Sensitivity: every input is actually part of the signature ───────────────────────

test('a one-character change in the request_uri changes the signature', () => {
  assert.notEqual(kipuSignature(SECRET, URI.replace('high', 'higH'), DATE), EXPECTED);
});

test('a one-character change in the Date changes the signature', () => {
  assert.notEqual(kipuSignature(SECRET, URI, DATE.replace('20:08:59', '20:08:58')), EXPECTED);
});

test('a one-character change in the secret changes the signature', () => {
  assert.notEqual(kipuSignature('test_secret_keZ', URI, DATE), EXPECTED);
});

test('the signature is deterministic for a fixed (secret, uri, date)', () => {
  assert.equal(kipuSignature(SECRET, URI, DATE), kipuSignature(SECRET, URI, DATE));
});

test('importing this module does not execute the probe', () => {
  // The entry point is guarded by a direct-run check. If that guard regresses, main()
  // runs on import, calls creds(), and process.exit(1)s the whole test runner — so
  // reaching this assertion at all is the real check.
  assert.ok(typeof kipuSignature === 'function');
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * THE VERDICT LOGIC, PINNED TO THE RECORDED MATRIX.
 *
 * `interpretDiagnosis` is pure precisely so it can be asserted here. Re-running
 * --diagnose to check a wording change would spend six more authentications against a
 * client that is already many consecutive failures deep, where a lockout would be
 * indistinguishable from a wrong key. The matrix below is the ACTUAL 2026-08-26 run.
 * ════════════════════════════════════════════════════════════════════════════════════ */
import { classifyKnownError, interpretDiagnosis, type ProbeOutcome } from '../scripts/probe-kipu-locations.js';

const FAILED_AUTH: ProbeOutcome = {
  status: 403,
  body: '{"errors":"Access Denied - API Client app failed to authenticate","status_code":403}',
};
const UNKNOWN_APP_ID: ProbeOutcome = {
  status: 403,
  body: '{"errors":"Access Denied - Invalid or Missing Recipient","status_code":403}',
};
const UNKNOWN_ACCESS_ID: ProbeOutcome = {
  status: 401,
  body: '{"errors":"Access Denied - API Client app not found","status_code":401}',
};

/** The real 2026-08-26 matrix: A=B=D=F failed-auth, C unknown app_id, E unknown access_id. */
const OBSERVED = {
  a: FAILED_AUTH, b: FAILED_AUTH, c: UNKNOWN_APP_ID,
  d: FAILED_AUTH, e: UNKNOWN_ACCESS_ID, f: FAILED_AUTH,
};

test('recorded matrix -> signature verdict, not a provisioning verdict', () => {
  const out = interpretDiagnosis(OBSERVED).join('\n');
  assert.match(out, /A == B \? YES/);
  assert.match(out, /A == C \? no/);
  assert.match(out, /> SIGNATURE\./);
  assert.doesNotMatch(out, /> PROVISIONING\./);
});

test('recorded matrix -> identity confirmed on BOTH halves', () => {
  // This is the branch the live run silently fell through: E matched neither A nor C,
  // because Kipu answers an unknown access_id (401) and an unknown app_id (403) with two
  // DIFFERENT errors. "Distinct from A" is the correct test, not "equals C".
  const out = interpretDiagnosis(OBSERVED).join('\n');
  assert.match(out, /IDENTITY IS CONFIRMED ON BOTH HALVES/);
  assert.doesNotMatch(out, /E INCONCLUSIVE/);
});

test('recorded matrix -> key-material axis exhausted, escalate rather than widen', () => {
  const out = interpretDiagnosis(OBSERVED).join('\n');
  assert.match(out, /STOP\./);
  assert.match(out, /DO NOT WIDEN THE MATRIX/);
});

test('a 200 on D outranks everything else and reverses the advice', () => {
  const out = interpretDiagnosis({ ...OBSERVED, d: { status: 200, body: '[]' } }).join('\n');
  assert.match(out, /KEY MATERIAL WAS THE BUG/);
  assert.doesNotMatch(out, /DO NOT WIDEN THE MATRIX/);
});

test('E matching A is reported as inconclusive for the ACCESS_ID half, not as confirmation', () => {
  // C still discriminates here, so the app_id half is genuinely confirmed — the report must
  // say exactly that much and no more, rather than collapsing to a single verdict.
  const out = interpretDiagnosis({ ...OBSERVED, e: FAILED_AUTH }).join('\n');
  assert.match(out, /APP_ID RECOGNISED, ACCESS_ID INCONCLUSIVE/);
  assert.doesNotMatch(out, /IDENTITY IS CONFIRMED/);
});

test('an all-identical matrix is reported as indeterminate, never as a verdict', () => {
  const out = interpretDiagnosis({
    a: FAILED_AUTH, b: FAILED_AUTH, c: FAILED_AUTH,
    d: FAILED_AUTH, e: FAILED_AUTH, f: FAILED_AUTH,
  }).join('\n');
  assert.match(out, /INDETERMINATE/);
  assert.doesNotMatch(out, /> SIGNATURE\./);
  assert.doesNotMatch(out, /IDENTITY IS CONFIRMED/);
});

test('an unrecognised app_id still produces the provisioning verdict', () => {
  const out = interpretDiagnosis({
    a: FAILED_AUTH, b: UNKNOWN_APP_ID, c: FAILED_AUTH,
    d: FAILED_AUTH, e: UNKNOWN_ACCESS_ID, f: FAILED_AUTH,
  }).join('\n');
  assert.match(out, /> PROVISIONING\./);
  assert.doesNotMatch(out, /> SIGNATURE\./);
});

test('the provisioning matrix NEVER also claims both identity halves — they contradict', () => {
  // ⚠ THE REGRESSION THIS PINS. This exact matrix (A == C, E distinct from A) reached the
  // PROVISIONING branch — "Kipu does not RECOGNISE our app_id" — and then ALSO reached an
  // identity branch that asserted the app_id half off E alone, in one report. E can only
  // ever discriminate the access_id; C is the app_id's control and here it says the app_id
  // is NOT recognised.
  const out = interpretDiagnosis({
    a: FAILED_AUTH, b: UNKNOWN_APP_ID, c: FAILED_AUTH,
    d: FAILED_AUTH, e: UNKNOWN_ACCESS_ID, f: FAILED_AUTH,
  }).join('\n');
  assert.match(out, /> PROVISIONING\./);
  assert.doesNotMatch(out, /IDENTITY IS CONFIRMED ON BOTH HALVES/);
  // It should say what IS true: the access_id discriminates, the app_id does not.
  assert.match(out, /ACCESS_ID RECOGNISED, APP_ID NOT/);
});

test('both halves are confirmed only when BOTH controls discriminate', () => {
  // The real 2026-08-26 matrix: C distinct (unknown app_id error) AND E distinct (401).
  const out = interpretDiagnosis(OBSERVED).join('\n');
  assert.match(out, /IDENTITY IS CONFIRMED ON BOTH HALVES/);

  // Drop C's discrimination and the claim must weaken, not persist.
  const cBlind = interpretDiagnosis({ ...OBSERVED, c: FAILED_AUTH }).join('\n');
  assert.doesNotMatch(cBlind, /IDENTITY IS CONFIRMED ON BOTH HALVES/);

  // Drop E's and it must weaken the other way.
  const eBlind = interpretDiagnosis({ ...OBSERVED, e: FAILED_AUTH }).join('\n');
  assert.doesNotMatch(eBlind, /IDENTITY IS CONFIRMED ON BOTH HALVES/);
  assert.match(eBlind, /APP_ID RECOGNISED, ACCESS_ID INCONCLUSIVE/);

  // Neither discriminating is reported as such, not silently as confirmation.
  const blind = interpretDiagnosis({ ...OBSERVED, c: FAILED_AUTH, e: FAILED_AUTH }).join('\n');
  assert.match(blind, /IDENTITY INCONCLUSIVE ON BOTH HALVES/);
});

/* ── the validity gate: a partial outage must not become a verdict ─────────────────── */

const TRANSPORT_ERROR: ProbeOutcome = { status: 0, body: 'network error: fetch failed', transportError: true };
const BAD_GATEWAY: ProbeOutcome = { status: 502, body: '<html>upstream</html>' };

test('a transport error on ANY control makes the whole diagnosis indeterminate', () => {
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    const out = interpretDiagnosis({ ...OBSERVED, [k]: TRANSPORT_ERROR }).join('\n');
    assert.match(out, /INDETERMINATE — THE MATRIX IS INCOMPLETE/, `control ${k} did not gate`);
    assert.match(out, /transport error/);
    // No verdict of any kind may be derived from an incomplete matrix.
    assert.doesNotMatch(out, /> SIGNATURE\./);
    assert.doesNotMatch(out, /> PROVISIONING\./);
    assert.doesNotMatch(out, /IDENTITY IS CONFIRMED/);
    assert.doesNotMatch(out, /DO NOT WIDEN THE MATRIX/);
  }
});

test('a non-authentication status (502) is gated the same way as a transport error', () => {
  const out = interpretDiagnosis({ ...OBSERVED, d: BAD_GATEWAY }).join('\n');
  assert.match(out, /INDETERMINATE — THE MATRIX IS INCOMPLETE/);
  assert.match(out, /HTTP 502 — not an authentication verdict/);
  assert.doesNotMatch(out, /IDENTITY IS CONFIRMED/);
});

test('two transport errors do not compare EQUAL into a false agreement', () => {
  // The failure mode the gate exists for: equality over synthetic results would read an
  // outage as "these two controls agree", which is how an outage becomes a verdict.
  const out = interpretDiagnosis({
    a: TRANSPORT_ERROR, b: TRANSPORT_ERROR, c: TRANSPORT_ERROR,
    d: TRANSPORT_ERROR, e: TRANSPORT_ERROR, f: TRANSPORT_ERROR,
  }).join('\n');
  assert.match(out, /INDETERMINATE — THE MATRIX IS INCOMPLETE/);
  assert.doesNotMatch(out, /All three responses are identical/);
});

test('every control in the real matrix is authentication-interpretable', () => {
  // Guards the gate itself: if the recorded matrix ever stopped passing, the tests above
  // would be asserting against an indeterminate result and would silently prove nothing.
  const out = interpretDiagnosis(OBSERVED).join('\n');
  assert.doesNotMatch(out, /INDETERMINATE — THE MATRIX IS INCOMPLETE/);
});

/* ── the census known-error allowlist ─────────────────────────────────────────────────
 * The census route is PHI-bearing and its body is never printed. The allowlist is what
 * keeps the route diagnostically useful anyway: it can CONFIRM a string we already know
 * and can never reveal one we do not.
 */

test('each observed Kipu error body maps to its label', () => {
  assert.match(classifyKnownError(FAILED_AUTH.body)!, /same body as control A/);
  assert.match(classifyKnownError(UNKNOWN_APP_ID.body)!, /same body as control C/);
  assert.match(classifyKnownError(UNKNOWN_ACCESS_ID.body)!, /same body as control E/);
});

test('an UNKNOWN body yields null — the allowlist never classifies what it has not seen', () => {
  assert.equal(classifyKnownError('{"errors":"Something we have never observed"}'), null);
  assert.equal(classifyKnownError(''), null);
});

test('the allowlist NEVER returns any part of the body it was given', () => {
  // ⚠ THE PROPERTY THAT MATTERS. A label is a fixed string chosen from the table; if a
  // future edit ever interpolated the body into it, a PHI-bearing census body could reach
  // stdout through the "safe" path. Feed it a body containing a marker and assert the
  // marker cannot come back out.
  const MARKER = 'PATIENT-NAME-MARKER-9f3a';
  for (const known of [FAILED_AUTH.body, UNKNOWN_APP_ID.body, UNKNOWN_ACCESS_ID.body]) {
    const label = classifyKnownError(`${known} ${MARKER}`);
    assert.ok(label, 'a known needle inside a larger body should still match');
    assert.equal(label!.includes(MARKER), false, 'the label echoed caller-supplied text');
  }
  assert.equal(classifyKnownError(`{"errors":"${MARKER}"}`), null);
});

test('a 200 census body is never passed to the classifier at all', () => {
  // Documented as a call-site invariant: censusScopeCheck passes null for status 200 rather
  // than decoding. This asserts the classifier is not a safe place to send PHI regardless —
  // it returns null for arbitrary content, so nothing is inferred from a payload.
  assert.equal(classifyKnownError('[{"patient":"real phi payload"}]'), null);
});

/* ══════════ QODO FINDING 2 — the --explain credential mask was FAIL-OPEN ══════════════
 * `String.replace` returns its input UNCHANGED when the pattern does not match. The old
 * mask ran a regex over the assembled Authorization header, so any access_id that broke
 * the pattern — a trailing newline is enough — printed the FULL access ID and signature,
 * under a comment promising neither would ever reach stdout.
 *
 * These tests assert the ABSENCE of the credential, not the presence of a placeholder. A
 * placeholder-present assertion passes happily while the real value sits next to it.
 * ════════════════════════════════════════════════════════════════════════════════════ */
import { authHeaderDisplay } from '../scripts/probe-kipu-locations.js';

const ACCESS_ID = 'CGqj6mLOU9bwa6KO0wuFD5i70GIn9luhsq6s0coegvE';
const SIGNATURE = 'gEHjE4LZabcdefghijklmnopqrstuvwxyz0123456789=';

test('a well-formed header masks the access_id and truncates the signature', () => {
  const out = authHeaderDisplay(`APIAuth-HMAC-SHA256 ${ACCESS_ID}:${SIGNATURE}`, SIGNATURE);
  assert.equal(out.includes(ACCESS_ID), false, 'the access_id survived masking');
  assert.match(out, /^APIAuth-HMAC-SHA256 \[ACCESS_ID REDACTED\]:gEHjE4LZ…$/);
  assert.equal(out.includes(SIGNATURE), false, 'the full signature survived');
});

test('a MALFORMED access_id still leaks nothing — newline, colon and space each', () => {
  // Each of these breaks the old regex, which then returned the header verbatim.
  const malformed = {
    newline: `${ACCESS_ID}\n`,
    colon: `${ACCESS_ID}:extra`,
    space: `${ACCESS_ID} trailing`,
    leadingNewline: `\n${ACCESS_ID}`,
    empty: '',
  };
  for (const [label, id] of Object.entries(malformed)) {
    const header = `APIAuth-HMAC-SHA256 ${id}:${SIGNATURE}`;
    const out = authHeaderDisplay(header, SIGNATURE);
    assert.equal(out.includes(ACCESS_ID), false, `${label}: the access_id reached stdout`);
    assert.equal(out.includes(SIGNATURE), false, `${label}: the full signature reached stdout`);
    // And it must not have fallen back to echoing the header.
    assert.equal(out === header, false, `${label}: fell back to the raw header`);
  }
});

test('an unrecognised scheme is replaced by a placeholder, never echoed', () => {
  const out = authHeaderDisplay(`Bearer-${ACCESS_ID} ${ACCESS_ID}:${SIGNATURE}`, SIGNATURE);
  assert.match(out, /^\[UNRECOGNISED SCHEME\]/);
  assert.equal(out.includes(ACCESS_ID), false, 'the scheme path echoed caller text');
});

test('the display never reads the header for the signature — a garbage header still truncates', () => {
  // The signature comes from the SAFE field signedUri returned, not from parsing.
  const out = authHeaderDisplay('total garbage with no colon at all', SIGNATURE);
  assert.match(out, /:gEHjE4LZ…$/);
  assert.equal(out.includes(SIGNATURE), false);
});

test('a missing signature yields a placeholder rather than an empty tail', () => {
  const out = authHeaderDisplay(`APIAuth-HMAC-SHA256 ${ACCESS_ID}:`, '');
  assert.match(out, /\[SIGNATURE UNAVAILABLE\]$/);
  assert.equal(out.includes(ACCESS_ID), false);
});

test('the output is built from a fixed alphabet — no caller text can reach it', () => {
  // Property check: whatever is fed in, the result must be one of the constructed shapes.
  const poison = 'POISON-MARKER-7f3b';
  for (const header of [`APIAuth ${poison}:${poison}`, poison, `${poison} ${poison}:${poison}`]) {
    const out = authHeaderDisplay(header, 'abcdefgh');
    assert.equal(out.includes(poison), false, `caller text leaked from header "${header.slice(0, 12)}…"`);
  }
});
