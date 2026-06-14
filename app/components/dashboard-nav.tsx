/**
 * Sub-navigation for the dashboard section (Overview / Payers / Collections).
 * A plain server component — just links, no client state — so it adds no bundle
 * weight and needs no 'use client'. Styled to match the TreatHealthOS palette.
 */
import Link from 'next/link';

const TABS: readonly { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/payers', label: 'Payers' },
  { href: '/dashboard/collections', label: 'Collections' },
];

export function DashboardNav() {
  return (
    <nav className="flex gap-1 border-b">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-teal500 hover:text-teal700"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
