/**
 * Scoped web app manifest for the Qualify mobile PWA. Next 15's built-in `manifest` metadata is
 * root-only, so this per-segment manifest is served by a route handler and referenced via a scoped
 * <link rel="manifest"> in the m/ layout.
 *
 * Scope is "/qualify/m" (no trailing slash so start_url stays in scope) — it covers ONLY the mobile
 * segment, so an installed instance can never navigate to Overview / Collections / Claims Desk or the
 * desktop /qualify (none of which are under /qualify/m). theme_color is the LIGHT ground, per the
 * ratified light scheme (not the superseded dark treatment).
 */
export const dynamic = 'force-static';

export function GET() {
  const manifest = {
    name: 'Qualify — Lead lookup',
    short_name: 'Lead lookup',
    description: 'Admissions lead qualification — resolve a payer and read facility ratings.',
    scope: '/qualify/m',
    start_url: '/qualify/m',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FBF8F4',
    theme_color: '#FBF8F4',
    icons: [
      { src: '/qualify/m/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/qualify/m/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}
