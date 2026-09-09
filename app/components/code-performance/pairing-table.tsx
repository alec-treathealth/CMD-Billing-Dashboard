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
 */
import { useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
}) {
  const sorted = useMemo(() => sortPairingRows(rows, sort), [rows, sort]);
  const dimYield = immatureWindow;
  const sortProps = (key: PairingSortKey) => ({
    sortKey: key,
    active: sort.key === key,
    direction: sort.direction,
    onSort: (k: string) => onSort(k as PairingSortKey),
  });

  return (
    <LocalTable label="Billing-code pairings">
      <thead>
        <tr>
          <LTh>
            <span className="sr-only">Expand</span>
          </LTh>
          <LTh>Procedure code</LTh>
          <LTh>Revenue code</LTh>
          <LTh align="right" {...sortProps('charges')}>Charges</LTh>
          <LTh align="right" {...sortProps('billed')}>Billed</LTh>
          <LTh align="right" {...sortProps('collected')}>Collected</LTh>
          <LTh dim={dimYield} {...sortProps('allowed_rate')} sub="reliable allowed ÷ billed · coverage beside it">
            Allowed rate
          </LTh>
          <LTh align="right" dim={dimYield} {...sortProps('paid_of_allowed')} sub="not clamped — over 100% is exposure">
            Paid of allowed
          </LTh>
          <LTh align="right" dim={dimYield} {...sortProps('underpaid_dollars')} sub="allowed − paid, posted charges">
            Underpaid
          </LTh>
          <LTh align="right" {...sortProps('days_p50')} sub="charge → LAST posting · p50 / p90">
            Days to money
          </LTh>
          <LTh align="right" {...sortProps('pct_zero_paid')} sub="signal, not a denial rate">
            Zero-paid
          </LTh>
          <LTh
            align="right"
            dim={dimYield}
            sub={
              summary.write_off_rate.state === 'suppressed' ? (
                <SuppressionReason metric={summary.write_off_rate} />
              ) : (
                'adjustments ÷ billed'
              )
            }
          >
            Write-off rate
          </LTh>
          <LTh align="right" {...sortProps('payer_concentration')} sub="top payer share of billed">
            Payer conc.
          </LTh>
          <LTh align="right" {...sortProps('facility_spread')} sub="allowed-rate max − min, ≥30 charges">
            Facility spread
          </LTh>
          <LTh>Flags</LTh>
          <LTh align="right" {...sortProps('days_idle')} sub="since last charge">
            Idle
          </LTh>
          <LTh
            align="right"
            dim={dimYield}
            sub={
              summary.patient_balance_rate.state === 'suppressed' ? (
                <SuppressionReason metric={summary.patient_balance_rate} />
              ) : (
                'outstanding as of today · share of billed · AR aging'
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
            <td colSpan={17} className="px-3 py-8 text-center text-sm text-ink600">
              No charges in this window for the selected facilities.
            </td>
          </tr>
        )}
        {sorted.map((r) => {
          const key = pairKeyOf(r);
          const open = expandedKey === key;
          const rowDim = dimYield || r.flags.includes('immature_window');
          return (
            <tr key={key} className={open ? 'bg-teal50/30' : 'hover:bg-teal50/20'} data-pair={key}>
              <LTd>
                <button
                  type="button"
                  onClick={() => onToggle(key)}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} drill-down for ${r.hcpcs ?? 'no procedure code'} × ${r.revcode ?? 'no revenue code'}`}
                  className="inline-flex h-11 w-11 items-center justify-center rounded text-teal700 hover:bg-teal50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal500"
                >
                  {open ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
                </button>
              </LTd>
              <LTd>
                <CodeSlot kind="procedure" code={r.hcpcs} suffix={r.loc_suffix} descriptions={descriptions} />
              </LTd>
              <LTd>
                <CodeSlot kind="revenue" code={r.revcode} descriptions={descriptions} />
              </LTd>
              <LTd align="right" num>{cell('charges', fmtInt(r.charges))}</LTd>
              <LTd align="right" num>{cell('billed', fmtMoney(r.billed))}</LTd>
              <LTd align="right" num>{cell('collected', fmtMoney(r.collected))}</LTd>
              <LTd dim={rowDim} className="min-w-[13rem]">
                <div className="flex items-center gap-2">
                  <div className="w-24 shrink-0"><MiniBar pct={r.allowed_rate} /></div>
                  <span className="ths-num whitespace-nowrap tabular-nums">{fmtPct(r.allowed_rate, 2)}</span>
                </div>
                <div className="ths-num mt-0.5 whitespace-nowrap text-xs tabular-nums text-ink600" data-coverage>
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
              <LTd align="right" num>{cell('payer_concentration', fmtPct(r.payer_concentration, 1))}</LTd>
              <LTd align="right" num>
                {r.facility_spread === null ? (
                  <span className="text-ink400" title="Fewer than two facilities with 30+ charges in this pairing">—</span>
                ) : (
                  `${r.facility_spread.toFixed(1)} pts`
                )}
              </LTd>
              <LTd><FlagPills flags={r.flags} /></LTd>
              <LTd align="right" num>{fmtDays(r.days_idle)}</LTd>
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
