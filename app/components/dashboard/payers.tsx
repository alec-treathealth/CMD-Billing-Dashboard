'use client';

/**
 * Dashboard — payer surfaces: the multi-dimensional Payer Chart widget and the
 * client-side Payer Detail Explorer (search / sort / show / columns over the
 * cached, non-PHI payer_gap summary). Split out of the former dashboard.tsx; the
 * table machinery (columns panel + drag-reorder, sort headers, selects) is shared
 * via @/components/data-grid.
 */
import { useMemo, useState } from 'react';
import { Columns3, RotateCcw } from 'lucide-react';

import { PayerChart } from '@/components/payer-chart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { ColumnsPanel, ControlSelect, SortHeaderCell, useColumnDnD } from '@/components/data-grid';
import { count, money, rate } from '@/lib/format';
import { loadPayerGap, type PayerGapSummary } from '@/lib/actions';
import { MiniBar, useWidget, WidgetCard } from './widgets';

/**
 * Payer chart widget — interactive, multi-dimensional payer chart (group/metric/
 * sort/show controls live inside PayerChart). Defaults to Top 10. `defaultTopN` is
 * preserved for callers that want a different default.
 */
export function PayerChartWidget({ defaultTopN = 10 }: { defaultTopN?: number }) {
  const state = useWidget<PayerGapSummary>(loadPayerGap);
  return (
    <WidgetCard title="Payer Chart - Multidimensional" state={state}>
      {state.status === 'ready' && <PayerChart data={state.data} defaultTopN={defaultTopN} />}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Payer Detail Explorer (Phase 8.x) — a filterable, sortable, configurable table
// of the per-payer non-PHI summary. Replaces the static top-15 table + bar chart
// on /dashboard/payers (the chart lives on the Overview page). All filtering and
// sorting is CLIENT-SIDE over the already-loaded cached payer_gap summary — no new
// API calls, no row data, no patient identifiers. Column order + visibility is
// session-only React state and is never persisted.
// ---------------------------------------------------------------------------

type PayerColKey = 'payer' | 'claims' | 'charged' | 'allowed' | 'paid' | 'avg_rate' | 'gap';

const PAYER_COLUMNS: readonly { key: PayerColKey; label: string; numeric: boolean }[] = [
  { key: 'payer', label: 'Payer', numeric: false },
  { key: 'claims', label: 'Claims', numeric: true },
  { key: 'charged', label: 'Charged', numeric: true },
  { key: 'allowed', label: 'Allowed', numeric: true },
  { key: 'paid', label: 'Paid', numeric: true },
  { key: 'avg_rate', label: 'Avg Rate', numeric: true },
  { key: 'gap', label: 'Collection Gap', numeric: true },
];

const PAYER_COLUMN_BY_KEY = new Map(PAYER_COLUMNS.map((c) => [c.key, c]));
const PAYER_DEFAULT_ORDER: readonly PayerColKey[] = PAYER_COLUMNS.map((c) => c.key);

interface PayerSort {
  key: PayerColKey;
  direction: 'asc' | 'desc';
}

const PAYER_SORT_PRESETS: readonly { id: string; label: string; sort: PayerSort }[] = [
  { id: 'claims-desc', label: 'Claims (desc)', sort: { key: 'claims', direction: 'desc' } },
  { id: 'charged-desc', label: 'Charged (desc)', sort: { key: 'charged', direction: 'desc' } },
  { id: 'paid-desc', label: 'Paid (desc)', sort: { key: 'paid', direction: 'desc' } },
  { id: 'gap-desc', label: 'Collection gap (desc)', sort: { key: 'gap', direction: 'desc' } },
  { id: 'rate-asc', label: 'Avg rate (asc)', sort: { key: 'avg_rate', direction: 'asc' } },
];

const PAYER_DEFAULT_SORT: PayerSort = { key: 'claims', direction: 'desc' };

/** Show-N options for the explorer (0 = All). */
const PAYER_SHOW_OPTIONS = [10, 25, 50, 0] as const;
const PAYER_DEFAULT_SHOW = 0; // All

type PayerRow = PayerGapSummary['by_payer'][number];

/** The comparable value for a payer row under a given column (number or string). */
function payerSortValue(r: PayerRow, key: PayerColKey): number | string {
  switch (key) {
    case 'payer':
      return (r.payer_name ?? '').toLowerCase();
    case 'claims':
      return r.claim_count;
    case 'charged':
      return r.total_charge;
    case 'allowed':
      return r.total_allowed;
    case 'paid':
      return r.total_paid;
    case 'avg_rate':
      return r.avg_collection_rate ?? -1; // nulls sort below any real 0..1 rate
    case 'gap':
      return r.total_collection_gap;
  }
}

/** Render a single payer cell for a column (label/number/gap-with-minibar). */
function PayerCell({ r, col }: { r: PayerRow; col: PayerColKey }) {
  switch (col) {
    case 'payer':
      return r.payer_name ?? <span className="text-muted-foreground">(blank)</span>;
    case 'claims':
      return <span className="tabular-nums">{count(r.claim_count)}</span>;
    case 'charged':
      return <span className="tabular-nums">{money(r.total_charge)}</span>;
    case 'allowed':
      return <span className="tabular-nums">{money(r.total_allowed)}</span>;
    case 'paid':
      return <span className="tabular-nums">{money(r.total_paid)}</span>;
    case 'avg_rate':
      return <span className="tabular-nums">{rate(r.avg_collection_rate)}</span>;
    case 'gap': {
      const pct = r.total_charge > 0 ? (r.total_collection_gap / r.total_charge) * 100 : 0;
      return (
        <div className="flex items-center justify-end gap-2">
          <span className="tabular-nums">{money(r.total_collection_gap)}</span>
          <span className="w-16 shrink-0">
            <MiniBar pct={pct} />
          </span>
        </div>
      );
    }
  }
}

export function PayerDetailExplorer() {
  const state = useWidget<PayerGapSummary>(loadPayerGap);
  return (
    <WidgetCard title="Payer detail explorer" state={state}>
      {state.status === 'ready' && <PayerDetailBody data={state.data} />}
    </WidgetCard>
  );
}

function PayerDetailBody({ data }: { data: PayerGapSummary }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PayerSort>(PAYER_DEFAULT_SORT);
  const [showN, setShowN] = useState<number>(PAYER_DEFAULT_SHOW);
  const [hidden, setHidden] = useState<Set<PayerColKey>>(() => new Set());
  const [columnOrder, setColumnOrder] = useState<string[]>([...PAYER_DEFAULT_ORDER]);
  const [showColumnPanel, setShowColumnPanel] = useState(false);

  const dnd = useColumnDnD(columnOrder, setColumnOrder);

  // Display order (known keys only) and the visible subset.
  const orderedColumns = useMemo(
    () =>
      columnOrder
        .map((k) => PAYER_COLUMN_BY_KEY.get(k as PayerColKey))
        .filter((c): c is (typeof PAYER_COLUMNS)[number] => c !== undefined),
    [columnOrder],
  );
  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => !hidden.has(c.key)),
    [orderedColumns, hidden],
  );

  // Filter (search) → sort → limit. Pure client-side over the loaded summary.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? data.by_payer.filter((r) => (r.payer_name ?? '').toLowerCase().includes(q))
      : [...data.by_payer];
    matched.sort((a, b) => {
      const av = payerSortValue(a, sort.key);
      const bv = payerSortValue(b, sort.key);
      let cmp: number;
      if (typeof av === 'string' || typeof bv === 'string') {
        cmp = String(av).localeCompare(String(bv));
      } else {
        cmp = av - bv;
      }
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return matched;
  }, [data.by_payer, search, sort]);

  const shown = showN > 0 ? filtered.slice(0, showN) : filtered;

  const activePresetId =
    PAYER_SORT_PRESETS.find((p) => p.sort.key === sort.key && p.sort.direction === sort.direction)?.id ??
    '';

  function toggleSort(key: PayerColKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'payer' ? 'asc' : 'desc' },
    );
  }

  function toggleColumn(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key as PayerColKey)) next.delete(key as PayerColKey);
      else next.add(key as PayerColKey);
      return next;
    });
  }

  function moveColumn(key: string, dir: 'up' | 'down') {
    setColumnOrder((prev) => {
      const next = [...prev];
      const i = next.indexOf(key);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function reset() {
    setSearch('');
    setSort(PAYER_DEFAULT_SORT);
    setShowN(PAYER_DEFAULT_SHOW);
    setHidden(new Set());
    setColumnOrder([...PAYER_DEFAULT_ORDER]);
  }

  return (
    <div className="space-y-4">
      {/* Filter bar — wraps on mobile. All controls are client-side. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search payer…"
          aria-label="Search payer"
          className="h-9 w-full sm:w-56"
        />
        <ControlSelect
          label="Sort by"
          value={activePresetId}
          ariaLabel="Sort payers by"
          onChange={(v) => {
            const preset = PAYER_SORT_PRESETS.find((p) => p.id === v);
            if (preset) setSort({ ...preset.sort });
          }}
        >
          {activePresetId === '' && <option value="">Custom</option>}
          {PAYER_SORT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </ControlSelect>
        <ControlSelect
          label="Show"
          value={showN}
          ariaLabel="Number of payers to show"
          onChange={(v) => setShowN(Number(v))}
        >
          {PAYER_SHOW_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'All' : `Top ${n}`}
            </option>
          ))}
        </ControlSelect>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowColumnPanel((s) => !s)}
          aria-expanded={showColumnPanel}
          className={showColumnPanel ? 'border-teal500 text-teal700' : undefined}
        >
          <Columns3 className="h-4 w-4" />
          Columns
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reset} className="text-ink600">
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
      </div>

      {showColumnPanel && (
        <ColumnsPanel
          columns={orderedColumns}
          isHidden={(k) => hidden.has(k as PayerColKey)}
          onToggle={toggleColumn}
          dnd={dnd}
          onMove={moveColumn}
        />
      )}

      <Table aria-label="Payer detail explorer">
        <TableHeader>
          <TableRow>
            {visibleColumns.map((c) => (
              <SortHeaderCell
                key={c.key}
                label={c.label}
                numeric={c.numeric}
                active={sort.key === c.key}
                direction={sort.direction}
                onToggle={() => toggleSort(c.key)}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={Math.max(1, visibleColumns.length)}
                className="py-10 text-center text-sm text-muted-foreground"
              >
                No payers match your search.
              </TableCell>
            </TableRow>
          ) : (
            shown.map((r, i) => (
              <TableRow key={`${r.payer_name ?? 'null'}-${i}`}>
                {visibleColumns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={c.numeric ? 'text-right tabular-nums' : undefined}
                  >
                    <PayerCell r={r} col={c.key} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        {count(shown.length)} payers · {count(data.rows_analyzed)} claims analyzed
      </p>
    </div>
  );
}
