'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: readonly { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/payers', label: 'Payers Explorer' },
  { href: '/dashboard/collections', label: 'Collections Explorer' },
];

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={[
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-teal500 text-teal700'
                : 'border-transparent text-muted-foreground hover:border-teal500 hover:text-teal700',
            ].join(' ')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
