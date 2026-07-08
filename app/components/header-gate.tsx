'use client';

/**
 * Hides the global brand/nav header on routes that render their own full-page
 * chrome (the split-panel /login). Client-side because the pathname is the
 * only input; the header itself stays a server-rendered child.
 */
import { usePathname } from 'next/navigation';

export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return null;
  return <>{children}</>;
}
