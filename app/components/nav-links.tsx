'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BookOpen, type LucideIcon } from 'lucide-react';

const LINKS: readonly { href: string; label: string; icon?: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/claims', label: 'Claims' },
  { href: '/code-reference', label: 'Code Reference', icon: BookOpen },
  { href: '/ask', label: 'Ask' },
];

export function NavLinks() {
  const pathname = usePathname();
  // Carry the active dashboard view (?view=) onto the Dashboard link so it doesn't reset the
  // tenant scope to Consolidated. Only /dashboard has a view; other links are untouched.
  // `active` stays keyed off the bare href, never the decorated one.
  const view = useSearchParams().get('view');
  return (
    <nav className="flex items-center justify-center gap-1 text-[13px] font-medium">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + '/');
        const linkHref =
          href === '/dashboard' && view ? `/dashboard?view=${encodeURIComponent(view)}` : href;
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
