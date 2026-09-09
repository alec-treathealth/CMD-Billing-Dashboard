/**
 * Code Performance's LOCAL table primitives. ui/table.tsx has 10 consumers and is deliberately not
 * edited (ruled 2026-09-08); this surface needs sortable, sub-labelled, right-aligned numeric headers
 * and a wide scroll container, so it carries its own thin set here. Dashboard tokens only.
 */
import type { ReactNode } from 'react';

export function LocalTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-ths-sm">
      <table className="w-full min-w-[1180px] border-collapse text-sm" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export function LTh({
  children,
  sub,
  align = 'left',
  dim = false,
  sortKey,
  active,
  direction,
  onSort,
  title,
}: {
  children: ReactNode;
  /** Second line under the header — the metric's unit or caveat, always visible. */
  sub?: ReactNode;
  align?: 'left' | 'right';
  /** De-emphasised (the maturity guard dims the yield columns). */
  dim?: boolean;
  sortKey?: string;
  active?: boolean;
  direction?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  title?: string;
}) {
  const content = (
    <span className="inline-flex flex-col">
      <span className="font-semibold">{children}</span>
      {sub && <span className="text-xs font-normal normal-case tracking-normal text-ink400">{sub}</span>}
    </span>
  );
  return (
    <th
      scope="col"
      title={title}
      aria-sort={sortKey ? (active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
      className={[
        'whitespace-nowrap border-b border-line bg-teal50/40 px-3 py-2 text-xs uppercase tracking-wide text-ink600',
        align === 'right' ? 'text-right' : 'text-left',
        dim ? 'opacity-60' : '',
      ].join(' ')}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={[
            'inline-flex min-h-[44px] items-center gap-1 rounded px-1 hover:text-teal700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500',
            align === 'right' ? 'flex-row-reverse text-right' : '',
          ].join(' ')}
          aria-label={`Sort by ${typeof children === 'string' ? children : sortKey}`}
        >
          {content}
          <span aria-hidden className="text-ink400">
            {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      ) : (
        <span className="inline-flex min-h-[44px] items-center">{content}</span>
      )}
    </th>
  );
}

export function LTd({
  children,
  align = 'left',
  num = false,
  dim = false,
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  /** Tabular numerals (ths-num). */
  num?: boolean;
  dim?: boolean;
  className?: string;
}) {
  return (
    <td
      className={[
        'border-b border-line px-3 py-2 align-top',
        align === 'right' ? 'text-right' : 'text-left',
        num ? 'ths-num whitespace-nowrap tabular-nums' : '',
        dim ? 'opacity-60' : '',
        className,
      ].join(' ')}
    >
      {children}
    </td>
  );
}
