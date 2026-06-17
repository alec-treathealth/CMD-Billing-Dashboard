'use client';

/**
 * Dashboard — payer surfaces: the multi-dimensional Payer Chart widget and the
 * client-side Payer Detail Explorer (search / sort / show / columns over the
 * cached, non-PHI payer_gap summary). Split out of the former dashboard.tsx.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Eye, EyeOff, RotateCcw } from 'lucide-react';

import { PayerChart } from '@/components/payer-chart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
// API calls, no row data, no patient identifiers. Column visibility is session-only
// React state and is never persisted.
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

const payerSelectCls =
  'h-9 rounded-md border border-input bg-background px-2 text-sm ring-offset-background ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

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
  const [showColumnPanel, setShowColumnPanel] = useState(false);

  const visibleColumns = useMemo(
    () => PAYER_COLUMNS.filter((c) => !hidden.has(c.key)),
    [hidden],
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

  function toggleColumn(key: PayerColKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function reset() {
    setSearch('');
    setSort(PAYER_DEFAULT_SORT);
    setShowN(PAYER_DEFAULT_SHOW);
    setHidden(new Set());
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
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort by
          <select
            value={activePresetId}
            onChange={(e) => {
              const preset = PAYER_SORT_PRESETS.find((p) => p.id === e.target.value);
              if (preset) setSort({ ...preset.sort });
            }}
            aria-label="Sort payers by"
            className={payerSelectCls}
          >
            {activePresetId === '' && <option value="">Custom</option>}
            {PAYER_SORT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Show
          <select
            value={showN}
            onChange={(e) => setShowN(Number(e.target.value))}
            aria-label="Number of payers to show"
            className={payerSelectCls}
          >
            {PAYER_SHOW_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'All' : `Top ${n}`}
              </option>
            ))}
          </select>
        </label>
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

      {/* Column show/hide — session-only layout state, never persisted. */}
      {showColumnPanel && (
        <div className="rounded-lg border border-line bg-card p-4 shadow-ths animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
            <Columns3 className="h-4 w-4 text-teal500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-ink600">Columns</span>
            <span className="text-[11px] text-ink400">— show or hide (layout only)</span>
          </div>
          <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {PAYER_COLUMNS.map((c) => {
              const isHidden = hidden.has(c.key);
              return (
                <li key={c.key} className="rounded-md px-2 py-1.5 transition-colors hover:bg-teal50/70">
                  <button
                    type="button"
                    onClick={() => toggleColumn(c.key)}
                    aria-pressed={!isHidden}
                    className="flex min-w-0 items-center gap-2 text-sm"
                  >
                    {isHidden ? (
                      <EyeOff className="h-4 w-4 shrink-0 text-ink400" />
                    ) : (
                      <Eye className="h-4 w-4 shrink-0 text-teal500" />
                    )}
                    <span className={isHidden ? 'text-ink400 line-through' : 'text-ink900'}>
                      {c.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Table aria-label="Payer detail explorer">
        <TableHeader>
          <TableRow>
            {visibleColumns.map((c) => {
              const active = sort.key === c.key;
              return (
                <TableHead
                  key={c.key}
                  className={`${c.numeric ? 'text-right' : ''} ${active ? 'text-teal700' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-teal700 ${
                      c.numeric ? 'flex-row-reverse' : ''
                    }`}
                    aria-label={`Sort by ${c.label}`}
                  >
                    {c.label}
                    {active ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ChevronDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </TableHead>
              );
            })}
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

