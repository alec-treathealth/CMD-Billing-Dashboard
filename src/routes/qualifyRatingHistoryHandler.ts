/**
 * Transport-agnostic handler for GET /api/cron/qualify-rating-history.
 *
 * Invoked daily by Vercel Cron (app/vercel.json, 10 5 * * * — a free minute after the 04:45
 * matview refresh settles, so the nightly snapshot reads at most ~25-minute-old rollup data; it is
 * DB-only, so the CMD-scoped :41-:59 probe-window rule does not bind it and it contends with no
 * CMD partner slot). Vercel Cron issues a GET and, when CRON_SECRET is set, attaches
 * `Authorization: Bearer <CRON_SECRET>`. Mirrors refreshChargeRollupHandler's shape.
 *
 * Security:
 *   - GET only — any other verb is 405 (independent of auth).
 *   - Bearer auth against CRON_SECRET, constant-time (isAuthorized). Missing/empty secret fails
 *     closed (401) — the endpoint is never open.
 *   - On failure the client gets a generic 500; the cause is logged server-side as a message only
 *     (never PHI, never the token). The durable per-date record lives in
 *     collections.qualify_rating_run, not in the HTTP response.
 *
 * Touches NO PHI at this layer: no request body, and the run returns non-PHI counts/dates only.
 */
import { isAuthorized } from '../bearerAuth.js';
import type { QualifyRatingHistoryStats } from '../collections/qualifyRatingHistory.js';

export interface QualifyRatingHistoryHttpRequest {
  /** HTTP method. GET only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
}

export interface QualifyRatingHistoryRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** Runs the snapshot catch-up + writes run-log rows; returns non-PHI stats. Throws on failure. */
  run: () => Promise<QualifyRatingHistoryStats>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handleQualifyRatingHistoryRequest(
  req: QualifyRatingHistoryHttpRequest,
  deps: QualifyRatingHistoryRouteDeps,
): Promise<HandlerResult> {
  // GET only — reject any other verb before touching auth.
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  // Fail closed on a missing/empty secret, then constant-time Bearer compare.
  if (!deps.secret || !isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  try {
    const stats = await deps.run();
    // ok listed last so the explicit flag is the intentional override (the repo's spread idiom).
    return { status: 200, body: { ...stats, ok: true } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token). The run-log rows
    // (written before this rethrow) are the durable record — this 500 is not the only signal.
    console.error('qualify-rating-history failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
}
