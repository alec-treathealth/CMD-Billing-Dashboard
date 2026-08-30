'use client';

/**
 * Billable Days panel — the fourth Claims Desk subtab. Upload the Kipu Billing Report CSVs,
 * the server parses them with the tested `src/kipu/` engine, and this renders the computed
 * week.
 *
 * ⚠ NOTHING IS STORED. The parsed model lives in React state for this tab only and is gone
 * on reload — the UI says so rather than leaving a biller to discover it. The `kipu.*` writer
 * is the next PR and lands behind the same action signature.
 *
 * ⚠ WHY A WEEK CHANGE RE-POSTS THE FILES. The action returns the computed rows for ONE week,
 * never the session corpus (~16 MB for the full nine-facility set). The browser therefore
 * keeps the `File` handles and re-posts them when the week changes. That round trip is
 * temporary and disappears entirely once the parsed corpus persists — at which point a week
 * change becomes a keyed read. Do not "fix" it by shipping every week at once.
 *
 * PHI: names / auth numbers / session topics are absent from the payload unless the viewer
 * has `canRevealPhi`. The reveal toggle only controls DISPLAY of what the server already
 * decided this viewer may see.
 */
import { useCallback, useRef, useState } from 'react';
import { importKipuReport, type ImportError, type KipuImportResult } from '@/lib/billing-audit/kipu-actions';
import type { KipuImportPayload, KipuRowDTO, KipuSegment } from '@/lib/billing-audit/kipu-import';
import type { DashboardView } from '@/lib/views';
import { BillableDaysGrid } from './grid';
import { BillableDaysDrawer, type DrawerTarget } from './drawer';
import { ImportSummary } from './import-summary';
import { CODE_LEGEND, type WeekStatus } from './legend';
import { countOverrides, type CellOverrides, type StatusOverrides } from './overrides';

/** Generic, enumerated. The server never sends file content or an identifier back. */
const ERROR_TEXT: Record<ImportError, string> = {
  unauthorized: 'You do not have access to import Kipu reports.',
  'wrong-view': 'Treat locations are BXR facilities — switch the view to BXR to import.',
  'no-files': 'No files were selected.',
  'too-many-files': 'Too many files at once. Upload one export (4 CSVs) at a time.',
  'file-too-large': 'One of those files is larger than this import accepts.',
  'total-too-large': 'Those files are too large in total. Upload one export at a time.',
  'not-csv': 'One of those files is not a Kipu Billing Report CSV.',
  'no-recognized-files': 'No Sessions or Evaluations CSV in that selection — those two carry the data.',
  'no-weeks': 'That export produced no dated sessions, so there is no week to show.',
  'unmapped-location':
    'That export contains a Kipu location that is not in the registry yet. A human has to map it before it can be counted — nothing was guessed.',
  'parse-failed': 'That export could not be parsed.',
};

const SEGMENTS: readonly { id: KipuSegment; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Needs review' },
  { id: 'past', label: 'Past auth' },
];

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="min-w-[120px] rounded-xl border border-line bg-card px-3 py-2">
      <div className="text-[11px] text-ink400">{label}</div>
      <div
        className={`font-mono text-lg font-semibold ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-ink900'}`}
      >
        {value}
      </div>
    </div>
  );
}

export function BillableDaysPanel({ view, canRevealPhi }: { view: DashboardView; canRevealPhi: boolean }) {
  const [data, setData] = useState<KipuImportPayload | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [segment, setSegment] = useState<KipuSegment>('all');
  const [locFilter, setLocFilter] = useState<string>('');
  const [facFilter, setFacFilter] = useState<string>('');
  const [revealed, setRevealed] = useState(false);
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  // SESSION-LOCAL overrides. Cleared whenever a new import replaces the data, because a
  // cell key from the previous export means nothing against a different one.
  const [cellOv, setCellOv] = useState<CellOverrides>(new Map());
  const [statusOv, setStatusOv] = useState<StatusOverrides>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (picked: File[], week: string | null, fresh: boolean) => {
      setBusy(true);
      setError(null);
      const fd = new FormData();
      fd.set('view', view);
      if (week) fd.set('week', week);
      for (const f of picked) fd.append('files', f);
      let res: KipuImportResult;
      try {
        res = await importKipuReport(fd);
      } catch {
        // A rejected body (too large for the server action limit) surfaces here, not as a result.
        setError('That upload could not be sent. Try one export at a time.');
        setBusy(false);
        return;
      }
      if (res.ok) {
        const { ok: _ok, ...payload } = res;
        setData(payload);
        setFiles(picked);
        if (fresh) {
          // A cell key is `${rowId}:${day}` and row ids are per-import ordinals, so carrying
          // overrides across a NEW export would silently re-point them at different people.
          setCellOv(new Map());
          setStatusOv(new Map());
        }
      } else {
        setError(ERROR_TEXT[res.error]);
        if (fresh) {
            setData(null);
            setFiles(null);
            setCellOv(new Map());
            setStatusOv(new Map());
          } else if (res.error !== 'no-weeks') {
            setData(null);
          }
      }
      setBusy(false);
    },
    [view],
  );

  const onPick = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    void send(Array.from(list), null, true);
  }, [send]);

  const gotoWeek = useCallback(
    (start: string) => {
      if (!files) return;
      void send(files, start, false);
    },
    [files, send],
  );

  // ⚠ THIS EARLY RETURN MUST STAY BELOW EVERY HOOK. It used to sit above the three
  // useCallbacks, which meant switching away from BXR changed the hook count between
  // renders — a rules-of-hooks violation that React only reports at runtime, so neither
  // tsc nor the build would have caught it.
  //
  // Treat's Kipu locations are BXR facilities. Any other view fails VISIBLY: an empty grid
  // would read as "no data this week", which is a different and wrong statement.
  if (view !== 'bxr') {
    return (
      <div className="rounded-xl border border-dashed border-line bg-card px-6 py-12 text-center">
        <h3 className="text-sm font-semibold text-ink900">Not available for this entity</h3>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-ink400">
          Treat&apos;s Kipu locations bill under BXR Consulting. Switch the view to BXR to import a
          Billing Report. This is not an empty week — there is no Treat data under this entity at all.
        </p>
      </div>
    );
  }

  const rows: readonly KipuRowDTO[] = (data?.rows ?? []).filter((r) => {
    if (segment === 'review' && !r.flag) return false;
    if (segment === 'past' && r.maxPast === 0) return false;
    if (locFilter && r.loc !== locFilter) return false;
    if (facFilter && !r.labels.includes(facFilter)) return false;
    return true;
  });

  const weekIdx = data ? data.weeks.findIndex((w) => w.start === data.selectedWeek) : -1;
  const prev = data && weekIdx >= 0 ? data.weeks[weekIdx + 1] : undefined; // weeks are newest-first
  const next = data && weekIdx > 0 ? data.weeks[weekIdx - 1] : undefined;

  return (
    <section className="space-y-4">
      {/* ── Import ─────────────────────────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onPick(e.dataTransfer.files);
        }}
        className={[
          'rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors',
          dragging ? 'border-[var(--brand-accent)] bg-ground' : 'border-line bg-card',
        ].join(' ')}
      >
        <p className="text-sm font-medium text-ink900">Drop the Kipu Billing Report CSVs</p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-ink400">
          Sessions, Evaluations, Patient and Labs from one export. Parsed on the server; nothing is
          saved — reloading this tab clears it.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => onPick(e.target.files)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="mt-3 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-ink900 hover:border-[var(--brand-accent)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {busy ? 'Parsing…' : data ? 'Import another export' : 'Choose files'}
        </button>
        {error && (
          <p role="alert" className="mx-auto mt-3 max-w-lg text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      {data && (
        <>
          {/* ── Week selector ───────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!prev || busy}
              onClick={() => prev && gotoWeek(prev.start)}
              className="rounded-md border border-line px-2 py-1 text-sm text-ink600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ← Prev
            </button>
            <label className="sr-only" htmlFor="billable-week">
              Week
            </label>
            <select
              id="billable-week"
              value={data.selectedWeek}
              disabled={busy}
              onChange={(e) => gotoWeek(e.target.value)}
              className="rounded-md border border-line bg-card px-2 py-1 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {data.weeks.map((w) => (
                <option key={w.start} value={w.start}>
                  {w.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!next || busy}
              onClick={() => next && gotoWeek(next.start)}
              className="rounded-md border border-line px-2 py-1 text-sm text-ink600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Next →
            </button>

            <select
              aria-label="Level of care"
              value={locFilter}
              onChange={(e) => setLocFilter(e.target.value)}
              className="ml-2 rounded-md border border-line bg-card px-2 py-1 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All levels of care</option>
              {data.locOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>

            <select
              aria-label="Location"
              value={facFilter}
              onChange={(e) => setFacFilter(e.target.value)}
              className="rounded-md border border-line bg-card px-2 py-1 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All locations</option>
              {data.facilityOptions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>

            {canRevealPhi && (
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="ml-auto rounded-md border border-line px-2 py-1 text-sm text-ink600 hover:border-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {revealed ? 'Hide identifiers' : 'Reveal identifiers'}
              </button>
            )}
          </div>

          {/* ── Stat strip ──────────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap gap-2">
            <Stat label="Clients" value={data.stats.clients} />
            <Stat label="Billable days this week" value={data.stats.billableDays} />
            <Stat label="Attended hours" value={data.stats.attendedHours} />
            <Stat
              label="Unauthorized days"
              value={data.stats.unauthorizedDays}
              tone={data.stats.unauthorizedDays > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Furthest past auth"
              value={data.stats.furthestPastAuth ? `${data.stats.furthestPastAuth}d` : '—'}
              tone={data.stats.furthestPastAuth > 0 ? 'warn' : undefined}
            />
          </div>

          {/* ── Segments ────────────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-1">
            {SEGMENTS.map((s) => {
              const n =
                s.id === 'all' ? data.stats.clients : s.id === 'review' ? data.stats.needsReview : data.stats.pastAuth;
              const on = segment === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSegment(s.id)}
                  className={[
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                    on ? 'border-[var(--brand-accent)] bg-[var(--brand-accent)]/10 text-[var(--brand-ink)]' : 'border-line text-ink600 hover:text-ink900',
                  ].join(' ')}
                >
                  {s.label}
                  <span className="ml-1.5 font-mono text-[10.5px] text-ink400">{n}</span>
                </button>
              );
            })}
            <span className="ml-auto text-xs text-ink400">
              {rows.length} of {data.stats.clients} shown
            </span>
          </div>

          <BillableDaysGrid
            rows={rows}
            weekStart={data.selectedWeek}
            phiIncluded={data.phiIncluded}
            revealed={revealed}
            cellOv={cellOv}
            statusOv={statusOv}
            onSetCell={(key, codes) =>
              setCellOv((prev) => {
                const next = new Map(prev);
                if (codes === null) next.delete(key);
                else next.set(key, codes);
                return next;
              })
            }
            onSetStatus={(rowId, status) =>
              setStatusOv((prev) => {
                const next = new Map(prev);
                if (status === null) next.delete(rowId);
                else next.set(rowId, status);
                return next;
              })
            }
            onOpen={(row, dayIndex) => setTarget({ row, dayIndex })}
          />

          {countOverrides(cellOv, statusOv) > 0 && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--brand-accent)] bg-[var(--brand-accent)]/8 px-3 py-2 text-xs"
            >
              <span className="font-semibold text-[var(--brand-ink)]">
                {countOverrides(cellOv, statusOv)} manual override
                {countOverrides(cellOv, statusOv) === 1 ? '' : 's'}
              </span>
              <span className="text-ink600">
                Held in this tab only — reloading or importing another export discards them. Nothing is
                written to the database in this release.
              </span>
              <button
                type="button"
                onClick={() => {
                  setCellOv(new Map());
                  setStatusOv(new Map());
                }}
                className="ml-auto rounded-md border border-line bg-card px-2 py-1 text-ink900 hover:border-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear all
              </button>
            </div>
          )}

          {/* ── Legend ──────────────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-ink400">
            <span className="ths-h font-semibold text-ink600">Codes</span>
            {CODE_LEGEND.map((c) => (
              <span key={c.code}>
                <span className="font-mono font-semibold text-ink600">{c.code}</span> {c.label}
                {c.cpt ? ` (${c.cpt})` : ''}
              </span>
            ))}
          </div>

          <ImportSummary d={data.diagnostics} />
        </>
      )}

      {target && (
        <BillableDaysDrawer
          target={target}
          phiIncluded={data?.phiIncluded ?? false}
          revealed={revealed}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
