'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, type LucideIcon } from 'lucide-react';

const LINKS: readonly { href: string; label: string; icon?: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/claims', label: 'Claims' },
  { href: '/code-reference', label: 'Code Reference', icon: BookOpen },
  { href: '/ask', label: 'Ask' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="ml-auto flex items-center gap-1 text-sm font-medium">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors',
              active
                ? 'bg-white/15 font-semibold text-white'
                : 'text-white/75 hover:bg-white/10 hover:text-white',
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
