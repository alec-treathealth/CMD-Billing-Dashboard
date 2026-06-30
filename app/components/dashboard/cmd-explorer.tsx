'use client';

/**
 * "All Collections" grid (Derek's 14-column CMD batch export) — DB-backed charge-line detail.
 *
 * Non-PHI columns come from loadCmdReport() ONE keyset page at a time (server-cached, NON-PHI
 * only), now scoped by an optional Facility + Month filter applied SERVER-SIDE (so a filter
 * searches the whole dataset, not just the visible page). The 3 PHI columns render •••••• until
 * the "Reveal all" button decrypts the current page's identifiers in one audited call
 * (revealCmdReportRows); fetched PHI is held in component state only (never persisted) and
 * dropped on page/filter change so every page starts fully masked. A reveal failure (e.g. a
 * LIBSODIUM_KEY mismatch) is surfaced, never silently swallowed. Columns are reordered by
 * dragging the header cells directly (no separate panel). Rows are ordered by id DESC.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect, Pager, useColumnDnD } from '@/components/data-grid';
import { PHI_MASK } from '@/lib/phi';
import {
  loadCmdExplorerFacilities,
  loadCmdReport,
  revealCmdReportRows,
  type CmdReportResult,
} from '@/lib/actions';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../../src/collections/cmdExplorer';

type ColKey =
  | keyof Omit<CmdExplorerRow, 'id' | 'ingested_at'>
  | 'patient_name'
  | 'member_id_raw'
  | 'group_number';

const COLUMNS: readonly { key: ColKey; label: string; phi: boolean; numeric: boolean }[] = [
  { key: 'charge_date', label: 'Charge From Date', phi: false, numeric: false },
  { key: 'payment_received', label: 'Payment Received', phi: false, numeric: false },
  { key: 'cpt_code', label: 'CPT Code', phi: false, numeric: false },
  { key: 'revenue_code', label: 'Revenue Code', phi: false, numeric: false },
  { key: 'facility', label: 'Facility', phi: false, numeric: false },
  { key: 'patient_name', label: 'Patient Name', phi: true, numeric: false },
  { key: 'member_id_raw', label: 'Member ID', phi: true, numeric: false },
  { key: 'group_number', label: 'Group Number', phi: true, numeric: false },
  { key: 'charge_amount', label: 'Charge Amount', phi: false, numeric: true },
  { key: 'allowed_amount', label: 'Allowed Amount', phi: false, numeric: true },
  { key: 'insurance_payments', label: 'Insurance Payments', phi: false, numeric: true },
  { key: 'adjustments', label: 'Adjustments', phi: false, numeric: true },
  { key: 'patient_balance_due', label: 'Patient Balance Due', phi: false, numeric: true },
  { key: 'primary_payer', label: 'Primary Payer', phi: false, numeric: false },
];
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const IS_PHI = new Set<string>(COLUMNS.filter((c) => c.phi).map((c) => c.key));
const IS_NUMERIC = new Set<string>(COLUMNS.filter((c) => c.numeric).map((c) => c.key));
const DEFAULT_ORDER: ColKey[] = COLUMNS.map((c) => c.key);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const YEAR_OPTIONS = [2026, 2025, 2024];

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** DB numerics arrive as clean decimal strings ('250.00', '-1660.05'); format as USD. */
function formatMoney(s: string | null): string {
  if (s === null || s === '') return '—';
  const n = Number(s);
  return Number.isFinite(n) ? MONEY.format(n) : s;
}

export function CmdCollectionsExplorer() {
  const [rows, setRows] = useState<CmdExplorerRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');

  // Server-side filters (the "same filters" the daily view has). `month === 0` = All months
  // (no date window); year is only used when a specific month is chosen. facility = '' = all.
  const [facility, setFacility] = useState('');
  const [year, setYear] = useState(YEAR_OPTIONS[0]!);
  const [month, setMonth] = useState(0); // 0 = All months
  const [facilityOptions, setFacilityOptions] = useState<string[]>([]);

  // Keyset pagination: cursors[p] is the cursor used to fetch page p (cursors[0] = null =
  // first page). hasNext mirrors the last page's nextCursor. Held client-side so Previous
  // can re-fetch an earlier page without a count(*) or offset.
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [hasNext, setHasNext] = useState(false);

  // Column order (session only); reorder by dragging the headers directly.
  const [order, setOrder] = useState<ColKey[]>([...DEFAULT_ORDER]);
  const dnd = useColumnDnD(order, (next) => setOrder(next as ColKey[]));

  // PHI for the current page, revealed in bulk via the "Reveal all" button (kept in memory
  // only, never persisted). Cleared on page/filter change so a new page starts fully masked.
  const [phi, setPhi] = useState<Map<number, CmdExplorerPhi>>(() => new Map());
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  // Guards against out-of-order page responses (fast Prev/Next clicks).
  const reqRef = useRef(0);

  // The active filter object passed to the action (month 0 → no date window). `year` only
  // contributes when a specific month is chosen, so it's excluded from the deps while
  // month === 0 — otherwise touching the Year dropdown in "All months" mode would mint a new
  // (identical) filter object and bounce pagination back to page 0 for no reason.
  const filterArg = useMemo(
    () => ({ facility: facility || undefined, ...(month > 0 ? { year, month } : {}) }),
    [facility, month, month > 0 ? year : 0],
  );

  const loadPage = useCallback(
    async (target: number, cursor: number | null, filter: typeof filterArg) => {
      const myReq = ++reqRef.current;
      setStatus('loading');
      // New page → drop any revealed PHI so nothing from the prior page lingers in memory.
      setPhi(new Map());
      setRevealed(false);
      setRevealing(false);
      setRevealError(null);
      try {
        const res: CmdReportResult = await loadCmdReport(cursor, filter);
        if (myReq !== reqRef.current) return; // a newer navigation superseded this load
        if (!res.ok) {
          setStatus('error');
          return;
        }
        setRows(res.rows);
        setHasNext(res.nextCursor !== null);
        setCursors((prev) => {
          const next = [...prev];
          next[target] = cursor;
          if (res.nextCursor !== null) next[target + 1] = res.nextCursor;
          return next;
        });
        setPage(target);
        setStatus('ready');
      } catch {
        if (myReq === reqRef.current) setStatus('error');
      }
    },
    [],
  );

  // Facility options for the filter (the explorer's own facility vocabulary), once on mount.
  useEffect(() => {
    let live = true;
    loadCmdExplorerFacilities()
      .then((r) => {
        if (live && r.ok) setFacilityOptions(r.facilities);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // (Re)load the first page whenever the filter changes (resets keyset pagination).
  useEffect(() => {
    setCursors([null]);
    void loadPage(0, null, filterArg);
  }, [filterArg, loadPage]);

  const busy = status === 'loading';

  /** Keyboard-fallback reorder (ArrowLeft/ArrowRight on the header grip → prev/next). */
  function moveColumn(key: ColKey, dir: 'left' | 'right') {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = dir === 'left' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  /**
   * Reveal (or hide) the patient identifiers for ALL rows on the current page in one
   * audited call. On failure the error is shown (not silently swallowed) — a common cause
   * is a LIBSODIUM_KEY that doesn't match the key the rows were ingested with.
   */
  async function toggleRevealAll() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (rows.length === 0) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await revealCmdReportRows(rows.map((r) => r.id));
      if (res.ok) {
        const map = new Map<number, CmdExplorerPhi>();
        for (const r of res.rows) {
          const { id, ...phiFields } = r;
          map.set(id, phiFields);
        }
        setPhi(map);
        setRevealed(true);
      } else {
        setRevealError(res.error);
      }
    } catch {
      setRevealError('The identifiers could not be revealed right now.');
    } finally {
      setRevealing(false);
    }
  }

  function cellText(key: ColKey, row: CmdExplorerRow): string {
    if (IS_PHI.has(key)) {
      if (!revealed) return PHI_MASK;
      const p = phi.get(row.id);
      const v = p ? p[key as keyof CmdExplorerPhi] : null;
      return v ?? '—';
    }
    const v = row[key as keyof CmdExplorerRow] as string | null;
    if (IS_NUMERIC.has(key)) return formatMoney(v);
    return v ?? '—';
  }

  return (
    <div className="space-y-3">
      {/* Filter bar — Facility (explorer vocabulary) + Month/Year window (server-side). */}
      <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
        <div className="flex flex-wrap items-center gap-3">
          <ControlSelect
            label="Facility"
            value={facility}
            ariaLabel="Facility"
            onChange={(v) => setFacility(v)}
          >
            <option value="">All facilities</option>
            {facilityOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </ControlSelect>
          <ControlSelect
            label="Month"
            value={month}
            ariaLabel="Month"
            onChange={(v) => setMonth(Number(v))}
          >
            <option value={0}>All months</option>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </ControlSelect>
          <ControlSelect
            label="Year"
            value={year}
            ariaLabel="Year"
            onChange={(v) => setYear(Number(v))}
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </ControlSelect>
          <div className="ml-auto flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {rows.length.toLocaleString()} charge lines on this page
            </p>
            {rows.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revealing}
                aria-pressed={revealed}
                onClick={() => void toggleRevealAll()}
                className={revealed ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]' : undefined}
              >
                {revealing ? 'Revealing…' : revealed ? 'Hide identifiers' : 'Reveal all'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {status === 'error' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          That page could not be loaded. Try again.
        </div>
      )}

      {revealError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {revealError}
        </div>
      )}

      {status === 'loading' && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading collections…</p>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No charge lines match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {order.map((c) => {
                  const dragging = dnd.draggingKey === c;
                  const isTarget = dnd.dropTargetKey === c && dnd.draggingKey !== c;
                  return (
                    <TableHead
                      key={c}
                      {...dnd.itemProps(c)}
                      aria-grabbed={dragging}
                      title="Drag to reorder"
                      className={[
                        'cursor-grab select-none border-l-2 active:cursor-grabbing',
                        IS_NUMERIC.has(c) ? 'text-right' : '',
                        isTarget ? 'border-l-[var(--brand-accent)]' : 'border-l-transparent',
                        dragging ? 'opacity-50' : '',
                      ].join(' ')}
                    >
                      <span className={`inline-flex items-center gap-1 ${IS_NUMERIC.has(c) ? 'flex-row-reverse' : ''}`}>
                        <button
                          type="button"
                          aria-label={`Reorder ${COLUMN_LABEL[c] ?? c}`}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowLeft') {
                              e.preventDefault();
                              moveColumn(c, 'left');
                            } else if (e.key === 'ArrowRight') {
                              e.preventDefault();
                              moveColumn(c, 'right');
                            }
                          }}
                          className="shrink-0 cursor-grab text-ink400 active:cursor-grabbing"
                        >
                          <GripVertical className="h-3 w-3" aria-hidden />
                        </button>
                        {COLUMN_LABEL[c] ?? c}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="transition-colors hover:bg-[var(--brand-soft)]">
                  {order.map((c) => (
                    <TableCell
                      key={c}
                      className={
                        IS_NUMERIC.has(c)
                          ? 'text-right tabular-nums'
                          : IS_PHI.has(c) && !revealed
                            ? 'text-muted-foreground'
                            : undefined
                      }
                    >
                      {cellText(c, row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pager
        page={page + 1}
        hasPrev={page > 0}
        hasNext={hasNext}
        disabled={busy}
        onPrev={() => {
          if (page > 0) void loadPage(page - 1, cursors[page - 1] ?? null, filterArg);
        }}
        onNext={() => {
          if (hasNext) void loadPage(page + 1, cursors[page + 1] ?? null, filterArg);
        }}
      />
    </div>
  );
}
