'use client';

/**
 * Patient drawer — session detail for one client's week, plus that client's data flags and
 * authorization history.
 *
 * a11y: focus trap, Escape-to-close and focus restore all come from the shared `useDialog`
 * hook (`app/components/qualify/useDialog.ts`) rather than being hand-rolled here.
 *
 * PHI: name, authorization number, session topic AND session PROVIDER arrive as `null` unless
 * the viewer has `canRevealPhi`. Everything else — dates, times, durations, statuses, codes —
 * is non-identifying and always shown.
 *
 * ⚠ THIS BLOCK LISTED `providers` AMONG THE ALWAYS-SHOWN NON-IDENTIFYING FIELDS UNTIL
 * 2026-08-29, and that was the defect, not merely a stale comment. Provider was ungated three
 * lines above a gated topic in the same mapper object. A provider on a session row is not a
 * bare staff name — it is "this clinician saw this client on this date", with the client
 * already identified on the row. It is gated now (Alec, 2026-08-29).
 *
 * ⚠ THE BILLABLE-DAY COUNT IS PASSED IN, NOT READ OFF THE ROW (Qodo 8, fixed 2026-08-30). This
 * header used to render `r.billableDays` — the engine's untouched number — while the grid row
 * two clicks away rendered `adjustedBillableDays(...)`. An edited client therefore showed TWO
 * different totals for the same week, and the drawer's was the one a biller would read as
 * authoritative because it sits under the client's name. The panel computes it ONCE and hands
 * the same value to both surfaces, `approximate` included, so they cannot disagree.
 *
 * ⚠ DO NOT RECOMPUTE IT HERE. The cap semantics belong to `overrides.ts` (and its own header
 * records where they are knowingly simplified). A second implementation in this file is how the
 * two numbers diverged in the first place.
 *
 * The two masks differ ON PURPOSE. `topic` renders `••••••` because the line exists only to
 * carry it, so an empty line would read as "no topic recorded". `provider` sits in a metadata
 * strip beside status and label and is guarded by `{s.provider && …}`, so a withheld value
 * simply drops out of the strip — which is also what a genuinely blank Kipu Provider column
 * does. Do not add a mask glyph there: it would claim data was withheld on rows where Kipu
 * never had any.
 */
import { useDialog } from '../../qualify/useDialog';
import type { KipuRowDTO } from '@/lib/billing-audit/kipu-import';
import { codeTitle } from './legend';

export interface DrawerTarget {
  row: KipuRowDTO;
  /** Day index to scroll emphasis to, or null when opened from the name cell. */
  dayIndex: number | null;
}

export function BillableDaysDrawer({
  target,
  billableDays,
  approximate,
  phiIncluded,
  revealed,
  onClose,
}: {
  target: DrawerTarget;
  /** Override-aware count from `adjustedBillableDays` — the SAME value the grid row shows. */
  billableDays: number;
  /** The grid's ` ≈` marker: this row's cap is applied approximately (see overrides.ts). */
  approximate: boolean;
  phiIncluded: boolean;
  revealed: boolean;
  onClose: () => void;
}) {
  const ref = useDialog<HTMLDivElement>(onClose, { trap: true, active: true });
  const r = target.row;
  const showName = phiIncluded && revealed && r.name;
  const sessions = r.days.flatMap((d) => d.sessions.map((s) => ({ ...s, dayIndex: d.i })));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="billable-drawer-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-line bg-card shadow-xl"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-line bg-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="billable-drawer-title" className="truncate text-base font-semibold text-ink900">
              {showName ? r.name : <span className="font-mono tracking-widest text-ink400">••••••</span>}
            </h2>
            <p className="mt-0.5 text-xs text-ink400">
              {r.loc || '—'}
              {r.payer ? ` · ${r.payer}` : ''} ·{' '}
              <span
                title={
                  approximate
                    ? "This row's auths span more than one level of care, so the server applies a per-day cap the browser does not reproduce. Treat this as indicative until it is recomputed server-side."
                    : undefined
                }
              >
                {billableDays}
                {approximate ? ' ≈' : ''}/{r.capDays} billable days
              </span>{' '}
              · {r.totalHours} h
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink600 hover:border-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            Close
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          {r.warn.length > 0 && (
            <section>
              <h3 className="ths-h mb-1.5 text-xs font-semibold text-ink900">Data flags</h3>
              <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                {r.warn.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="ths-h mb-1.5 text-xs font-semibold text-ink900">Authorization history</h3>
            {r.auths.length === 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                No authorization on file in this export.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {r.auths.map((a, i) => (
                  <li key={i} className="rounded-lg border border-line px-2.5 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink900">{a.loc || '—'}</span>
                      {a.freq && <span className="text-ink400">{a.freq}</span>}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink600">
                      {a.start || '—'} → {a.end || '—'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink400">
                      auth #{' '}
                      {a.no ? (
                        <span className="font-mono text-ink600">{a.no}</span>
                      ) : (
                        <span className="font-mono tracking-widest">••••</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="ths-h mb-1.5 text-xs font-semibold text-ink900">
              Sessions this week
              <span className="ml-1.5 font-normal text-ink400">{sessions.length}</span>
            </h3>
            {sessions.length === 0 ? (
              <p className="text-xs text-ink400">No sessions recorded in this week.</p>
            ) : (
              <ul className="space-y-1.5">
                {sessions.map((s, i) => (
                  <li
                    key={i}
                    className={[
                      'rounded-lg border px-2.5 py-1.5 text-xs',
                      target.dayIndex === s.dayIndex ? 'border-[var(--brand-accent)]' : 'border-line',
                    ].join(' ')}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-ink600">{s.date}</span>
                      <span className="font-mono text-[11px] text-ink400">
                        {s.start}
                        {s.end ? `–${s.end}` : ''}
                      </span>
                      <span
                        title={codeTitle(s.kind === 'group' ? 'G' : s.kind === 'bps' ? 'BPS' : 'T')}
                        className="rounded bg-ground px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ink600"
                      >
                        {s.kind}
                      </span>
                      <span className="ml-auto font-mono text-[11px] text-ink600">{s.hrs} h</span>
                    </div>
                    <div className="mt-0.5 text-ink900">
                      {s.topic ? (
                        s.topic
                      ) : (
                        <span className="font-mono tracking-widest text-ink400">••••••</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink400">
                      {s.provider && <span>{s.provider}</span>}
                      <span>{s.status}</span>
                      {!s.billable && (
                        <span className="rounded bg-amber-100 px-1 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          held non-billable
                        </span>
                      )}
                      {s.label && <span className="truncate">{s.label}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
