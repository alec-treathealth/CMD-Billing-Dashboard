'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BookOpen, type LucideIcon } from 'lucide-react';

// Overview + Collections are the two tenant-scoped dashboard surfaces, promoted to the top bar
// (they used to live in a secondary sub-nav). They share the ?view= tenant scope; the rest are
// global. Order matches the reading flow: Overview → Collections → Claims → reference/agent.
const LINKS: readonly { href: string; label: string; icon?: LucideIcon }[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/collections', label: 'Collections' },
  { href: '/claims', label: 'Claims' },
  { href: '/code-reference', label: 'Code Reference', icon: BookOpen },
  { href: '/ask', label: 'Ask' },
];

/** The two dashboard routes that carry a tenant scope (?view=); the rest are view-agnostic. */
const VIEW_SCOPED = new Set<string>(['/dashboard', '/dashboard/collections']);

export function NavLinks() {
  const pathname = usePathname();
  // Carry the active dashboard view (?view=) onto the tenant-scoped links so switching surfaces
  // doesn't reset the scope to Consolidated. The value is canonical on any settled dashboard page
  // (each self-redirects to its clamped view) and re-clamped server-side at the destination.
  const view = useSearchParams().get('view');
  return (
    <nav className="flex items-center justify-center gap-1 text-[13px] font-medium">
      {LINKS.map(({ href, label, icon: Icon }) => {
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
