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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS PROBE GETS ITS OWN TINY POOL, AND WHY IT NO LONGER FAILS SILENTLY
 *
 * Diagnosed 2026-08-12 from live Supabase logs. A background revalidation of this entry failed with
 * `Connection terminated due to connection timeout` — node-postgres could not ACQUIRE a connection,
 * so the query never executed. Next swallows a failed background revalidation by design and serves
 * the previous value, so the page rendered 200 in 93ms with stale numbers and no signal anywhere.
 *
 * The contention it lost: 66 seconds earlier
 * `select collections.refresh_cmd_explorer_charge_rollup()` ran for 87,681ms against a
 * **475 MB** matview (measured: 475 MB total / 165 MB heap), and `refresh_facility_resolution()`
 * took a further 12,342ms. Both use CONCURRENTLY, so readers were NOT lock-blocked — this is I/O
 * and connection-slot pressure, not locking. `max_connections` is **60** (measured), and Supavisor
 * shows connect/terminate churn every few seconds as serverless isolates each open their own pool.
 *
 * THE PROBE'S OWN QUERY IS NOT THE PROBLEM. Measured live: 53.7ms, 358 buffers, a seq scan over
 * ~21k rows. It is a rounding error next to an 87-second refresh. The cost was entirely in
 * ACQUIRING a slot for it — which is why the fix is about the connection, not the SQL.
 *
 * So this module no longer borrows the shared 4-slot reader pool, and it no longer opens a FIFTH
 * general-purpose one either. It gets a dedicated pool of exactly ONE connection with a short
 * acquire timeout and a single retry:
 *
 *   - `max: 1` — strictly SMALLER than the `max: 4` it used to allocate, so the app's total
 *     footprint against that 60-connection budget goes DOWN, not up. Three cache scopes refreshing
 *     every 5 minutes do not need four slots.
 *   - Isolated from the slow readers. In the shared pool this one-row read queued behind the
 *     ~30s aggregates and the charge-rollup grid page; here nothing else can occupy its slot.
 *   - `connectionTimeoutMillis: 2_000` — DELIBERATELY SHORTER than the shared pool's 10s, not
 *     longer. Raising it would convert a fast failure into a slow one and hide the contention
 *     behind a page that just feels sluggish. Fail fast, then retry.
 *   - ONE retry with jitter. The contention window is an 87-second refresh, so a retry is not a
 *     guarantee — it converts the common brief-spike miss into a hit while leaving a genuine
 *     sustained outage still visible, and bounds the worst case at ~4.4s instead of one 10s hang.
 *   - `statement_timeout: 8_000` against a measured 53.7ms — ~150x headroom, and it means a probe
 *     that DOES get a slot can never itself become the thing holding one.
 *
 * OBSERVABILITY. A failure is now logged with the cache key and tenant scope (both non-PHI) and
 * then RETHROWN. Rethrowing is deliberate: returning a sentinel would let unstable_cache MEMOIZE
 * the failure for the full TTL, so one bad moment would pin a "no data" state for five minutes.
 * Rethrowing keeps the last good value in the cache — which is the correct thing to serve — while
 * making the failure loud.
 *
 * AND THE UI NO LONGER PRESENTS A STALE VALUE AS CURRENT. The cached record now carries
 * `measuredAt`: when the value was actually READ from the database. Nothing about it is invented —
 * it is a real, measured timestamp — and it is what lets the surface say "last checked N ago"
 * instead of implying the number is live. See collectionsFreshness() and data-freshness.tsx.
 *
 * ⚠ NOT THE FIX FOR THE 87-SECOND REFRESH. That is the real long-term problem and it is the
 * incremental-watermark-sync follow-up named in PR #215. This change stops the symptom being
 * INVISIBLE and stops this probe competing for a pool slot on its own; it does not make the matview
 * cheaper.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { unstable_cache } from 'next/cache';
import pg from 'pg';
import { sanitizeConnectionString, verifyFullSsl } from '../../src/ssl.js';
import { readerConnectionStringFromEnv } from '../../src/queries/executor.js';
import { assertEntityScope } from '../../src/collections/entityScope.js';
import { DASHBOARD_CACHE_TAG } from '../../src/cacheTags.js';

/** The unstable_cache key prefix. Exported so the failure log and the tests name the same thing. */
export const FRESHNESS_CACHE_KEY = 'collections-data-updated-at';

/** Cache TTL, seconds. The tags below normally refresh it sooner; this is the fallback. */
export const FRESHNESS_REVALIDATE_SECONDS = 300;

/**
 * How old `measuredAt` may get before the UI stops presenting the value as current. Two full TTLs.
 *
 * ⚠ AN OLD measuredAt IS NOT PROOF OF FAILURE, and the wording downstream must not claim it is.
 * unstable_cache revalidates on ACCESS, so on a quiet page the value can legitimately be hours old
 * simply because nobody visited. "Last checked N ago" is true in both cases; "refresh failing" would
 * not be. The unambiguous failure signal is the log line, not this threshold.
 */
export const FRESHNESS_STALE_AFTER_MS = FRESHNESS_REVALIDATE_SECONDS * 2 * 1000;

/** Acquire budget for the probe's single connection. Short ON PURPOSE — see the header. */
const PROBE_CONNECT_TIMEOUT_MS = 2_000;
/** Server-side ceiling. The query measures 53.7ms; this only catches pathology. */
const PROBE_STATEMENT_TIMEOUT_MS = 8_000;
/** One retry. Base backoff plus jitter so concurrent isolates do not retry in lockstep. */
const PROBE_RETRY_BASE_MS = 150;
const PROBE_RETRY_JITTER_MS = 250;

export interface CollectionsFreshness {
  /** ISO timestamp of the last CMD cron write for this scope, or null if nothing is ingested. */
  updatedAt: string | null;
  /** ISO timestamp of when this value was actually READ from the database. Never synthesized. */
  measuredAt: string;
}

/**
 * Dedicated single-connection pool. NOT makeReaderPool: that builds a `max: 4` general-purpose pool
 * with a 10s acquire budget and a 120s statement ceiling, all sized for the slow aggregate reads
 * this probe was starving behind.
 */
let cachedPool: pg.Pool | undefined;
function probePool(): pg.Pool {
  cachedPool ??= new pg.Pool({
    // Strip any sslmode/ssl param so it cannot override verify-full (dropping the CA).
    connectionString: sanitizeConnectionString(readerConnectionStringFromEnv()),
    ssl: verifyFullSsl(),
    max: 1,
    application_name: 'collections-freshness-probe',
    statement_timeout: PROBE_STATEMENT_TIMEOUT_MS,
    query_timeout: PROBE_STATEMENT_TIMEOUT_MS + 2_000,
    connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
    // Do not hold the slot open between five-minute refreshes; releasing it back to the 60-slot
    // budget matters more here than saving one handshake on a probe this infrequent.
    idleTimeoutMillis: 10_000,
  });
  return cachedPool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test seam: swap the executor. Returns the previous one so a test can restore it. */
let queryImpl: (scope: string[]) => Promise<string | null> = defaultQuery;
export function __setFreshnessQueryForTests(
  fn: (scope: string[]) => Promise<string | null>,
): (scope: string[]) => Promise<string | null> {
  const prev = queryImpl;
  queryImpl = fn;
  return prev;
}
export function __restoreFreshnessQueryForTests(
  fn: (scope: string[]) => Promise<string | null>,
): void {
  queryImpl = fn;
}

async function defaultQuery(scope: string[]): Promise<string | null> {
  const { rows } = await probePool().query<{ updated_at: string | null }>(
    "select max(created_at)::text as updated_at from collections.daily_collections where source_tag = 'cmd' and business_entity_id = any($1::uuid[])",
    [scope],
  );
  return rows[0]?.updated_at ?? null;
}

/**
 * The probe itself: acquire, read, retry once, log loudly, rethrow. EXPORTED UNCACHED because
 * unstable_cache does not execute outside a Next request context, so this is the only way the retry
 * and logging behaviour can be covered hermetically. Production always goes through the cached
 * wrapper below; nothing else should call this directly.
 */
export async function readCollectionsFreshness(entityIds: string[]): Promise<CollectionsFreshness> {
  // Fail-closed scope check stays OUTSIDE the retry: an empty/malformed scope is a programming
  // error, not a transient one, and retrying it would just delay the throw.
  const scope = assertEntityScope(entityIds, 'collectionsDataUpdatedAt');

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const updatedAt = await queryImpl(scope);
      return { updatedAt, measuredAt: new Date().toISOString() };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        // Jittered so concurrent isolates coming off the same stalled refresh do not retry in
        // lockstep and re-create the pile-up this is meant to survive.
        await sleep(PROBE_RETRY_BASE_MS + Math.floor(Math.random() * PROBE_RETRY_JITTER_MS));
      }
    }
  }

  // Loud, with the cache key and tenant scope so the failing entry is identifiable — this is the
  // signal that did not exist before, when a swallowed background revalidation left NO trace
  // anywhere. Tenant UUIDs are non-PHI (they are compile-time constants in app/lib/views.ts); the
  // driver message is a connection/driver string and carries no row data.
  console.error(
    `dataFreshness: revalidation FAILED for cache key '${FRESHNESS_CACHE_KEY}' scope=[${scope.join(',')}] ` +
      `after 2 attempts — the previous cached value will continue to be served as STALE:`,
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  );
  // RETHROW rather than return a sentinel: a returned value would be memoized by unstable_cache for
  // the full TTL, pinning a transient failure into five minutes of "no data". Throwing leaves the
  // last good value cached, which is the right thing to serve — just no longer silently.
  throw lastErr;
}

/**
 * Cached freshness record for the given RBAC-clamped tenant scope. `entityIds` is part of the cache
 * key, so each scope memoizes separately. Invalidated by the same tags the cron revalidates
 * ('cmd-explorer', DASHBOARD_CACHE_TAG); the TTL is only a fallback if a tag-bust is missed.
 *
 * THROWS if the read fails and no cached value exists (a cold miss during contention). Callers must
 * handle that — see collectionsFreshness().
 */
export const collectionsDataUpdatedAt = unstable_cache(
  readCollectionsFreshness,
  [FRESHNESS_CACHE_KEY],
  { revalidate: FRESHNESS_REVALIDATE_SECONDS, tags: ['cmd-explorer', DASHBOARD_CACHE_TAG] },
);

export type FreshnessState =
  /** Read succeeded (or a cached value is being served) and is recent enough to present as current. */
  | { status: 'current'; updatedAt: string | null; measuredAt: string }
  /** A real cached value, but last confirmed against the database a while ago. Value is NOT faked. */
  | { status: 'stale'; updatedAt: string | null; measuredAt: string }
  /** No value at all — a cold miss that failed. Nothing is invented; the surface says so. */
  | { status: 'unavailable' };

/**
 * What a page should render. Never throws, never invents a timestamp.
 *
 * The cold-miss catch matters on its own: before this, a probe failure with no cached entry
 * propagated out of an async server component and broke the whole page render. A freshness LABEL
 * must never be able to take down the dashboard it annotates.
 */
export async function collectionsFreshness(
  entityIds: string[],
  now: () => number = Date.now,
  /** Loader seam. Production uses the cached wrapper; tests inject the uncached probe, because
   *  unstable_cache does not execute outside a Next request context. */
  load: (ids: string[]) => Promise<CollectionsFreshness> = collectionsDataUpdatedAt,
): Promise<FreshnessState> {
  let record: CollectionsFreshness;
  try {
    record = await load(entityIds);
  } catch {
    // Already logged with the cache key inside readCollectionsFreshness.
    return { status: 'unavailable' };
  }
  const measuredMs = Date.parse(record.measuredAt);
  const aged = Number.isFinite(measuredMs) && now() - measuredMs > FRESHNESS_STALE_AFTER_MS;
  return {
    status: aged ? 'stale' : 'current',
    updatedAt: record.updatedAt,
    measuredAt: record.measuredAt,
  };
}
