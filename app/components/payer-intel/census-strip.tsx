'use client';

/**
 * Census & incoming — the IDLE-state facility strip. Every value carries the as-of stamp in
 * Pacific time (the strip header; per-row deviations render their own stamp only when they
 * differ). Data honesty rules, enforced here so no renderer can misread the sentinels:
 *   · outpatient rows have NO bed semantics — openBeds/bedCapacity/occupancy render '—', never 0
 *     or "full" (the 0078 contract; the core already nulls them);
 *   · `pendingAdmits` is a typed seam that is ALWAYS null in v1 (the Monday aggregation drops
 *     non-admitted statuses before anything is stored) — it renders '—' with a title saying so,
 *     and the pipeline-dependent status pills ('Beds, no pipeline' / 'Thin pipeline' /
 *     'Spoken for') stay dark until that column ships. Only the capacity-derivable pills render.
 */
import type { PayerIntelCensusRow } from '../../lib/payer-intel/contract';
import { EM_DASH, fmtInt, fmtPstTime } from './format';

function StatusPill({ row }: { row: PayerIntelCensusRow }) {
  if (row.boardFamily === 'outpatient') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFF1F0] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#5F6D6C]">
        <span className="h-1 w-1 rounded-full bg-[#5F6D6C]" />
        OP caseload
      </span>
    );
  }
  if (row.status === 'full') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFF1F0] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#5F6D6C]">
        <span className="h-1 w-1 rounded-full bg-[#5F6D6C]" />
        Full
      </span>
    );
  }
  if (row.status === 'open') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E5F2ED] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#287860]">
        <span className="h-1 w-1 rounded-full bg-[#287860]" />
        Open beds
      </span>
    );
  }
  return <span className="text-xs text-ink400">{EM_DASH}</span>;
}

export function PayerIntelCensusStrip({
  rows,
  syncedAt,
}: {
  rows: readonly PayerIntelCensusRow[];
  syncedAt: string | null;
}) {
  return (
    <section aria-label="Census and incoming" data-pi-section="census">
      <div className="mb-2 flex items-baseline gap-2.5 px-0.5">
        <h2 className="font-head text-[17px] font-medium tracking-tight text-ink900">Census &amp; incoming</h2>
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink400">
          live from admissions boards · {fmtPstTime(syncedAt)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink400">
          No census rows yet — the hourly admissions-board sync has not written for any facility.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-ths-sm">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-teal50 text-left text-[10px] font-semibold uppercase tracking-wide text-ink600">
                <th className="px-4 py-2">Facility</th>
                <th className="px-4 py-2 text-right">Open beds</th>
                <th className="px-4 py-2 text-right" title="Not yet fed by the admissions boards — pending statuses are not stored">
                  Pending admits
                </th>
                <th className="px-4 py-2 text-right">Occupancy</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.facilityCode} className="border-t border-line hover:bg-teal50">
                  <td className="px-4 py-2 font-semibold text-ink900">{r.facilityName}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {r.boardFamily === 'outpatient' ? EM_DASH : fmtInt(r.openBeds)}
                  </td>
                  <td
                    className="px-4 py-2 text-right font-mono tabular-nums text-ink400"
                    title="Pending admits are not stored by the census sync yet"
                  >
                    {r.pendingAdmits !== null ? fmtInt(r.pendingAdmits) : EM_DASH}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {r.occupancyPct !== null ? `${r.occupancyPct}%` : EM_DASH}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
