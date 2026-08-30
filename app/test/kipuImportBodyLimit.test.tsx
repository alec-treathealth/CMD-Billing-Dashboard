/**
 * QODO #11 (PR #268) — the Server Action body ceiling must EXCEED the action's own byte
 * bound, not equal it.
 *
 * `next.config.mjs` had `bodySizeLimit: '32mb'`, byte-for-byte equal to `MAX_TOTAL_BYTES`.
 * Next measures the RAW MULTIPART BODY, which is strictly larger than the files inside it, so
 * an upload at the documented ceiling was refused by Next BEFORE the action ran — the action's
 * bound was unreachable, and the rejection surfaced through the panel's `catch` as the generic
 * "could not be sent" rather than as `total-too-large`.
 *
 * ⚠ THIS TEST IS THE ONLY THING THAT CAN HOLD THE TWO IN AGREEMENT. `next.config.mjs` is a
 * `.mjs` config loaded by Next's own loader; it cannot import the TypeScript bounds, so the
 * relationship is unenforceable at the type level and a comment is all that was keeping it —
 * a comment which stated the wrong relationship for the whole life of the feature.
 *
 * Hermetic: it imports the real config object and the real constants. No server, no network.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import nextConfig from '../next.config.mjs';
import {
  MAX_BYTES_PER_FILE,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MULTIPART_OVERHEAD_ALLOWANCE,
  REQUIRED_BODY_SIZE_LIMIT_BYTES,
} from '../lib/billing-audit/kipu-import-bounds';

/**
 * Next parses this with the `bytes` package, where `mb` is a MEBIbyte (1024²) — not 10⁶.
 * Getting that wrong in either direction is a 4.8% error at this size, which is larger than
 * the entire multipart allowance, so the unit is parsed explicitly rather than assumed.
 */
function parseByteSize(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(v.trim());
  assert.ok(m, `bodySizeLimit "${v}" is not a form this test knows how to compare`);
  const n = Number(m![1]);
  const unit = m![2]!.toLowerCase();
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]!;
  return n * mult;
}

const configured = (): number => {
  const raw = nextConfig.experimental?.serverActions?.bodySizeLimit;
  assert.equal(typeof raw, 'string', 'serverActions.bodySizeLimit is missing from next.config.mjs');
  return parseByteSize(raw as string);
};

test('the body limit is STRICTLY GREATER than MAX_TOTAL_BYTES — equal is the bug', () => {
  const limit = configured();
  // Name the wrong value. `>=` was the documented rule and is exactly what shipped broken, so
  // asserting `>=` here would pass against the defect it is meant to catch.
  assert.notEqual(limit, MAX_TOTAL_BYTES, 'the body limit equals MAX_TOTAL_BYTES — Qodo #11');
  assert.ok(limit > MAX_TOTAL_BYTES, `body limit ${limit} must exceed MAX_TOTAL_BYTES ${MAX_TOTAL_BYTES}`);
});

test('the headroom covers a worst-case multipart envelope, not just one byte', () => {
  const limit = configured();
  assert.ok(
    limit >= REQUIRED_BODY_SIZE_LIMIT_BYTES,
    `body limit ${limit} is below the required ${REQUIRED_BODY_SIZE_LIMIT_BYTES}`,
  );
  assert.equal(limit - MAX_TOTAL_BYTES >= MULTIPART_OVERHEAD_ALLOWANCE, true);
});

test('a MAXIMUM-SIZE upload still fits once its multipart envelope is counted', () => {
  // The scenario the defect made impossible, priced from the action's own bounds rather than
  // from a guess: 16 parts at the worst-case header size, plus the two field parts.
  const WORST_BOUNDARY = 74; // '--' + a 70-char boundary + CRLF
  const WORST_DISPOSITION = 50 + 255; // header text + a filename at the filesystem maximum
  const WORST_CONTENT_TYPE = 24;
  const CRLFS = 4;
  const perFilePart = WORST_BOUNDARY + WORST_DISPOSITION + WORST_CONTENT_TYPE + CRLFS;
  const fieldParts = 2 * (WORST_BOUNDARY + 45 + CRLFS + 32); // view, week
  const envelope = MAX_FILES * perFilePart + fieldParts + WORST_BOUNDARY;

  assert.ok(
    MAX_TOTAL_BYTES + envelope <= configured(),
    `a full ${MAX_TOTAL_BYTES}-byte upload plus a ${envelope}-byte envelope exceeds the limit`,
  );
  // And the allowance is a real margin over that envelope, not a number fitted to it.
  assert.ok(MULTIPART_OVERHEAD_ALLOWANCE > envelope * 10, 'the allowance is too tight to absorb a new field');
});

test('the bounds themselves are unchanged — this fix must not widen what the action accepts', () => {
  // Raising the ceiling is not the same as accepting more. The three real limits are the ones
  // that refuse an upload, and Qodo #11 is about reachability, not capacity.
  assert.equal(MAX_FILES, 16);
  assert.equal(MAX_BYTES_PER_FILE, 20 * 1024 * 1024);
  assert.equal(MAX_TOTAL_BYTES, 32 * 1024 * 1024);
});

test('the bounds module carries no `use server` directive', () => {
  // It is imported by a 'use server' file. If it ever gained the directive, its value exports
  // would become illegal and every Server Action on the page would 500 — while passing the
  // full five-command gate, which is exactly how that class of defect ships.
  const src = readFileSync(
    new URL('../lib/billing-audit/kipu-import-bounds.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/^\s*['"]use server['"]/m.test(src), false, 'kipu-import-bounds.ts declared use server');
});
