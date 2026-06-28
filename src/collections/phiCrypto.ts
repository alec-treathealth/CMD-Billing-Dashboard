/**
 * PHI field encryption/decryption for the CMD Collections Explorer (migration 0019).
 *
 * SERVER-ONLY. This is the ONLY module in the project that encrypts/decrypts the three
 * Explorer PHI identifiers (patient_name, member_id, group_number). It is imported by
 * the server composition root (app/lib/server.ts) and by the ingest CLIs
 * (cmdExplorerSeed.ts / cmdExplorerCron.ts) — NEVER by a Client Component. It must
 * never be bundled to the browser: it reads LIBSODIUM_KEY from the server environment,
 * and a browser must never receive that key or a decryption oracle. A `typeof window`
 * guard hard-fails if this is ever executed in a browser (this matches the src/
 * server-only convention — the library uses an import boundary + this guard rather
 * than the Next `'use server'` directive, which would wrongly declare these primitives
 * as browser-callable Server Actions, or the `server-only` package, which throws under
 * the plain-Node tsx CLI that ingests with this module).
 *
 * FORMAT (must match the staging-pipeline convention, SQL Schemas/002,004): each PHI
 * value is libsodium `crypto_secretbox_easy` ciphertext with the random per-value
 * nonce PREPENDED — the stored bytea is `nonce ‖ ciphertext` (nonce = 24 bytes, then
 * ciphertext = plaintext length + 16-byte MAC). decryptPhi splits the nonce back off.
 *
 * KEY: LIBSODIUM_KEY env var, 32 bytes as 64 hex chars (crypto_secretbox_KEYBYTES).
 * Validated on first use; a missing/short/non-hex key throws (fail-closed) — the
 * module never proceeds with bad key material.
 *
 * PHI DISCIPLINE (docs/CLAUDE.md §2): no plaintext, ciphertext bytes, or key material
 * ever appears in a log, an Error message, or a thrown value. Errors name the failure
 * mode only ("PHI decryption failed"), never the content.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// libsodium-wrappers@0.7.x ships a BROKEN ESM build: dist/modules-esm/libsodium-wrappers.mjs
// imports a sibling "./libsodium.mjs" that does not exist, so a native ESM `import` fails
// under tsx / Node ESM with ERR_MODULE_NOT_FOUND. Its CJS build correctly requires the
// installed `libsodium` core package, so load that via createRequire. Works under tsx,
// Node ESM, and the Next server runtime (mark it in serverExternalPackages so Next does
// not try to bundle the wasm — a Gate-4 app concern). `typeof import(...)` is type-only
// (no runtime emit), so it supplies the @types without triggering the broken ESM path.
const sodium = createRequire(import.meta.url)('libsodium-wrappers') as typeof import('libsodium-wrappers');

// Hard fail-closed if this server-only module is ever run in a browser context.
// No-op under Node/tsx (CLIs) and the Next server runtime, where `window` is absent.
// Reached via globalThis so it typechecks without the DOM lib (root tsconfig is node-only).
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('phiCrypto is server-only and must never run in the browser');
}

/** Typed error for all crypto failures. Message names the failure mode, never PHI. */
export class PhiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhiCryptoError';
  }
}

// libsodium-wrappers loads its WASM asynchronously; every call must await `ready`.
// Singleton: the promise resolves once and is reused, so warm calls don't re-init.
let readyPromise: Promise<unknown> | null = null;
async function ensureReady(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready;
  await readyPromise;
}

// Decoded key, cached BY its source hex: an unchanged LIBSODIUM_KEY reuses the decoded
// bytes; a changed key (rotation, or a test toggling the env) re-derives. The env is the
// source of truth, re-read each call (cheap); the cache only skips the from_hex decode
// when the value is identical.
let cached: { hex: string; key: Uint8Array } | null = null;
async function getKey(): Promise<Uint8Array> {
  await ensureReady();
  const hex = process.env.LIBSODIUM_KEY?.trim();
  if (!hex) throw new PhiCryptoError('LIBSODIUM_KEY is not set');
  if (cached && cached.hex === hex) return cached.key;
  if (hex.length !== 64) {
    throw new PhiCryptoError('LIBSODIUM_KEY must be 32 bytes encoded as 64 hex chars');
  }
  let key: Uint8Array;
  try {
    key = sodium.from_hex(hex);
  } catch {
    throw new PhiCryptoError('LIBSODIUM_KEY is not valid hex');
  }
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new PhiCryptoError('LIBSODIUM_KEY must decode to exactly 32 bytes');
  }
  cached = { hex, key };
  return key;
}

/**
 * Encrypt a PHI plaintext to a `nonce ‖ ciphertext` Buffer for storage in a bytea
 * column. The nonce is freshly random per call (never reused), so identical inputs
 * encrypt to different bytes — which is why dedup keys off row_fingerprint (hashed
 * plaintext), never the ciphertext.
 */
export async function encryptPhi(plaintext: string): Promise<Buffer> {
  const key = await getKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  const out = Buffer.alloc(nonce.length + cipher.length);
  Buffer.from(nonce).copy(out, 0);
  Buffer.from(cipher).copy(out, nonce.length);
  return out;
}

/**
 * Decrypt a `nonce ‖ ciphertext` Buffer (as written by encryptPhi) back to its UTF-8
 * plaintext. Throws PhiCryptoError on any failure (wrong key, tampered/corrupt bytes,
 * truncated input) — it NEVER returns unauthenticated/garbage output.
 */
export async function decryptPhi(ciphertext: Buffer): Promise<string> {
  const key = await getKey();
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  if (ciphertext.length < nonceLen + sodium.crypto_secretbox_MACBYTES) {
    throw new PhiCryptoError('ciphertext is too short to be valid');
  }
  const nonce = ciphertext.subarray(0, nonceLen);
  const body = ciphertext.subarray(nonceLen);
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_secretbox_open_easy(body, nonce, key);
  } catch {
    // Verification/auth failure (wrong key or tampered bytes). Never leak details.
    throw new PhiCryptoError('PHI decryption failed');
  }
  return Buffer.from(plain).toString('utf8');
}

/**
 * SHA-256 (hex) over a pre-normalized field array. The CALLER owns normalization and
 * field ORDER; this function only joins + hashes. Fields are joined on the ASCII Unit
 * Separator (0x1f) — a delimiter that does not occur in CMD report cells — so distinct
 * field boundaries can never collide into the same digest. Output is 64 lowercase hex
 * chars, matching the row_fingerprint column (and the query_log identity-hash format).
 */
const FIELD_SEP = '\x1f';
export function fingerprintRow(fields: string[]): string {
  return createHash('sha256').update(fields.join(FIELD_SEP), 'utf8').digest('hex');
}
