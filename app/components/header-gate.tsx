'use client';

/**
 * Hides the global brand/nav header on routes that render their own full-page
 * chrome (the Continuity-styled auth screens). Client-side because the pathname
 * is the only input; the header itself stays a server-rendered child.
 */
import { usePathname } from 'next/navigation';

const FULL_PAGE_ROUTES = new Set(['/login', '/forgot-password']);

export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname !== null && FULL_PAGE_ROUTES.has(pathname)) return null;
  return <>{children}</>;
}
