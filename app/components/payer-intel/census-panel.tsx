'use client';

/**
 * Census & incoming — a SIDE PANEL (Alec, 2026-08-17 second review: "if the Census can be put on
 * the side as a side panel, that would be better use of fitting the page"). It supersedes the
 * full-width strip that preceded it, which in turn superseded the mock's full table; both earlier
 * shapes ate the fold.
 *
 * The panel is a narrow vertical column that rides BOTH view states in the page's right rail:
 *   · an always-visible summary line (open beds · residential count · full count);
 *   · the RESIDENTIAL list inline — that is the bed decision, so it should not be behind a click.
 *     Capped at ~15 rows of height and scrolled, which is a plain always-on scrollport (never a
 *     breakpoint-gated max-height — see the inert-scrollport trap: a max-h that only exists above
 *     a breakpoint silently stops being a scroller below it);
 *   · the OUTPATIENT caseloads behind an accessible disclosure (button + aria-expanded +
 *     aria-controls, `hidden` rather than CSS-hidden-but-focusable) — they carry no bed semantics,
 *     so they are reference, not decision.
 *
 * Data honesty rules, enforced here so no renderer can misread the sentinels:
 *   · outpatient rows have NO bed semantics — openBeds/bedCapacity/occupancy render '—', never 0
 *     or "full" (the 0078 contract; the core already nulls them);
 *   · `pendingAdmits` is a typed seam that is ALWAYS null in v1 (the Monday aggregation drops
 *     non-admitted statuses before anything is stored) — the panel omits the column entirely
 *     rather than printing a column of em dashes in 320px of width.
 */
import { useId, useState } from 'react';
import type { PayerIntelCensusRow } from '../../lib/payer-intel/contract';
import { EM_DASH, fmtInt, fmtPstTime } from './format';

/** One residential row: name · open beds · occupancy. Full rows read as a muted pill, not a number
 *  the eye has to compare against capacity. */
function BedRow({ row }: { row: PayerIntelCensusRow }) {
  const full = row.status === 'full';
  return (
    <li className="flex items-baseline gap-2 border-t border-line px-3 py-1.5 first:border-t-0">
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink900" title={row.facilityName}>
        {row.facilityName}
      </span>
      {full ? (
        <span className="rounded-full bg-[#EFF1F0] px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-[#5F6D6C]">
          Full
        </span>
      ) : (
        <span className="whitespace-nowrap font-mono text-xs font-semibold text-teal700 tabular-nums">
          {fmtInt(row.openBeds)} open
        </span>
      )}
      <span className="w-9 whitespace-nowrap text-right font-mono text-[11px] text-ink400 tabular-nums">
        {row.occupancyPct !== null ? `${row.occupancyPct}%` : EM_DASH}
      </span>
    </li>
  );
}

export function PayerIntelCensusPanel({
  rows,
  syncedAt,
  defaultOpen = false,
}: {
  rows: readonly PayerIntelCensusRow[];
  syncedAt: string | null;
  /** Start with the outpatient caseloads expanded. Default closed — beds are the decision. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const residential = rows.filter((r) => r.boardFamily === 'residential');
  const outpatient = rows.filter((r) => r.boardFamily !== 'residential');
  const openBeds = residential.reduce((sum, r) => sum + (r.openBeds ?? 0), 0);
  const fullCount = residential.filter((r) => r.status === 'full').length;

  return (
    <section
      aria-label="Census and incoming"
      data-pi-section="census"
      className="rounded-md border border-line bg-surface shadow-ths-sm"
    >
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="font-head text-[14px] font-semibold tracking-tight text-ink900">Census &amp; incoming</h2>
          <span className="flex-1" />
          <span className="whitespace-nowrap font-mono text-[9.5px] font-medium uppercase tracking-wider text-ink400">
            live · {fmtPstTime(syncedAt)}
          </span>
        </div>
        {rows.length > 0 ? (
          <p className="mt-1 text-[12.5px] leading-snug text-ink600">
            <span className="font-semibold text-ink900">{fmtInt(openBeds)} open beds</span> across{' '}
            {residential.length} residential
            {fullCount > 0 ? (
              <>
                {' · '}
                <span className="font-semibold text-ink900">{fullCount} full</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-[12.5px] text-ink400">
          No census rows yet — the hourly admissions-board sync has not written for any facility.
        </p>
      ) : (
        <>
          {/* ALWAYS-ON scrollport (no breakpoint gate) so the cap behaves identically at every
              width; ~15 rows before it scrolls, which fits today's 12 residential boards without
              scrolling at all and still bounds the panel if the roster grows. */}
          <ul className="max-h-[430px] overflow-y-auto">
            {residential.map((r) => (
              <BedRow key={r.facilityCode} row={r} />
            ))}
          </ul>
          {outpatient.length > 0 ? (
            <div className="border-t border-line">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen(!open)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] font-semibold text-teal700 hover:bg-teal50 hover:text-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
              >
                <span aria-hidden>{open ? '▾' : '▸'}</span>
                {outpatient.length} outpatient caseloads
              </button>
              <ul id={listId} hidden={!open} className="max-h-[240px] overflow-y-auto pb-1">
                {outpatient.map((r) => (
                  <li
                    key={r.facilityCode}
                    className="flex items-baseline gap-2 border-t border-line px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink900" title={r.facilityName}>
                      {r.facilityName}
                    </span>
                    {/* Beds do not apply to an OP caseload — the census count is the caseload. */}
                    <span className="whitespace-nowrap font-mono text-[11px] text-ink600 tabular-nums">
                      {r.admittedCount !== null ? `${fmtInt(r.admittedCount)} active` : EM_DASH}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
