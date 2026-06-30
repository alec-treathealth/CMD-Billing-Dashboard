'use client';

/**
 * View switcher — the dashboard "which entity" dropdown, mounted in the global top bar
 * (next to the user avatar). Updates the URL `?view=` param (the single source of truth,
 * read server-side by the dashboard pages), so the selection survives refresh, is
 * shareable, and scopes the whole dashboard (Overview + Collections). Other query params
 * are preserved.
 *
 * Renders ONLY on dashboard routes — on /claims, /ask, etc. there is no view, so it
 * returns null. Reads the active view from the URL itself (no prop), so it is
 * self-contained in the layout. No localStorage/cookies (CLAUDE.md §2); the param is
 * non-PHI. This control never touches data or any auth gate — it only rewrites the URL.
 */
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { resolveView, viewOptions } from '@/lib/views';

export function ViewSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Only the dashboard has a "view". Off-dashboard routes render nothing.
  const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  if (!onDashboard) return null;

  const view = resolveView({ view: searchParams?.get('view') ?? undefined });

  function onChange(next: string) {
    if (next === view) return;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <select
      value={view}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Dashboard view"
      className="h-8 rounded-md bg-white/10 px-2 text-[13px] font-medium text-white ring-1 ring-white/30 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    >
      {viewOptions.map((o) => (
        <option key={o.value} value={o.value} className="text-ink900">
          {o.label}
        </option>
      ))}
    </select>
  );
}
