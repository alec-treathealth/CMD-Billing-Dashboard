/**
 * Canonical Next cache tag names (Phase 8.2).
 *
 * Single source of truth shared by BOTH sides of the cache contract:
 *   - the app tags its dashboard aggregate `unstable_cache` readers with it
 *     (app/lib/server.ts) and allowlists it for /api/revalidate, and
 *   - the ingest's best-effort revalidate notifier POSTs it after refresh
 *     (src/revalidateClient.ts).
 *
 * Keeping it here (framework-free `src`) avoids drift between the two and keeps
 * the ingest from importing app code.
 */

/** The tag every non-PHI dashboard aggregate reader is registered under. */
export const DASHBOARD_CACHE_TAG = 'dashboard-aggregates';
