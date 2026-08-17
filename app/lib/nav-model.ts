/**
 * The navigation model — ONE source of truth for which links exist, which are
 * tenant-scoped, and which a role may see.
 *
 * Extracted from `components/nav-links.tsx` (unchanged semantics) so the top bar
 * and the M3 navigation rail render the SAME set from the SAME RBAC decision. Two
 * copies of `linksFor` would be two places for the Qualify entitlement to drift.
 *
 * `linksFor` is nav VISIBILITY only — it hides dead links, it does not authorize.
 * RBAC is still enforced server-side at every route and server action. Do not
 * treat this module as a gate.
 */
import {
  BookOpen,
  FileSearch,
  LayoutDashboard,
  Radar,
  Target,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@/lib/rbac';

export type NavLink = {
  href: string;
  label: string;
  /** Top-bar icon. Historically set on Code Reference only; the bar renders it when present. */
  icon?: LucideIcon;
  /** Rail icon. REQUIRED in spirit — an icon-first rail has nothing to draw without it. */
  railIcon: LucideIcon;
  isBeta?: boolean;
};

// Overview + Collections are the two tenant-scoped dashboard surfaces, promoted to the top bar
// (they used to live in a secondary sub-nav). They share the ?view= tenant scope; the rest are
// global. Order matches the reading flow: Overview → Collections → Claims → reference.
const OVERVIEW: NavLink = { href: '/dashboard', label: 'Overview', railIcon: LayoutDashboard };
const COLLECTIONS: NavLink = {
  href: '/dashboard/collections',
  label: 'Collections',
  railIcon: Wallet,
};
// Display label "Claims Desk" (2026-07-15) — the route + internal names stay /billing-audit.
const CLAIMS_AUDIT: NavLink = {
  href: '/billing-audit',
  label: 'Claims Desk',
  railIcon: FileSearch,
  isBeta: true,
};
// Claims tab TAKEN DOWN 2026-07-15 (Alec) — /claims routes redirect to home; the Claims
// Explorer code stays in git for a quick restore.
// Ask tab REMOVED 2026-07-15 (Alec) — unfinished; /ask route redirects to home (reversible).
const CODE_REFERENCE: NavLink = {
  href: '/code-reference',
  label: 'Code Reference',
  icon: BookOpen,
  railIcon: BookOpen,
};

const BASE_LINKS: readonly NavLink[] = [OVERVIEW, COLLECTIONS, CLAIMS_AUDIT, CODE_REFERENCE];

// Qualify (Prompt 3): a CROSS-TENANT admissions surface, NOT ?view=-scoped. It sits between Overview
// and Collections and is visible only to the two roles that may reach it (super_admin +
// admissions_seat) — RBAC is still enforced server-side at the route; this only controls the nav.
const QUALIFY_LINK: NavLink = {
  href: '/qualify',
  label: 'Qualify',
  railIcon: Target,
  isBeta: true,
};

// Payer Intel (2026-08-17): the consolidated Collections-search × Qualify-intelligence tab —
// cross-tenant like Qualify, same role pair (super_admin + admissions_seat; the ruling lives in
// lib/payer-intel/principal.ts). NOT ?view=-scoped. ⚠ The NAME already means the monthly intel.*
// research cron elsewhere in this repo — this link is the PAGE, /api/cron/payer-intel is not it.
const PAYER_INTEL_LINK: NavLink = {
  href: '/payer-intel',
  label: 'Payer Intel',
  railIcon: Radar,
  isBeta: true,
};

/** The tenant-scoped routes that carry a ?view= scope; the rest are view-agnostic (Qualify included:
 *  it is cross-tenant and pins its own scope). Billing Audit is PHI + tenant-scoped (BXR-only). */
export const VIEW_SCOPED = new Set<string>([
  '/dashboard',
  '/dashboard/collections',
  '/billing-audit',
]);

/**
 * The visible nav links for a role. admissions_seat WAS a single-surface persona; as of
 * 2026-08-17 it sees Qualify + Payer Intel (both cross-tenant admissions surfaces that admit it —
 * every other route still redirects it to Qualify, so those stay hidden). super_admin sees the
 * full set with the two beta surfaces after Overview; admin / user / unknown see the standard set
 * with neither (both routes deny them server-side).
 */
export function linksFor(role: Role | undefined): NavLink[] {
  if (role === 'admissions_seat') return [QUALIFY_LINK, PAYER_INTEL_LINK];
  if (role === 'super_admin')
    return [OVERVIEW, QUALIFY_LINK, PAYER_INTEL_LINK, COLLECTIONS, CLAIMS_AUDIT, CODE_REFERENCE];
  return [...BASE_LINKS];
}

/**
 * Carry the active dashboard view (?view=) onto the tenant-scoped links so switching surfaces
 * doesn't reset the scope to Consolidated. The value is canonical on any settled dashboard page
 * (each self-redirects to its clamped view) and re-clamped server-side at the destination.
 */
export function navHref(href: string, view: string | null): string {
  return VIEW_SCOPED.has(href) && view ? `${href}?view=${encodeURIComponent(view)}` : href;
}

/**
 * Whether a link is the active one for a pathname. '/dashboard' must match EXACTLY — otherwise
 * '/dashboard/collections' (which starts with '/dashboard/') would light up Overview too. Every
 * other link still matches its subroutes.
 */
export function isActiveNav(href: string, pathname: string | null): boolean {
  if (pathname === null) return false;
  return pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'));
}
