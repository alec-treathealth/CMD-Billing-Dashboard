/**
 * Code Performance's LOCAL table primitives. ui/table.tsx has 10 consumers and is deliberately not
 * edited (ruled 2026-09-08); this surface needs sortable, sub-labelled, right-aligned numeric headers
 * and a sticky identity column, so it carries its own thin set here. Dashboard tokens only.
 *
 * ── THIS NO LONGER CREATES ITS OWN SCROLLPORT, AND THAT IS THE POINT (2026-09-09) ────────────────
 * It used to be `overflow-x-auto` wrapping `min-w-[1180px]`. Two problems, both visible on screen:
 *   · 1180px was a FICTION. Seventeen columns whose headers carry a second caveat line rendered with
 *     `whitespace-nowrap` need far more than that, so the declared minimum never bound anything —
 *     the table simply overflowed, and inside a `max-w-7xl` (1280px) route it was clipped on both
 *     edges with the leading code column scrolled out of reach.
 *   · An inner scrollport is a second thing to scroll. The route now bounds itself to the viewport
 *     and gives the reader ONE scroll area, so a nested one would trap the wheel and, worse, would
 *     become the containing block for `position: sticky` and break the sticky header.
 * So the wrapper is transparent to scrolling: `w-max min-w-full` lets the table take its natural
 * width and the page's single scroll area moves it on both axes, which is also what lets `sticky`
 * resolve against that one scrollport.
 *
 * ⚠️ A STICKY CELL'S BACKGROUND MUST BE OPAQUE. The header was `bg-teal50/40`; a translucent sticky
 * cell lets the rows scroll through it and the text becomes unreadable the moment it overlaps
 * anything. Solid `bg-teal50` on the header and `bg-card` on the sticky body cell. The z-order is
 * three-tier on purpose: the header/identity CORNER (30) must sit above the header row (20), which
 * must sit above the sticky body cells (10), or the corner cell is painted over while scrolling.
 */
import type { ReactNode } from 'react';

/**
 * ⚠️ THE BACKGROUND AND BORDER BELONG TO THE TABLE, NOT TO A WRAPPER (2026-09-10). They were on a
 * wrapping `<div>`, which produced a visible vertical colour seam partway across the table: the
 * wrapper is only as wide as the scroll container, the table is `w-max` and therefore WIDER, and
 * everything past the wrapper's right edge had no `bg-card` — so the page's `ground` token (a warm
 * off-white) showed through beside `card` (pure white). It looked like a per-column colour change, which is
 * why it read as a styling glitch rather than a box-model one.
 *
 * It only appeared when the inner scrollport was removed: while the wrapper was `overflow-x-auto` it
 * WAS the scroll container, so the table could never exceed it. Putting the paint on the element
 * that actually spans the content is the fix, and it cannot regress the same way.
 *
 * ⚠️ `border-separate`, NOT `border-collapse`, and that is a STICKY requirement rather than a style
 * preference. With collapsed borders the border belongs to the TABLE, not the cell, so a sticky
 * header's bottom rule scrolls away with the body and the pinned row loses its edge mid-scroll
 * (Chrome). Separated borders are drawn per cell and travel with the sticky cell; `border-spacing-0`
 * keeps the cells flush so nothing else about the grid changes.
 */
export function LocalTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <table
      className="w-max min-w-full border-separate border-spacing-0 rounded-lg border border-line bg-card text-sm shadow-ths-sm"
      aria-label={label}
    >
      {children}
    </table>
  );
}

export function LTh({
  children,
  sub,
  align = 'left',
  dim = false,
  stick = false,
  sortKey,
  active,
  direction,
  onSort,
  title,
}: {
  children: ReactNode;
  /** Second line under the header — the metric's unit. Long caveats belong in a MetricHint, not here. */
  sub?: ReactNode;
  align?: 'left' | 'right';
  /** De-emphasised (the maturity guard dims the yield columns). */
  dim?: boolean;
  /** Pins the column to the left edge while the reader scrolls horizontally. */
  stick?: boolean;
  sortKey?: string;
  active?: boolean;
  direction?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  title?: string;
}) {
  const content = (
    <span className="inline-flex flex-col items-start">
      <span className="font-semibold">{children}</span>
      {/* ⚠️ `text-ink600`, NOT `text-ink400`, and the reason is the SURFACE (a11y pass 2026-09-10).
          ink400 is documented in tailwind.config as meeting AA "on white" — 4.88:1 — and it does.
          This caption does not paint on white: making the sticky header opaque (which a sticky
          header must be, or rows scroll through it) changed the ground under it from `bg-teal50/40`
          over white to a SOLID teal50, where ink400 measures 4.35:1 and fails 1.4.3 for 10px text.
          ink600 is 6.31:1 on the same surface. A token's ratio is a
          property of the PAIR, never of the colour alone; ths-tokens-contrast.test.tsx pins this. */}
      {sub && <span className="whitespace-nowrap text-[10px] font-normal normal-case leading-tight tracking-normal text-ink600">{sub}</span>}
    </span>
  );
  return (
    <th
      scope="col"
      title={title}
      aria-sort={sortKey ? (active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
      className={[
        'whitespace-nowrap border-b border-line bg-teal50 px-2.5 py-1 text-left align-middle text-[11px] uppercase tracking-wide text-ink600',
        // The header carries its own opaque fill, so it must repeat the table's radius or it paints
        // square corners over the rounded border.
        'first:rounded-tl-lg last:rounded-tr-lg',
        'sticky top-0',
        stick ? 'left-0 z-30' : 'z-20',
        align === 'right' ? 'text-right' : 'text-left',
        dim ? 'opacity-60' : '',
      ].join(' ')}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={[
            'inline-flex min-h-[26px] items-center gap-1 rounded px-0.5 hover:text-teal700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500',
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
        <span className="inline-flex min-h-[26px] items-center">{content}</span>
      )}
    </th>
  );
}

/**
 * A body cell. `rowHeader` renders `<th scope="row">` instead of `<td>`, with identical styling.
 *
 * ⚠️ THE IDENTITY CELL MUST BE A ROW HEADER (a11y pass 2026-09-10). Thirteen columns of bare `<td>`
 * means a screen reader moving across a row announces "89.56%" against its COLUMN header and nothing
 * about which pairing it belongs to — the reader has to remember the row they entered. `scope="row"`
 * is what makes the association programmatically determinable (WCAG 1.3.1), and it costs nothing
 * visually because the styling is shared.
 */
export function LTd({
  children,
  align = 'left',
  num = false,
  dim = false,
  stick = false,
  rowHeader = false,
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  /** Tabular numerals (ths-num). */
  num?: boolean;
  dim?: boolean;
  /** Pins the cell to the left edge — must be opaque, see the file header. */
  stick?: boolean;
  /** Render as `<th scope="row">` — the cell that names the row. */
  rowHeader?: boolean;
  className?: string;
}) {
  const Cell = rowHeader ? 'th' : 'td';
  return (
    <Cell
      scope={rowHeader ? 'row' : undefined}
      className={[
        'border-b border-line px-2.5 py-1.5 align-top',
        stick ? 'sticky left-0 z-10 bg-card' : '',
        align === 'right' ? 'text-right' : 'text-left',
        num ? 'ths-num whitespace-nowrap tabular-nums' : '',
        dim ? 'opacity-60' : '',
        rowHeader ? 'font-normal' : '',
        className,
      ].join(' ')}
    >
      {children}
    </Cell>
  );
}
