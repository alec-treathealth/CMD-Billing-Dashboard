/**
 * Shared transport-layer Bearer auth — the constant-time token check both
 * Next.js API routes (agent + results) gate on. Lifted verbatim from the retired
 * Express dev harness (src/server.ts) so the comparison semantics are unchanged:
 * length-safe, never short-circuits on content, never logs the token.
 *
 * The callable modules (runAgentTurn, fetchResults) have NO auth of their own;
 * authorization is enforced here, at the transport boundary, by the route
 * handlers in src/routes/.
 */
import { timingSafeEqual } from 'node:crypto';

/** Constant-time comparison; false on any length mismatch (no early content leak). */
export function tokenMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return match === null ? null : match[1]!;
}

/** True iff the header carries a Bearer token matching `secret` (constant-time). */
export function isAuthorized(header: string | null | undefined, secret: string): boolean {
  const token = bearerFromHeader(header);
  return token !== null && tokenMatches(token, secret);
}
