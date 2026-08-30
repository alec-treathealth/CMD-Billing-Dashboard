/**
 * The library under ../src is authored as ESM with explicit `.js` import
 * specifiers (NodeNext style). Teach webpack to resolve those specifiers to the
 * `.ts` sources so the route handlers can import the agent/query/results modules
 * directly. `pg` is kept external to the server bundle (native-ish, Node-only).
 *
 * @type {import('next').NextConfig}
 */
// Security response headers applied to every route. Defense-in-depth for a PHI app.
// HSTS is intentionally omitted — Vercel's edge already sends a strong
// `strict-transport-security` (2yr, includeSubDomains, preload); we don't duplicate it.
// NOTE: this is a `frame-ancestors`-only CSP (the clickjacking control). A full
// script-src/style-src CSP needs per-request nonces for Next's inline runtime and is a
// separate, Report-Only-first rollout — do NOT expand this into script-src here.
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
];

const nextConfig = {
  // Don't advertise the framework/version to clients.
  poweredByHeader: false,
  experimental: {
    // ⚠ RAISED FOR THE KIPU BILLING REPORT UPLOAD (Billable Days subtab). Server Actions
    // default to a 1 MB body, and ONE real Kipu export is ~3.6 MB (its Sessions CSV alone is
    // ~2.6 MB) — so the default silently rejected every genuine import.
    //
    // This is a global ceiling, not a per-action one, which is why it is deliberately a
    // FLOOR rather than the real control: `app/lib/billing-audit/kipu-actions.ts` enforces
    // max file count, max bytes per file and max total BEFORE it reads a single byte. Raise
    // that module's constants first if a larger import is ever needed; this number only has
    // to stay >= its MAX_TOTAL_BYTES.
    serverActions: { bodySizeLimit: '32mb' },
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  // libsodium-wrappers ships a BROKEN ESM build (imports a non-existent
  // ./libsodium.mjs), so src/collections/phiCrypto.ts loads its working CJS build via
  // createRequire. Mark it server-external so Next/webpack does not try to bundle it.
  // Both phiCrypto consumers — the /api/cron/cmd-explorer route and the PHI reveal
  // path — are server-only; without this, `next build` fails resolving the wasm.
  // See docs/CLAUDE.md §15.
  serverExternalPackages: ['libsodium-wrappers'],
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    if (isServer) {
      config.externals = [...(config.externals ?? []), 'pg', 'pg-native'];
    }
    return config;
  },
};

export default nextConfig;
