/**
 * Blind indexes for searchable PHI (migration 0036). SERVER-ONLY.
 *
 * A blind index is a KEYED HMAC of a normalized PHI value, stored alongside the encrypted
 * value so PHI-entitled users can look rows up by member ID / alpha prefix / group number
 * WITHOUT the plaintext ever being decrypted at query time or stored in the clear. Search
 * computes the same HMAC over the typed term and equality-matches it.
 *
 * KEY SEPARATION: this uses INDEX_HMAC_KEY, which MUST be distinct from LIBSODIUM_KEY (the
 * encryption key). A leak of one key must not compromise the other. HMAC is one-way and
 * keyed, so a DB-only attacker cannot reverse the token or brute-force the (low-entropy)
 * identifiers without the key.
 *
 * PHI DISCIPLINE: like phiCrypto, no plaintext or key material ever appears in a log, an
 * Error message, or a thrown value. The HMAC token is NOT PHI (it is a keyed one-way digest)
 * and is safe to store, index, and audit — but the INPUT to blindIndex() is PHI and must be
 * handled as such by callers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeMemberId } from './normalize.js';

// Hard fail-closed if this server-only module is ever run in a browser context.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('blindIndex is server-only and must never run in the browser');
}

export class BlindIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlindIndexError';
  }
}

/** How many leading characters form the "alpha prefix" blind index (BCBS convention: 3). */
export const ALPHA_PREFIX_LEN = 3;

// Decoded key cached by source hex (an unchanged env reuses the bytes). INDEX_HMAC_KEY is
// 32 bytes as 64 hex chars — same shape as LIBSODIUM_KEY, but a DIFFERENT value (enforced by
// operators; the code only validates shape). Re-read each call (cheap); fail-closed if unset.
let cached: { hex: string; key: Buffer } | null = null;
function getKey(): Buffer {
  const hex = process.env.INDEX_HMAC_KEY?.trim();
  if (!hex) throw new BlindIndexError('INDEX_HMAC_KEY is not set');
  if (cached && cached.hex === hex) return cached.key;
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new BlindIndexError('INDEX_HMAC_KEY must be 32 bytes encoded as 64 hex chars');
  }
  const key = Buffer.from(hex, 'hex');
  cached = { hex, key };
  return key;
}

/** HMAC-SHA256 (lowercase hex) of a normalized key string, or null for an absent value. */
function hmac(normalized: string | null): string | null {
  if (normalized === null || normalized === '') return null;
  return createHmac('sha256', getKey()).update(normalized, 'utf8').digest('hex');
}

// --- normalization (ingest and query MUST use the SAME transform per field) -----------------

/** Normalized member id (upper, whitespace-stripped, leading '-' removed) or null. */
export function memberIdNormalized(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return normalizeMemberId(raw).norm;
}

/** The alpha-prefix key: the first ALPHA_PREFIX_LEN chars of the normalized member id, or null. */
export function alphaPrefixNormalized(raw: string | null | undefined): string | null {
  const norm = memberIdNormalized(raw);
  if (norm === null || norm.length < ALPHA_PREFIX_LEN) return null;
  return norm.slice(0, ALPHA_PREFIX_LEN);
}

/** Normalized group number (upper, whitespace-stripped) or null. */
export function groupNumberNormalized(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const norm = raw.trim().toUpperCase().replace(/\s+/g, '');
  return norm === '' ? null : norm;
}

// --- blind-index tokens (what gets stored / matched) ----------------------------------------

/** Full-member-id blind index for a raw member id (ingest + exact-lookup query). */
export function memberIdBlindIndex(raw: string | null | undefined): string | null {
  return hmac(memberIdNormalized(raw));
}

/** Alpha-prefix (first 3 chars) blind index for a raw member id / typed prefix. */
export function alphaPrefixBlindIndex(raw: string | null | undefined): string | null {
  return hmac(alphaPrefixNormalized(raw));
}

/** Group-number blind index for a raw group number. */
export function groupNumberBlindIndex(raw: string | null | undefined): string | null {
  return hmac(groupNumberNormalized(raw));
}

/** Normalized patient name (trimmed, internal whitespace collapsed, upper) or null.
 *  ADDITIVE (billing-audit plane, 2026-07-13): ingest + query MUST share this transform;
 *  collections' member/group helpers above are untouched. */
export function patientNameNormalized(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const norm = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  return norm === '' ? null : norm;
}

/** Full-name blind index for a raw patient name (audit ingest + exact-lookup query). */
export function patientNameBlindIndex(raw: string | null | undefined): string | null {
  return hmac(patientNameNormalized(raw));
}

/** First-3-chars prefix blind index for a raw patient name / typed prefix. */
export function patientNamePrefixBlindIndex(raw: string | null | undefined): string | null {
  const norm = patientNameNormalized(raw);
  if (norm === null || norm.length < ALPHA_PREFIX_LEN) return null;
  return hmac(norm.slice(0, ALPHA_PREFIX_LEN));
}

/**
 * Ingest-safe patient-name blind index (Qualify client-name search, migration 0066): a missing/
 * invalid INDEX_HMAC_KEY returns null instead of breaking the money-path ingest — rows simply
 * aren't name-searchable until the key is set and cmdNameBidxBackfill.ts runs. Query paths use the
 * throwing patientNameBlindIndex above so misconfiguration is visible, never silent nulls.
 */
export function patientNameBlindIndexSafe(raw: string | null | undefined): string | null {
  try {
    return patientNameBlindIndex(raw);
  } catch (e) {
    if (e instanceof BlindIndexError) return null;
    throw e;
  }
}

export interface RowBlindIndexes {
  member_id_bidx: string | null;
  member_id_prefix_bidx: string | null;
  group_number_bidx: string | null;
}

/** The four blind-index tokens for one claims.audit_row (billing-audit plane). */
export interface AuditRowBlindIndexes {
  patient_name_bidx: string | null;
  patient_name_pfx3_bidx: string | null;
  member_id_bidx: string | null;
  member_id_pfx3_bidx: string | null;
}

/**
 * Ingest-safe audit-row variant (mirrors blindIndexesForRowSafe): a missing/invalid
 * INDEX_HMAC_KEY returns all-null tokens instead of breaking the ingest — the rows
 * simply aren't PHI-searchable until the key is set and a backfill runs. NOTE the
 * schema requires patient_name_bidx NOT NULL, so the INGEST maps a null token to a
 * skip; query paths use the throwing helpers above so misconfiguration is visible.
 */
export function auditBlindIndexesForRowSafe(
  patientName: string | null,
  memberId: string | null,
): AuditRowBlindIndexes {
  try {
    return {
      patient_name_bidx: patientNameBlindIndex(patientName),
      patient_name_pfx3_bidx: patientNamePrefixBlindIndex(patientName),
      member_id_bidx: memberIdBlindIndex(memberId),
      member_id_pfx3_bidx: alphaPrefixBlindIndex(memberId),
    };
  } catch (e) {
    if (e instanceof BlindIndexError) {
      return { patient_name_bidx: null, patient_name_pfx3_bidx: null, member_id_bidx: null, member_id_pfx3_bidx: null };
    }
    throw e;
  }
}

/** All three tokens for one row's PHI (throws if INDEX_HMAC_KEY is unset/invalid). */
export function blindIndexesForRow(memberId: string | null, groupNumber: string | null): RowBlindIndexes {
  return {
    member_id_bidx: memberIdBlindIndex(memberId),
    member_id_prefix_bidx: alphaPrefixBlindIndex(memberId),
    group_number_bidx: groupNumberBlindIndex(groupNumber),
  };
}

/**
 * Ingest-safe variant: if INDEX_HMAC_KEY is unset/invalid, return all-null tokens instead of
 * throwing — a missing search key must NEVER break the money-path ingest (cron/seed). The rows
 * simply aren't searchable by PHI until the key is set and cmdBlindIndexBackfill.ts runs. When
 * the key IS present, this behaves identically to blindIndexesForRow. Query paths use the
 * throwing variant so a misconfiguration surfaces as a visible search error, not silent nulls.
 */
const NULL_INDEXES: RowBlindIndexes = { member_id_bidx: null, member_id_prefix_bidx: null, group_number_bidx: null };
export function blindIndexesForRowSafe(memberId: string | null, groupNumber: string | null): RowBlindIndexes {
  try {
    return blindIndexesForRow(memberId, groupNumber);
  } catch (e) {
    if (e instanceof BlindIndexError) return { ...NULL_INDEXES };
    throw e;
  }
}

/** Constant-time hex-token comparison (defense in depth for any in-process token check). */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
