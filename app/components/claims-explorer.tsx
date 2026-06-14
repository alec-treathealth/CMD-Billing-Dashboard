'use client';

/**
 * Claims Data Explorer (Phase 7.4 MVP) — a server-driven, page-limited table of
 * NON-PHI claim rows. Every page is fetched from the loadClaimsPage Server Action
 * (default 50 rows, LIMIT-bounded server-side), so the full table never ships to
 * the client. Filter/sort round-trip to the server through the existing
 * injection-safe allowlist; nothing is persisted client-side.
 *
 * PHI discipline: browse_claims projects only non-PHI columns, so there is no
 * patient identifier to mask here. Cells still render through displayCell (which
 * masks any PHI column) as defense in depth — patient-level data stays on the
 * audited reveal path, not in this list.
 */
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, rate } from '@/lib/format';
import { displayCell, isPhiColumn } from '@/lib/phi';
import {
  loadClaimsPage,
  type BrowseClaimsResult,
  type BrowseClaimsSort,
  type ClaimFilter,
} from '@/lib/actions';

const PAGE_SIZE = 50;

/** Columns rendered as currency; collection_rate renders as a percentage. */
const MONEY_COLUMNS: ReadonlySet<string> = new Set([
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
]);

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

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: BrowseClaimsResult };

/** The pending filter inputs (applied on submit, not per keystroke). */
interface FilterDraft {
  facility: string;
  payer: string;
  source_year: string;
}

const EMPTY_DRAFT: FilterDraft = { facility: '', payer: '', source_year: '' };

/** Turn the draft into a validated-shape ClaimFilter (server re-validates too). */
function draftToFilter(draft: FilterDraft): ClaimFilter {
  const filter: ClaimFilter = {};
  const facility = draft.facility.trim();
  const payer = draft.payer.trim();
  const year = draft.source_year.trim();
  if (facility) filter.facility = facility;
  if (payer) filter.payer = payer;
  if (year && /^\d{4}$/.test(year)) filter.source_year = Number(year);
  return filter;
}

export function ClaimsExplorer() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [filter, setFilter] = useState<ClaimFilter>({});
  const [sort, setSort] = useState<BrowseClaimsSort>({ column: 'date_of_service', direction: 'desc' });
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  // Re-fetch whenever the applied filter, sort, or page changes. Rows live in
  // component state for the session only — never persisted anywhere.
  useEffect(() => {
    let live = true;
    setStatus({ kind: 'loading' });
    loadClaimsPage({ filter, sort, page, pageSize: PAGE_SIZE })
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
  }, [filter, sort, page]);

  const applyFilters = useCallback(() => {
    setPage(0);
    setFilter(draftToFilter(draft));
  }, [draft]);

  const resetFilters = useCallback(() => {
    setPage(0);
    setDraft(EMPTY_DRAFT);
    setFilter({});
  }, []);

  const toggleSort = useCallback((column: string) => {
    if (!SORTABLE_COLUMNS.has(column)) return;
    setPage(0);
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  }, []);

  const columns = status.kind === 'ready' ? status.data.columns : [];
  const rows = status.kind === 'ready' ? status.data.rows : [];
  const hasNext = status.kind === 'ready' ? status.data.hasNext : false;

  return (
    <div className="space-y-4">
      {/* Filter bar — values round-trip to the server allowlist; safe by construction. */}
      <div className="grid items-end gap-3 rounded-md border bg-card p-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="cx-facility" className="text-xs">Facility</Label>
          <Input
            id="cx-facility"
            value={draft.facility}
            placeholder="exact facility name"
            onChange={(e) => setDraft((d) => ({ ...d, facility: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cx-payer" className="text-xs">Payer</Label>
          <Input
            id="cx-payer"
            value={draft.payer}
            placeholder="exact payer name"
            onChange={(e) => setDraft((d) => ({ ...d, payer: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cx-year" className="text-xs">Source year</Label>
          <Input
            id="cx-year"
            value={draft.source_year}
            inputMode="numeric"
            placeholder="e.g. 2023"
            onChange={(e) => setDraft((d) => ({ ...d, source_year: e.target.value }))}
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={applyFilters}>Apply</Button>
          <Button type="button" variant="outline" onClick={resetFilters}>Reset</Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {status.kind === 'ready'
            ? `Page ${status.data.page + 1} · ${rows.length.toLocaleString('en-US')} rows (max ${PAGE_SIZE}/page)`
            : status.kind === 'loading'
              ? 'Loading…'
              : ''}
        </div>
        <span className="text-[10px] text-muted-foreground">
          Patient identifiers are excluded from this list.
        </span>
      </div>

      {status.kind === 'error' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {status.message}
        </div>
      )}

      {status.kind !== 'error' && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => {
                  const sortable = SORTABLE_COLUMNS.has(c);
                  const active = sort.column === c;
                  return (
                    <TableHead key={c} className="capitalize">
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(c)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          aria-label={`Sort by ${columnLabel(c)}`}
                        >
                          {columnLabel(c)}
                          <span className="text-[10px] text-muted-foreground">
                            {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      ) : (
                        columnLabel(c)
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && status.kind === 'ready' ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="text-center text-sm text-muted-foreground">
                    No claims match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, i) => (
                  <TableRow key={(row.id as string | number | null) ?? i}>
                    {columns.map((c) => (
                      <TableCell
                        key={c}
                        className={MONEY_COLUMNS.has(c) || c === 'collection_rate' ? 'text-right tabular-nums' : undefined}
                      >
                        {cellText(c, row[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page === 0 || status.kind === 'loading'}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          ← Previous
        </Button>
        <div className="text-xs text-muted-foreground">Page {page + 1}</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasNext || status.kind === 'loading'}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}
