'use client';

/**
 * Hides the global brand/nav header on routes that render their own full-page
 * chrome (the Continuity-styled auth screens, and the /qualify/m PWA). Client-side
 * because the pathname is the only input; the header itself stays a server-rendered
 * child.
 *
 * The route list lives in `lib/shell.ts` so the header, the navigation rail, and the
 * content inset all gate on ONE predicate — three copies would drift the first time
 * a full-page route is added.
 */
import { usePathname } from 'next/navigation';

import { isFullPageRoute } from '@/lib/shell';

export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isFullPageRoute(pathname)) return null;
  return <>{children}</>;
}
