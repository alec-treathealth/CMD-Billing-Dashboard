'use client';

/**
 * Billing Audit work table (Phase-4 build 3) — the flat, dense, charge-line-grain landing grid
 * over claims.audit_row. NON-PHI: the patient column is a static mask; the only per-row patient
 * handle is cmd_patient_id (opaque CMD key, stored plaintext). Reveal of name/DOB/member-id is the
 * separate gated + audited drill (build 5). Keyset paging + allowlisted sort via loadAuditRows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pager, SortHeaderCell } from '@/components/data-grid';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { loadAuditRows, type AuditCursor, type AuditFilter, type AuditGridRow, type AuditSort } from '@/lib/actions';
import type { AuditScope } from '../../../src/billingAudit/auditConfig';
import type { DashboardView } from '@/lib/views';

// Status category → chip label + semantic color (distinct from the teal brand accent).
const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  PAID: { label: 'Paid', fg: '#2F7D57', bg: '#E7F1EA' },
  AT_PAYER: { label: 'At payer', fg: '#3A6B8A', bg: '#E7EEF4' },
  BALANCE_DUE_PATIENT: { label: 'Balance due — patient', fg: '#B0741F', bg: '#F6EEDF' },
  APPROVED_HIGHER: { label: 'Approved higher', fg: '#5B4B8A', bg: '#ECE8F5' },
  NEEDS_RENEGOTIATING: { label: 'Needs renegotiating', fg: '#B0741F', bg: '#F6EEDF' },
  ON_HOLD: { label: 'On hold', fg: '#6B7A78', bg: '#ECEFEE' },
  OTHER: { label: 'Other', fg: '#6B7A78', bg: '#ECEFEE' },
};

export function StatusChip({ category, payer }: { category: string; payer: string | null }) {
  const s = STATUS[category] ?? STATUS.OTHER!;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: s.fg, backgroundColor: s.bg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.fg }} />
      {s.label}
      {category === 'AT_PAYER' && payer ? <span className="font-mono text-[10px] font-medium opacity-80">{payer}</span> : null}
    </span>
  );
}

export function money(cents: string): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Column { key: string; label: string; numeric?: boolean; sortColumn?: AuditSort['column']; }

const BASE_COLS: Column[] = [
  { key: 'patient', label: 'Patient' },
  { key: 'facility', label: 'Facility', sortColumn: 'facility_code' },
  { key: 'payer', label: 'Payer', sortColumn: 'payer_name' },
  { key: 'status', label: 'Status', sortColumn: 'status_category' },
  { key: 'code', label: 'CPT / Rev' },
  { key: 'charge', label: 'Charge', numeric: true, sortColumn: 'charge_amount_cents' },
  { key: 'dos', label: 'DOS', sortColumn: 'charge_from_date' },
];
const IP_EXTRA: Column[] = [{ key: 'tob', label: 'TOB' }, { key: 'admit', label: 'Admission' }];
const OP_EXTRA: Column[] = [{ key: 'freq', label: 'Claim freq' }, { key: 'mod2', label: 'Mod 2' }];
const TAIL_COLS: Column[] = [
  { key: 'auth', label: 'Auth #' },
  { key: 'lastfu', label: 'Last FU note' },
  { key: 'flag', label: '⚑', numeric: true },
];

export interface AuditWorkTableProps {
  scope: AuditScope;
  view: DashboardView;
  canRevealPhi: boolean;
  filter: AuditFilter;
  initialPage?: { rows: AuditGridRow[]; nextCursor: AuditCursor | null } | null;
  onOpenDrill?: (row: AuditGridRow) => void;
}

export function AuditWorkTable({ scope, view, canRevealPhi, filter, initialPage, onOpenDrill }: AuditWorkTableProps) {
  const columns = [...BASE_COLS, ...(scope === 'IP' ? IP_EXTRA : OP_EXTRA), ...TAIL_COLS];
  const [rows, setRows] = useState<AuditGridRow[]>(initialPage?.rows ?? []);
  const [cursors, setCursors] = useState<(AuditCursor | null)[]>([null, ...(initialPage?.nextCursor ? [initialPage.nextCursor] : [])]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState<boolean>(initialPage?.nextCursor != null);
  const [sort, setSort] = useState<AuditSort>({ column: 'charge_from_date', direction: 'desc' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(initialPage != null);
  const filterKey = JSON.stringify(filter);

  const load = useCallback(async (target: number, cursorList: (AuditCursor | null)[]) => {
    setLoading(true);
    setError(null);
    const res = await loadAuditRows(scope, cursorList[target] ?? null, filter, sort, view);
    if (!res.ok) { setError(res.error); setLoading(false); return; }
    setRows(res.rows);
    setHasNext(res.nextCursor != null);
    setPage(target);
    if (res.nextCursor != null && target === cursorList.length - 1) {
      setCursors([...cursorList, res.nextCursor]);
    }
    setLoading(false);
  }, [scope, filter, sort, view]);

  // Refetch page 0 whenever the filter or sort changes (skip the very first render when the
  // server already seeded the initial page for the default filter+sort).
  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    setCursors([null]);
    void load(0, [null]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sort.column, sort.direction, scope]);

  const onSort = (column: AuditSort['column']) => {
    setSort((prev) => prev.column === column
      ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: 'desc' });
  };

  return (
    <div className="rounded-xl border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="ths-h text-sm font-semibold">{scope === 'IP' ? 'IP' : 'OP'} Audit — work table</span>
        <span className="text-xs text-ink400">charge-line grain · sorted by <span className="text-ink600">{sort.column === 'charge_from_date' ? 'DOS' : sort.column}</span> {sort.direction === 'desc' ? '↓' : '↑'}</span>
        <span className="ml-auto text-xs text-ink400">{loading ? 'Loading…' : `${rows.length} row${rows.length === 1 ? '' : 's'} · page ${page + 1}`}</span>
      </div>
      {error ? (
        <p className="px-4 py-8 text-center text-sm text-[color:var(--status-danger,#C0453B)]">{error}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => c.sortColumn ? (
                  <SortHeaderCell
                    key={c.key}
                    label={c.label}
                    numeric={c.numeric}
                    active={sort.column === c.sortColumn}
                    direction={sort.direction}
                    onToggle={() => onSort(c.sortColumn!)}
                  />
                ) : (
                  <TableHead key={c.key} className={c.numeric ? 'text-right' : undefined}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-ink400">
                    No charges match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={onOpenDrill ? () => onOpenDrill(r) : undefined}
                    className={onOpenDrill ? 'cursor-pointer' : undefined}
                  >
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <span className="font-mono tracking-widest text-ink400">••••••</span>
                      </span>
                      <div className="font-mono text-[11px] text-ink400">PT-{r.cmd_patient_id}</div>
                    </TableCell>
                    <TableCell>
                      {r.office_name ?? r.facility_code ?? '—'}
                      {r.facility_code ? <div className="text-[11px] text-ink400">{r.facility_code}</div> : null}
                    </TableCell>
                    <TableCell>{r.payer_name ?? '—'}</TableCell>
                    <TableCell><StatusChip category={r.status_category} payer={r.status_payer} /></TableCell>
                    <TableCell className="font-mono">{[r.cpt_code, r.rev_code].filter(Boolean).join(' / ') || '—'}</TableCell>
                    <TableCell className="text-right font-mono">{money(r.charge_amount_cents)}</TableCell>
                    <TableCell className="font-mono">{r.charge_from_date ?? '—'}</TableCell>
                    {scope === 'IP' ? (
                      <>
                        <TableCell className="font-mono">{r.type_of_bill ?? '—'}</TableCell>
                        <TableCell className="font-mono">{r.admission_date ?? '—'}</TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>{r.claim_frequency ?? '—'}</TableCell>
                        <TableCell className="font-mono">{r.modifier_2 ?? '—'}</TableCell>
                      </>
                    )}
                    <TableCell className="font-mono">{r.auth_number ?? '—'}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-ink600" title={r.last_fu_note ?? undefined}>{r.last_fu_note ?? '—'}</TableCell>
                    <TableCell className="text-center text-ink400">–</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex items-center justify-end border-t border-line px-3 py-2">
        <Pager
          page={page + 1}
          hasPrev={page > 0}
          hasNext={hasNext}
          disabled={loading}
          onPrev={() => load(page - 1, cursors)}
          onNext={() => load(page + 1, cursors)}
        />
      </div>
    </div>
  );
}
