'use client';

/**
 * Shared table machinery for the explorer surfaces (Claims, Payers, Collections).
 * These three tables had each re-implemented the same pieces; this module
 * centralizes them:
 *
 *   - SELECT_CLASS / ControlSelect — the labelled native <select> in the filter bars
 *   - useColumnDnD                 — native HTML5 drag-to-reorder over a column order
 *   - ColumnsPanel                 — the show/hide + drag-reorder "Columns" panel
 *   - SortHeaderCell               — a sortable <TableHead> with the asc/desc affordance
 *   - Pager                        — the prev / page-N / next control
 *
 * Each explorer keeps its OWN data source, filters, and pagination model — this is
 * presentation + the column-reorder interaction only. All layout state is owned by
 * the caller and is session-only (never persisted: no localStorage/cookies).
 */
import { useCallback, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Eye, EyeOff, GripVertical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { TableHead } from '@/components/ui/table';

/** Shared native-select styling; replaces the per-explorer copies. */
export const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm ring-offset-background ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** A labelled native <select> used across the explorer filter bars. */
export function ControlSelect({
  label,
  value,
  ariaLabel,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string | number;
  ariaLabel: string;
  onChange: (raw: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={className ?? SELECT_CLASS}
      >
        {children}
      </select>
    </label>
  );
}

export interface ColumnDnD {
  draggingKey: string | null;
  dropTargetKey: string | null;
  itemProps: (key: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
}

/**
 * Native HTML5 drag-to-reorder over a string-keyed column order. The dragged key
 * lives in a ref (no re-render while dragging); `draggingKey`/`dropTargetKey` drive
 * the opacity + top-border visuals only. Dropping SWAPS the dragged and target
 * positions in `order` (via `setOrder`).
 */
export function useColumnDnD(order: string[], setOrder: (next: string[]) => void): ColumnDnD {
  const dragKey = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const reorder = useCallback(
    (dragged: string, target: string) => {
      if (dragged === target) return;
      const next = [...order];
      const i = next.indexOf(dragged);
      const j = next.indexOf(target);
      if (i < 0 || j < 0) return;
      [next[i], next[j]] = [next[j]!, next[i]!];
      setOrder(next);
    },
    [order, setOrder],
  );

  const itemProps = useCallback(
    (key: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        dragKey.current = key;
        setDraggingKey(key);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault(); // allow drop
        e.dataTransfer.dropEffect = 'move';
        setDropTargetKey((prev) => (prev === key ? prev : key));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const dragged = dragKey.current;
        if (dragged) reorder(dragged, key);
        dragKey.current = null;
        setDraggingKey(null);
        setDropTargetKey(null);
      },
      onDragEnd: () => {
        dragKey.current = null;
        setDraggingKey(null);
        setDropTargetKey(null);
      },
    }),
    [reorder],
  );

  return { draggingKey, dropTargetKey, itemProps };
}

/**
 * The "Columns" panel: a card of draggable show/hide rows (Eye/EyeOff toggle +
 * GripVertical handle). `columns` is the current ORDER; visibility + reorder are
 * owned by the caller (`isHidden`/`onToggle` + the `dnd` hook). `onMove` is an
 * optional keyboard fallback (ArrowUp/ArrowDown on the handle).
 */
export function ColumnsPanel({
  columns,
  isHidden,
  onToggle,
  dnd,
  onMove,
}: {
  columns: readonly { key: string; label: string }[];
  isHidden: (key: string) => boolean;
  onToggle: (key: string) => void;
  dnd: ColumnDnD;
  onMove?: (key: string, dir: 'up' | 'down') => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-ths animate-in fade-in-0 slide-in-from-top-1 duration-200">
      <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
        <Columns3 className="h-4 w-4 text-teal500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-ink600">Columns</span>
        <span className="text-[11px] text-ink400">— show, hide, and drag to reorder (layout only)</span>
      </div>
      <ul className="space-y-0.5">
        {columns.map((c) => {
          const hidden = isHidden(c.key);
          const dragging = dnd.draggingKey === c.key;
          const isTarget = dnd.dropTargetKey === c.key && dnd.draggingKey !== c.key;
          return (
            <li
              key={c.key}
              aria-grabbed={dragging}
              data-drop-target={isTarget ? '' : undefined}
              {...dnd.itemProps(c.key)}
              className={`flex items-center gap-2 rounded-md border-t-2 px-2 py-1.5 transition-colors hover:bg-teal50/70 ${
                isTarget ? 'border-teal500' : 'border-transparent'
              } ${dragging ? 'opacity-50' : ''}`}
            >
              <button
                type="button"
                aria-label={`Drag to reorder ${c.label}`}
                onKeyDown={
                  onMove
                    ? (e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          onMove(c.key, 'up');
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          onMove(c.key, 'down');
                        }
                      }
                    : undefined
                }
                className="shrink-0 cursor-grab text-ink300 active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onToggle(c.key)}
                aria-pressed={!hidden}
                className="flex min-w-0 flex-1 items-center gap-2 text-sm capitalize"
              >
                {hidden ? (
                  <EyeOff className="h-4 w-4 shrink-0 text-ink400" />
                ) : (
                  <Eye className="h-4 w-4 shrink-0 text-teal500" />
                )}
                <span className={`truncate ${hidden ? 'text-ink400 line-through' : 'text-ink900'}`}>
                  {c.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A sortable column header cell. Renders a <TableHead>; when `sortable`, a button
 * toggles sort and shows the asc/desc (or idle) affordance. `numeric` right-aligns.
 */
export function SortHeaderCell({
  label,
  numeric = false,
  sortable = true,
  active,
  direction,
  onToggle,
}: {
  label: string;
  numeric?: boolean;
  sortable?: boolean;
  active: boolean;
  direction: 'asc' | 'desc';
  onToggle: () => void;
}) {
  return (
    <TableHead className={`${numeric ? 'text-right' : ''} ${active ? 'text-teal700' : ''}`}>
      {sortable ? (
        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex items-center gap-1 transition-colors hover:text-teal700 ${
            numeric ? 'flex-row-reverse' : ''
          }`}
          aria-label={`Sort by ${label}`}
        >
          {label}
          {active ? (
            direction === 'asc' ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )
          ) : (
            <ChevronDown className="h-3 w-3 opacity-40" />
          )}
        </button>
      ) : (
        label
      )}
    </TableHead>
  );
}

/** Prev / page-N / Next pager shared by the explorers. */
export function Pager({
  page,
  hasPrev,
  hasNext,
  disabled = false,
  onPrev,
  onNext,
}: {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <Button type="button" variant="outline" size="sm" disabled={!hasPrev || disabled} onClick={onPrev}>
        ← Previous
      </Button>
      <span className="text-xs text-muted-foreground">Page {page}</span>
      <Button type="button" variant="outline" size="sm" disabled={!hasNext || disabled} onClick={onNext}>
        Next →
      </Button>
    </div>
  );
}
