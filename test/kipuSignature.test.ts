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
import { interpretDiagnosis, type ProbeOutcome } from '../scripts/probe-kipu-locations.js';

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

test('E matching A is reported as inconclusive, not as confirmation', () => {
  const out = interpretDiagnosis({ ...OBSERVED, e: FAILED_AUTH }).join('\n');
  assert.match(out, /E INCONCLUSIVE/);
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
