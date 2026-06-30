'use client';

/**
 * Per-view brand theme switch. Sets `<html data-view="…">` from the active dashboard
 * view (route + ?view=) so the brand accent variables in globals.css apply — navy/gold
 * for BXR, indigo/violet for Indigo, teal for Consolidated. OFF dashboard routes the
 * attribute is cleared, so the rest of the app keeps the default TreatHealthOS teal.
 *
 * Renders nothing; it only mutates the <html> attribute in an effect. Uses useEffect
 * (not useLayoutEffect) to avoid the SSR warning — a brief default-teal first paint on a
 * dashboard route is acceptable for this internal tool. The ?view= param is non-PHI.
 */
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { resolveView } from '@/lib/views';

export function BrandTheme() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
    const root = document.documentElement;
    if (onDashboard) {
      root.dataset.view = resolveView({ view: searchParams?.get('view') ?? undefined });
    } else {
      delete root.dataset.view;
    }
    return () => {
      delete root.dataset.view;
    };
  }, [pathname, searchParams]);

  return null;
}
