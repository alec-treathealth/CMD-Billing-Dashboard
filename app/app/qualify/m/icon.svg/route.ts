/**
 * PWA install icon for the Qualify mobile app — the TreatHealthOS hexagon on a solid teal ground
 * (maskable-friendly). Served as SVG so it needs no binary asset; referenced from the manifest.
 */
export const dynamic = 'force-static';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">
<rect width="100" height="100" rx="18" fill="#0E3A3A"/>
<polygon points="50,22 68,33 50,44 32,33" fill="#1C8B82"/>
<polygon points="68,33 68,55 50,66 50,44" fill="#135E5A"/>
<polygon points="50,44 50,66 32,55 32,33" fill="#E2674F"/>
<polygon points="50,66 66,75 50,84 34,75" fill="#F0917C"/>
</svg>`;

export function GET() {
  return new Response(SVG, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    },
  });
}
