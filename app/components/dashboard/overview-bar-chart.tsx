'use client';

/**
 * Master BXR Chart — the merged Overview bar chart. Replaces the two former
 * standalone widgets (Collections MTD/YTD by facility + Payers paid vs. collection
 * gap) with one widget driven by two dropdowns:
 *
 *  • View  — "By Facility" (MTD/YTD facility bars) or "By Payer" (paid vs. gap bars).
 *  • Month — "June (MTD)" (the current 2026 month) plus every prior 2026 month
 *            with data (May…January), reverse-chron. 2026 only.
 *
 * The chart rendering itself reuses the exact recharts bodies, tooltips, legends,
 * and color tokens from the originals (FacilityKpiBars / PayerGapBars), so there
 * is no visual regression. Data scoping per selection:
 *
 *  • Facility · MTD  → cached loadCollectionsKpis() (stacked MTD + YTD bars).
 *  • Facility · past → loadCollectionsDailyRange({year,month}) aggregated to a
 *                      single gross bar per facility (tooltip: Gross/Checks/EFT).
 *  • Payer · any month → month-scoped for EVERY month incl. the current one:
 *                        loadCmdPayerMonth(year,month) reads that month's CMD
 *                        rollup (with per-facility drill-down). When the rollup
 *                        has no rows for the month, it falls back to
 *                        loadPayerGapRange({from:'2026-MM-01', to:'2026-MM-DD'})
 *                        so the view never breaks (no facility breakdown then).
 *
 * Aggregate, non-PHI: reads only collections (daily_collections + facilities) and
 * the payer_gap summary. No patient data, no rows.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { CalendarClock, Download, Filter, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect } from '@/components/data-grid';
import { PayerGapBars, payerChartRows } from '@/components/payer-chart';
import { money, moneyAxis } from '@/lib/format';
import {
  loadCmdPayerMonth,
  loadCollectionsDaily,
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadFacilityDimension,
  loadPayerGapRange,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type FacilityDimensionRow,
  type PayerGapSummary,
} from '@/lib/actions';
import { facilityLabel } from '../../../src/collections/summaryTypes';
import type { CmdPayerFacilityRow } from '../../../src/collections/cmdPayerRollup';
import { CHART_COLORS, FacilityKpiBars, kpiChartRows, LegendSwatch } from './collections';
import { MiniBar, useWidget, WidgetCard } from './widgets';
import { type DashboardView, viewToEntityIds } from '@/lib/views';

/** The chart card title per view (so an Indigo/Consolidated view isn't mislabeled "BXR"). */
function chartTitleFor(view: DashboardView): string {
  switch (view) {
    case 'bxr':
      return 'Master BXR Chart';
    case 'indigo':
      return 'Master Indigo Chart';
    case 'consolidated':
      return 'Master Chart (Consolidated)';
  }
}

type DailyRow = CollectionsDailyResult['rows'][number];

const YEAR = 2026;
const PAYER_TOP_N = 10; // matches the former PayerChartWidget defaultTopN={10}
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

type View = 'facility' | 'payer';
/** By Facility care-setting filter: all facilities, inpatient only, or outpatient only. */
type CareFilter = 'ALL' | 'IP' | 'OP';

/** A single-month gross row per facility (past-month facility view). */
interface FacilityGrossRow {
  facility: string;
  /** Real facility code (drill-down key + IP/OP dimension join), or null if unassigned. */
  facility_code: string | null;
  blank: boolean;
  gross: number;
  checks: number;
  eft: number;
}

/** Aggregate a month's daily rows into one gross/checks/eft total per facility. */
function aggregateGrossByFacility(rows: CollectionsDailyResult['rows']): FacilityGrossRow[] {
  const byFacility = new Map<string, FacilityGrossRow>();
  for (const r of rows) {
    const key = r.facility_code ?? '__unassigned__';
    const existing = byFacility.get(key);
    if (existing) {
      existing.gross += r.gross_amount;
      existing.checks += r.checks_amount;
      existing.eft += r.eft_amount;
    } else {
      byFacility.set(key, {
        facility: facilityLabel(r),
        facility_code: r.facility_code,
        blank: r.facility_name === null,
        gross: r.gross_amount,
        checks: r.checks_amount,
        eft: r.eft_amount,
      });
    }
  }
  return [...byFacility.values()].sort((a, b) => b.gross - a.gross);
}

function FacilityGrossTooltip({
  active,
  payload,
  monthLabel = '',
}: {
  active?: boolean;
  payload?: { payload: FacilityGrossRow }[];
  /** Prefix for the row labels (the selected month name, e.g. 'May'). */
  monthLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  const prefix = monthLabel ? `${monthLabel} ` : '';
  // gross = checks + eft (verified). The bar splits gross into Checks + EFT; Gross
  // is shown last as the summary total (the bar length), not a stacked segment.
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-ths">
      <div className="mb-1 font-semibold text-ink900">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">{prefix}Checks</dt>
        <dd className="text-right text-ink900">{money(r.checks)}</dd>
        <dt className="text-muted-foreground">{prefix}EFT</dt>
        <dd className="text-right text-ink900">{money(r.eft)}</dd>
        <dt className="text-muted-foreground">{prefix}Gross</dt>
        <dd className="text-right text-[var(--brand-ink)]">{money(r.gross)}</dd>
      </dl>
    </div>
  );
}

/**
 * Per-facility payment-type bars (past-month facility view). Month gross splits
 * into its two payment types — Checks + EFT (verified identity: gross = checks +
 * eft) — as two non-overlapping segments summing to month gross (the bar length).
 * Reuses the same axes and money formatters as the MTD chart.
 */
function FacilityGrossBars({
  rows,
  monthLabel,
  onBarClick,
}: {
  rows: FacilityGrossRow[];
  /** Selected month name (e.g. 'May'), used as the tooltip label prefix. */
  monthLabel: string;
  /** Optional: invoked with the clicked bar's facility_code (drill-down key). */
  onBarClick?: (facilityCode: string) => void;
}) {
  return (
    <>
      {/* Vertical bars (facility on X, money on Y), spread to the full container width. */}
      <div
        role="img"
        aria-label="Collections gross by facility"
        style={{ width: '100%', height: 380, cursor: onBarClick ? 'pointer' : undefined }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 64, left: 8 }}
            barCategoryGap="18%"
            onClick={(state) => {
              const code = (state?.activePayload?.[0]?.payload as FacilityGrossRow | undefined)?.facility_code;
              if (onBarClick && typeof code === 'string') onBarClick(code);
            }}
          >
            <CartesianGrid vertical={false} stroke="#E4E9E6" />
            <XAxis
              type="category"
              dataKey="facility"
              interval={0}
              angle={-35}
              textAnchor="end"
              height={64}
              tick={{ fontSize: 10, fill: '#4A5C5A' }}
              stroke="#E4E9E6"
            />
            <YAxis
              type="number"
              tickFormatter={moneyAxis}
              width={64}
              tick={{ fontSize: 11, fill: '#859794' }}
              stroke="#E4E9E6"
            />
            <Tooltip content={<FacilityGrossTooltip monthLabel={monthLabel} />} cursor={{ fill: 'rgba(28,139,130,0.06)' }} />
            {/* Stacked bottom→top: Checks → EFT = month gross (bar height). */}
            <Bar dataKey="checks" stackId="gross" name={`${monthLabel} Checks`} fill={CHART_COLORS.checks} radius={[0, 0, 0, 0]} />
            <Bar dataKey="eft" stackId="gross" name={`${monthLabel} EFT`} fill={CHART_COLORS.eft} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <LegendSwatch color={CHART_COLORS.checks} label={`${monthLabel} Checks`} />
        <LegendSwatch color={CHART_COLORS.eft} label={`${monthLabel} EFT`} />
        <span className="ml-auto">Bar height = month gross.</span>
      </div>
    </>
  );
}

/** Async state for the past-month fetch (skipped entirely for the MTD option). */
type PastState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'facility'; rows: FacilityGrossRow[]; daily: DailyRow[] }
  | { kind: 'payer'; summary: PayerGapSummary; byFacility: CmdPayerFacilityRow[] };

/** 'YYYY-MM-DD' → 'MM/DD/YYYY' for the drill-down table (matches the source grid). */
function formatMmDdYyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** CSV-escape a field (quote when it contains a comma, quote, or newline). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Trigger a client-side CSV download (no server round-trip). BOM-prefixed so
 * Excel reads it as UTF-8; href is a data: URI built from encodeURIComponent.
 */
function downloadCsv(filename: string, table: string[][]): void {
  const BOM = '\uFEFF'; // UTF-8 byte-order mark so Excel detects UTF-8
  const csv = table.map((cols) => cols.map(csvField).join(',')).join('\r\n');
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(BOM + csv)}`;
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Drill-down: the daily distribution for one facility in the selected month.
 * Renders an inline panel (card) below the chart with a Date/Checks/EFT/Gross
 * table + a bold totals row. `rows` are the already-in-memory daily rows for the
 * month; we filter them to `facilityLabel` client-side (no new fetch). Aggregate,
 * non-PHI (daily_collections only).
 */
function FacilityDailyPanel({
  facilityCode,
  facilityName,
  monthLabel,
  rows,
  onClose,
}: {
  /** Drill-down key (the clicked bar's facility_code). */
  facilityCode: string;
  /** Display name/acronym for the panel heading. */
  facilityName: string;
  monthLabel: string;
  rows: DailyRow[];
  onClose: () => void;
}) {
  const facilityRows = useMemo(
    () =>
      rows
        .filter((r) => r.facility_code === facilityCode)
        .filter((r) => r.gross_amount !== 0 || r.checks_amount !== 0 || r.eft_amount !== 0)
        .sort((a, b) => a.payment_date.localeCompare(b.payment_date)),
    [rows, facilityCode],
  );

  const totals = useMemo(
    () =>
      facilityRows.reduce(
        (acc, r) => ({
          checks: acc.checks + r.checks_amount,
          eft: acc.eft + r.eft_amount,
          gross: acc.gross + r.gross_amount,
        }),
        { checks: 0, eft: 0, gross: 0 },
      ),
    [facilityRows],
  );

  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink900">
          {facilityName} — {monthLabel}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close daily distribution"
          className="text-ink600"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {facilityRows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No data for this facility in {monthLabel}.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Checks</TableHead>
              <TableHead className="text-right">EFT</TableHead>
              <TableHead className="text-right">Gross</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {facilityRows.map((r) => (
              <TableRow key={r.payment_date}>
                <TableCell className="tabular-nums">{formatMmDdYyyy(r.payment_date)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.checks_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.eft_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.gross_amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>TOTALS</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.checks)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.eft)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.gross)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * Drill-down: the per-facility breakdown for one payer in the selected month.
 * Mirrors FacilityDailyPanel — an inline card below the chart with a
 * Facility/Charged/Allowed/Paid/Gap table + a bold totals row. `rows` are the
 * already-in-memory per-facility rows for the month; we filter them to the clicked
 * payer client-side (no new fetch). Aggregate, non-PHI (CMD rollup only).
 */
function PayerFacilityPanel({
  payer,
  monthLabel,
  rows,
  onClose,
}: {
  payer: string;
  monthLabel: string;
  rows: CmdPayerFacilityRow[];
  onClose: () => void;
}) {
  // Match the bar's displayed payer label: payerChartRows renders a null payer as
  // '(blank)', so the clicked label compares against the same fallback here.
  const payerRows = useMemo(
    () =>
      rows
        .filter((r) => (r.payer_name ?? '(blank)') === payer)
        .filter((r) => r.total_charge !== 0 || r.total_allowed !== 0 || r.total_paid !== 0)
        .sort((a, b) => b.total_charge - a.total_charge),
    [rows, payer],
  );

  const totals = useMemo(
    () =>
      payerRows.reduce(
        (acc, r) => ({
          charge: acc.charge + r.total_charge,
          allowed: acc.allowed + r.total_allowed,
          paid: acc.paid + r.total_paid,
          gap: acc.gap + r.total_collection_gap,
        }),
        { charge: 0, allowed: 0, paid: 0, gap: 0 },
      ),
    [payerRows],
  );

  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink900">
          {payer} — {monthLabel}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close facility breakdown"
          className="text-ink600"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {payerRows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No facility breakdown for this payer in {monthLabel}.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Facility</TableHead>
              <TableHead className="text-right">Charged</TableHead>
              <TableHead className="text-right">Allowed</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Gap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payerRows.map((r) => (
              <TableRow key={r.facility_name ?? '(unassigned)'}>
                <TableCell>{r.facility_name ?? '(unassigned)'}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_charge)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_allowed)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_paid)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_collection_gap)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>TOTALS</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.charge)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.allowed)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.paid)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(totals.gap)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * Per-payer breakdown table for the By Payer view — the richer field set from
 * /dashboard/payers (Charged / Allowed / Paid / Collection gap per payer, BCBS-TX
 * style), month-scoped to the chart's selected month. Accompanies the bars (it does
 * not replace them): the bars give at-a-glance shape, this gives the full numbers.
 * Clicking a payer row opens the SAME per-facility drill-down a bar click does, so
 * the row label matches the bar's '(blank)' fallback. Aggregate, non-PHI.
 */
function PayerBreakdownTable({
  summary,
  monthLabel,
  selectedPayer,
  onPayerClick,
}: {
  summary: PayerGapSummary;
  monthLabel: string;
  selectedPayer: string | null;
  onPayerClick: (payer: string) => void;
}) {
  const rows = useMemo(
    () => [...summary.by_payer].sort((a, b) => b.total_charge - a.total_charge),
    [summary],
  );
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          charge: acc.charge + r.total_charge,
          allowed: acc.allowed + r.total_allowed,
          paid: acc.paid + r.total_paid,
          gap: acc.gap + r.total_collection_gap,
        }),
        { charge: 0, allowed: 0, paid: 0, gap: 0 },
      ),
    [rows],
  );

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
      <h3 className="text-sm font-semibold text-ink900">Payer breakdown — {monthLabel}</h3>
      <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
        Charged / Allowed / Paid / Collection gap per payer. Click a payer for its per-facility breakdown.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Payer</TableHead>
            <TableHead className="text-right">Charged</TableHead>
            <TableHead className="text-right">Allowed</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Collection Gap</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const label = r.payer_name ?? '(blank)';
            const gapPct = r.total_charge > 0 ? (r.total_collection_gap / r.total_charge) * 100 : 0;
            const active = selectedPayer === label;
            return (
              <TableRow
                key={`${label}-${i}`}
                onClick={() => onPayerClick(label)}
                className={`cursor-pointer ${active ? 'bg-[var(--brand-soft)]' : 'hover:bg-[var(--brand-soft)]'}`}
              >
                <TableCell>
                  {r.payer_name ?? <span className="text-muted-foreground">(blank)</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_charge)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_allowed)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.total_paid)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular-nums">{money(r.total_collection_gap)}</span>
                    <span className="w-14 shrink-0">
                      <MiniBar pct={gapPct} />
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          <TableRow className="border-t-2 font-semibold">
            <TableCell>TOTALS</TableCell>
            <TableCell className="text-right tabular-nums">{money(totals.charge)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(totals.allowed)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(totals.paid)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(totals.gap)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function ChartLoading() {
  return <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>;
}

function ChartError() {
  return (
    <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
      That selection could not be loaded.
    </div>
  );
}

/**
 * Designed empty state. Two flavors so "no data yet" never reads the same as "your filter hid
 * everything": `pending` (a clock — data hasn't posted; optional CTA to jump back to the latest
 * month) vs `filtered` (a funnel — loosen/reset the filter). Brand-tokened, non-PHI.
 */
function ChartEmpty({
  title,
  subtitle,
  variant = 'pending',
  action,
}: {
  title: string;
  subtitle?: string;
  variant?: 'pending' | 'filtered';
  action?: { label: string; onClick: () => void };
}) {
  const Icon = variant === 'filtered' ? Filter : CalendarClock;
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand-ink)]">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="text-sm font-semibold text-ink900">{title}</div>
      {subtitle && <p className="max-w-xs text-xs text-muted-foreground">{subtitle}</p>}
      {action && (
        <Button type="button" variant="outline" size="sm" className="mt-1" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function OverviewBarChart({ scope = 'consolidated' }: { scope?: DashboardView }) {
  // The view → entity-id seam (app/lib/views.ts). Carried but not yet consumed by the
  // readers (the collections schema has no business_entity_id column today); all three
  // views render BXR-or-stub data. This is where the chart gains real scope once Indigo
  // data lands. Title reflects the scope so the card isn't mislabeled.
  // (`scope`, not `view`: this file's own `view` state is the By Facility/By Payer toggle.)
  const entityIds = viewToEntityIds(scope);
  void entityIds;

  // MTD data is the already-cached aggregate read for whichever view is active.
  const kpisState = useWidget<CollectionsKpis>(loadCollectionsKpis);
  // Latest-month daily rows (cached) — backs the MTD facility drill-down panel.
  const dailyMtdState = useWidget<CollectionsDailyResult>(loadCollectionsDaily);
  // Canonical facility dimension (code -> care_setting/acronym) for the IP/OP split,
  // Facility filters, and acronym bar labels. Cached reference (migration 0016).
  const dimState = useWidget<FacilityDimensionRow[]>(loadFacilityDimension);

  // Anchor the "current" month to the latest DATA day (as_of = max payment_date), NOT the
  // wall clock. On the 1st of a new month — before that month's collections have posted —
  // `new Date()` would point the chart at an empty month while the KPI tiles and All
  // Facilities table (which both anchor to the data) still show the prior month, so the
  // chart's "July" filter would sit over June's numbers. Deriving from as_of keeps the whole
  // overview consistent; the anchor advances on its own once the new month's data lands.
  const asOf = kpisState.status === 'ready' ? kpisState.data.as_of : null;
  const anchorYear = asOf ? Number(asOf.slice(0, 4)) : YEAR;
  const currentMonth = asOf ? Number(asOf.slice(5, 7)) : null;
  const monthOptions = currentMonth
    ? Array.from({ length: currentMonth }, (_, i) => currentMonth - i)
    : [];

  const [view, setView] = useState<View>('facility');
  const [month, setMonth] = useState<number | null>(null);
  // Re-anchor the selected month when the data anchor first resolves (or advances).
  useEffect(() => {
    setMonth(currentMonth);
  }, [currentMonth]);
  const isMtd = month !== null && month === currentMonth;

  // Bar filters. care/facility apply to the By Facility view; payer to By Payer.
  const [careFilter, setCareFilter] = useState<CareFilter>('ALL');
  const [facilityFilter, setFacilityFilter] = useState<string>(''); // facility_code, '' = all
  const [payerFilter, setPayerFilter] = useState<string>(''); // payer label, '' = all

  // facility_code -> dimension row (care_setting + display_acronym). Empty until loaded.
  const dimByCode = useMemo(() => {
    const m = new Map<string, FacilityDimensionRow>();
    if (dimState.status === 'ready') for (const d of dimState.data) m.set(d.facility_code, d);
    return m;
  }, [dimState]);

  // Drill-down: the facility whose daily distribution panel is open (null = none).
  const [selectedFacility, setSelectedFacility] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Bring the drill-down into view when a bar is clicked (no-op if already visible).
  // Keyed on the facility only, so changing month while a panel is open swaps the
  // data in place without yanking the viewport around.
  useEffect(() => {
    if (selectedFacility) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedFacility]);

  // By Payer drill-down: the payer whose per-facility table is open (null = none).
  const [selectedPayer, setSelectedPayer] = useState<string | null>(null);
  const payerPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedPayer) payerPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedPayer]);

  // Past-month scoping: facility → daily range (aggregated), payer → gap range.
  // MTD reads the cached aggregates above, so no fetch is issued for it.
  const [past, setPast] = useState<PastState>({ kind: 'idle' });
  useEffect(() => {
    // Facility MTD reads the cached kpis aggregate — no fetch. Facility past months
    // fetch a daily range. By Payer is month-scoped for EVERY month (incl. the
    // current one): it reads the CMD rollup, falling back to the matview date-range
    // path when the rollup has no rows for the month, so the view never breaks.
    if (month === null) {
      // Data anchor not resolved yet (KPIs still loading) — nothing to fetch.
      setPast({ kind: 'idle' });
      return;
    }
    if (view === 'facility' && isMtd) {
      setPast({ kind: 'idle' });
      return;
    }
    let live = true;
    setPast({ kind: 'loading' });
    if (view === 'facility') {
      loadCollectionsDailyRange({ year: anchorYear, month })
        .then((r) => {
          if (!live) return;
          setPast(
            r.ok
              ? { kind: 'facility', rows: aggregateGrossByFacility(r.data.rows), daily: r.data.rows }
              : { kind: 'error' },
          );
        })
        .catch(() => {
          if (live) setPast({ kind: 'error' });
        });
    } else {
      const from = `${anchorYear}-${pad2(month)}-01`;
      const to = `${anchorYear}-${pad2(month)}-${pad2(lastDayOfMonth(anchorYear, month))}`;
      (async () => {
        const cmd = await loadCmdPayerMonth(anchorYear, month);
        if (!live) return;
        if (cmd.ok && cmd.data.summary.by_payer.length > 0) {
          setPast({ kind: 'payer', summary: cmd.data.summary, byFacility: cmd.data.by_facility });
          return;
        }
        // Empty rollup (month not ingested) → matview range; no facility breakdown.
        const fallback = await loadPayerGapRange({ from, to });
        if (!live) return;
        setPast(
          fallback.ok ? { kind: 'payer', summary: fallback.data, byFacility: [] } : { kind: 'error' },
        );
      })().catch(() => {
        if (live) setPast({ kind: 'error' });
      });
    }
    return () => {
      live = false;
    };
  }, [view, month, isMtd, anchorYear]);

  // --- Filtering + acronym relabeling (client-side over the loaded rows). ---
  // Filter facility rows by the active care-setting + facility selection, and relabel
  // each bar's category to its display acronym. Drill-down still keys on facility_code
  // (preserved by the spread). Generic so it serves both the MTD and past-month shapes.
  function filterFacilityRows<T extends { facility: string; facility_code: string | null }>(rows: T[]): T[] {
    return rows
      .filter((r) => {
        if (careFilter !== 'ALL') {
          const cs = r.facility_code ? dimByCode.get(r.facility_code)?.care_setting ?? null : null;
          if (cs !== careFilter) return false;
        }
        if (facilityFilter && r.facility_code !== facilityFilter) return false;
        return true;
      })
      .map((r) => {
        const acr = r.facility_code ? dimByCode.get(r.facility_code)?.display_acronym : null;
        return acr ? { ...r, facility: acr } : r;
      });
  }

  // Unfiltered facility rows for the current view/month — backs the Facility dropdown
  // options (only facilities that actually have bars this month).
  const facilityBase: { facility_code: string | null }[] =
    view !== 'facility'
      ? []
      : isMtd
        ? kpisState.status === 'ready'
          ? kpisState.data.by_facility
          : []
        : past.kind === 'facility'
          ? past.rows
          : [];

  // Facility dropdown options: facilities present this month whose care_setting matches
  // the IP/OP filter, labeled by acronym, value = facility_code.
  const facilityOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of facilityBase) {
      const code = r.facility_code;
      if (!code) continue;
      const dim = dimByCode.get(code);
      if (careFilter !== 'ALL' && (dim?.care_setting ?? null) !== careFilter) continue;
      if (!seen.has(code)) seen.set(code, dim?.display_acronym ?? code);
    }
    return [...seen.entries()]
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [facilityBase, dimByCode, careFilter]);

  // By Payer: the month's summary filtered to the selected payer (drives BOTH the bars
  // and the breakdown table) + the payer dropdown options.
  const payerSummaryFiltered: PayerGapSummary | null = useMemo(() => {
    if (past.kind !== 'payer') return null;
    if (!payerFilter) return past.summary;
    return {
      ...past.summary,
      by_payer: past.summary.by_payer.filter((p) => (p.payer_name ?? '(blank)') === payerFilter),
    };
  }, [past, payerFilter]);

  const payerOptions = useMemo(() => {
    if (past.kind !== 'payer') return [];
    return [...past.summary.by_payer]
      .sort((a, b) => b.total_charge - a.total_charge)
      .map((p) => p.payer_name ?? '(blank)');
  }, [past]);

  // Display name for the open facility drill-down (selectedFacility holds a code).
  const selectedDim = selectedFacility ? dimByCode.get(selectedFacility) : undefined;
  const selectedFacilityName = selectedDim?.display_acronym ?? selectedDim?.facility_name ?? selectedFacility ?? '';

  const monthName = month ? MONTH_NAMES[month - 1]! : '';
  const monthLabel = month ? `${monthName} ${anchorYear}` : '';
  const clickHint = ' Click a facility for its daily breakdown.';
  const payerClickHint = ' Click a payer for its facility breakdown.';
  const description =
    view === 'facility'
      ? isMtd
        ? `MTD vs. YTD gross by facility, sorted by YTD gross.${clickHint}`
        : `${monthLabel} gross by facility, sorted by gross.${clickHint}`
      : `Top ${PAYER_TOP_N} payers by total charged (${monthLabel}) — paid vs. collection gap.${payerClickHint}`;

  // Daily rows for the selected month (drill-down): cached latest-month rows for
  // MTD, the already-fetched range rows for a past month. No new fetch is issued.
  const monthDailyRows: DailyRow[] = isMtd
    ? dailyMtdState.status === 'ready'
      ? dailyMtdState.data.rows
      : []
    : past.kind === 'facility'
      ? past.daily
      : [];
  const dailyReady = isMtd ? dailyMtdState.status === 'ready' : past.kind === 'facility';
  const dailyError = isMtd ? dailyMtdState.status === 'error' : past.kind === 'error';

  // Export CSV is facility-only; enabled once the displayed data is ready.
  const canExport =
    view === 'facility' && (isMtd ? kpisState.status === 'ready' : past.kind === 'facility');

  function handleExport() {
    const fileMonth = isMtd ? `mtd-${monthName.toLowerCase()}` : monthName.toLowerCase();
    const filename = `collections-by-facility-${fileMonth}-${anchorYear}.csv`;
    let table: string[][];
    if (isMtd) {
      if (kpisState.status !== 'ready') return;
      const facilities = [...kpisState.data.by_facility].sort((a, b) => b.ytd_gross - a.ytd_gross);
      table = [
        ['Facility', 'Checks', 'EFT', 'Gross', 'YTD Gross'],
        ...facilities.map((r) => [
          facilityLabel(r),
          r.mtd_checks.toFixed(2),
          r.mtd_eft.toFixed(2),
          r.mtd_gross.toFixed(2),
          r.ytd_gross.toFixed(2),
        ]),
      ];
    } else {
      if (past.kind !== 'facility') return;
      table = [
        ['Facility', 'Checks', 'EFT', 'Gross'],
        ...past.rows.map((r) => [r.facility, r.checks.toFixed(2), r.eft.toFixed(2), r.gross.toFixed(2)]),
      ];
    }
    downloadCsv(filename, table);
  }

  const facilityFiltersActive = careFilter !== 'ALL' || facilityFilter !== '';
  const resetFacilityFilters = () => {
    setCareFilter('ALL');
    setFacilityFilter('');
  };
  // CTA shown on an empty NON-latest month: jump back to the latest month with data.
  const latestName = currentMonth ? MONTH_NAMES[currentMonth - 1] : null;
  const backToLatest =
    currentMonth !== null && month !== currentMonth && latestName
      ? { label: `View ${latestName}`, onClick: () => setMonth(currentMonth) }
      : undefined;

  function chartArea() {
    if (view === 'facility') {
      if (isMtd) {
        if (kpisState.status === 'loading') return <ChartLoading />;
        if (kpisState.status === 'error') return <ChartError />;
        const rows = filterFacilityRows(kpiChartRows(kpisState.data));
        if (rows.length === 0) {
          return facilityFiltersActive ? (
            <ChartEmpty
              variant="filtered"
              title="No facilities match"
              subtitle="Adjust the IP/OP setting or facility filter to see collections."
              action={{ label: 'Reset filters', onClick: resetFacilityFilters }}
            />
          ) : (
            <ChartEmpty
              title="No collections yet"
              subtitle="This month's collections haven't posted. This view updates daily around 6 AM."
            />
          );
        }
        return <FacilityKpiBars rows={rows} monthLabel="MTD" onBarClick={setSelectedFacility} />;
      }
      if (past.kind === 'facility') {
        const rows = filterFacilityRows(past.rows);
        if (rows.length === 0) {
          return facilityFiltersActive ? (
            <ChartEmpty
              variant="filtered"
              title="No facilities match"
              subtitle="Adjust the IP/OP setting or facility filter to see collections."
              action={{ label: 'Reset filters', onClick: resetFacilityFilters }}
            />
          ) : (
            <ChartEmpty
              title={`No collections in ${monthLabel}`}
              subtitle="Payments for this month haven't posted yet. This view updates daily around 6 AM."
              action={backToLatest}
            />
          );
        }
        return <FacilityGrossBars rows={rows} monthLabel={monthName} onBarClick={setSelectedFacility} />;
      }
      if (past.kind === 'error') return <ChartError />;
      return <ChartLoading />;
    }

    // By Payer — month-scoped via `past` (CMD rollup, matview fallback), narrowed by
    // the Payer filter. Clicking a payer opens its per-facility breakdown panel.
    if (past.kind === 'payer' && payerSummaryFiltered) {
      const rows = payerChartRows(payerSummaryFiltered, PAYER_TOP_N);
      if (rows.length === 0) {
        return payerFilter ? (
          <ChartEmpty
            variant="filtered"
            title="No activity for this payer"
            subtitle={`No ${monthLabel} activity for the selected payer.`}
            action={{ label: 'All payers', onClick: () => setPayerFilter('') }}
          />
        ) : (
          <ChartEmpty
            title={`No payer activity in ${monthLabel}`}
            subtitle="Payments for this month haven't posted yet. This view updates daily around 6 AM."
            action={backToLatest}
          />
        );
      }
      return <PayerGapBars rows={rows} onBarClick={setSelectedPayer} />;
    }
    if (past.kind === 'error') return <ChartError />;
    return <ChartLoading />;
  }

  return (
    <WidgetCard title={chartTitleFor(scope)} state={{ status: 'ready' }}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <ControlSelect
            label="View"
            value={view}
            ariaLabel="Chart view"
            onChange={(v) => {
              setView(v as View);
              // Filters are view-specific; reset them so a stale filter never hides data.
              setCareFilter('ALL');
              setFacilityFilter('');
              setPayerFilter('');
            }}
          >
            <option value="facility">By Facility</option>
            <option value="payer">By Payer</option>
          </ControlSelect>
          <ControlSelect
            label="Month"
            value={month ?? ''}
            ariaLabel="Month"
            onChange={(v) => setMonth(Number(v))}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {m === currentMonth ? `${MONTH_NAMES[m - 1]} (MTD)` : MONTH_NAMES[m - 1]}
              </option>
            ))}
          </ControlSelect>
          {view === 'facility' && (
            <>
              <ControlSelect
                label="Setting"
                value={careFilter}
                ariaLabel="Inpatient / Outpatient filter"
                onChange={(v) => {
                  setCareFilter(v as CareFilter);
                  setFacilityFilter(''); // the facility list is scoped to the chosen setting
                }}
              >
                <option value="ALL">IP &amp; OP</option>
                <option value="IP">IP only</option>
                <option value="OP">OP only</option>
              </ControlSelect>
              <ControlSelect
                label="Facility"
                value={facilityFilter}
                ariaLabel="Facility filter"
                onChange={(v) => setFacilityFilter(v)}
              >
                <option value="">All facilities</option>
                {facilityOptions.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.label}
                  </option>
                ))}
              </ControlSelect>
            </>
          )}
          {view === 'payer' && (
            <ControlSelect
              label="Payer"
              value={payerFilter}
              ariaLabel="Payer filter"
              onChange={(v) => setPayerFilter(v)}
            >
              <option value="">All payers</option>
              {payerOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </ControlSelect>
          )}
          {view === 'facility' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={!canExport}
              className="ml-auto"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          )}
        </div>

        <div className="text-sm text-muted-foreground">{description}</div>

        {chartArea()}

        {view === 'payer' && payerSummaryFiltered && (
          <PayerBreakdownTable
            summary={payerSummaryFiltered}
            monthLabel={monthLabel}
            selectedPayer={selectedPayer}
            onPayerClick={setSelectedPayer}
          />
        )}

        {view === 'facility' && selectedFacility && (
          <div ref={panelRef}>
            {dailyReady ? (
              <FacilityDailyPanel
                facilityCode={selectedFacility}
                facilityName={selectedFacilityName}
                monthLabel={monthLabel}
                rows={monthDailyRows}
                onClose={() => setSelectedFacility(null)}
              />
            ) : (
              <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink900">
                    {selectedFacilityName} — {monthLabel}
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedFacility(null)}
                    aria-label="Close daily distribution"
                    className="text-ink600"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {dailyError ? 'Unable to load the daily distribution.' : 'Loading daily distribution…'}
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'payer' && selectedPayer && (
          <div ref={payerPanelRef}>
            <PayerFacilityPanel
              payer={selectedPayer}
              monthLabel={monthLabel}
              rows={past.kind === 'payer' ? past.byFacility : []}
              onClose={() => setSelectedPayer(null)}
            />
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
