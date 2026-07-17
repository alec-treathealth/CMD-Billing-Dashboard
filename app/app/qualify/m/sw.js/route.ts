/**
 * Service worker for the Qualify mobile PWA, served at /qualify/m/sw.js and scope-limited to
 * /qualify/m/ (Service-Worker-Allowed). It caches ONLY immutable build assets under /_next/static/;
 * every dynamic/data/POST request (page HTML, Next Server Actions, getQualifySnapshot/Movers, the
 * manifest) is network-only and NEVER cached — so no PHI- or dollar-bearing response can be stored.
 *
 * The cache rule here mirrors `isShellAsset` in app/lib/qualify/m/swCachePolicy.ts (the tested source
 * of truth); the prefix is injected so the two never drift.
 */
import { SHELL_ASSET_PREFIX } from '@/lib/qualify/m/swCachePolicy';

export const dynamic = 'force-static';

const SW_SOURCE = `
const CACHE = 'qualify-m-shell-v1';
const SHELL_ASSET_PREFIX = ${JSON.stringify(SHELL_ASSET_PREFIX)};

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Cache ONLY immutable, same-origin build assets. Never touch POST (Server Actions), the page HTML,
  // the data path, or the manifest — so no PHI/dollar response is ever stored. (Mirrors swCachePolicy.)
  const isShell = req.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(SHELL_ASSET_PREFIX);
  if (!isShell) return; // network passthrough, uncached
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  })());
});
`;

export function GET() {
  return new Response(SW_SOURCE, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'service-worker-allowed': '/qualify/m/',
      'cache-control': 'no-cache',
    },
  });
}
