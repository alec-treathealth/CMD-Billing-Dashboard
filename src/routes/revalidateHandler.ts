/**
 * Transport-agnostic handler for POST /api/revalidate (Phase 8.2) — exact
 * dashboard freshness via explicit cache invalidation after ingest.
 *
 * The dashboard aggregate readers are wrapped in Next's `unstable_cache` with a
 * 15-minute `revalidate` fallback and a shared tag. This handler lets the daily
 * CMD ingest (after it refreshes the matviews) drop that cache IMMEDIATELY by
 * invalidating the tag, instead of waiting up to 15 minutes. The fallback remains.
 *
 * Security:
 *   - POST only — any other verb is 405 (independent of auth).
 *   - Bearer auth against a dedicated REVALIDATE_SECRET, constant-time
 *     (`isAuthorized`). A missing/empty secret fails closed (401) — the endpoint
 *     is never open.
 *   - The tag is checked against a CLOSED allowlist; an absent tag defaults to the
 *     dashboard tag. Any other (arbitrary) tag is rejected 400 and NOTHING is
 *     invalidated — the client can never invalidate an unlisted tag.
 *
 * It touches NO PHI: there is no row data here, the body carries only a tag name,
 * and nothing (token, body, tag) is ever logged. The actual `revalidate` action
 * is injected (the Next route passes `revalidateTag`) so this stays framework-free
 * and unit-testable.
 */
import { isAuthorized } from '../bearerAuth.js';

export interface RevalidateHttpRequest {
  /** HTTP method. POST only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
  /** Parsed JSON body (untrusted): `{ tag?: string }`, or null when absent. */
  body: unknown;
}

export interface RevalidateRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** The closed set of cache tags this endpoint is permitted to invalidate. */
  allowedTags: ReadonlySet<string>;
  /** Tag used when the body omits one; MUST be a member of `allowedTags`. */
  defaultTag: string;
  /** Injected cache invalidation (revalidateTag in prod; a spy in tests). */
  revalidate: (tag: string) => void;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * Pull the requested tag from the body. An absent body or absent `tag` defaults to
 * `defaultTag`. A non-object body, or a `tag` that is not a string, returns null
 * (rejected as bad_request) — the allowlist check below also fail-closes.
 */
function extractTag(body: unknown, defaultTag: string): string | null {
  if (body === null || body === undefined) return defaultTag;
  if (typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).tag;
  if (raw === undefined) return defaultTag;
  if (typeof raw !== 'string') return null;
  return raw;
}

export function handleRevalidateRequest(
  req: RevalidateHttpRequest,
  deps: RevalidateRouteDeps,
): HandlerResult {
  // POST only — reject any other verb before touching auth or the cache.
  if (req.method !== undefined && req.method.toUpperCase() !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  // Fail closed on a missing/empty secret, then constant-time Bearer compare.
  if (!deps.secret || !isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const tag = extractTag(req.body, deps.defaultTag);
  if (tag === null || !deps.allowedTags.has(tag)) {
    // Arbitrary / unlisted tag — invalidate nothing.
    return { status: 400, body: { error: 'bad_request' } };
  }

  deps.revalidate(tag);
  return { status: 200, body: { revalidated: true } };
}
