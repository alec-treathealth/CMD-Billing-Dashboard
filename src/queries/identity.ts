/**
 * Identity binding for client_history (and, in Phase 3, the results route).
 *
 * The patient search terms are PHI and must NEVER be stored at rest or logged.
 * Instead we persist only `identity_hash` = SHA-256 of the (lower-cased last
 * name | normalized member id | query_id). Because the digest folds in the
 * server-generated query_id, it binds one query_id to exactly one identity: the
 * results route recomputes this from re-supplied terms and refuses to serve PHI
 * unless it matches (see migrations/0004_query_log.sql, Decision 2).
 *
 * This module is the SINGLE source of truth for that computation. Both the
 * producing function (client_history) and the future consuming route MUST hash
 * through here so the two sides can never silently diverge.
 */
import { createHash } from 'node:crypto';

/**
 * Normalize a member id to the same canonical form ingest stored in
 * `member_id_norm`: trimmed, upper-cased, leading `-` removed (absolute value
 * for matching). Returns '' for blank input so it can feed the hash's
 * coalesce(member_id_norm,'') slot unchanged.
 */
export function normalizeMemberId(raw: string | undefined | null): string {
  if (raw == null) return '';
  return raw.trim().toUpperCase().replace(/^-+/, '');
}

/**
 * The canonical identity hash. `memberIdNorm` MUST already be normalized via
 * normalizeMemberId (pass '' when absent). Output is 64 lowercase hex chars,
 * satisfying the query_log CHECK (`^[0-9a-f]{64}$`). Irreversible, non-PHI.
 */
export function computeIdentityHash(
  patientLast: string,
  memberIdNorm: string,
  queryId: string,
): string {
  const material = `${patientLast.trim().toLowerCase()}|${memberIdNorm}|${queryId}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
