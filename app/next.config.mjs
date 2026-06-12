/**
 * The library under ../src is authored as ESM with explicit `.js` import
 * specifiers (NodeNext style). Teach webpack to resolve those specifiers to the
 * `.ts` sources so the route handlers can import the agent/query/results modules
 * directly. `pg` is kept external to the server bundle (native-ish, Node-only).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
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
