'use client';

/**
 * CMD Collections Explorer grid (Derek's 14-column batch export). Reuses the shared
 * data-grid shell (column show/hide + drag-to-reorder, sortable headers, pager) from
 * the Claims Explorer. Non-PHI columns come from loadCmdReport() (cached server-side,
 * NON-PHI only). The 3 PHI columns render •••••• until an explicit per-row reveal,
 * which fetches just that row's identifiers via the audited revealCmdReportRow action;
 * fetched PHI is held in component state only (never persisted) and toggled per row.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ColumnsPanel, Pager, SortHeaderCell, useColumnDnD } from '@/components/data-grid';
import { PHI_MASK } from '@/lib/phi';
import { loadCmdReport, revealCmdReportRow, type CmdReportResult } from '@/lib/actions';
import type { CmdExplorerNonPhiRow, CmdExplorerPhi } from '../../../src/collections/cmdExplorer';

type ColKey =
  | keyof Omit<CmdExplorerNonPhiRow, 'rowId'>
  | 'patient_name'
  | 'member_id_raw'
  | 'group_number';

const COLUMNS: readonly { key: ColKey; label: string; phi: boolean; numeric: boolean }[] = [
  { key: 'charge_from_date', label: 'Charge From Date', phi: false, numeric: false },
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
const IS_DATE = new Set<string>(['charge_from_date', 'payment_received']);
const DEFAULT_ORDER: ColKey[] = COLUMNS.map((c) => c.key);
const PAGE_SIZE = 50;

type Sort = { column: ColKey; direction: 'asc' | 'desc' };

function toNum(s: string | null): number | null {
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s.trim());
  const n = Number(s.replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
function toTime(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
}

export function CmdCollectionsExplorer() {
  const [rows, setRows] = useState<CmdExplorerNonPhiRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort | null>(null);

  // Column layout (session only).
  const [order, setOrder] = useState<ColKey[]>([...DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showPanel, setShowPanel] = useState(false);
  const dnd = useColumnDnD(order, (next) => setOrder(next as ColKey[]));

  // PHI revealed per row (fetched on demand, kept in memory only) + visibility toggle.
  const [phi, setPhi] = useState<Map<string, CmdExplorerPhi>>(() => new Map());
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [revealing, setRevealing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    loadCmdReport()
      .then((r: CmdReportResult) => {
        if (!live) return;
        if (!r.ok) {
          setStatus('error');
          return;
        }
        setRows(r.rows);
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, []);

  const visible = useMemo(() => order.filter((k) => !hidden.has(k)), [order, hidden]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { column, direction } = sort;
    const dir = direction === 'asc' ? 1 : -1;
    const compare = (a: CmdExplorerNonPhiRow, b: CmdExplorerNonPhiRow): number => {
      const av = a[column as keyof CmdExplorerNonPhiRow] as string | null;
      const bv = b[column as keyof CmdExplorerNonPhiRow] as string | null;
      if (IS_NUMERIC.has(column) || IS_DATE.has(column)) {
        const an = IS_DATE.has(column) ? toTime(av) : toNum(av);
        const bn = IS_DATE.has(column) ? toTime(bv) : toNum(bv);
        if (an === null && bn === null) return 0;
        if (an === null) return 1; // nulls last
        if (bn === null) return -1;
        return (an - bn) * dir;
      }
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return av.localeCompare(bv) * dir;
    };
    return [...rows].sort(compare);
  }, [rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const hasPhiColumn = visible.some((c) => IS_PHI.has(c));

  function toggleSort(c: ColKey) {
    if (IS_PHI.has(c)) return; // masked columns aren't sortable
    setPage(0);
    setSort((prev) =>
      prev && prev.column === c
        ? { column: c, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column: c, direction: 'asc' },
    );
  }

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

  async function onReveal(rowId: string) {
    if (phi.has(rowId)) {
      setShown((prev) => {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
      return;
    }
    setRevealing(rowId);
    try {
      const res = await revealCmdReportRow(rowId);
      if (res.ok) {
        setPhi((prev) => new Map(prev).set(rowId, res.phi));
        setShown((prev) => new Set(prev).add(rowId));
      }
    } finally {
      setRevealing(null);
    }
  }

  function cellText(key: ColKey, row: CmdExplorerNonPhiRow): string {
    if (IS_PHI.has(key)) {
      if (!shown.has(row.rowId)) return PHI_MASK;
      const p = phi.get(row.rowId);
      const v = p ? p[key as keyof CmdExplorerPhi] : null;
      return v ?? '—';
    }
    const v = row[key as keyof CmdExplorerNonPhiRow] as string | null;
    return v ?? '—';
  }

  if (status === 'loading') {
    return (
      <p className="text-sm text-muted-foreground">
        Running the CMD report… this can take a moment.
      </p>
    );
  }
  if (status === 'error') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        The collections report could not be loaded. Confirm CMD API access and try again.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {sorted.length.toLocaleString()} charge lines
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowPanel((s) => !s)}>
          {showPanel ? 'Hide columns' : 'Columns'}
        </Button>
      </div>

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
                <SortHeaderCell
                  key={c}
                  label={COLUMN_LABEL[c] ?? c}
                  numeric={IS_NUMERIC.has(c)}
                  sortable={!IS_PHI.has(c)}
                  active={sort?.column === c}
                  direction={sort?.direction ?? 'asc'}
                  onToggle={() => toggleSort(c)}
                />
              ))}
              {hasPhiColumn && <TableHead className="text-right">Identifiers</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row) => (
              <TableRow key={row.rowId} className="transition-colors hover:bg-teal50/50">
                {visible.map((c) => (
                  <TableCell
                    key={c}
                    className={
                      IS_NUMERIC.has(c)
                        ? 'text-right tabular-nums'
                        : IS_PHI.has(c) && !shown.has(row.rowId)
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
                      disabled={revealing === row.rowId}
                      aria-pressed={shown.has(row.rowId)}
                      onClick={() => void onReveal(row.rowId)}
                    >
                      {revealing === row.rowId ? '…' : shown.has(row.rowId) ? 'Hide' : 'Reveal'}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pager
        page={page}
        hasPrev={page > 0}
        hasNext={page < pageCount - 1}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
      />
    </div>
  );
}
