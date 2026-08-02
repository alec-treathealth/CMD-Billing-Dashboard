'use client';

/**
 * Top-bar navigation (the 'bar' shell mode). Renders the role's links centered in the brand
 * header. The link set, the ?view= forwarding, and the active-route test all come from
 * `lib/nav-model.ts`, which the M3 navigation rail shares — so the two shells can never
 * disagree about what a role may see.
 */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { isActiveNav, linksFor, navHref } from '@/lib/nav-model';
import type { Role } from '@/lib/rbac';

export function NavLinks({ role }: { role?: Role }) {
  const pathname = usePathname();
  const view = useSearchParams().get('view');
  const links = linksFor(role);
  return (
    <nav className="flex items-center justify-center gap-1 text-[13px] font-medium">
      {links.map(({ href, label, icon: Icon, isBeta }) => {
        const active = isActiveNav(href, pathname);
        return (
          <Link
            key={href}
            href={navHref(href, view)}
            aria-current={active ? 'page' : undefined}
            className={[
              'relative inline-flex items-center gap-1.5 rounded-md px-4 py-2 transition-colors',
              active
                ? 'bg-white/25 font-semibold text-white ring-1 ring-white/30'
                : 'bg-white/10 text-white/80 hover:bg-white/20 hover:text-white',
            ].join(' ')}
          >
            {Icon ? <Icon aria-hidden className="h-4 w-4" /> : null}
            {label}
            {/* Sparkly coral "Beta" flag (decorative). Shimmer + twinkle auto-disable under
                prefers-reduced-motion via the global reset in globals.css. */}
            {isBeta ? (
              <span className="q-beta-badge" aria-hidden="true">
                Beta
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
