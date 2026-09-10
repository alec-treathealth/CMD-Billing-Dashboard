import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NavLinks } from '@/components/nav-links';
import { TenantScope, TenantScopeRail } from '@/components/nav/tenant-scope';
import { TenantLogo } from '@/components/tenant-logo';
import { UserMenu } from '@/components/user-menu';
import { ArNotificationsBell } from '@/components/ar-notifications-bell';
import { BrandTheme } from '@/components/brand-theme';
import { HeaderGate } from '@/components/header-gate';
import { NavRail } from '@/components/shell/nav-rail';
import { SpeedInsights } from '@/components/speed-insights';
import { ContentInset } from '@/components/shell/content-inset';
import { dashboardAccess } from '@/lib/access';
import { claimsAuditMaintenanceBlocks } from '@/lib/billing-audit/maintenance';
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
  // and the entitled views for the tenant-scope control. An unprovisioned user still gets an avatar
  // (so they can Sign out) but no scope control; the no-auth fallback yields all views and a null
  // email (no avatar).
  const access = await dashboardAccess();
  const email = access.ok
    ? access.access.user?.email ?? null
    : access.reason === 'unprovisioned'
      ? access.user.email
      : null;
  const allowedViews = access.ok ? access.access.allowedViews : undefined;
  const canManageUsers = access.ok ? access.access.canManageUsers : false;
  const canViewUserLogs = access.ok ? isAlecOwnerEmail(access.access.user?.email) : false;
  // Payer-alias ruling is super_admin ONLY and needs a REAL principal — this mirrors the gate in
  // app/app/admin/payer-aliases/page.tsx term for term (`!access.access.user || role !== 'super_admin'`
  // → redirect). Deliberately NOT `canManageUsers`: that is admin ∪ super_admin, and
  // `ref.payer_alias_map` has no tenancy column to clamp an entity-scoped admin against — the page's
  // docblock rejects that role by name. The staged-rollout fallback (role super_admin, user null)
  // must not grow the link either, hence the explicit user check. This is a front door only; the page
  // and its Server Action re-gate.
  const canRulePayerAliases = access.ok
    ? Boolean(access.access.user) && access.access.role === 'super_admin'
    : false;
  // A single-entitled-tenant user (entity admin OR entity user — anyone who is NOT a super-admin
  // and has an entity) is branded by their fixed entity, server-side, LEFT of the avatar on every
  // route. A super-admin's tenant is view-dependent (?view=) and is stated client-side by the
  // <TenantScope> pill beside the lockup; here it resolves to null (no entity), so no avatar-side
  // logo.
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
            nav and the scope control below. */}
        <Suspense fallback={null}>
          <NavRail mode={shellMode} role={role} />
        </Suspense>
        <ContentInset mode={shellMode}>
        {/* Brand anchor bar — background follows the active view (--brand-bar; teal by
            default off-dashboard). In 'bar' mode a 3-col grid keeps the nav centered, with the
            logo + tenant-scope pill left and the user avatar right. In 'rail' mode the rail owns
            the brand and the nav, so the bar slims to the scope pill (left) and the avatar
            (right). Hidden on /login, which renders its own full-page split-panel chrome.
            NOTE: exactly ONE display class — emitting both `flex` and `grid` would leave the
            layout to Tailwind's stylesheet order rather than to this ternary.
            gap-2 below lg / gap-3 at lg+ (2026-09-08, ruling 2b), applied here AND to col 1's
            inner gap: together with dropping the pill's icon below lg (2a) this closed the 768px
            overflow the scope pill introduced — measured 768/768 against the shipped stylesheet.
            (An earlier draft of this note said it was "NOT sufficient"; that reading came from a
            broken replica and was wrong.) The residual is 390px, where the nav overflowed by
            ~306px BEFORE this change — pre-existing, unguarded WCAG 1.4.10, out of scope here. */}
        <HeaderGate>
        <header
          className={[
            'h-14 items-center gap-2 bg-[var(--brand-bar)] px-4 transition-colors duration-300 sm:px-6 lg:gap-3',
            railMode ? 'flex justify-between' : 'grid grid-cols-[auto_1fr_auto]',
          ].join(' ')}
        >
          {/* col 1: logo + title + TENANT SCOPE.
              ⚠ RULING REVERSED 2026-09-08 (Alec). The block that used to sit on col 3 said:
              "THE ViewSwitcher DROPDOWN WAS REMOVED FROM HERE 2026-08-18 (Alec: 'No dropdowns').
              Entity selection now lives ON the page as <TenantTabs> … Do not re-add a switcher to
              the top bar: two controls writing the same URL param would be a state-sync bug
              waiting to happen." Alec reversed the placement half of that ruling on 2026-09-08:
              the selector returns to the top bar as <TenantScope> — a filled, LABELLED pill with
              a menu, immediately right of the lockup — and the in-body <TenantTabs> row was
              REMOVED from all three routes and deleted. The state-sync half of the old warning is
              honoured, not overridden: TenantScope is the ONLY interactive writer of ?view=
              (grep -rn "params.set('view'" app/ → one file), so there are not two controls.
              ⚠ THERE WERE TWO 2026-09-08 RULINGS, NOT ONE. An in-nav control was first specced that
              morning and then ruled AGAINST — "stay put" — on two findings: it would reverse the
              2026-08-18 ruling, and the layout is a Server Component that cannot read searchParams,
              so it could not know that the Claims Desk offers two tenants while /dashboard offers
              three (that ruling was recorded in tenant-tabs.tsx, now deleted with it). Alec then
              reversed course the same day and this control is the result. What answered the
              Server-Component objection is `offeredViews` in tenant-scope.tsx: the route-narrowed set
              is derived CLIENT-side from usePathname() with the same claimsDeskViews the desk page
              uses, so the nav and the page cannot disagree.
              What did NOT reverse: the tenant is stated as TEXT at rest on every route — the
              2026-08-18 objection to a scope "collapsed into a label the user had to go find" is
              met by the pill's always-visible name, not by a logo.
              In rail mode the rail carries the mark, so this cell holds ONLY the pill — a tenant
              indicator that vanished on an env var would be the exact failure this control
              exists to prevent (ruling 4, 2026-09-08). TenantScope reads ?view= via
              useSearchParams, so it keeps a Suspense boundary for the static routes (/, the
              /code-reference redirect stub — /code-performance itself is force-dynamic) this shared
              layout also renders. Inner gap mirrors the header's (2b). */}
          <div className="flex items-center gap-2 lg:gap-3">
            {railMode ? null : (
              <>
                <Logo size={26} />
                <div className="leading-none">
                  <div className="ths-h text-sm font-semibold tracking-tight text-white">
                    TreatHealth<span className="text-[#5FBFA8]">OS</span>
                  </div>
                  <div className="mt-0.5 hidden text-[9px] font-semibold uppercase tracking-widest text-white/70 sm:block">
                    Billing · RCM
                  </div>
                </div>
              </>
            )}
            <Suspense fallback={null}>
              <TenantScope allowedViews={allowedViews} />
            </Suspense>
          </div>
          {/* col 2: nav — centered. NavLinks reads ?view= (to forward it onto the Dashboard
              link) via useSearchParams, so it must be wrapped in Suspense for the static routes
              (/, the /code-reference redirect stub — /code-performance itself is force-dynamic) this
              shared layout also renders — same as the scope pill above.
              In rail mode the rail is the nav, so this is omitted rather than duplicated. */}
          {railMode ? null : (
            <Suspense fallback={null}>
              <NavLinks role={role} />
            </Suspense>
          )}
          {/* col 3: single-tenant logo + user avatar.
              <SwitcherTenantLogo> was REMOVED from here 2026-09-08 with the ruling above: it was a
              read-only, logo-only indicator of the same tenant the <TenantScope> pill now states
              in text, 200px to its left — two indicators of one fact, the less legible of them
              redundant. <TenantLogo> itself STAYS (it is the server-side single-tenant mark below).
              The avatar needs a session email, so it stays conditional. */}
          <div className="flex items-center justify-end gap-3">
            {/* single-tenant user: their entity's logo immediately LEFT of the avatar (server-side). */}
            {singleTenantSlug ? <TenantLogo slug={singleTenantSlug} /> : null}
            {/* AR Management change feed — a super-admin surface by request (2026-09-09). Rendered by
                DOM omission for every other role; the actions behind it re-gate on the role too. It
                needs a real principal, so the no-auth fallback (role super_admin, email null) shows
                nothing.
                ⚠ ALSO GATED ON THE ROLLOUT FLAG, and this is the one piece of AR Management that
                lives in the LAYOUT rather than behind /billing-audit's own gate. Without the
                maintenance check the bell renders for every super-admin while the page it links to
                still shows "being rebuilt" — a live unread badge whose every click dead-ends. That
                is 12 of the 14 super-admins today. This is a RENDER gate only: the flag must never
                enter an authorization path (see lib/maintenance-bypass.ts), so the actions behind
                the bell keep their own independent role gate and are unchanged. */}
            {role === 'super_admin' && email && !claimsAuditMaintenanceBlocks(email) ? <ArNotificationsBell /> : null}
            {email ? (
              <UserMenu
                email={email}
                canManageUsers={canManageUsers}
                canViewUserLogs={canViewUserLogs}
                canRulePayerAliases={canRulePayerAliases}
              />
            ) : null}
          </div>
        </header>
        {/* The 4px tenant rail — full-bleed, directly under the bar, in the active tenant's
            --entity-fill. It carries its OWN data-view (see tenant-scope.tsx: BrandTheme stamps
            <html data-view> on /dashboard* only, so on /billing-audit nothing above it carries the
            attribute). Inside the HeaderGate so it hides with the header on full-page routes;
            Suspense for the same reason as the pill. Renders nothing when there is no tenant scope
            (admissions_seat) — same derivation as the pill, so they cannot disagree. */}
        <Suspense fallback={null}>
          <TenantScopeRail allowedViews={allowedViews} />
        </Suspense>
        </HeaderGate>
        {children}
        </ContentInset>
        {/* Core Web Vitals. Our own wrapper, never @vercel/speed-insights/next directly — the
            vitals beacon carries the full href, so the wrapper strips the query string before
            egress (?facility=/?payer=/?actor= must not leave). See components/speed-insights.tsx
            for the payload contract and the P0-4 ruling it inherits. It needs no Suspense here:
            the package wraps its own useSearchParams() reader. Renders null. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
