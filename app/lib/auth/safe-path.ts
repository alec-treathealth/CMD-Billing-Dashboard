/**
 * Pure guard for post-auth redirect destinations. A value is a safe internal destination iff it is an
 * app-relative path ("/…") and NOT protocol-relative ("//host", which a browser would treat as an
 * absolute URL to another origin). Query/hash are allowed (e.g. "/qualify/m?welcome=1"). Anything
 * else — absolute URLs, empty, non-strings — returns null so callers fall back to a known-safe default.
 *
 * Used to thread the invite "set up on mobile / web" destination through /auth/confirm → /set-password
 * without opening a redirect to an arbitrary origin. The destination page still enforces its own role
 * gate, so this only bounds the ORIGIN, not authorization.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return null;
}
