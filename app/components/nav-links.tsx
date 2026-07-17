'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BookOpen, type LucideIcon } from 'lucide-react';
import type { Role } from '@/lib/rbac';

type NavLink = { href: string; label: string; icon?: LucideIcon };

// Overview + Collections are the two tenant-scoped dashboard surfaces, promoted to the top bar
// (they used to live in a secondary sub-nav). They share the ?view= tenant scope; the rest are
// global. Order matches the reading flow: Overview → Collections → Claims → reference.
const BASE_LINKS: readonly NavLink[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/collections', label: 'Collections' },
  // Display label "Claims Audit" (2026-07-15) — the route + internal names stay /billing-audit.
  { href: '/billing-audit', label: 'Claims Audit' },
  // Claims tab TAKEN DOWN 2026-07-15 (Alec) — /claims routes redirect to home; the Claims
  // Explorer code stays in git for a quick restore.
  // Ask tab REMOVED 2026-07-15 (Alec) — unfinished; /ask route redirects to home (reversible).
  { href: '/code-reference', label: 'Code Reference', icon: BookOpen },
];

// Qualify (Prompt 3): a CROSS-TENANT admissions surface, NOT ?view=-scoped. It sits between Overview
// and Collections and is visible only to the two roles that may reach it (super_admin +
// admissions_seat) — RBAC is still enforced server-side at the route; this only controls the nav.
const QUALIFY_LINK: NavLink = { href: '/qualify', label: 'Qualify' };

/** The tenant-scoped routes that carry a ?view= scope; the rest are view-agnostic (Qualify included:
 *  it is cross-tenant and pins its own scope). Billing Audit is PHI + tenant-scoped (BXR-only). */
const VIEW_SCOPED = new Set<string>(['/dashboard', '/dashboard/collections', '/billing-audit']);

/**
 * The visible top-nav links for a role. admissions_seat is a single-surface persona — it sees ONLY
 * Qualify (every other route redirects it here anyway, so dead links are hidden). super_admin sees
 * Qualify plus the standard set; admin / user / unknown see the standard set with NO Qualify entry.
 */
function linksFor(role: Role | undefined): NavLink[] {
  if (role === 'admissions_seat') return [QUALIFY_LINK];
  if (role === 'super_admin') return [BASE_LINKS[0], QUALIFY_LINK, ...BASE_LINKS.slice(1)];
  return [...BASE_LINKS];
}

export function NavLinks({ role }: { role?: Role }) {
  const pathname = usePathname();
  // Carry the active dashboard view (?view=) onto the tenant-scoped links so switching surfaces
  // doesn't reset the scope to Consolidated. The value is canonical on any settled dashboard page
  // (each self-redirects to its clamped view) and re-clamped server-side at the destination.
  const view = useSearchParams().get('view');
  const links = linksFor(role);
  return (
    <nav className="flex items-center justify-center gap-1 text-[13px] font-medium">
      {links.map(({ href, label, icon: Icon }) => {
        // '/dashboard' must match EXACTLY — otherwise '/dashboard/collections' (which starts with
        // '/dashboard/') would light up Overview too. Every other link still matches its subroutes.
        const active =
          pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'));
        const linkHref =
          VIEW_SCOPED.has(href) && view ? `${href}?view=${encodeURIComponent(view)}` : href;
        return (
          <Link
            key={href}
            href={linkHref}
            aria-current={active ? 'page' : undefined}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-4 py-2 transition-colors',
              active
                ? 'bg-white/25 font-semibold text-white ring-1 ring-white/30'
                : 'bg-white/10 text-white/80 hover:bg-white/20 hover:text-white',
            ].join(' ')}
          >
            {Icon ? <Icon aria-hidden className="h-4 w-4" /> : null}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
