'use client';

/**
 * The 7-day Billable Days grid — one row per client, one cell per weekday, code chips per day.
 * Ported from `docs/mockups/weekly-billable-days-v4.html` (layout and interaction only; its
 * inline CSS and CDN icons are not used) onto the app's tokens.
 *
 * PHI: the client name is `null` in the payload unless the viewer has `canRevealPhi`, so a
 * plain `user` gets the mask because there is nothing else to render — not because this
 * component chose to hide it. When a name IS present it still renders masked until the
 * viewer explicitly reveals.
 *
 * OVERRIDES ARE SESSION-LOCAL. A cell's codes and a row's week status can both be changed by
 * hand — edge cases and entry mistakes are the whole reason the billers keep a spreadsheet —
 * but nothing is saved and a reload discards it. The grid states that rather than implying
 * durability. Mark-billed / write-off / retro-auth stay absent: those are workflow ACTIONS
 * with downstream consequences, and shipping them without a store would be a lie.
 *
 * Week status cannot be derived from a Kipu export at all — it is billing-workflow state a
 * human sets — so an untouched row shows "—" rather than a guess.
 */
import { useState } from 'react';
import type { KipuRowDTO, KipuDayDTO } from '@/lib/billing-audit/kipu-import';
import { codeTitle, WEEK_STATUSES, type WeekStatus } from './legend';
import {
  OVERRIDE_CODES,
  adjustedBillableDays,
  cellKey,
  effectiveCodes,
  isApproximate,
  rowHasOverride,
  statusKey,
  type CellOverrides,
  type StatusOverrides,
} from './overrides';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function DayCell({
  d,
  codes,
  overridden,
  onOpen,
  onSet,
}: {
  d: KipuDayDTO;
  codes: readonly string[];
  overridden: boolean;
  onOpen: () => void;
  onSet: (codes: readonly string[] | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <td className="relative border-l border-line p-0 align-top">
      <button
        type="button"
        onClick={() => setMenu((m) => !m)}
        aria-expanded={menu}
        aria-haspopup="menu"
        title={`${d.date} — ${d.hrs} h — click to view or override`}
        className={[
          'flex h-full min-h-[52px] w-full flex-col items-start gap-1 px-2 py-1.5 text-left transition-colors',
          'hover:bg-ground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          d.oow ? 'bg-amber-50 dark:bg-amber-950/30' : '',
          overridden ? 'ring-1 ring-inset ring-[var(--brand-accent)]' : '',
        ].join(' ')}
      >
        <span className="flex flex-wrap gap-1">
          {codes.map((c, i) => (
            <span
              key={`${c}-${i}`}
              title={codeTitle(c)}
              className="rounded bg-[var(--brand-accent)]/12 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--brand-ink)]"
            >
              {c}
            </span>
          ))}
          {d.dc && (
            <span
              title="Discharge"
              className="rounded bg-ink900/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink600"
            >
              D/C
            </span>
          )}
        </span>
        {d.hrs > 0 && <span className="font-mono text-[10.5px] text-ink400">{d.hrs} h</span>}
        {d.oow && (
          <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
            outside auth{d.past > 0 ? ` · ${d.past}d past` : ''}
          </span>
        )}
        {overridden && <span className="text-[10px] font-medium text-[var(--brand-ink)]">overridden</span>}
      </button>

      {menu && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-0.5 w-44 rounded-lg border border-line bg-card p-1 shadow-lg"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setMenu(false);
              onOpen();
            }}
            className="block w-full rounded px-2 py-1 text-left text-xs text-ink900 hover:bg-ground"
          >
            Open session detail
          </button>
          <div className="my-1 border-t border-line" />
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-ink400">Set code</div>
          <div className="flex flex-wrap gap-1 px-1 pb-1">
            {OVERRIDE_CODES.map((c) => (
              <button
                role="menuitem"
                key={c}
                type="button"
                title={codeTitle(c)}
                onClick={() => {
                  setMenu(false);
                  onSet([c]);
                }}
                className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink900 hover:border-[var(--brand-accent)]"
              >
                {c}
              </button>
            ))}
            <button
              role="menuitem"
              type="button"
              title="Show the attended hours instead of a service code"
              onClick={() => {
                setMenu(false);
                onSet(['HRS']);
              }}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink900 hover:border-[var(--brand-accent)]"
            >
              HRS
            </button>
          </div>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setMenu(false);
              onSet(null);
            }}
            disabled={!overridden}
            className="block w-full rounded px-2 py-1 text-left text-xs text-ink600 hover:bg-ground disabled:opacity-40"
          >
            Revert to parsed
          </button>
        </div>
      )}
    </td>
  );
}

/** Auth pill — including the "no auth on file" state, which is a finding, not an empty cell. */
function AuthPill({ r }: { r: KipuRowDTO }) {
  if (!r.hasAuth) {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        No auth on file
      </span>
    );
  }
  const latest = r.auths[r.auths.length - 1]!;
  const past = r.maxPast > 0;
  return (
    <span
      title={`${r.auths.length} authorization${r.auths.length === 1 ? '' : 's'} · latest thru ${latest.end || '—'}`}
      className={[
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        past
          ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
          : 'border-line bg-ground text-ink600',
      ].join(' ')}
    >
      {past ? `${r.maxPast}d past auth` : `Auth thru ${latest.end || '—'}`}
    </span>
  );
}

export function BillableDaysGrid({
  rows,
  weekStart,
  phiIncluded,
  revealed,
  cellOv,
  statusOv,
  onSetCell,
  onSetStatus,
  onOpen,
}: {
  rows: readonly KipuRowDTO[];
  weekStart: string;
  phiIncluded: boolean;
  revealed: boolean;
  cellOv: CellOverrides;
  statusOv: StatusOverrides;
  onSetCell: (key: string, codes: readonly string[] | null) => void;
  /** Receives the WEEK-SCOPED key, not a bare row id — see overrides.ts. */
  onSetStatus: (key: string, status: WeekStatus | null) => void;
  onOpen: (row: KipuRowDTO, dayIndex: number | null) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-card px-6 py-10 text-center text-sm text-ink400">
        No clients with counted hours in this week.
      </div>
    );
  }

  const dates = rows[0]!.days.map((d) => d.date);

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full min-w-[980px] border-collapse text-sm">
        <caption className="sr-only">
          Billable days by client for the week beginning {weekStart}. Each cell lists the service codes
          recorded for that day.
        </caption>
        <thead>
          <tr className="border-b border-line bg-ground/60">
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink600">
              Client
            </th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink600">
              Auth
            </th>
            {DOW.map((d, i) => (
              <th key={d} scope="col" className="border-l border-line px-2 py-2 text-left text-xs font-semibold text-ink600">
                {d}
                <span className="ml-1 font-mono text-[10px] font-normal text-ink400">
                  {(dates[i] ?? '').slice(5)}
                </span>
              </th>
            ))}
            <th scope="col" className="border-l border-line px-3 py-2 text-right text-xs font-semibold text-ink600">
              Days
            </th>
            <th scope="col" className="border-l border-line px-3 py-2 text-left text-xs font-semibold text-ink600">
              Week status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const adjusted = adjustedBillableDays(r, cellOv, weekStart);
            const edited = rowHasOverride(r, cellOv, weekStart);
            const approx = isApproximate(r, cellOv, weekStart);
            const over = adjusted > r.capDays;
            return (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-ground/40">
                <th scope="row" className="max-w-[240px] px-3 py-2 text-left align-top font-normal">
                  <button
                    type="button"
                    onClick={() => onOpen(r, null)}
                    className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    {phiIncluded && revealed && r.name ? (
                      <span className="font-medium text-ink900">{r.name}</span>
                    ) : (
                      <span className="font-mono tracking-widest text-ink400">••••••</span>
                    )}
                  </button>
                  <div className="mt-0.5 text-[11px] text-ink400">
                    {r.loc || '—'}
                    {r.payer ? ` · ${r.payer}` : ''}
                  </div>
                  {r.warn.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {r.warn.map((w, i) => (
                        <div key={i} className="text-[10.5px] text-amber-700 dark:text-amber-400">
                          {w}
                        </div>
                      ))}
                    </div>
                  )}
                  {r.multiLoc && (
                    <div className="mt-0.5 text-[10.5px] text-ink400">auths span more than one level of care</div>
                  )}
                </th>
                <td className="px-3 py-2 align-top">
                  <AuthPill r={r} />
                </td>
                {r.days.map((d) => {
                  const key = cellKey(weekStart, r.id, d.i);
                  return (
                    <DayCell
                      key={d.i}
                      d={d}
                      codes={effectiveCodes(r, d.i, cellOv, weekStart)}
                      overridden={cellOv.has(key)}
                      onOpen={() => onOpen(r, d.i)}
                      onSet={(codes) => onSetCell(key, codes)}
                    />
                  );
                })}
                <td className="border-l border-line px-3 py-2 text-right align-top">
                  <span
                    className={`font-mono text-sm font-semibold ${over ? 'text-red-700 dark:text-red-400' : 'text-ink900'}`}
                    title={over ? `Over the ${r.capDays}-day cap for this level of care` : undefined}
                  >
                    {adjusted}
                  </span>
                  <span className="font-mono text-xs text-ink400"> / {r.capDays}</span>
                  <div className="font-mono text-[10.5px] text-ink400">{r.totalHours} h</div>
                  {edited && (
                    <div
                      className="text-[10px] font-medium text-[var(--brand-ink)]"
                      title={
                        approx
                          ? 'This row\'s auths span more than one level of care, so the server applies a per-day cap the browser does not reproduce. Treat this as indicative until it is recomputed server-side.'
                          : `Recounted from the overridden cells (was ${r.billableDays})`
                      }
                    >
                      adjusted{approx ? ' ≈' : ''}
                    </div>
                  )}
                </td>
                <td className="border-l border-line px-3 py-2 align-top">
                  {/* Session-local: cannot be derived from an export, and does not persist yet. */}
                  <label className="sr-only" htmlFor={`ws-${r.id}`}>
                    Week status
                  </label>
                  <select
                    id={`ws-${r.id}`}
                    value={statusOv.get(statusKey(weekStart, r.id)) ?? ''}
                    onChange={(e) =>
                      onSetStatus(statusKey(weekStart, r.id), (e.target.value || null) as WeekStatus | null)
                    }
                    title="Billing workflow state — set by hand, not saved"
                    className="rounded-md border border-line bg-card px-1.5 py-0.5 text-xs text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">—</option>
                    {WEEK_STATUSES.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
