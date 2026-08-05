'use client';

/**
 * Facility Resolution — the client island. Owns interaction state only; every filter is parsed
 * and every dollar is summed SERVER-side (charge grain, from the 0086 matview).
 *
 * Mutation flow follows the repo convention (registry-client.tsx): useTransition + explicit
 * refetch. There is no optimistic store — the assignment triggers a matview refresh server-side,
 * so the authoritative post-write state is one round trip away and a fabricated local guess could
 * disagree with it. The dialog stays open, disabled, with a live "Saving…" status until the
 * server confirms; only then does the queue reload and the selection clear.
 *
 * A11y: SR-only role="status" announcer for result counts and save outcomes; the dialog is a
 * focus-trapped aria-modal using the shared useDialog hook; the facility picker is a
 * combobox/listbox with full arrow-key + Home/End + Escape support and aria-activedescendant.
 *
 * PHI: rows carry member_id_bidx (HMAC token) only. Nothing here writes to the URL.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useDialog } from '../qualify/useDialog';
import {
  AssignDialogFields,
  ChipRow,
  METHOD_LABELS,
  QueueTable,
  ResolutionOverviewTiles,
  formatUsd,
} from './facility-resolution-leaves';
import {
  assignFacility,
  loadResolutionOverview,
  queryResolutionQueue,
  type ResolutionOverviewResult,
  type ResolutionQueueResult,
} from '@/lib/facility-resolution-actions';
import {
  memberDisplayToken,
  RESOLUTION_METHODS,
  type ResolutionChip,
  type ResolutionMethod,
  type ResolutionOverviewRow,
  type ResolutionRow,
  type ResolutionSort,
  type ResolutionSortColumn,
} from '../../../src/collections/facilityResolutionQuery';

interface FacilityOption {
  facility_code: string;
  facility_name: string;
}

const SEARCH_HELP =
  'Try: unresolved · jul 2024 · >5000 · 1200-4000 · 2024-03 · seed · "mental health" · M-a1b2c3';

export function FacilityResolutionView({
  view,
  initialOverview,
  initialQueue,
}: {
  view: string;
  initialOverview: ResolutionOverviewResult;
  initialQueue: ResolutionQueueResult;
}) {
  const [overview, setOverview] = useState<ResolutionOverviewRow[]>(initialOverview.overview ?? []);
  const [facilities] = useState<FacilityOption[]>(initialOverview.facilities ?? []);
  const [rows, setRows] = useState<ResolutionRow[]>(initialQueue.rows ?? []);
  const [chips, setChips] = useState<ResolutionChip[]>(initialQueue.chips ?? []);
  const [searchInput, setSearchInput] = useState('');
  const [methods, setMethods] = useState<ResolutionMethod[]>(['unresolved']);
  const [sort, setSort] = useState<ResolutionSort>({ column: 'charge_date', direction: 'desc' });
  const [selected, setSelected] = useState<Map<number, ResolutionRow>>(new Map());
  const [error, setError] = useState<string | null>(initialQueue.ok ? null : (initialQueue.error ?? null));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Guards an out-of-order response from overwriting a newer one (the qualify compose-bar rule).
  const genRef = useRef(0);

  const refetch = useCallback(
    (nextSearch: string, nextMethods: ResolutionMethod[], nextSort: ResolutionSort) => {
      const gen = ++genRef.current;
      startTransition(async () => {
        const res = await queryResolutionQueue(view, nextSearch, nextMethods, nextSort, null);
        if (gen !== genRef.current) return; // a newer request superseded this one
        if (!res.ok) {
          setError(res.error ?? 'Could not load the queue.');
          return;
        }
        setError(null);
        setRows(res.rows ?? []);
        setChips(res.chips ?? []);
      });
    },
    [view],
  );

  // Debounced search (the explorer's 350ms convention).
  useEffect(() => {
    const t = setTimeout(() => refetch(searchInput, methods, sort), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const setMethodFilter = (m: ResolutionMethod) => {
    const next = methods.includes(m) ? methods.filter((x) => x !== m) : [...methods, m];
    setMethods(next);
    refetch(searchInput, next, sort);
  };

  const onSort = (column: ResolutionSortColumn) => {
    const next: ResolutionSort =
      sort.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'desc' };
    setSort(next);
    refetch(searchInput, methods, next);
  };

  const removeChip = (index: number) => {
    // Chips are derived from the text input, so removing one re-writes the input without that
    // token rather than mutating a separate filter store (one source of truth).
    const chip = chips[index];
    if (chip === undefined) return;
    const tokens = searchInput.split(/\s+/).filter((t) => t !== '');
    const label = chip.kind === 'unmatched' ? chip.raw : null;
    const nextInput =
      label !== null
        ? tokens.filter((t) => t !== label).join(' ')
        : tokens.slice(0, Math.max(0, tokens.length - 1)).join(' ');
    setSearchInput(nextInput);
  };

  const toggleRow = (row: ResolutionRow) => {
    const next = new Map(selected);
    if (next.has(row.id)) next.delete(row.id);
    else next.set(row.id, row);
    setSelected(next);
  };
  const toggleAll = (pageRows: ResolutionRow[]) => {
    const all = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
    const next = new Map(selected);
    for (const r of pageRows) {
      if (all) next.delete(r.id);
      else next.set(r.id, r);
    }
    setSelected(next);
  };

  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const selectedMembers = useMemo(
    () => new Set(selectedRows.map((r) => r.member_id_bidx)),
    [selectedRows],
  );
  const selectedDollars = selectedRows.reduce((a, r) => a + Number(r.charge_amount), 0);

  const liveMessage = pending
    ? 'Loading charges…'
    : `${rows.length} ${rows.length === 1 ? 'charge' : 'charges'} shown` +
      (selected.size > 0
        ? `, ${selected.size} selected across ${selectedMembers.size} ${selectedMembers.size === 1 ? 'member' : 'members'}`
        : '');

  const onSaved = (written: number, facilityCode: string) => {
    setSaveMessage(`Assigned ${written.toLocaleString('en-US')} ${written === 1 ? 'charge' : 'charges'} to ${facilityCode}.`);
    setSelected(new Map());
    setDialogOpen(false);
    startTransition(async () => {
      const [ov, q] = await Promise.all([
        loadResolutionOverview(view),
        queryResolutionQueue(view, searchInput, methods, sort, null),
      ]);
      if (ov.ok && ov.overview) setOverview(ov.overview);
      if (q.ok) {
        setRows(q.rows ?? []);
        setChips(q.chips ?? []);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div aria-live="polite" role="status" className="sr-only">
        {saveMessage ?? liveMessage}
      </div>

      <ResolutionOverviewTiles overview={overview} />

      <section aria-label="Unresolved queue" className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-ths-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label htmlFor="resolution-search" className="text-sm font-medium text-ink900">
              Search the queue
            </label>
            <input
              id="resolution-search"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchInput('');
              }}
              placeholder="amount, date, method, facility, member token…"
              aria-describedby="resolution-search-help"
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p id="resolution-search-help" className="mt-1 text-xs text-ink400">
              {SEARCH_HELP}
            </p>
          </div>
          <div role="group" aria-label="Filter by method" className="flex flex-wrap gap-1.5">
            {RESOLUTION_METHODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={methods.includes(m)}
                onClick={() => setMethodFilter(m)}
                className={
                  'rounded-full border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
                  (methods.includes(m)
                    ? 'border-teal700 bg-teal900 text-white'
                    : 'border-line bg-surface text-ink600 hover:border-teal700/50')
                }
              >
                {METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        <ChipRow chips={chips} onRemove={removeChip} />

        {error !== null ? (
          <p role="alert" className="rounded-md border border-coral600/50 bg-coral50 px-3 py-2 text-sm text-coral600">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink600" aria-hidden>
            {pending ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'charge' : 'charges'} shown`}
            {selected.size > 0 ? (
              <>
                {' · '}
                <span className="font-mono tabular-nums text-ink900">{selected.size}</span> selected (
                <span className="font-mono tabular-nums text-ink900">{formatUsd(selectedDollars.toFixed(2))}</span>
                {') across '}
                <span className="font-mono tabular-nums text-ink900">{selectedMembers.size}</span>{' '}
                {selectedMembers.size === 1 ? 'member' : 'members'}
              </>
            ) : null}
          </p>
          <button
            type="button"
            disabled={selected.size === 0 || pending}
            onClick={() => {
              setSaveMessage(null);
              setDialogOpen(true);
            }}
            className="rounded-md bg-teal900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Assign facility…
          </button>
        </div>

        <QueueTable
          rows={rows}
          sort={sort}
          onSort={onSort}
          selection={{ selected: new Set(selected.keys()), onToggle: toggleRow, onToggleAll: toggleAll }}
        />
      </section>

      {dialogOpen ? (
        <AssignDialog
          view={view}
          rows={selectedRows}
          memberCount={selectedMembers.size}
          facilities={facilities}
          onClose={() => setDialogOpen(false)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

/** Focus-trapped assignment dialog with a keyboard-complete facility combobox. */
function AssignDialog({
  view,
  rows,
  memberCount,
  facilities,
  onClose,
  onSaved,
}: {
  view: string;
  rows: ResolutionRow[];
  memberCount: number;
  facilities: FacilityOption[];
  onClose: () => void;
  onSaved: (written: number, facilityCode: string) => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose, { trap: true, active: true });
  const baseId = useId();
  const listboxId = `${baseId}-facilities`;
  const noteId = `${baseId}-note`;
  const scopeName = `${baseId}-scope`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<FacilityOption | null>(null);
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<'charges' | 'members'>('charges');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q === '' ? facilities : facilities.filter((f) =>
      f.facility_name.toLowerCase().includes(q) || f.facility_code.toLowerCase().includes(q),
    );
    return list.slice(0, 50);
  }, [facilities, query]);

  const choose = (f: FacilityOption) => {
    setPicked(f);
    setQuery(f.facility_name);
    setOpen(false);
  };

  const onComboKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const f = filtered[active];
      if (f) choose(f);
    } else if (e.key === 'Escape' && open) {
      // Escape closes the LIST first; a second Escape reaches the dialog and closes it.
      e.stopPropagation();
      setOpen(false);
    }
  };

  const submit = () => {
    setErr(null);
    if (picked === null) {
      setErr('Choose a facility.');
      return;
    }
    if (note.trim() === '') {
      setErr('A note is required.');
      return;
    }
    setSaving(true);
    void (async () => {
      const res = await assignFacility(view, {
        facility_code: picked.facility_code,
        note: note.trim(),
        scope,
        charges: rows.map((r) => ({
          business_entity_id: r.business_entity_id,
          member_id_bidx: r.member_id_bidx,
          charge_date: r.charge_date,
          cpt_key: r.cpt_key,
          revenue_key: r.revenue_key,
          charge_amount: r.charge_amount,
        })),
      });
      setSaving(false);
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      onSaved(res.written, picked.facility_code);
    })();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink900/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        tabIndex={-1}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-ths-lg"
      >
        <h2 id={`${baseId}-title`} className="text-lg font-semibold tracking-tight text-ink900">
          Assign a facility
        </h2>

        <div aria-live="polite" role="status" className="sr-only">
          {saving ? 'Saving assignment…' : (err ?? '')}
        </div>

        <AssignDialogFields
          chargeCount={rows.length}
          memberCount={memberCount}
          facilityListboxId={listboxId}
          noteId={noteId}
          scopeName={scopeName}
          scope={scope}
          onScopeChange={setScope}
          note={note}
          onNoteChange={setNote}
        >
          <div className="space-y-1">
            <label htmlFor={`${baseId}-facility`} className="text-sm font-medium text-ink900">
              Facility
            </label>
            <input
              id={`${baseId}-facility`}
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-describedby={`${listboxId}-usage`}
              aria-activedescendant={open && filtered[active] ? `${listboxId}-opt-${filtered[active]!.facility_code}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPicked(null);
                setOpen(true);
                setActive(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onComboKeyDown}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {open ? (
              <ul
                id={listboxId}
                role="listbox"
                aria-label="Facilities"
                className="max-h-52 overflow-y-auto rounded-md border border-line bg-surface"
              >
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-ink400">No facility matches.</li>
                ) : (
                  filtered.map((f, i) => (
                    <li
                      key={f.facility_code}
                      id={`${listboxId}-opt-${f.facility_code}`}
                      role="option"
                      aria-selected={picked?.facility_code === f.facility_code}
                      className={
                        'cursor-pointer px-3 py-2 text-sm ' +
                        (i === active ? 'bg-teal50 text-teal900' : 'text-ink900')
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(f);
                      }}
                    >
                      {f.facility_name}{' '}
                      <span className="font-mono text-xs text-ink400">{f.facility_code}</span>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        </AssignDialogFields>

        {err !== null ? (
          <p role="alert" className="rounded-md border border-coral600/50 bg-coral50 px-3 py-2 text-sm text-coral600">
            {err}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-line px-3 py-2 text-sm text-ink900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded-md bg-teal900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {saving ? 'Saving…' : 'Record assignment'}
          </button>
        </div>

        <p className="text-xs text-ink400">
          Assignments are append-only. Re-assigning a charge supersedes the previous record and
          keeps both in the audit trail. Selection:{' '}
          {rows.length > 0 ? memberDisplayToken(rows[0]!.member_id_bidx) : '—'}
          {memberCount > 1 ? ` +${memberCount - 1} more` : ''}.
        </p>
      </div>
    </div>
  );
}
