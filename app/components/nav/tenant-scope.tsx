'use client';

/**
 * TENANT SCOPE — the nav-resident "which entity am I looking at" control (2026-09-08).
 *
 * ── WHAT THIS REVERSES, AND WHO REVERSED IT ────────────────────────────────────────────────────
 * On 2026-08-18 Alec ruled "No dropdowns" and the entity selector became `TenantTabs`, a row of
 * pills on the page body of /dashboard, /dashboard/collections and /billing-audit. On 2026-09-08
 * Alec reversed that ruling: the selector returns to the top bar as a filled, LABELLED pill with a
 * menu, plus a 4px rail under the nav, and the in-body row is deleted. The reversal is his and is
 * recorded at its old site in app/layout.tsx. The substance that survives from the 2026-08-18
 * ruling is the part that was never about placement: the tenant is stated as TEXT, at rest, on
 * every route — never collapsed into a logo, never conveyed by colour alone.
 *
 * ── THE INVARIANT: ONE INTERACTIVE WRITER OF ?view= ───────────────────────────────────────────
 * This is the only client component that performs an interactive write of the `?view=` param —
 * tenant-scope.test.tsx scans every `'use client'` file for a `.set(…'view'…)` call or a
 * `?view=` literal in CODE (comments stripped) and requires the hit list to be exactly this file,
 * with billable-days/panel.tsx's `fd.set('view', …)` allowlisted by name as a FormData field for a
 * Server Action rather than a URL write. Two OTHER classes of writer exist and are load-bearing,
 * so they are not this component's concern and must not be "consolidated" into it: the
 * server-side canonicalisation redirects in the page files (which make URL, theme and data agree,
 * and on /billing-audit narrow fail-closed), and the `navHref` forwarding in lib/nav-model.ts
 * (which carries the scope across a surface change).
 *
 * ── THE ROUTE-NARROWED SEAM ────────────────────────────────────────────────────────────────────
 * The root layout is a Server Component that already resolves RBAC — it hands `allowedViews` in —
 * but it cannot know the ROUTE, and the Claims Desk offers two tenants where /dashboard offers
 * three. `offeredViews` makes that decision here from `usePathname()`, by calling the SAME
 * `claimsDeskViews` the desk page uses, so the nav and the page cannot disagree about what is on
 * offer — for the desk INDEX only: its sub-route /billing-audit/facility-resolution resolves `?view=`
 * with the GENERIC resolver (Consolidated included), so `isClaimsDeskRoute` is an EXACT match and the
 * test binds that classification to each page's resolver import (Qodo #344 finding 3).
 * This component narrows; it never widens — a hand-edited `?view=` is clamped against the
 * offered set, and the page re-clamps server-side and scopes its data by the CLAMPED value.
 * ⚠ THE CONTROL IS NOT THE GATE. Do not "simplify" by trusting this option list for anything.
 *
 * ── WHEN THE PILL IS A LABEL, NOT A CONTROL ────────────────────────────────────────────────────
 * Three shapes, ruled together on 2026-09-08 because they share one principle: the pill may only
 * OFFER a choice where choosing does something, and it may only NAME a scope that is real.
 *   · ONE offered view (an entity admin/user): the pill RENDERS, as a non-interactive <span> — no
 *     chevron, no aria-haspopup, not a button. Their tenant is stated; there is nothing to switch.
 *     (TenantTabs rendered nothing here, which left them with no tenant indicator at all.)
 *   · ZERO offered views (admissions_seat — `allowedViewsFor` returns [] by design; its only
 *     surface, /payer-intel, is cross-tenant and not ?view=-scoped): render NOTHING. Any tenant
 *     name would be a lie and "Consolidated" would advertise a dashboard scope they do not have.
 *   · AN UNSCOPED ROUTE (any pathname outside `VIEW_SCOPED` in lib/nav-model.ts — /payer-intel,
 *     /admin, /account, /code-reference, /qualify…): the SAME rationale applies to a super_admin
 *     there, and the Phase 1 recon missed it (the code reviewer caught it). Offering BXR on
 *     /payer-intel would write `?view=bxr` onto a route that ignores it and paint a gold rail
 *     over a cross-tenant surface. So the pill is the non-interactive <span> — it STATES the
 *     carried scope rather than offering to change it. Not nothing: `navHref` forwards this scope
 *     onto the next scoped link, so the scope is real and stating it is honest. RULED (Alec,
 *     2026-09-08, on the code review of this change).
 *
 * ── WHY next/link AND NOT <a> ──────────────────────────────────────────────────────────────────
 * Options are real links so middle-click / open-in-new-tab / copy-link work — but they MUST be
 * `next/link`, because a same-pathname `?view=` change is a SOFT navigation and that is
 * load-bearing: the Billable Days panel (billing-audit/billable-days/overrides.ts) keeps a
 * biller's uploaded CSV corpus and unsaved edits mounted across a BXR → Indigo → BXR glance, and
 * `billingAuditViewRemount.test.tsx` pins the `key={view}` remount that makes the PHI tables
 * re-derive on the same soft nav. A bare <a> would hard-navigate and destroy the first while
 * making the second redundant. `<Link>` gives both behaviours: a real href, and a soft nav on a
 * plain left-click. `prefetch={false}`: the destinations are dynamic routes, so the viewport
 * prefetch buys little and would fire three RSC requests on every open.
 *
 * ── FOCUS ──────────────────────────────────────────────────────────────────────────────────────
 * Activating an option unmounts the menu, and the focused element with it; Next's soft nav does
 * not restore focus, so without intervention a keyboard user lands on <body> and Tabs back
 * through the whole header. Both Escape and activation therefore return focus to the trigger —
 * the APG menu-button pattern. Escape is handled ONCE, at document level while the menu is open
 * (the same shape as user-menu.tsx), so it also works when focus has drifted to non-focusable
 * padding inside the menu. The focus-on-open effect fires only on the closed→open TRANSITION:
 * `offeredViews` returns a fresh array per render, so a naive dependency on it would yank focus
 * back to the active item on every upstream re-render while a user is arrowing.
 * ⚠ These are WCAG 2.4.3 claims and CLAUDE.md wants such claims EXECUTED under jsdom
 * (app/test/helpers/dom.tsx, the dialog-focus.test.tsx pattern), not asserted from source. The
 * "one new test" ruling on this change held that back; it is the listed follow-up.
 *
 * ── DATA-VIEW IS ON THE ELEMENT, NOT INHERITED ─────────────────────────────────────────────────
 * globals.css's `[data-view=…]` rules are BARE attribute selectors, and `BrandTheme` stamps
 * `<html data-view>` on /dashboard* ONLY — on /billing-audit there is no ancestor to inherit from
 * and an inheriting pill paints consolidated teal for every tenant (measured: rgb(95,191,168) with
 * the attribute removed vs rgb(192,160,240) with it, /billing-audit?view=indigo). So the pill,
 * every menu item, and the rail carry their own `data-view`, and read `--entity-fill` /
 * `--entity-on` resolved on THAT element.
 *
 * ── RESPONSIVE ─────────────────────────────────────────────────────────────────────────────────
 * Below `lg` (1024px) the building icon is dropped and the short label ("Consolidated" / "BXR" /
 * "Indigo") replaces the full name. RULED — Alec, 2026-09-08, ruling 2(a) verbatim: *"drop the
 * building icon from the pill below lg, short label only."* The original brief said the same
 * (*"collapse the trigger to icon + short label (Consolidated / BXR / Indigo) but never to
 * icon-only"*). The tenant stays readable as TEXT at every width. ⚠ `lg:inline` and `lg:block`
 * did not exist in the shipped stylesheet before this component (no source used them; Tailwind
 * emits only what it scans), which produced an icon-only pill in a replica built on the old CSS.
 * tenant-scope.test.tsx greps the shipped CSS for both.
 *
 * ── MOTION ─────────────────────────────────────────────────────────────────────────────────────
 * `transition-transform` on the chevron and `transition-colors` elsewhere are collapsed to 0.01ms
 * by the global prefers-reduced-motion reset in globals.css (~L176). There is deliberately no
 * per-component `motion-reduce:` opt-out; the test pins the global mechanism instead.
 *
 * ── TEST SEAM ──────────────────────────────────────────────────────────────────────────────────
 * `TenantScopeView` / `TenantScopeRailView` take the hook-derived values as PROPS and own only
 * their interaction state, so `renderToStaticMarkup` can render them in node:test (the nav-rail
 * convention). `TenantScope` / `TenantScopeRail` are the mounted wrappers that read the router.
 */
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Building2, Check, ChevronDown } from 'lucide-react';

import { clampView, resolveView, viewOptions, type DashboardView } from '@/lib/views';
import { claimsDeskViews } from '@/lib/billing-audit/views';
import { VIEW_SCOPED } from '@/lib/nav-model';

/** The below-`lg` label. Text at every width; the full name returns at >=1024px. */
export const SHORT_LABEL: Readonly<Record<DashboardView, string>> = {
  consolidated: 'Consolidated',
  bxr: 'BXR',
  indigo: 'Indigo',
};

/** The full tenant name, from the ONE place the app names tenants (lib/views.ts). */
export function fullLabel(view: DashboardView): string {
  return viewOptions.find((o) => o.value === view)?.label ?? view;
}

/**
 * The Claims Desk INDEX — the one screen whose plane set is narrower than RBAC (two tenants, BXR
 * default, via `resolveClaimsDeskView`). EXACT match, deliberately NOT a prefix: the desk's sub-route
 * /billing-audit/facility-resolution hangs under the same nav tab but resolves `?view=` with the
 * GENERIC `resolveView` + `clampView` against full RBAC, Consolidated included — it moved there from
 * /dashboard/collections on 2026-08-17 for nav placement only ("nothing about the data, the RBAC, or
 * the server actions changed", per its page header). The first draft matched the prefix, so on that
 * workbench a super_admin with no `?view=` saw a BXR pill and a gold rail while the page queried BOTH
 * tenants and its attribution writes ran Consolidated (Qodo #344 finding 3). "Lives under the Claims
 * Desk tab" and "uses the Claims Desk resolver" are different predicates; this function is the second.
 * tenant-scope.test.tsx binds this classification to each desk page's resolver import so the two
 * cannot drift again.
 */
export function isClaimsDeskRoute(pathname: string | null): boolean {
  return pathname === '/billing-audit';
}

/**
 * Whether this route READS `?view=` — i.e. whether choosing a tenant here does anything. The set
 * is `VIEW_SCOPED` (lib/nav-model.ts), matched by exact path or sub-route so that
 * /billing-audit/facility-resolution and /dashboard/collections/* count. Off these routes the pill
 * still states the carried scope (navHref forwards it) but does not offer to change it.
 */
export function isViewScopedRoute(pathname: string | null): boolean {
  if (pathname === null) return false;
  for (const href of VIEW_SCOPED) {
    if (pathname === href || pathname.startsWith(href + '/')) return true;
  }
  return false;
}

/**
 * The tenants ON OFFER for this route: RBAC entitlement ∩ the route's planes, in the route's tab
 * order. Pure. Never wider than `allowedViews`. Empty means "no tenant scope for this principal".
 */
export function offeredViews(
  pathname: string | null,
  allowedViews: readonly DashboardView[] | undefined,
): DashboardView[] {
  if (!allowedViews || allowedViews.length === 0) return [];
  if (isClaimsDeskRoute(pathname)) return claimsDeskViews(allowedViews);
  return viewOptions.filter((o) => allowedViews.includes(o.value)).map((o) => o.value);
}

/** The destination for one option: the CURRENT route with only `?view=` replaced. */
export function scopeHref(pathname: string, search: string, view: DashboardView): string {
  const params = new URLSearchParams(search);
  params.set('view', view);
  return `${pathname}?${params.toString()}`;
}

/** One derivation for the pill and the rail, so the two can never disagree about the tenant. */
function useTenantScope(allowedViews: readonly DashboardView[] | undefined) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const offered = offeredViews(pathname, allowedViews);
  const active =
    offered.length === 0
      ? null
      : clampView(resolveView({ view: searchParams?.get('view') ?? undefined }), offered);
  return {
    offered,
    active,
    pathname: pathname ?? '/',
    search: searchParams?.toString() ?? '',
    interactive: isViewScopedRoute(pathname),
  };
}

export type TenantScopeViewProps = {
  offered: readonly DashboardView[];
  active: DashboardView | null;
  pathname: string;
  search: string;
  /** false off `VIEW_SCOPED` routes: the pill STATES the carried scope and offers no menu. */
  interactive: boolean;
};

// Shared by the interactive pill and the non-interactive <span>, so the two read identically at
// rest. `min-h-[44px]` is the WCAG 2.5.5 floor, measured 44.0px. `shrink-0` because this sits in
// the header's first grid cell beside the lockup and must not be squashed by the centred nav.
const PILL =
  'inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold ' +
  'bg-[var(--entity-fill)] text-[var(--entity-on)]';

/** The label pair: full name at >=lg, short label below. Both are text; neither is ever alone. */
function Label({ view }: { view: DashboardView }) {
  return (
    <>
      <span className="hidden lg:inline">{fullLabel(view)}</span>
      <span className="lg:hidden">{SHORT_LABEL[view]}</span>
    </>
  );
}

export function TenantScopeView({ offered, active, pathname, search, interactive }: TenantScopeViewProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const wasOpen = useRef(false);

  // Hooks run unconditionally; every bail-out sits below them (rules of hooks).

  // aria-live, ported from TenantTabs (ratified 2026-09-08 #338): these options NAVIGATE, so a
  // screen-reader user gets a route change with no spoken confirmation of which tenant is now in
  // scope — and tenant IS the scope. Silent on first mount (no previous view = no change); speaks
  // on a change, including a back/forward that moves ?view=, which is why it keys off `active`.
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<DashboardView | null>(null);
  useEffect(() => {
    if (active !== null && announced.current !== null && announced.current !== active) {
      setAnnouncement(`Tenant scope: ${fullLabel(active)}`);
    }
    announced.current = active;
  }, [active]);

  // Close on a pointer-down outside the control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Close on ANY navigation the menu did not initiate — browser back/forward, a nav-bar link. `open`
  // is local state in a component that lives in the persistent root layout, so without this a menu
  // left open would ride into the next route: hidden behind the non-interactive label on an unscoped
  // route, then reappearing open on return (Qodo #344 finding 2). Focus is left where the browser put
  // it — yanking it to the trigger on a history navigation would be worse than the stale menu was.
  useEffect(() => {
    setOpen(false);
  }, [pathname, search]);

  // Escape: ONE handler, at document level while open (see FOCUS above). Closes AND returns focus
  // to the trigger, so a keyboard user is never stranded on a detached or non-focusable node.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // On open, focus lands on the ACTIVE option, not the first — the menu is a radio group and the
  // checked item is where a keyboard user expects to start. Fires on the closed→open TRANSITION
  // only: the deps are complete (no exhaustive-deps waiver), but the body acts once per open.
  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened || active === null) return;
    const i = Math.max(0, offered.indexOf(active));
    itemRefs.current[i]?.focus();
  }, [open, offered, active]);

  if (active === null || offered.length === 0) return null;

  // A LABEL, not a control (see the docblock): one tenant on offer, OR a route that does not read
  // ?view=. Not a button — a control that does nothing is worse than a label. No chevron, no
  // popup semantics.
  if (offered.length === 1 || !interactive) {
    return (
      <span data-view={active} className={PILL}>
        <Building2 aria-hidden className="hidden h-4 w-4 lg:block" />
        <Label view={active} />
        <span className="sr-only"> — current tenant scope</span>
      </span>
    );
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onItemKeyDown(e: React.KeyboardEvent<HTMLAnchorElement>, i: number) {
    const last = offered.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Tab') {
      // Let focus leave naturally; just do not leave the menu open behind it.
      setOpen(false);
      return;
    } else if (e.key === ' ') {
      // Space activates a menuitemradio (the APG menu pattern), but a native anchor activates on
      // Enter only — Space would scroll the page instead (Qodo #344 finding 1). `.click()` dispatches
      // a real click, so next/link's soft navigation AND onActivate run through the one path a
      // pointer uses; nothing is duplicated and modified-click behaviour is untouched.
      e.preventDefault();
      e.currentTarget.click();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    itemRefs.current[next]?.focus();
  }

  // Activation: close AND return focus to the trigger (see FOCUS above). Mouse users see no ring —
  // :focus-visible heuristics suppress it after a pointer activation — so there is no visual cost.
  function onActivate() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-view={active}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        // The pill is a LIGHT chip on a DARK bar, so the focus ring is white with a bar-coloured
        // offset: the offset separates ring from chip, and white clears every --brand-bar by
        // >=9:1. (A --brand-ink ring would be 1.35-1.65:1 against the bar — invisible.)
        className={[
          PILL,
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--brand-bar)]',
        ].join(' ')}
      >
        <Building2 aria-hidden className="hidden h-4 w-4 lg:block" />
        <Label view={active} />
        <span className="sr-only">. Change tenant scope</span>
        <ChevronDown
          aria-hidden
          className={['h-4 w-4 shrink-0 transition-transform', open ? 'rotate-180' : ''].join(' ')}
        />
      </button>

      {open ? (
        // role="menu" + menuitemradio is what gives "the active option carries a check" to
        // assistive tech (aria-checked), and the arrow-key model a menu implies. The cost is that
        // each item announces as a menu item rather than a link; the href is still real, so the
        // link BEHAVIOURS (middle-click, new tab) are intact even though the link ROLE is not
        // announced. Deliberate: the semantics describe what the control IS (a choice of one
        // tenant), not how it happens to navigate. `aria-controls` on the closed trigger points at
        // an id that is not yet in the DOM; APG lists it as optional for menu buttons and axe skips
        // the check while aria-expanded="false", so it is kept rather than mounting a hidden menu.
        <div
          id={menuId}
          role="menu"
          aria-label="Tenant scope"
          className="absolute left-0 top-full z-50 mt-2 min-w-[220px] rounded-lg border border-line bg-surface p-1 shadow-ths-lg"
        >
          {offered.map((v, i) => {
            const checked = v === active;
            return (
              <Link
                key={v}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                href={scopeHref(pathname, search, v)}
                prefetch={false}
                role="menuitemradio"
                aria-checked={checked}
                tabIndex={-1}
                data-view={v}
                onClick={onActivate}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                className={[
                  'flex min-h-[44px] items-center gap-3 rounded-md px-3 text-sm text-ink900 transition-colors',
                  'hover:bg-[var(--brand-soft)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-ink)]',
                ].join(' ')}
              >
                {/* Swatch in THIS option's fill (data-view is on the link). Decorative; the name
                    beside it carries the meaning (WCAG 1.4.1). */}
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: 'var(--entity-fill)' }}
                />
                <Building2 aria-hidden className="h-4 w-4 shrink-0 text-ink600" />
                <span className="flex-1">{fullLabel(v)}</span>
                {checked ? <Check aria-hidden className="h-4 w-4 shrink-0 text-[var(--brand-ink)]" /> : null}
              </Link>
            );
          })}
        </div>
      ) : null}

      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

/**
 * The 4px ambient rail under the nav. Decorative and REDUNDANT with the labelled pill by design,
 * so WCAG 1.4.11 does not bind against the ground (it measures ~2:1 there); it does clear >=3:1
 * against every bar above it (5.64 / 6.21 / 5.65), which is what makes it read as a band.
 * ⚠ On /dashboard* the bar above is already the tenant's --brand-bar, so the rail only ADDS
 * signal off-dashboard (/billing-audit and the unscoped routes). Hidden from AT: the pill says it.
 */
export function TenantScopeRailView({ active }: { active: DashboardView | null }) {
  if (active === null) return null;
  return <div data-view={active} aria-hidden className="h-1 w-full bg-[var(--entity-fill)]" />;
}

/** Mounted pill: reads the route + ?view=, derives offered/active/interactive, renders the view. */
export function TenantScope({ allowedViews }: { allowedViews?: readonly DashboardView[] }) {
  const s = useTenantScope(allowedViews);
  return (
    <TenantScopeView
      offered={s.offered}
      active={s.active}
      pathname={s.pathname}
      search={s.search}
      interactive={s.interactive}
    />
  );
}

/** Mounted rail: the same derivation as the pill, so they cannot show different tenants. */
export function TenantScopeRail({ allowedViews }: { allowedViews?: readonly DashboardView[] }) {
  const s = useTenantScope(allowedViews);
  return <TenantScopeRailView active={s.active} />;
}
