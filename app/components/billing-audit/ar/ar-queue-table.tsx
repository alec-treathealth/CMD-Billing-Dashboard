'use client';

/**
 * The AR QUEUE grid — claim grain over claims.ar_claim (NON-PHI projection). Keyset paging +
 * allowlisted sort via loadArQueue. The patient column is a fixed mask; "Reveal all" (canRevealPhi
 * only) bulk-reveals the CURRENT page through one gated + audited action and caches the names by
 * cmd_patient_id for the session. Each row's left rail is painted with the age ramp so the grid reads
 * against the aging strip above it without a legend.
 *
 * Collections grid idiom: ONE focusable scrollport (`role="region"`, keyboard-scrollable), a bare
 * <table> with a sticky header, 15px type, tight cells, opacity-60 while a refetch is in flight —
 * never a skeleton over content that is already on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pager, SortHeaderCell } from '@/components/data-grid';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { loadArQueue, revealArPatientsAction } from '@/lib/ar/actions';
import type { ArCursor, ArFilter, ArQueueRow, ArSort, ArSortColumn, ArLatestNote } from '@/lib/ar/contract';
import type { DashboardView } from '@/lib/views';
import { ArStatusChip, BAND_COLOR, BandPill, DenialPills, PatientMask, WorkChip, dateRange, money, relativeTime, shortDate } from './ar-leaves';

export interface ArQueueTableProps {
  view: DashboardView;
  canRevealPhi: boolean;
  filter: ArFilter;
  sort: ArSort;
  onSort: (column: ArSortColumn) => void;
  initialPage: { rows: ArQueueRow[]; nextCursor: ArCursor | null; latestNotes?: Record<string, ArLatestNote> } | null;
  onOpenClaim: (row: ArQueueRow) => void;
  revealAll: boolean;
  onToggleRevealAll: () => void;
  /** Bump to reload the current page in place (after a drawer write). */
  refreshToken: number;
  /** The claim currently open in the drawer — highlighted in the grid. */
  activeClaimId: string | null;
}

interface Col { key: string; label: string; numeric?: boolean; sort?: ArSortColumn; className?: string }
const COLS: readonly Col[] = [
  { key: 'patient', label: 'Patient' },
  { key: 'facility', label: 'Facility', sort: 'facility_code' },
  { key: 'status', label: 'Status · payer', sort: 'current_payer_name' },
  { key: 'dos', label: 'Dates of service', sort: 'dos_from' },
  { key: 'codes', label: 'Codes' },
  { key: 'charged', label: 'Charged', numeric: true, sort: 'total_charges' },
  { key: 'paid', label: 'Paid', numeric: true },
  { key: 'balance', label: 'Balance', numeric: true, sort: 'balance' },
  { key: 'age', label: 'Age', sort: 'age' },
  { key: 'denial', label: 'Denial' },
  { key: 'remit', label: '835 · error' },
  { key: 'work', label: 'Work', sort: 'work_status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'followup', label: 'Follow-up', sort: 'cmd_followup_date' },
  // NOTES IS LAST, DELIBERATELY (Alec, 2026-09-10). It is the only free-text column and the only
  // one with no width ceiling, so wherever it sits it pushes everything after it far to the right —
  // with Notes in the middle, Work/Assignee/Follow-up ended up separated from the rest of the row
  // by a band of whitespace as wide as the longest note on the page. Last, it can run as long as
  // it likes and nothing is stranded behind it.
  // ⚠ COLS drives ONLY the header row; the body cells below are written out by hand in source
  // order. These two orders are not linked by anything but this comment — move a column here and
  // you MUST move its <TableCell> too, or every cell after it renders under the wrong heading.
  { key: 'notes', label: 'Notes', sort: 'last_note_at' },
];

const CELL = 'px-2.5 py-1.5 align-middle whitespace-nowrap';

export function ArQueueTable({ view, canRevealPhi, filter, sort, onSort, initialPage, onOpenClaim, revealAll, onToggleRevealAll, refreshToken, activeClaimId }: ArQueueTableProps) {
  const [rows, setRows] = useState<ArQueueRow[]>(initialPage?.rows ?? []);
  const [cursors, setCursors] = useState<(ArCursor | null)[]>([null, ...(initialPage?.nextCursor ? [initialPage.nextCursor] : [])]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState<boolean>(initialPage?.nextCursor != null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Map<string, { name: string; member: string | null }>>(new Map());
  // The latest follow-up note per claim arrives on its own UNCACHED channel alongside the rows
  // (see loadArLatestNotes) — never merged into ArQueueRow, so the cached page payload stays
  // PHI-free. Keyed by cmd_claim_id.
  const [latestNotes, setLatestNotes] = useState<Record<string, ArLatestNote>>(initialPage?.latestNotes ?? {});
  const seeded = useRef(initialPage != null);
  // Request generation: Server Actions cannot be aborted, so a late response for a superseded filter /
  // sort / page must not overwrite the current selection — only the newest request commits.
  const generation = useRef(0);
  const filterKey = JSON.stringify(filter);
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => { setNowMs(Date.now()); }, [rows]);

  const load = useCallback(async (target: number, cursorList: (ArCursor | null)[]) => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    const res = await loadArQueue(view, cursorList[target] ?? null, filter, sort);
    if (gen !== generation.current) return; // superseded — a newer request owns the state now
    if (!res.ok) { setError(res.error); setLoading(false); return; }
    setRows(res.rows);
    setLatestNotes(res.latestNotes);
    setHasNext(res.nextCursor != null);
    setPage(target);
    if (res.nextCursor != null && target === cursorList.length - 1) setCursors([...cursorList, res.nextCursor]);
    setLoading(false);
  }, [view, filter, sort]);

  // Page 0 on any filter / sort change (skipping the very first render when the server seeded it).
  useEffect(() => {
    if (seeded.current) { seeded.current = false; return; }
    setCursors([null]);
    void load(0, [null]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sort.column, sort.direction]);

  // Drawer writes: reload the CURRENT page in place so the row reflects the new work status / note.
  const lastRefresh = useRef(refreshToken);
  useEffect(() => {
    if (lastRefresh.current === refreshToken) return;
    lastRefresh.current = refreshToken;
    void load(page, cursors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // Reveal-all: one gated + audited bulk call for the page's not-yet-revealed patients.
  useEffect(() => {
    if (!revealAll || !canRevealPhi) return;
    const missing = [...new Set(rows.map((r) => r.cmd_patient_id))].filter((id) => !revealed.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    revealArPatientsAction(view, missing).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setError(res.error); return; }
      setRevealed((prev) => {
        const next = new Map(prev);
        for (const p of res.patients) next.set(p.cmd_patient_id, { name: p.patient_name, member: p.member_id });
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAll, rows, canRevealPhi, view]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-ink400">
          {rows.length === 0 && !loading ? 'No claims match these filters.' : `Showing ${rows.length} claim${rows.length === 1 ? '' : 's'} on page ${page + 1}${hasNext ? ' · more available' : ''}`}
        </div>
        {canRevealPhi ? (
          <button
            type="button"
            aria-pressed={revealAll}
            onClick={onToggleRevealAll}
            className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors ${revealAll ? 'border-teal700 bg-teal700 text-white' : 'border-line bg-card text-ink600 hover:bg-teal50'}`}
          >
            {revealAll ? 'Hide patient names' : 'Reveal patient names'}
          </button>
        ) : null}
      </div>

      {error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <div
        role="region"
        aria-label="AR queue"
        aria-busy={loading}
        tabIndex={0}
        className={`max-h-[calc(100dvh-24rem)] min-h-[16rem] overflow-auto overscroll-contain rounded-md border border-line bg-surface transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${loading ? 'opacity-60' : ''}`}
      >
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-surface [&_tr]:border-b-0">
            <TableRow className="border-b-0 shadow-[inset_0_-1px_0_#E4E9E6]">
              {COLS.map((c) => (
                <SortHeaderCell
                  key={c.key}
                  label={c.label}
                  numeric={c.numeric}
                  sortable={Boolean(c.sort)}
                  active={c.sort !== undefined && sort.column === c.sort}
                  direction={sort.direction}
                  onToggle={() => { if (c.sort) onSort(c.sort); }}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const rev = revealAll ? revealed.get(r.cmd_patient_id) ?? null : null;
              const rail = r.band ? BAND_COLOR[r.band] : '#E4E9E6';
              const active = activeClaimId === r.cmd_claim_id;
              const followup = r.due_on ?? r.cmd_followup_date;
              const overdue = followup !== null && nowMs !== null && Date.parse(`${followup}T23:59:59Z`) < nowMs;
              const lastNote = [r.last_cmd_note_at, r.last_user_note_at].filter((x): x is string => x !== null).sort().pop() ?? null;
              const note = latestNotes[r.cmd_claim_id];
              const paidSinceWorked = Number(r.balance) <= 0 && r.work_status !== 'open' && r.work_status !== 'resolved' && r.work_status !== 'dismissed';
              return (
                <TableRow
                  key={r.id}
                  onClick={() => onOpenClaim(r)}
                  className={`cursor-pointer border-b border-line transition-colors hover:bg-teal50/60 ${active ? 'bg-teal50' : ''}`}
                  style={{ boxShadow: `inset 3px 0 0 ${rail}` }}
                  aria-selected={active}
                >
                  <TableCell className={`${CELL} pl-3`}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenClaim(r); }}
                      className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      aria-label={`Open claim ${r.cmd_claim_id}`}
                    >
                      <PatientMask revealed={rev} cmdPatientId={r.cmd_patient_id} />
                    </button>
                  </TableCell>
                  <TableCell className={CELL}>
                    <span className="inline-flex rounded bg-ground px-1.5 py-0.5 text-xs font-semibold text-ink900" title={r.facility_name ?? undefined}>{r.facility_code}</span>
                  </TableCell>
                  <TableCell className={`${CELL} max-w-[18rem]`}>
                    <ArStatusChip statusRaw={r.status_raw} statusCategory={r.status_category} statusPayer={r.status_payer} cmdStatusText={r.cmd_status_text} />
                    {paidSinceWorked ? <span className="ml-1 rounded bg-status-ok/10 px-1.5 py-0.5 text-xs font-semibold text-status-ok">paid since worked</span> : null}
                    {/* The chip is the DERIVED category; this is CMD's own wording, which is what a
                        rep recognises from the CMD screen. Shown only when it adds something the
                        chip has not already said. */}
                    {r.status_raw && r.status_raw !== r.status_category ? (
                      <span className="mt-0.5 block truncate text-xs text-ink400" title={r.status_raw}>{r.status_raw}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className={`${CELL} ths-num text-ink600`}>{dateRange(r.dos_from, r.dos_to)}</TableCell>
                  <TableCell className={`${CELL} ths-num text-xs text-ink600`}>
                    {r.cpt_codes.slice(0, 2).join(' ')}{r.cpt_codes.length > 2 ? ` +${r.cpt_codes.length - 2}` : ''}
                    {r.rev_codes.length ? <span className="text-ink400"> / {r.rev_codes.slice(0, 2).join(' ')}</span> : null}
                  </TableCell>
                  <TableCell className={`${CELL} ths-num text-right`}>{money(r.total_charges)}</TableCell>
                  <TableCell className={`${CELL} ths-num text-right text-ink600`}>{money(Number(r.ins_paid) + Number(r.pat_paid))}</TableCell>
                  <TableCell className={`${CELL} ths-num text-right font-semibold text-ink900`}>{money(r.balance)}</TableCell>
                  <TableCell className={CELL}><BandPill band={r.band} ageDays={r.age_days} /></TableCell>
                  <TableCell className={CELL}><DenialPills items={r.denial_summary} /></TableCell>
                  <TableCell className={`${CELL} max-w-[12rem] text-xs`}>
                    {/* What the payer's remittance said, and separately whether the claim is stuck
                        on a SUBMISSION error — a different work queue from a payer decision. */}
                    {r.last_835_status ? <span className="block truncate text-ink600" title={r.last_835_status}>{r.last_835_status}</span> : null}
                    {r.last_error_code ? (
                      <span className="mt-0.5 inline-flex rounded bg-status-danger/10 px-1.5 py-0.5 font-semibold text-status-danger" title={`Clearinghouse / payer error ${r.last_error_code}`}>
                        err {r.last_error_code}
                      </span>
                    ) : null}
                    {!r.last_835_status && !r.last_error_code ? <span className="text-ink400">—</span> : null}
                  </TableCell>
                  {/* The EFFECTIVE state, outlined when it is CMD's inference rather than a
                      person's ruling. `work_status === 'open'` is exactly "no human has ruled",
                      because ar_set_work is the only writer of that column. */}
                  <TableCell className={CELL}>
                    <WorkChip status={r.effective_work_state} derived={r.work_status === 'open'} />
                  </TableCell>
                  <TableCell className={`${CELL} text-xs text-ink600`}>{r.assignee_email ? r.assignee_email.split('@')[0] : <span className="text-ink400">—</span>}</TableCell>
                  <TableCell className={`${CELL} ths-num text-xs ${overdue ? 'font-semibold text-status-danger' : 'text-ink600'}`}>{followup ? shortDate(followup) : <span className="text-ink400">—</span>}</TableCell>
                  {/* max-w is what makes the inner `truncate` DO anything. truncate is
                      overflow-hidden + ellipsis + nowrap, all of which need a width to resolve
                      against; in a table cell with no ceiling the cell just grows to the longest
                      note on the page. That was survivable while Notes sat mid-row (its neighbours
                      capped it); as the LAST column nothing constrains it, so the cap moves here
                      explicitly. 32rem is the widest that still leaves the ellipsis visible at
                      1440px without the table needing a horizontal scroll of its own. */}
                  <TableCell className={`${CELL} max-w-[32rem] text-xs`}>
                    {/* Gated on `note` as well as the counters. cmd_note_count DOES include
                        patient-level notes (arSnapshotMap.ts sums claim + patient), so today the two
                        agree exactly — measured 25,043 vs 25,043 open claims, 0 divergent. But the
                        counters come from the LAST SNAPSHOT while ar_claim_note accumulates across
                        runs, so once CMD prunes a note from its export the counter drops while the
                        note persists, and a proxy gate would hide the very thing being rendered. */}
                    {r.cmd_note_count > 0 || lastNote || note ? (
                      <>
                        <span className="inline-flex items-baseline gap-1">
                          <span className="ths-num font-semibold text-ink900">{r.cmd_note_count}</span>
                          <span className="text-ink400">{relativeTime(lastNote, nowMs) ?? shortDate(lastNote)}</span>
                        </span>
                        {/* The note BODY — PHI, delivered on the uncached channel. Ruled visible to
                            every role that can reach the queue (Alec, 2026-09-10); the read is
                            audited server-side. `note` is absent, not empty, when there is none. */}
                        {note ? (
                          <span className="mt-0.5 block truncate text-ink600" title={note.text}>
                            {note.source === 'user' ? <span className="mr-1 font-semibold text-ink900">app</span> : null}
                            {note.claim_level ? null : <span className="mr-1 text-ink400" title="a patient-level CMD note, not written against this claim">pt</span>}
                            {note.text}
                          </span>
                        ) : null}
                      </>
                    ) : <span className="text-ink400">none</span>}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={COLS.length} className="py-10 text-center text-sm text-ink400">Nothing here — widen the filters or include paid claims.</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
      </div>
      <Pager page={page + 1} hasPrev={page > 0} hasNext={hasNext} disabled={loading} onPrev={() => void load(page - 1, cursors)} onNext={() => void load(page + 1, cursors)} />
    </div>
  );
}
