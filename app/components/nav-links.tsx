'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/claims', label: 'Claims' },
  { href: '/ask', label: 'Ask' },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="ml-auto flex items-center gap-1 text-sm font-medium">
      {LINKS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={[
              'rounded-md px-3 py-1.5 transition-colors',
              active
                ? 'bg-white/15 font-semibold text-white'
                : 'text-white/75 hover:bg-white/10 hover:text-white',
            ].join(' ')}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
