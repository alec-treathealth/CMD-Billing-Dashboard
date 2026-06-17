'use client';

/**
 * Claims Data Explorer (Phase 7.4; keyset pagination in 7.5; faceted dropdowns +
 * column layout controls in 8.1) — a server-driven, page-limited table of NON-PHI
 * claim rows. Every page is fetched from the loadClaimsPage Server Action (default
 * 50 rows, LIMIT-bounded server-side), so the full table never ships to the client.
 * Filter/sort round-trip to the server through the existing injection-safe
 * allowlist; nothing is persisted client-side.
 *
 * Filters (facility / payer / source year) are dropdowns populated from the CACHED,
 * non-PHI facet lists (loadClaimFacets → cached distribution matview reads). The
 * facets are aggregate dimension values only — never patient data.
 *
 * Column show/hide/reorder is LAYOUT-ONLY view state held in React for the session:
 * it changes only how the already-fetched non-PHI columns are presented and never
 * triggers a re-fetch, never changes the query, and is never persisted (no
 * localStorage/sessionStorage/cookies). Row data and PHI are never stored.
 *
 * Pagination is keyset (cursor) on the synthetic id. Forward navigation uses the
 * server-provided nextCursor; backward navigation pops a small in-memory stack of
 * the (non-PHI) cursors used so far — no OFFSET, no backward SQL. The cursor holds
 * only the sort-column value + id (both non-PHI) and lives in React state only.
 *
 * PHI discipline: browse_claims projects only non-PHI columns, so there is no
 * patient identifier to mask here. Cells still render through displayCell (which
 * masks any PHI column) as defense in depth — patient-level data stays on the
 * audited reveal path, not in this list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Columns3, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { ColumnsPanel, Pager, SortHeaderCell, useColumnDnD } from '@/components/data-grid';
import { money, rate } from '@/lib/format';
import { displayCell, isPhiColumn } from '@/lib/phi';
import {
  loadClaimFacets,
  loadClaimsPage,
  type BrowseClaimsCursor,
  type BrowseClaimsResult,
  type BrowseClaimsSort,
  type ClaimFacets,
  type ClaimFilter,
} from '@/lib/actions';

const PAGE_SIZE = 50;

/**
 * Shared native-select styling. `appearance-none` strips the platform chevron so
 * we can render our own (see SelectField); teal focus ring ties it to the brand.
 */
const CONTROL_CLASS =
  'h-10 w-full cursor-pointer appearance-none truncate rounded-md border border-line bg-surface pl-3 pr-9 text-sm text-ink900 ring-offset-background transition-colors hover:border-teal200 focus-visible:border-teal500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

/** Columns rendered as currency; collection_rate renders as a percentage. */
const MONEY_COLUMNS: ReadonlySet<string> = new Set([
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
]);

/**
 * Text columns. Everything else is set in IBM Plex Mono with tabular figures for a
 * clean financial-ledger read (ids, dates, codes, money, rates align column-wise).
 */
const TEXT_COLUMNS: ReadonlySet<string> = new Set(['facility_name', 'payer_name']);

/** Columns the table header allows sorting by (mirrors the server allowlist). */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'source_year',
  'date_of_service',
  'facility_name',
  'payer_name',
  'hcpcs_code',
  'revenue_code',
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'collection_rate',
]);

function columnLabel(column: string): string {
  return column.replace(/_/g, ' ');
}

/** Format a non-PHI cell; PHI columns (none in this projection) stay masked. */
function cellText(column: string, value: unknown): string {
  if (isPhiColumn(column)) return displayCell(column, value, false);
  if (value === null || value === undefined) return '—';
  if (MONEY_COLUMNS.has(column)) return money(value);
  if (column === 'collection_rate') return rate(value);
  return String(value);
}

/** Per-column cell classes — ledger mono + right-aligned numerics, left-aligned text. */
function cellClass(column: string): string {
  if (TEXT_COLUMNS.has(column)) return '';
  const right = MONEY_COLUMNS.has(column) || column === 'collection_rate';
  return `font-mono text-[13px] tabular-nums${right ? ' text-right' : ''}`;
}

/** A labelled facet dropdown with a custom chevron (native select stays accessible). */
function SelectField({
  id,
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wide text-ink400">
        {label}
      </Label>
      <div className="relative">
        <select
          id={id}
          className={CONTROL_CLASS}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400"
        />
      </div>
    </div>
  );
}

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: BrowseClaimsResult };

const DEFAULT_SORT: BrowseClaimsSort = { column: 'date_of_service', direction: 'desc' };

export function ClaimsExplorer() {
  const [facets, setFacets] = useState<ClaimFacets | null>(null);
  const [filter, setFilter] = useState<ClaimFilter>({});
  const [sort, setSort] = useState<BrowseClaimsSort>(DEFAULT_SORT);
  // A stack of the cursors used to reach each page; the last entry is the current
  // page's starting cursor (null = first page). Pushing = next, popping = previous.
  const [cursorStack, setCursorStack] = useState<(BrowseClaimsCursor | null)[]>([null]);
  // Bumped to force a re-fetch when neither filter/sort/cursor changed (e.g. Retry).
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  // ---- Layout-only column view state (session only; never persisted) --------
  // The stable set of non-PHI columns the server returns, captured on first load
  // so the header and the Columns panel stay stable across page loads.
  const [knownColumns, setKnownColumns] = useState<string[]>([]);
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [showColumnPanel, setShowColumnPanel] = useState(false);

  const cursor = cursorStack[cursorStack.length - 1] ?? null;
  const pageNumber = cursorStack.length;

  // Load the cached, non-PHI facet option lists once for the filter dropdowns.
  useEffect(() => {
    let live = true;
    loadClaimFacets().then((r) => {
      if (live && r.ok) setFacets(r.data);
    });
    return () => {
      live = false;
    };
  }, []);

  // Re-fetch whenever the applied filter, sort, or current cursor changes (or a
  // manual reload is requested). Rows and cursors live in component state for the
  // session only — never persisted. Column layout state is intentionally NOT a
  // dependency here: changing it never re-queries.
  useEffect(() => {
    let live = true;
    setStatus({ kind: 'loading' });
    loadClaimsPage({ filter, sort, cursor, pageSize: PAGE_SIZE })
      .then((r) => {
        if (!live) return;
        setStatus(r.ok ? { kind: 'ready', data: r.data } : { kind: 'error', message: r.error });
      })
      .catch(() => {
        if (live) setStatus({ kind: 'error', message: 'The claims could not be loaded.' });
      });
    return () => {
      live = false;
    };
  }, [filter, sort, cursor, reloadKey]);

  // Capture the column set from the first (and any) successful load so layout
  // controls remain available and the header doesn't flicker during page loads.
  useEffect(() => {
    if (status.kind === 'ready' && status.data.columns.length > 0) {
      setKnownColumns((prev) =>
        prev.length === status.data.columns.length && prev.every((c, i) => c === status.data.columns[i])
          ? prev
          : status.data.columns,
      );
    }
  }, [status]);

  // Effective display order: the user's order filtered to known columns, with any
  // not-yet-ordered columns appended in their server order. Pure layout.
  const orderedColumns = useMemo(() => {
    if (knownColumns.length === 0) return [];
    const ordered = columnOrder.filter((c) => knownColumns.includes(c));
    for (const c of knownColumns) if (!ordered.includes(c)) ordered.push(c);
    return ordered;
  }, [columnOrder, knownColumns]);

  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => !hiddenColumns.has(c)),
    [orderedColumns, hiddenColumns],
  );

  const updateFilter = useCallback((patch: Partial<ClaimFilter>) => {
    setCursorStack([null]); // any filter change invalidates the keyset position
    setFilter((prev) => {
      const next: ClaimFilter = { ...prev };
      for (const key of Object.keys(patch) as (keyof ClaimFilter)[]) {
        const value = patch[key];
        if (value === undefined) delete next[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    setCursorStack([null]);
    setFilter({});
    setSort(DEFAULT_SORT);
    // Reset layout too, so "Reset" returns the grid to its default presentation.
    setColumnOrder([]);
    setHiddenColumns(new Set());
  }, []);

  const toggleSort = useCallback((column: string) => {
    if (!SORTABLE_COLUMNS.has(column)) return;
    setCursorStack([null]); // sort change invalidates the keyset position
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  }, []);

  const toggleColumnVisible = useCallback((column: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }, []);

  // Keyboard-fallback reorder (ArrowUp/ArrowDown on the drag handle). Not exposed as
  // UI buttons anymore — drag-and-drop is the primary path; this keeps it accessible.
  const moveColumn = useCallback(
    (column: string, direction: 'up' | 'down') => {
      setColumnOrder(() => {
        const order = [...orderedColumns];
        const i = order.indexOf(column);
        const j = direction === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= order.length) return order;
        [order[i], order[j]] = [order[j]!, order[i]!];
        return order;
      });
    },
    [orderedColumns],
  );

  // Native HTML5 drag-to-reorder for the Columns panel (shared with the other
  // explorers via @/components/data-grid). Operates over the effective display
  // order so a swap persists the full order; session-only, never persisted.
  const dnd = useColumnDnD(orderedColumns, setColumnOrder);

  const nextCursor = status.kind === 'ready' ? status.data.nextCursor : null;

  const goNext = useCallback(() => {
    if (nextCursor) setCursorStack((stack) => [...stack, nextCursor]);
  }, [nextCursor]);

  const goPrev = useCallback(() => {
    setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }, []);

  const rows = status.kind === 'ready' ? status.data.rows : [];
  const hasNext = status.kind === 'ready' ? status.data.hasNext : false;
  const hasPrev = pageNumber > 1;
  const loading = status.kind === 'loading';
  const yearValue = filter.source_year !== undefined ? String(filter.source_year) : '';

  return (
    <div className="space-y-4">
      {/* Filter bar — values come from cached non-PHI facets; round-trip to the
          server allowlist; safe by construction. */}
      <div className="grid items-end gap-x-4 gap-y-3 rounded-lg border border-line bg-card p-4 shadow-ths sm:grid-cols-[1fr_1fr_minmax(7rem,0.6fr)_auto]">
        <SelectField
          id="cx-facility"
          label="Facility"
          value={filter.facility ?? ''}
          disabled={facets === null}
          onChange={(v) => updateFilter({ facility: v || undefined })}
        >
          <option value="">All facilities</option>
          {facets?.facility.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </SelectField>
        <SelectField
          id="cx-payer"
          label="Payer"
          value={filter.payer ?? ''}
          disabled={facets === null}
          onChange={(v) => updateFilter({ payer: v || undefined })}
        >
          <option value="">All payers</option>
          {facets?.payer.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </SelectField>
        <SelectField
          id="cx-year"
          label="Year"
          value={yearValue}
          disabled={facets === null}
          onChange={(v) => updateFilter({ source_year: v ? Number(v) : undefined })}
        >
          <option value="">All years</option>
          {facets?.source_year.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </SelectField>
        <div className="flex gap-2 justify-self-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowColumnPanel((s) => !s)}
            aria-expanded={showColumnPanel}
            className={showColumnPanel ? 'border-teal500 text-teal700' : undefined}
          >
            <Columns3 className="h-4 w-4" />
            Columns
          </Button>
          <Button type="button" variant="ghost" onClick={resetAll} className="text-ink600">
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      {/* Column show/hide + reorder — layout-only; never re-queries or persists. */}
      {showColumnPanel && orderedColumns.length > 0 && (
        <ColumnsPanel
          columns={orderedColumns.map((c) => ({ key: c, label: columnLabel(c) }))}
          isHidden={(k) => hiddenColumns.has(k)}
          onToggle={toggleColumnVisible}
          dnd={dnd}
          onMove={moveColumn}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {status.kind === 'ready'
            ? `Page ${pageNumber} · ${rows.length.toLocaleString('en-US')} rows (max ${PAGE_SIZE}/page)`
            : loading
              ? 'Loading…'
              : ''}
        </div>
        <span className="text-[10px] text-muted-foreground">
          Patient identifiers are excluded from this list.
        </span>
      </div>

      {status.kind === 'error' ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
          {status.message}
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="relative rounded-md border">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
              Loading…
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                {visibleColumns.map((c) => (
                  <SortHeaderCell
                    key={c}
                    label={columnLabel(c)}
                    numeric={!TEXT_COLUMNS.has(c)}
                    sortable={SORTABLE_COLUMNS.has(c)}
                    active={sort.column === c}
                    direction={sort.direction}
                    onToggle={() => toggleSort(c)}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.kind === 'ready' && rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={Math.max(1, visibleColumns.length)}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No claims match these filters. Try widening or resetting them.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, i) => {
                  const id = row.id as string | number | null;
                  return (
                    <TableRow key={id ?? i} className="transition-colors hover:bg-teal50/50">
                      {visibleColumns.map((c) => (
                        <TableCell key={c} className={cellClass(c)}>
                          {c === 'id' && id !== null ? (
                            <Link
                              href={`/claims/${id}`}
                              className="font-medium text-teal700 underline-offset-2 hover:underline"
                            >
                              {String(id)}
                            </Link>
                          ) : (
                            cellText(c, row[c])
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Pager
        page={pageNumber}
        hasPrev={hasPrev}
        hasNext={hasNext}
        disabled={loading}
        onPrev={goPrev}
        onNext={goNext}
      />
    </div>
  );
}
