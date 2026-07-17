'use client';

/**
 * Hides the global brand/nav header on routes that render their own full-page
 * chrome (the Continuity-styled auth screens). Client-side because the pathname
 * is the only input; the header itself stays a server-rendered child.
 */
import { usePathname } from 'next/navigation';

const FULL_PAGE_ROUTES = new Set(['/login', '/forgot-password', '/set-password']);

export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === null) return <>{children}</>;
  // The Qualify mobile PWA (/qualify/m) is a full-screen, self-chrome surface — hide the global brand
  // header there. Uses startsWith so it never matches the desktop /qualify (which keeps the header).
  if (FULL_PAGE_ROUTES.has(pathname) || pathname.startsWith('/qualify/m')) return null;
  return <>{children}</>;
}
