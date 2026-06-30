'use client';

/**
 * View switcher — the dashboard's "which entity" dropdown. Updates the URL `?view=`
 * param (the single source of truth, read server-side in the overview page), so the
 * selection survives refresh and is shareable. Other query params are preserved.
 *
 * No localStorage/cookies (CLAUDE.md §2). The param is non-PHI. This control never
 * touches data or any auth gate — it only rewrites the URL; the server page re-reads
 * `?view=` and renders the corresponding (BXR-or-stub) scope.
 */
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { ControlSelect } from '@/components/data-grid';
import { type DashboardView, viewOptions } from '@/lib/views';

export function ViewSwitcher({ view }: { view: DashboardView }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(next: string) {
    if (next === view) return;
    // Preserve any other params; only the `view` key changes.
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <ControlSelect label="View" value={view} ariaLabel="Dashboard view" onChange={onChange}>
      {viewOptions.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </ControlSelect>
  );
}
