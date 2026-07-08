'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const TABS: readonly { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/collections', label: 'Collections' },
];

export function DashboardNav() {
  const pathname = usePathname();
  // Forward the active view (?view=) so switching tabs keeps the tenant scope. The value is
  // already canonical on any settled dashboard page (the page self-redirects to the clamped
  // view), and the destination re-clamps server-side — so pass it through verbatim. `active`
  // stays keyed off the bare path (t.href), never the decorated href.
  const view = useSearchParams().get('view');
  return (
    <nav className="flex gap-1 border-b">
      {TABS.map((t) => {
        const active = pathname === t.href;
        const href = view ? `${t.href}?view=${encodeURIComponent(view)}` : t.href;
        return (
          <Link
            key={t.href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={[
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]'
                : 'border-transparent text-muted-foreground hover:border-[var(--brand-accent)] hover:text-[var(--brand-ink)]',
            ].join(' ')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
