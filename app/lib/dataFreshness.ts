/**
 * "Data last updated" timestamp for the CMD-sourced collections pipeline.
 *
 * The cron re-inserts each facility's current-window daily deposits on EVERY run (span-scoped
 * replace, src/collections/db.ts), stamping a fresh created_at — so max(created_at) over the
 * source_tag='cmd' rows tracks the last successful cron WRITE even on a run that appended no new
 * charge lines (ON CONFLICT DO NOTHING). That makes it the right "is the data fresh?" signal for
 * both the Overview and Collections pages (same logic on both).
 *
 * Non-PHI (a single timestamp), reader-only (claims_reader already has SELECT on
 * collections.daily_collections), and cached under the SAME tags the cron busts — so it refreshes
 * the instant a run completes, with a short TTL as a fallback.
 */
import { unstable_cache } from 'next/cache';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../src/queries/executor.js';
import { assertEntityScope } from '../../src/collections/entityScope.js';
import { DASHBOARD_CACHE_TAG } from '../../src/cacheTags.js';

let cachedExecutor: PgExecutor | undefined;
function readerExecutor(): PgExecutor {
  // verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts).
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

async function queryCollectionsUpdatedAt(entityIds: string[]): Promise<string | null> {
  const scope = assertEntityScope(entityIds, 'collectionsDataUpdatedAt');
  const { rows } = await readerExecutor().query<{ updated_at: string | null }>(
    "select max(created_at)::text as updated_at from collections.daily_collections where source_tag = 'cmd' and business_entity_id = any($1::uuid[])",
    [scope],
  );
  return rows[0]?.updated_at ?? null;
}

/**
 * ISO timestamp (UTC, with offset) of the last CMD cron write for the given tenant scope, or
 * null if nothing has been ingested yet. `entityIds` is the RBAC-clamped tenant scope (fail-closed
 * — an empty scope throws), and it is part of the cache key, so each tenant scope memoizes
 * separately. Cached and invalidated by the same tags the cron revalidates ('cmd-explorer' for the
 * explorer grid, DASHBOARD_CACHE_TAG for the overview aggregates), so a completed run surfaces
 * immediately; the 5-min TTL is only a fallback if a tag-bust is ever missed.
 */
export const collectionsDataUpdatedAt = unstable_cache(
  queryCollectionsUpdatedAt,
  ['collections-data-updated-at'],
  { revalidate: 300, tags: ['cmd-explorer', DASHBOARD_CACHE_TAG] },
);
