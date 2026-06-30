'use client';

/**
 * CMD Collections Explorer grid (Derek's 14-column batch export) — DB-backed.
 *
 * Non-PHI columns come from loadCmdReport() ONE keyset page at a time (server-cached,
 * NON-PHI only) — the pager drives the server cursor, so the browser never holds the
 * whole dataset. The 3 PHI columns render •••••• until an explicit per-row reveal, which
 * fetches just that row's identifiers via the audited revealCmdReportRow action; fetched
 * PHI is held in component state only (never persisted) and is dropped on page change so
 * every page starts fully masked. Column show/hide + drag-reorder come from the shared
 * data-grid shell. Rows are ordered by id DESCENDING (newest snapshot first) so freshly
 * cron-ingested rows surface on the first page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ColumnsPanel, Pager, useColumnDnD } from '@/components/data-grid';
import { PHI_MASK } from '@/lib/phi';
import { loadCmdReport, revealCmdReportRow, type CmdReportResult } from '@/lib/actions';
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

  // Keyset pagination: cursors[p] is the cursor used to fetch page p (cursors[0] = null =
  // first page). hasNext mirrors the last page's nextCursor. Held client-side so Previous
  // can re-fetch an earlier page without a count(*) or offset.
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [hasNext, setHasNext] = useState(false);

  // Column layout (session only).
  const [order, setOrder] = useState<ColKey[]>([...DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showPanel, setShowPanel] = useState(false);
  const dnd = useColumnDnD(order, (next) => setOrder(next as ColKey[]));

  // PHI revealed per row (fetched on demand, kept in memory only) + visibility toggle.
  // Keyed by bigserial id; cleared on page change so a new page starts fully masked.
  const [phi, setPhi] = useState<Map<number, CmdExplorerPhi>>(() => new Map());
  const [shown, setShown] = useState<Set<number>>(() => new Set());
  const [revealing, setRevealing] = useState<number | null>(null);

  // Guards against out-of-order page responses (fast Prev/Next clicks).
  const reqRef = useRef(0);

  const loadPage = useCallback(async (target: number, cursor: number | null) => {
    const myReq = ++reqRef.current;
    setStatus('loading');
    // New page → drop any revealed PHI so nothing from the prior page lingers in memory.
    setPhi(new Map());
    setShown(new Set());
    setRevealing(null);
    try {
      const res: CmdReportResult = await loadCmdReport(cursor);
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
  }, []);

  useEffect(() => {
    void loadPage(0, null);
  }, [loadPage]);

  const visible = useMemo(() => order.filter((k) => !hidden.has(k)), [order, hidden]);
  const hasPhiColumn = visible.some((c) => IS_PHI.has(c));
  const busy = status === 'loading';

  function toggleHidden(k: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function moveColumn(key: string, dir: 'up' | 'down') {
    setOrder((prev) => {
      const i = prev.indexOf(key as ColKey);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  async function onReveal(id: number) {
    if (phi.has(id)) {
      setShown((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setRevealing(id);
    try {
      const res = await revealCmdReportRow(id);
      if (res.ok) {
        setPhi((prev) => new Map(prev).set(id, res.phi));
        setShown((prev) => new Set(prev).add(id));
      }
    } finally {
      setRevealing(null);
    }
  }

  function cellText(key: ColKey, row: CmdExplorerRow): string {
    if (IS_PHI.has(key)) {
      if (!shown.has(row.id)) return PHI_MASK;
      const p = phi.get(row.id);
      const v = p ? p[key as keyof CmdExplorerPhi] : null;
      return v ?? '—';
    }
    const v = row[key as keyof CmdExplorerRow] as string | null;
    if (IS_NUMERIC.has(key)) return formatMoney(v);
    return v ?? '—';
  }

  if (status === 'loading' && rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading collections…</p>;
  }
  if (status === 'error' && rows.length === 0) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        The collections report could not be loaded. Reload and try again.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows.length.toLocaleString()} charge lines on this page
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowPanel((s) => !s)}>
          {showPanel ? 'Hide columns' : 'Columns'}
        </Button>
      </div>

      {status === 'error' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          That page could not be loaded. Try again.
        </div>
      )}

      {showPanel && (
        <ColumnsPanel
          columns={COLUMNS.map((c) => ({ key: c.key, label: c.label }))}
          isHidden={(k) => hidden.has(k)}
          onToggle={toggleHidden}
          dnd={dnd}
          onMove={moveColumn}
        />
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {visible.map((c) => (
                <TableHead key={c} className={IS_NUMERIC.has(c) ? 'text-right' : undefined}>
                  {COLUMN_LABEL[c] ?? c}
                </TableHead>
              ))}
              {hasPhiColumn && <TableHead className="text-right">Identifiers</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="transition-colors hover:bg-teal50/50">
                {visible.map((c) => (
                  <TableCell
                    key={c}
                    className={
                      IS_NUMERIC.has(c)
                        ? 'text-right tabular-nums'
                        : IS_PHI.has(c) && !shown.has(row.id)
                          ? 'text-muted-foreground'
                          : undefined
                    }
                  >
                    {cellText(c, row)}
                  </TableCell>
                ))}
                {hasPhiColumn && (
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={revealing === row.id}
                      aria-pressed={shown.has(row.id)}
                      onClick={() => void onReveal(row.id)}
                    >
                      {revealing === row.id ? '…' : shown.has(row.id) ? 'Hide' : 'Reveal'}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pager
        page={page + 1}
        hasPrev={page > 0}
        hasNext={hasNext}
        disabled={busy}
        onPrev={() => {
          if (page > 0) void loadPage(page - 1, cursors[page - 1] ?? null);
        }}
        onNext={() => {
          if (hasNext) void loadPage(page + 1, cursors[page + 1] ?? null);
        }}
      />
    </div>
  );
}
