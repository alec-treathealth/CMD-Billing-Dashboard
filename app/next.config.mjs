/**
 * The library under ../src is authored as ESM with explicit `.js` import
 * specifiers (NodeNext style). Teach webpack to resolve those specifiers to the
 * `.ts` sources so the route handlers can import the agent/query/results modules
 * directly. `pg` is kept external to the server bundle (native-ish, Node-only).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
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
