/**
 * Best-effort dashboard cache invalidation, called by the ingest AFTER the
 * aggregate matviews are refreshed (Phase 8.2). It POSTs to the deployed
 * /api/revalidate endpoint so the dashboard drops its cached aggregates
 * immediately rather than waiting out the 15-minute fallback.
 *
 * Safety / "do not break local ingest":
 *   - ENV-GATED: a no-op unless BOTH REVALIDATE_URL and REVALIDATE_SECRET are set
 *     (local ingest has neither, so it simply skips).
 *   - NON-FATAL: any network/HTTP error is swallowed and reported as a generic
 *     result; ingest success never depends on it.
 *   - The secret travels only in the Authorization header and is NEVER logged.
 *
 * `env` and `fetchImpl` are injectable so this is testable without a network.
 */
import { DASHBOARD_CACHE_TAG } from './cacheTags.js';

export interface RevalidateNotifyResult {
  /** True when both env vars were present and a request was attempted. */
  attempted: boolean;
  /** True when the endpoint returned a 2xx. Meaningless when !attempted. */
  ok: boolean;
}

export async function notifyDashboardRevalidate(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<RevalidateNotifyResult> {
  const url = env.REVALIDATE_URL?.trim();
  const secret = env.REVALIDATE_SECRET?.trim();
  if (!url || !secret) return { attempted: false, ok: false };

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: DASHBOARD_CACHE_TAG }),
    });
    return { attempted: true, ok: res.ok };
  } catch {
    // Network failure / DNS / TLS — non-fatal. No secret, no detail leaked.
    return { attempted: true, ok: false };
  }
}
