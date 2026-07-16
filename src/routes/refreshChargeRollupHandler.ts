/**
 * Transport-agnostic handler for GET /api/cron/refresh-charge-rollup.
 *
 * Invoked hourly by Vercel Cron (app/vercel.json, 45 * * * * — after the :00 BXR and :30 Indigo
 * explorer ingests). Vercel Cron issues a GET and, when CRON_SECRET is set, attaches
 * `Authorization: Bearer <CRON_SECRET>`. This handler gates on that secret (constant-time,
 * `isAuthorized`) and then runs the injected refresh. Mirrors cmdPayerRefreshHandler's shape.
 *
 * Security:
 *   - GET only — any other verb is 405 (independent of auth).
 *   - Bearer auth against the dedicated CRON_SECRET. A missing/empty secret fails closed (401) —
 *     the endpoint is never open.
 *   - On failure the client gets a generic 500; the cause is logged server-side as a message only
 *     (never PHI, never the token). The durable per-attempt record lives in the run-log table, not
 *     in the HTTP response.
 *
 * Touches NO PHI at this layer: the request carries no body, and the refresh returns non-PHI stats
 * only. The refresh (and its DB wiring) is injected so this stays framework-free and unit-testable.
 */
import { isAuthorized } from '../bearerAuth.js';
import type { ChargeRollupRefreshStats } from '../collections/refreshChargeRollup.js';

export interface RefreshChargeRollupHttpRequest {
  /** HTTP method. GET only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
}

export interface RefreshChargeRollupRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** Runs the refresh + writes the run-log row; returns non-PHI stats. Throws on failure (caught here). */
  refresh: () => Promise<ChargeRollupRefreshStats>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handleRefreshChargeRollupRequest(
  req: RefreshChargeRollupHttpRequest,
  deps: RefreshChargeRollupRouteDeps,
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
    const stats = await deps.refresh();
    // stats already carries ok (always true on the success path); list it last so the explicit
    // flag is the intentional override rather than a value silently clobbered by the spread.
    return { status: 200, body: { ...stats, ok: true } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token). The run-log row
    // (written before this rethrow) is the durable record — this 500 is not the only signal.
    console.error('refresh-charge-rollup failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'refresh_failed' } };
  }
}
