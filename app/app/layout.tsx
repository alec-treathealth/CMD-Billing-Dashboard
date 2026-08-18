import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NavLinks } from '@/components/nav-links';
import { SwitcherTenantLogo } from '@/components/dashboard/switcher-tenant-logo';
import { TenantLogo } from '@/components/tenant-logo';
import { UserMenu } from '@/components/user-menu';
import { BrandTheme } from '@/components/brand-theme';
import { HeaderGate } from '@/components/header-gate';
import { NavRail } from '@/components/shell/nav-rail';
import { ContentInset } from '@/components/shell/content-inset';
import { dashboardAccess } from '@/lib/access';
import { isAlecOwnerEmail } from '@/lib/alec-only';
import { resolveShellModeEnv } from '@/lib/shell';
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
  // Which chrome to render. Server-read env, default 'bar' — production is unchanged until
  // SHELL_MODE=rail is set (and, as with the maintenance switches, redeployed).
  const shellMode = resolveShellModeEnv(process.env.SHELL_MODE);
  const railMode = shellMode === 'rail';
  return (
    <html lang="en">
      <body className="min-h-screen bg-ground">
        {/* Sets <html data-view="…"> per active dashboard view (brand accent). */}
        <Suspense fallback={null}>
          <BrandTheme />
        </Suspense>
        {/* The M3 navigation rail (SHELL_MODE=rail only). Fixed to the left edge, outside the
            HeaderGate because it self-gates on the same isFullPageRoute predicate. It reads
            ?view= to forward the tenant scope, so it needs the same Suspense boundary as the
            nav and switcher below. */}
        <Suspense fallback={null}>
          <NavRail mode={shellMode} role={role} />
        </Suspense>
        <ContentInset mode={shellMode}>
        {/* Brand anchor bar — background follows the active view (--brand-bar; teal by
            default off-dashboard). In 'bar' mode a 3-col grid keeps the nav centered, logo
            left, and the right column holds the view switcher + user avatar. In 'rail' mode
            the rail owns the brand and the nav, so the bar slims to the right-hand controls.
            Hidden on /login, which renders its own full-page split-panel chrome.
            NOTE: exactly ONE display class — emitting both `flex` and `grid` would leave the
            layout to Tailwind's stylesheet order rather than to this ternary. */}
        <HeaderGate>
        <header
          className={[
            'h-14 items-center gap-3 bg-[var(--brand-bar)] px-4 transition-colors duration-300 sm:px-6',
            railMode ? 'flex justify-end' : 'grid grid-cols-[auto_1fr_auto]',
          ].join(' ')}
        >
          {/* col 1: logo + title — omitted in rail mode, where the rail carries the mark. */}
          {railMode ? null : (
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
          )}
          {/* col 2: nav — centered. NavLinks reads ?view= (to forward it onto the Dashboard
              link) via useSearchParams, so it must be wrapped in Suspense for the static routes
              (/, /code-reference) this shared layout also renders — same as the switcher below.
              In rail mode the rail is the nav, so this is omitted rather than duplicated. */}
          {railMode ? null : (
            <Suspense fallback={null}>
              <NavLinks role={role} />
            </Suspense>
          )}
          {/* col 3: current-tenant logo + user avatar.
              ⚠ THE ViewSwitcher DROPDOWN WAS REMOVED FROM HERE 2026-08-18 (Alec: "No dropdowns").
              Entity selection now lives ON the page as <TenantTabs>, on Overview and Collections —
              the two routes that actually have a `?view=` scope. Do not re-add a switcher to the top
              bar: two controls writing the same URL param would be a state-sync bug waiting to
              happen, and the whole point of the change was that the choice should be visible at rest
              rather than collapsed into a label.
              SwitcherTenantLogo STAYS: it is a read-only indicator of the active tenant (client,
              ?view=-driven; null on consolidated / off-dashboard), which is still useful in the
              chrome on every route. It reads ?view= via useSearchParams, so it keeps its Suspense
              boundary for the static routes (/, /code-reference) this shared layout also renders.
              The avatar needs a session email, so it stays conditional. */}
          <div className="flex items-center justify-end gap-3">
            <Suspense fallback={null}>
              <SwitcherTenantLogo allowedViews={allowedViews} />
            </Suspense>
            {/* single-tenant user: their entity's logo immediately LEFT of the avatar (server-side). */}
            {singleTenantSlug ? <TenantLogo slug={singleTenantSlug} /> : null}
            {email ? <UserMenu email={email} canManageUsers={canManageUsers} canViewUserLogs={canViewUserLogs} /> : null}
          </div>
        </header>
        </HeaderGate>
        {children}
        </ContentInset>
      </body>
    </html>
  );
}
