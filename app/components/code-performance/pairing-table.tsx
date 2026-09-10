'use client';

/**
 * The pairing table — one row per (procedure code, level-of-care suffix, revenue code), billed desc by
 * default, sortable client-side over an ALLOWLIST of numeric keys (nothing user-controlled reaches
 * SQL). The correctness requirements that live here rather than in styling:
 *   · allowed_coverage renders IN THE SAME CELL as allowed_rate — below 60% the rate is noise;
 *   · paid_of_allowed is NEVER clamped — over 100% is the signal;
 *   · suppressed metrics render as a visible state with the reason in the header;
 *   · the maturity guard DIMS the yield columns (header + cells) when the window is immature;
 *   · patient_balance_rate sits at the far right, apart from allowed_rate — it is AR aging.
 *
 * ── DENSITY (2026-09-09) ─────────────────────────────────────────────────────────────────────────
 * Sixteen columns is an analyst's instrument, and this route is read by executives who want the
 * money line first. So the table opens COMPACT — twelve columns, the volume/yield/velocity spine —
 * and a toggle restores the four analytical ones (payer concentration, facility spread, flags,
 * idle). Nothing is removed from the data or the drill-down; the toggle changes what is on screen.
 *
 * ⚠️ PATIENT BALANCE STAYS THE LAST COLUMN IN BOTH DENSITIES, and there must remain a real distance
 * between it and allowed rate. It is AR aging that decays as patients pay; parked next to a yield
 * ratio it reads as one, which is the misreading the original layout was built to prevent. The
 * render suite asserts both the last-column position and the separation, in the default density.
 *
 * ⚠️ THE EXPAND CONTROL LIVES IN THE CODE CELL, not its own column. It used to be a 17th column
 * whose only content was a chevron; folding it into the identity cell buys ~44px, removes a column
 * from every horizontal scroll, and lets ONE cell be the sticky left edge — a two-column sticky
 * region needs a hard-coded pixel offset for the second, which silently breaks the moment a code
 * description wraps to a different width.
 */
import { useMemo } from 'react';
import { ChevronDown, ChevronRight, Columns3, PanelRight } from 'lucide-react';

import { MiniBar } from '@/components/dashboard/widgets';
import { displayCell } from '@/lib/phi';
import type { CodeDescriptionMap, CodePerfPairingRow, CodePerfSummary } from '@/lib/code-performance/contract';

import { CodeSlot } from './code-slot';
import { FlagPills } from './flags';
import { fmtDays, fmtInt, fmtMoney, fmtPct } from './format';
import { GatedValue, SuppressionReason } from './gated-metric';
import { LocalTable, LTd, LTh } from './local-table';

export const PAIRING_SORT_KEYS = [
  'billed',
  'charges',
  'collected',
  'allowed_rate',
  'allowed_coverage',
  'paid_of_allowed',
  'underpaid_dollars',
  'days_p50',
  'pct_zero_paid',
  'payer_concentration',
  'facility_spread',
  'days_idle',
] as const;
export type PairingSortKey = (typeof PAIRING_SORT_KEYS)[number];
export interface PairingSort {
  key: PairingSortKey;
  direction: 'asc' | 'desc';
}
export const DEFAULT_PAIRING_SORT: PairingSort = { key: 'billed', direction: 'desc' };

export function pairKeyOf(r: { hcpcs: string | null; loc_suffix: string | null; revcode: string | null }): string {
  return `${r.hcpcs ?? '␀'}|${r.loc_suffix ?? ''}|${r.revcode ?? '␀'}`;
}

/** Stable client-side sort; NULLs last in both directions. Pure — tested. */
export function sortPairingRows(rows: readonly CodePerfPairingRow[], sort: PairingSort): CodePerfPairingRow[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return pairKeyOf(a).localeCompare(pairKeyOf(b));
    return av < bv ? -dir : dir;
  });
}

export function nextSort(current: PairingSort, key: PairingSortKey): PairingSort {
  if (current.key !== key) return { key, direction: 'desc' };
  return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
}

const cell = (column: string, v: unknown): string => displayCell(column, v, false);

export function PairingTable({
  rows,
  descriptions,
  summary,
  immatureWindow,
  sort,
  onSort,
  expandedKey,
  onToggle,
  dense = false,
}: {
  rows: readonly CodePerfPairingRow[];
  descriptions: CodeDescriptionMap;
  /** Carries the tenant's suppression states — identical on every row, so the header says it once. */
  summary: CodePerfSummary;
  immatureWindow: boolean;
  sort: PairingSort;
  onSort: (key: PairingSortKey) => void;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  /** Owned by the view, because the control that sets it is PINNED outside this table's scroller. */
  dense?: boolean;
}) {
  const sorted = useMemo(() => sortPairingRows(rows, sort), [rows, sort]);
  const dimYield = immatureWindow;
  const sortProps = (key: PairingSortKey) => ({
    sortKey: key,
    active: sort.key === key,
    direction: sort.direction,
    onSort: (k: string) => onSort(k as PairingSortKey),
  });
  // 13 compact + 3 analytical. Kept in one place so the header row and the empty-state colSpan
  // cannot drift apart — a mismatched colSpan silently misaligns the "no charges" row.
  const columns = dense ? 16 : 13;

  return (
    <LocalTable label="Billing-code pairings">
        <thead>
          <tr>
            <LTh stick>Code</LTh>
            <LTh>Revenue code</LTh>
            <LTh align="right" {...sortProps('charges')}>Charges</LTh>
            <LTh align="right" {...sortProps('billed')}>Billed</LTh>
            <LTh align="right" {...sortProps('collected')}>Collected</LTh>
            <LTh dim={dimYield} {...sortProps('allowed_rate')} sub="coverage beside it">
              Allowed rate
            </LTh>
            <LTh align="right" dim={dimYield} {...sortProps('paid_of_allowed')} sub="unclamped">
              Paid of allowed
            </LTh>
            <LTh align="right" dim={dimYield} {...sortProps('underpaid_dollars')} sub="allowed − paid">
              Underpaid
            </LTh>
            <LTh align="right" {...sortProps('days_p50')} sub="p50 / p90">
              Days to money
            </LTh>
            <LTh align="right" {...sortProps('pct_zero_paid')} sub="signal, not denials">
              Zero-paid
            </LTh>
            <LTh
              align="right"
              dim={dimYield}
              sub={
                summary.write_off_rate.state === 'suppressed' ? (
                  <SuppressionReason metric={summary.write_off_rate} label="write-off rate" />
                ) : (
                  'adjustments ÷ billed'
                )
              }
            >
              Write-off rate
            </LTh>
            {dense && (
              <>
                <LTh align="right" {...sortProps('payer_concentration')} sub="top payer share">
                  Payer conc.
                </LTh>
                <LTh align="right" {...sortProps('facility_spread')} sub="max − min, ≥30 charges">
                  Facility spread
                </LTh>
                <LTh align="right" {...sortProps('days_idle')} sub="since last charge">
                  Idle
                </LTh>
              </>
            )}
            {/* ⚠️ FLAGS IS NOT OPTIONAL, and the render suite is what says so. It was briefly in the
                analytical group, which hid `paid > allowed` — the one cell on the row that says a
                pairing carries clawback exposure — behind a toggle nobody had clicked. A density
                control may drop columns a reader can re-derive; it may not drop the alarm. */}
            <LTh>Flags</LTh>
            <LTh
              align="right"
              dim={dimYield}
              sub={
                summary.patient_balance_rate.state === 'suppressed' ? (
                  <SuppressionReason metric={summary.patient_balance_rate} label="patient balance" />
                ) : (
                  'AR aging · share of billed'
                )
              }
              title="Outstanding patient balance as of today, share of billed, on charges billed in this window. Decays as patients pay — not comparable to allowed rate."
            >
              Patient balance
            </LTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns} className="px-3 py-8 text-center text-sm text-ink600">
                No charges in this window for the selected facilities.
              </td>
            </tr>
          )}
          {sorted.map((r) => {
            const key = pairKeyOf(r);
            const open = expandedKey === key;
            const rowDim = dimYield || r.flags.includes('immature_window');
            return (
              // `scroll-mt-12` clears the sticky header when the browser scrolls a focused control
              // into view. Without it, Tabbing into a row just below the header parks that control
              // UNDER the pinned header — WCAG 2.2 SC 2.4.11 (focus not obscured). 48px covers the
              // header's ~40px; a string render cannot verify the outcome, only that the rule ships.
              <tr key={key} className={`scroll-mt-12 ${open ? 'bg-teal50/30' : 'hover:bg-teal50/20'}`} data-pair={key}>
                {/* The identity cell IS the expand control's home and the sticky left edge. */}
                {/* rowHeader: this cell NAMES the row, so it is a th[scope=row] — without it a
                    screen reader crossing 13 columns announces each value against its column header
                    and nothing about which pairing it belongs to. */}
                <LTd stick rowHeader className={open ? 'bg-teal50' : ''}>
                  <div className="flex items-start gap-1">
                    {/* ⚠️ 32px, not 24px. This is the row's PRIMARY action on a dense table. 24px is
                        exactly the SC 2.5.8 floor with no margin, and it was 44px before the
                        header-height work took it down as collateral. The rows carry a code
                        description and are already taller than 32px, so this costs no height. */}
                    <button
                      type="button"
                      onClick={() => onToggle(key)}
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} drill-down for ${r.hcpcs ?? 'no procedure code'} × ${r.revcode ?? 'no revenue code'}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-teal700 hover:bg-teal50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                    >
                      {open ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
                    </button>
                    <CodeSlot kind="procedure" code={r.hcpcs} suffix={r.loc_suffix} descriptions={descriptions} />
                  </div>
                </LTd>
                <LTd>
                  <CodeSlot kind="revenue" code={r.revcode} descriptions={descriptions} />
                </LTd>
                <LTd align="right" num>{cell('charges', fmtInt(r.charges))}</LTd>
                <LTd align="right" num>{cell('billed', fmtMoney(r.billed))}</LTd>
                <LTd align="right" num>{cell('collected', fmtMoney(r.collected))}</LTd>
                <LTd dim={rowDim} className="min-w-[11rem]">
                  <div className="flex items-center gap-2">
                    <div className="w-16 shrink-0"><MiniBar pct={r.allowed_rate} /></div>
                    <span className="ths-num whitespace-nowrap tabular-nums">{fmtPct(r.allowed_rate, 2)}</span>
                  </div>
                  <div className="ths-num mt-0.5 whitespace-nowrap text-[10px] tabular-nums text-ink600" data-coverage>
                    coverage {fmtPct(r.allowed_coverage, 1)}
                    {r.allowed_coverage !== null && r.allowed_coverage < 60 ? ' · rate is noise' : ''}
                  </div>
                </LTd>
                <LTd align="right" num dim={rowDim} className={r.paid_of_allowed !== null && r.paid_of_allowed > 100 ? 'font-semibold text-status-danger' : ''}>
                  {cell('paid_of_allowed', fmtPct(r.paid_of_allowed, 2))}
                </LTd>
                <LTd align="right" num dim={rowDim}>{cell('underpaid_dollars', fmtMoney(r.underpaid_dollars))}</LTd>
                <LTd align="right" num>
                  {fmtDays(r.days_p50)} <span className="text-ink400">/ {fmtDays(r.days_p90)}</span>
                </LTd>
                <LTd align="right" num>{cell('pct_zero_paid', fmtPct(r.pct_zero_paid, 1))}</LTd>
                <LTd align="right" num dim={rowDim}>
                  <GatedValue metric={r.write_off_rate} format={(v) => fmtPct(v, 2)} />
                </LTd>
                {dense && (
                  <>
                    <LTd align="right" num>{cell('payer_concentration', fmtPct(r.payer_concentration, 1))}</LTd>
                    <LTd align="right" num>
                      {r.facility_spread === null ? (
                        <span className="text-ink400" title="Fewer than two facilities with 30+ charges in this pairing">—</span>
                      ) : (
                        `${r.facility_spread.toFixed(1)} pts`
                      )}
                    </LTd>
                    <LTd align="right" num>{fmtDays(r.days_idle)}</LTd>
                  </>
                )}
                <LTd><FlagPills flags={r.flags} /></LTd>
                <LTd align="right" num dim={rowDim}>
                  <GatedValue metric={r.patient_balance_rate} format={(v) => fmtPct(v, 2)} />
                </LTd>
              </tr>
            );
          })}
        </tbody>
    </LocalTable>
  );
}

/**
 * The table's toolbar — row count, active sort, and the density control.
 *
 * ⚠️ IT IS RENDERED BY THE VIEW, PINNED, AND NOT BY THE TABLE (2026-09-10). It used to sit inside
 * the same box as the table, which put it inside the HORIZONTAL scroller: a `justify-between` row
 * inside a `w-max` content box right-aligns against the TABLE's width, not the viewport's, so the
 * "All columns" button lived off-screen and slid past as the reader scrolled sideways looking for it.
 * Pinned above the scroller it stays where it was reached for. That is also why `dense` is the view's
 * state — the control and the table it governs are now in different boxes.
 */
export function PairingToolbar({
  count,
  sort,
  dense,
  onDenseChange,
  chartsOpen,
  onChartsChange,
}: {
  count: number;
  sort: PairingSort;
  dense: boolean;
  onDenseChange: (next: boolean) => void;
  /** Omit both to hide the sidebar control — the table renders standalone in tests. */
  chartsOpen?: boolean;
  onChartsChange?: (next: boolean) => void;
}) {
  const btn =
    'inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink600 transition-colors hover:bg-teal50 hover:text-teal900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500';
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-ink600">
        {fmtInt(count)} pairing{count === 1 ? '' : 's'} · sorted by {sort.key.replace(/_/g, ' ')}{' '}
        {sort.direction === 'desc' ? 'high to low' : 'low to high'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* ⚠️ THE TWO LAYOUT CONTROLS SIT TOGETHER, and the sidebar one exists because the sidebar
            COSTS the table 21rem. Thirteen columns want about 1900px; a 1680px window minus the
            sidebar leaves roughly 1260, so more of the table sits off-screen than before the charts
            moved. Rather than choose for the reader, both levers are here: drop the analytical
            columns, or reclaim the sidebar's width. Neither hides data — the charts are derived from
            what the table already shows. */}
        {onChartsChange !== undefined && (
          <button
            type="button"
            aria-expanded={chartsOpen ?? true}
            aria-controls="cp-charts"
            onClick={() => onChartsChange(!(chartsOpen ?? true))}
            className={btn}
          >
            <PanelRight aria-hidden className="h-3.5 w-3.5" />
            {chartsOpen ?? true ? 'Hide charts' : 'Show charts'}
          </button>
        )}
        <button type="button" aria-pressed={dense} onClick={() => onDenseChange(!dense)} className={btn}>
          <Columns3 aria-hidden className="h-3.5 w-3.5" />
          {dense ? 'Fewer columns' : 'All columns'}
        </button>
      </div>
    </div>
  );
}
