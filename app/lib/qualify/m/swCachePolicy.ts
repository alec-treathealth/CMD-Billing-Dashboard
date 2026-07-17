/**
 * Service-worker cache policy for the Qualify mobile PWA (Prompt 4b) — PURE, the single source of the
 * rule. The SW caches ONLY immutable build assets under /_next/static/ (GET). Everything else — the
 * dynamic page HTML, Next Server Actions (POST), the getQualifySnapshot / getQualifyMovers data path,
 * the manifest, the SW itself — is network-only and NEVER cached. So no PHI- or dollar-bearing
 * response can ever land in the SW cache. The served sw.js mirrors `isShellAsset` verbatim, and
 * test/qualifySwCache.test.ts drives `simulateSwCache` over a full search→list→swipe→detail request
 * set (including a PHI/dollar-laden Server-Action POST) to prove the cache stays clean.
 */
export const SHELL_ASSET_PREFIX = '/_next/static/';

/** Only same-path immutable build assets are cacheable. POST (Server Actions) and every dynamic/data
 *  path return false → network passthrough, never stored. */
export function isShellAsset(pathname: string, method: string): boolean {
  return method.toUpperCase() === 'GET' && pathname.startsWith(SHELL_ASSET_PREFIX);
}

export interface SimReq {
  pathname: string;
  method: string;
  /** Response body the request WOULD return (only used to prove nothing sensitive gets stored). */
  body?: string;
}

/** Apply the SW rule to a request sequence and return exactly what would be stored in the cache. */
export function simulateSwCache(requests: ReadonlyArray<SimReq>): { cachedPaths: string[]; cachedBodies: string[] } {
  const cachedPaths: string[] = [];
  const cachedBodies: string[] = [];
  for (const r of requests) {
    if (isShellAsset(r.pathname, r.method)) {
      cachedPaths.push(r.pathname);
      cachedBodies.push(r.body ?? '');
    }
  }
  return { cachedPaths, cachedBodies };
}
