'use client';

/**
 * Super-admin, switcher-side tenant logo. A super-admin's "current tenant" is the `?view=` param
 * (client-only — the root layout is a Server Component and can't read searchParams), so this
 * mirrors TenantTabs / BrandTheme: it renders the CURRENT tenant's logo immediately to the LEFT
 * of the dropdown, and ONLY when there is a single tenant to show —
 *   • on a /dashboard route,
 *   • for a multi-view principal (super-admin; ≤1 view means no switcher and no tenant choice), and
 *   • when a specific tenant is selected — the consolidated view (TenantLogo returns null for it)
 *     and every non-dashboard route show no tenant logo.
 * Single-tenant users never reach here (≤1 view); their logo is placed server-side by the avatar.
 *
 * ⚠ THE /dashboard TEST IS NO LONGER "WHERE A VIEW EXISTS" — IT IS NOW A DELIBERATE CHOICE.
 * This docblock justified the route check with "(there is no view elsewhere)" until 2026-08-31,
 * when a tenant control landed on /billing-audit: that route resolves and canonicalises its own
 * `?view=` (BXR or Indigo, never consolidated — see `lib/billing-audit/views.ts`), so a view
 * demonstrably DOES exist elsewhere now and the parenthetical was false.
 *
 * The behaviour is unchanged on purpose, not by oversight. `.claude/rules/nextjs-app.md` rules
 * that "off-dashboard chrome stays teal", and `BrandTheme` clears `<html data-view>` off
 * /dashboard for the same reason — so a tenant logo in the global top bar would be the one piece
 * of per-tenant chrome on an otherwise teal surface. The Claims Desk states its tenant on the
 * page instead, via TenantTabs' own per-tenant swatch (the swatch span carries `data-view`
 * itself, and globals.css's `[data-view=…]` rules are bare attribute selectors, so the accent
 * resolves there without `<html>` being involved).
 *
 * Qodo flagged this as a correctness bug on PR #308 and it was REJECTED on that evidence.
 * Whether off-dashboard chrome SHOULD now follow the tenant is a live design question for Alec —
 * a second surface having a tenant choice is new — but it is a ruling, not a bug fix, and it
 * would change three components at once. Do not "fix" it here without that ruling.
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
