/**
 * Transport-agnostic handler for GET /api/cron/refresh-cmd-payer.
 *
 * Invoked daily by Vercel Cron (app/vercel.json). Vercel Cron issues a GET and,
 * when CRON_SECRET is set, attaches `Authorization: Bearer <CRON_SECRET>`. This
 * handler gates on that secret (constant-time, `isAuthorized`) and then runs the
 * injected refresh.
 *
 * Security:
 *   - GET only — any other verb is 405 (independent of auth).
 *   - Bearer auth against a dedicated CRON_SECRET. A missing/empty secret fails
 *     closed (401) — the endpoint is never open.
 *   - On failure the client gets a generic 500; the cause is logged server-side as
 *     a message only (never PHI, never the token).
 *
 * It touches NO PHI at this layer: the request carries no body, and the refresh
 * returns non-PHI stats only. The refresh itself (and its DB/live-API wiring) is
 * injected so this stays framework-free and unit-testable.
 */
import { isAuthorized } from '../bearerAuth.js';
import type { RefreshStats } from '../collections/cmdPayerRefresh.js';

export interface CmdPayerRefreshHttpRequest {
  /** HTTP method. GET only — any other verb is 405. */
  method?: string;
  authorization?: string | null;
}

export interface CmdPayerRefreshRouteDeps {
  /** Shared secret; undefined/empty => fail closed (401). Never logged. */
  secret: string | undefined;
  /** Runs the refresh; returns non-PHI stats. Throws on failure (caught here). */
  refresh: () => Promise<RefreshStats>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export async function handleCmdPayerRefreshRequest(
  req: CmdPayerRefreshHttpRequest,
  deps: CmdPayerRefreshRouteDeps,
): Promise<HandlerResult> {
  // GET only — reject any other verb before touching auth or the live API.
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  // Fail closed on a missing/empty secret, then constant-time Bearer compare.
  if (!deps.secret || !isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  try {
    const stats = await deps.refresh();
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token).
    console.error('cmd-payer refresh failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'refresh_failed' } };
  }
}
