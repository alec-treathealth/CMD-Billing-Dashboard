/**
 * Qualify mobile PWA layout — attaches the scoped manifest + iOS web-app metadata and a light
 * theme_color to this segment only (the global brand header is hidden on /qualify/m by HeaderGate).
 * The per-request gate lives in page.tsx.
 */
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Lead lookup',
  manifest: '/qualify/m/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Lead lookup' },
};

export const viewport: Viewport = {
  themeColor: '#FBF8F4',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  userScalable: false,
};

export default function QualifyMobileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
