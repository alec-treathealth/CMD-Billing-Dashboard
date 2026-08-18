'use client';

/**
 * Super-admin, switcher-side tenant logo. A super-admin's "current tenant" is the `?view=` param
 * (client-only — the root layout is a Server Component and can't read searchParams), so this
 * mirrors TenantTabs / BrandTheme: it renders the CURRENT tenant's logo immediately to the LEFT
 * of the dropdown, and ONLY when there is a single tenant to show —
 *   • on a /dashboard route (there is no view elsewhere),
 *   • for a multi-view principal (super-admin; ≤1 view means no switcher and no tenant choice), and
 *   • when a specific tenant is selected — the consolidated view (TenantLogo returns null for it)
 *     and every non-dashboard route show no tenant logo.
 * Single-tenant users never reach here (≤1 view); their logo is placed server-side by the avatar.
 */
import { usePathname, useSearchParams } from 'next/navigation';

import { clampView, resolveView, type DashboardView } from '@/lib/views';
import { TenantLogo } from '@/components/tenant-logo';

export function SwitcherTenantLogo({ allowedViews }: { allowedViews?: DashboardView[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  if (!onDashboard || !allowedViews || allowedViews.length <= 1) return null;

  const view = clampView(resolveView({ view: searchParams?.get('view') ?? undefined }), allowedViews);
  // consolidated → tenantBrand() is null → TenantLogo renders nothing (no single tenant to brand).
  return <TenantLogo slug={view} />;
}
