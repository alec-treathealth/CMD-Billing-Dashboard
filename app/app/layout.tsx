import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NavLinks } from '@/components/nav-links';
import { ViewSwitcher } from '@/components/dashboard/view-switcher';
import { SwitcherTenantLogo } from '@/components/dashboard/switcher-tenant-logo';
import { TenantLogo } from '@/components/tenant-logo';
import { UserMenu } from '@/components/user-menu';
import { BrandTheme } from '@/components/brand-theme';
import { HeaderGate } from '@/components/header-gate';
import { dashboardAccess } from '@/lib/access';
import { isAlecOwnerEmail } from '@/lib/alec-only';
import './globals.css';

// Co-locate every page's server function with the database. The Supabase project is in
// us-west-1 (N. California); Vercel's default function region is iad1 (Washington DC), so every
// auth call + DB connection/query was paying a cross-country round trip (the in-function
// auth/v1/user call measured ~245ms vs ~30ms at the SF edge). sfo1 is the Vercel region next to
// us-west-1, so functions, DB, and the SF users all sit on the west coast. Inherited by every
// route segment below (App Router route-segment config).
export const preferredRegion = 'sfo1';

export const metadata: Metadata = {
  title: 'TreatHealthOS Billing & RCM',
  description: 'Historical out-of-network behavioral-health claims search (PHI — compliance layer on).',
};

/** TreatHealthOS hexagon mark (teal/coral facets), inline so the shell needs no asset. */
function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="TreatHealthOS">
      <polygon
        points="50,4 88,26 88,74 50,96 12,74 12,26"
        fill="rgba(255,255,255,.08)"
        stroke="#fff"
        strokeWidth="5"
      />
      <polygon points="50,20 68,31 50,42 32,31" fill="#1C8B82" />
      <polygon points="68,31 68,53 50,64 50,42" fill="#135E5A" />
      <polygon points="50,42 50,64 32,53 32,31" fill="#E2674F" />
      <polygon points="50,64 66,73 50,82 34,73" fill="#F0917C" />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // One cached resolution (deduped with the dashboard page on dashboard routes): the avatar email
  // and the entitled views for the switcher. An unprovisioned user still gets an avatar (so they
  // can Sign out) but no switcher; the no-auth fallback yields all views and a null email (no avatar).
  const access = await dashboardAccess();
  const email = access.ok
    ? access.access.user?.email ?? null
    : access.reason === 'unprovisioned'
      ? access.user.email
      : null;
  const allowedViews = access.ok ? access.access.allowedViews : undefined;
  const canManageUsers = access.ok ? access.access.canManageUsers : false;
  const canViewUserLogs = access.ok ? isAlecOwnerEmail(access.access.user?.email) : false;
  // A single-entitled-tenant user (entity admin OR entity user — anyone who is NOT a super-admin
  // and has an entity) is branded by their fixed entity, server-side, LEFT of the avatar on every
  // route. A super-admin's tenant is view-dependent (?view=) and is handled client-side by the
  // switcher-side <SwitcherTenantLogo>; here it resolves to null (no entity), so no avatar-side logo.
  const role = access.ok ? access.access.role : undefined;
  const singleTenantSlug = role && role !== 'super_admin' ? (access.ok ? access.access.entity : null) : null;
  return (
    <html lang="en">
      <body className="min-h-screen bg-ground">
        {/* Sets <html data-view="…"> per active dashboard view (brand accent). */}
        <Suspense fallback={null}>
          <BrandTheme />
        </Suspense>
        {/* Brand anchor bar — background follows the active view (--brand-bar; teal by
            default off-dashboard). 3-col grid keeps the nav centered, logo left, and the
            right column holds the view switcher + user avatar. Hidden on /login, which
            renders its own full-page split-panel chrome. */}
        <HeaderGate>
        <header className="grid h-14 grid-cols-[auto_1fr_auto] items-center gap-3 bg-[var(--brand-bar)] px-4 transition-colors duration-300 sm:px-6">
          {/* col 1: logo + title */}
          <div className="flex items-center gap-3">
            <Logo size={26} />
            <div className="leading-none">
              <div className="ths-h text-sm font-semibold tracking-tight text-white">
                TreatHealth<span className="text-[#5FBFA8]">OS</span>
              </div>
              <div className="mt-0.5 hidden text-[9px] font-semibold uppercase tracking-widest text-white/70 sm:block">
                Billing · RCM
              </div>
            </div>
          </div>
          {/* col 2: nav — centered. NavLinks reads ?view= (to forward it onto the Dashboard
              link) via useSearchParams, so it must be wrapped in Suspense for the static routes
              (/, /code-reference) this shared layout also renders — same as the switcher below. */}
          <Suspense fallback={null}>
            <NavLinks />
          </Suspense>
          {/* col 3: view switcher (dashboard routes only) + user avatar.
              The ViewSwitcher is NON-PHI UI (it just rewrites ?view=) and renders regardless
              of auth — production gates the app via Vercel Deployment Protection, where there
              is no Supabase session/email, so gating it on `email` wrongly hid it there. It
              reads ?view= via useSearchParams, so it must be wrapped in Suspense for the static
              routes (/, /code-reference) this shared layout also renders, and it self-hides off
              dashboard routes. The avatar needs a session email, so it stays conditional. */}
          <div className="flex items-center justify-end gap-3">
            {/* super-admin: current-tenant logo LEFT of the switcher (client, ?view=-driven; null on
                consolidated / off-dashboard). Single-tenant users render nothing here (≤1 view). */}
            <Suspense fallback={null}>
              <SwitcherTenantLogo allowedViews={allowedViews} />
            </Suspense>
            <Suspense fallback={null}>
              <ViewSwitcher allowedViews={allowedViews} />
            </Suspense>
            {/* single-tenant user: their entity's logo immediately LEFT of the avatar (server-side). */}
            {singleTenantSlug ? <TenantLogo slug={singleTenantSlug} /> : null}
            {email ? <UserMenu email={email} canManageUsers={canManageUsers} canViewUserLogs={canViewUserLogs} /> : null}
          </div>
        </header>
        </HeaderGate>
        {children}
      </body>
    </html>
  );
}
