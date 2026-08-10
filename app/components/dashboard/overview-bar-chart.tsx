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
 * Rendered in the Treat Design System v2 light-mode layer (app/app/ths-v2.css),
 * which the Overview page opts into with data-ths='v2'. Data scoping per selection:
 *
 *  • Facility · MTD  → cached loadCollectionsKpis(), reshaped by mtdGrossRows() into
 *                      the same Checks+EFT bars every other month renders.
 *  • Facility · YTD  → the same cached aggregate, as a separate horizontal ranking
 *                      chart below the month chart (FacilityYtdBars).
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
  loadUpcomingManual,
  loadUpcomingOverrides,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type FacilityDimensionRow,
  type PayerGapSummary,
} from '@/lib/actions';
// overviewFacilityLabel, not facilityLabel: this tab calls the no-facility bucket
// "Interest Payments/Other" (Alec, 2026-08-10). The Collections tab keeps "(unassigned)",
// where the bucket really is group-code lineage and the interest wording would be wrong.
import { OTHER_FACILITY_LABEL, overviewFacilityLabel } from '../../../src/collections/summaryTypes';
import {
  expectedCentsByFacilityForMonth,
  resolveForecast,
  type ResolvedForecastRow,
} from '../../../src/veris/upcomingForecast';
import {
  mergeExpectedIntoFacilityRows,
  type FacilityGrossRow,
} from '@/lib/forecast/chart-series';
import type { CmdPayerFacilityRow } from '../../../src/collections/cmdPayerRollup';
import { MiniBar, useWidget } from './widgets';
import { tenantBrand } from '@/lib/tenant-branding';
import { viewTitle, type DashboardView } from '@/lib/views';

/**
 * Chart palette — Treat Design System v2 tokens, resolved at paint time from the
 * [data-ths='v2'] scope this page renders inside (see app/app/ths-v2.css). Every
 * fill clears 3:1 on the card surface, the WCAG 1.4.11 bar for a graphical object.
 *
 * EFT takes the primary teal because it is the dominant payment type in every
 * month of this data; Checks takes coral, which in v2 is explicitly DECORATION and
 * carries no severity — a coral segment must never read as "something is wrong".
 * The YTD ranking chart takes the deep teal so the two facility charts on this page
 * can never be confused at a glance.
 */
const CHART = {
  eft: 'var(--chart-1)',
  checks: 'var(--chart-2)',
  ytd: 'var(--chart-5)',
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
  /**
   * EXPECTED (operator-keyed, not yet collected). Amber --chart-4 (#9a6a00, 4.5:1) because it
   * is the only remaining token that reads as "outstanding" without reading as "wrong" —
   * coral is already Checks and is explicitly decoration in v2, and reusing either teal would
   * make asserted money indistinguishable from confirmed money at a glance, which is the one
   * thing this series must never do.
   */
  expected: 'var(--chart-4)',
} as const;

/** Bar hover wash — the accent at 6%, matching the v2 table row-hover weight. */
const BAR_CURSOR_FILL = 'rgba(28,139,130,0.06)';

/**
 * The company chip on a chart card: real logo + spelled-out name, in the tenant's own
 * color. On the Consolidated view this is what tells you which book each stacked card
 * is reporting, so it is deliberately larger and higher-contrast than a plain tag.
 *
 * The logo comes from tenantBrand() — the single declared tenant→asset map — but is
 * rendered here rather than through <TenantLogo>, whose treatment (white circle,
 * white/30 ring, white initials) is tuned for the dark top bar and would disappear on
 * a light card. A tenant with no asset, and the defensive 'consolidated' case, fall
 * back to the colored dot; the name renders either way, so nothing depends on the
 * image loading.
 */
function TenantChip({ scope }: { scope: DashboardView }) {
  const brand = tenantBrand(scope);
  return (
    <span className="ths-tenant">
      {brand?.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny fixed static asset, same call as <TenantLogo>
        <img src={brand.src} alt="" aria-hidden className="ths-tenant-logo" />
      ) : (
        <span className="ths-dot" />
      )}
      {viewTitle(scope)}
    </span>
  );
}

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
// FacilityGrossRow and mergeExpectedIntoFacilityRows live in app/lib/forecast/chart-series.ts.
// They are pure, and this component is not importable under the app's plain-node test runner
// (it reaches @/lib/actions -> app/lib/access.ts -> React cache()), so keeping them here would
// have made them untestable. Same seam, same reason, as app/lib/forecast/edit-feedback.ts.

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
        facility: overviewFacilityLabel(r),
        facility_code: r.facility_code,
        blank: r.facility_name === null,
        gross: r.gross_amount,
        checks: r.checks_amount,
        eft: r.eft_amount,
        // Filled in by mergeExpectedIntoFacilityRows; this aggregate is collections-only.
        expected: 0,
      });
    }
  }
  return [...byFacility.values()].sort((a, b) => b.gross - a.gross);
}

/**
 * The CURRENT month's rows in the same shape as a past month's, so every month
 * renders through one chart. The KPI aggregate is already loaded and already
 * month-to-date, so this is a reshape — no fetch, no re-aggregation.
 */
function mtdGrossRows(data: CollectionsKpis): FacilityGrossRow[] {
  return data.by_facility
    .map((r) => ({
      facility: overviewFacilityLabel(r),
      facility_code: r.facility_code,
      blank: r.facility_name === null,
      gross: r.mtd_gross,
      checks: r.mtd_checks,
      eft: r.mtd_eft,
      // Collections-only; mergeExpectedIntoFacilityRows adds the forecast series.
      expected: 0,
    }))
    .sort((a, b) => b.gross - a.gross);
}

/** One legend entry: a color dot + its label. Replaces the v1 square swatch. */
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="ths-dot" style={{ color }} />
      {label}
    </span>
  );
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
  //
  // EXPECTED IS NAMED SEPARATELY AND AFTER GROSS, never folded into it. Someone reading this
  // tooltip is deciding whether money is in the bank; "Gross" must keep meaning exactly what
  // CMD confirmed, with the asserted-but-unconfirmed figure standing beside it on its own row.
  return (
    <div className="ths-tooltip">
      <div className="ths-card-title mb-1">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt>{prefix}Checks</dt>
        <dd>{money(r.checks)}</dd>
        <dt>{prefix}EFT</dt>
        <dd>{money(r.eft)}</dd>
        <dt>{prefix}Gross</dt>
        <dd className="total">{money(r.gross)}</dd>
        {r.expected > 0 && (
          <>
            <dt>Expected</dt>
            <dd>{money(r.expected)}</dd>
          </>
        )}
      </dl>
      {r.expected > 0 && (
        <p className="ths-card-meta mt-1">Expected is operator-keyed, not yet confirmed by CMD.</p>
      )}
    </div>
  );
}

/**
 * Per-facility payment-type bars — the facility view for EVERY month, current
 * included. Month gross splits into its two payment types (verified identity:
 * gross = checks + eft) as two non-overlapping segments summing to month gross,
 * the bar height.
 *
 * WHY THIS IS NOW THE ONLY FACILITY-BY-MONTH CHART: the current month used to get
 * a different, three-series chart that stacked this month's Checks + EFT under
 * `ytd_remaining` (= YTD gross − MTD gross) and set bar height to YTD gross. That
 * mixed two time bases in one stack, so the amber residual was 80–95% of every bar
 * and dwarfed the segments the reader came for — and because `ytd_remaining` is a
 * derived residual that exists nowhere else in the product, the tooltip never named
 * it. Year-to-date now has its own chart (FacilityYtdBars) where the comparison is
 * the point, instead of riding along on top of a month.
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
  // Drives whether the Expected series, its legend entry and its caption exist at all. A book
  // with no forecast rows must render EXACTLY the chart it rendered before this feature — no
  // extra legend key, no zero-height segment, no altered caption.
  const anyExpected = rows.some((r) => r.expected > 0);
  return (
    <>
      {/* Vertical bars (facility on X, money on Y), spread to the full container width. */}
      <div
        role="img"
        aria-label="Collections gross by facility"
        // ths-chart-clickable is what actually lands the pointer cursor — recharts sets
        // cursor:default inline on its own wrapper, which beats inheritance from here.
        className={onBarClick ? 'ths-chart-clickable' : undefined}
        style={{ width: '100%', height: 380 }}
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
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis
              type="category"
              dataKey="facility"
              interval={0}
              angle={-35}
              textAnchor="end"
              height={64}
              tick={{ fontSize: 10, fill: CHART.axis }}
              stroke={CHART.grid}
            />
            <YAxis
              type="number"
              tickFormatter={moneyAxis}
              width={64}
              tick={{ fontSize: 11, fill: CHART.axis }}
              stroke={CHART.grid}
            />
            <Tooltip content={<FacilityGrossTooltip monthLabel={monthLabel} />} cursor={{ fill: BAR_CURSOR_FILL }} />
            {/* Stacked bottom→top: Checks → EFT = COLLECTED gross, then Expected on top.
                Expected is last so the collected portion keeps its familiar footprint at the
                axis and the asserted money reads as sitting above it. The rounded cap moves
                to Expected only when there is any — see roundedTopKey. */}
            <Bar dataKey="checks" stackId="gross" name={`${monthLabel} Checks`} fill={CHART.checks} radius={[0, 0, 0, 0]} />
            <Bar
              dataKey="eft"
              stackId="gross"
              name={`${monthLabel} EFT`}
              fill={CHART.eft}
              radius={anyExpected ? [0, 0, 0, 0] : [3, 3, 0, 0]}
            />
            {/* Rendered ONLY when there is expected money, so an empty series never adds a
                legend entry or a zero-height segment to a book that has no forecast rows. */}
            {anyExpected && (
              <Bar
                dataKey="expected"
                stackId="gross"
                name="Expected (not yet in CMD)"
                fill={CHART.expected}
                fillOpacity={0.55}
                radius={[3, 3, 0, 0]}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="ths-card-meta flex flex-wrap items-center gap-4">
        <LegendDot color={CHART.checks} label={`${monthLabel} Checks`} />
        <LegendDot color={CHART.eft} label={`${monthLabel} EFT`} />
        {anyExpected && <LegendDot color={CHART.expected} label="Expected (not yet in CMD)" />}
        {/* The caption has to change with the data, not stay a fixed sentence: once an
            expected segment is on screen, "bar height = gross" is false, and a caption that
            quietly overstates collected money is worse than no caption. */}
        <span className="ml-auto">
          {anyExpected
            ? `Bar height = ${monthLabel || 'month'} collected + expected. Expected is operator-keyed and not yet confirmed by CMD.`
            : `Bar height = ${monthLabel || 'month'} gross.`}
        </span>
      </div>
    </>
  );
}

/**
 * Axis-label guard for the YTD chart. Facilities without a display acronym fall back
 * to their full CMD name ("CROWN VIEW CO-OCCURRING INSTITUTE - 612335"), and recharts
 * has no ellipsis of its own — an over-long tick just overlaps its neighbours. The
 * tooltip always shows the untruncated name, so nothing is lost.
 */
function truncateLabel(value: string): string {
  return value.length > 26 ? `${value.slice(0, 25)}…` : value;
}

/** A facility's year-to-date gross (the YTD ranking chart's row shape). */
interface FacilityYtdRow {
  facility: string;
  facility_code: string | null;
  ytd_gross: number;
}

/**
 * Map the KPI aggregate to YTD rows, richest first. Same source as the month
 * chart (kpis.by_facility), so the two charts can never disagree.
 */
function ytdRows(data: CollectionsKpis): FacilityYtdRow[] {
  return data.by_facility
    .map((r) => ({
      facility: overviewFacilityLabel(r),
      facility_code: r.facility_code,
      ytd_gross: r.ytd_gross,
    }))
    .sort((a, b) => b.ytd_gross - a.ytd_gross);
}

function FacilityYtdTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: FacilityYtdRow }[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0]!.payload;
  return (
    <div className="ths-tooltip">
      <div className="ths-card-title mb-1">{r.facility}</div>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt>YTD gross</dt>
        <dd className="total">{money(r.ytd_gross)}</dd>
      </dl>
    </div>
  );
}

/**
 * "YTD gross by facility" — a single-series HORIZONTAL ranking chart.
 *
 * Horizontal on purpose, and it is the accessibility win in this pass: the vertical
 * month chart has to rotate its category labels -35° and still truncates them, which
 * is unreadable for Indigo's 30 facilities with names like "CROWN VIEW CO-OCCURRING
 * INSTITUTE - 612335". Here every label is horizontal, left-aligned and read at a
 * normal angle. The differing form is also what keeps this chart from being confused
 * with the month chart above it.
 *
 * Deliberately NOT clickable: the drill-down panel shows one MONTH's daily rows, so a
 * click here would open a month panel from a year-to-date bar. One chart, one claim.
 */
function FacilityYtdBars({ rows, year }: { rows: FacilityYtdRow[]; year: number }) {
  // 22px per row keeps 30 facilities legible without a scroll; the floor stops a
  // one-facility filter from rendering a single absurdly fat bar.
  const height = Math.max(140, rows.length * 22 + 32);
  return (
    <>
      <div role="img" aria-label={`Year-to-date ${year} gross collections by facility`} style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 8 }} barCategoryGap="22%">
            <CartesianGrid horizontal={false} stroke={CHART.grid} />
            <XAxis type="number" tickFormatter={moneyAxis} tick={{ fontSize: 11, fill: CHART.axis }} stroke={CHART.grid} />
            <YAxis
              type="category"
              dataKey="facility"
              width={168}
              interval={0}
              tickFormatter={truncateLabel}
              tick={{ fontSize: 10, fill: CHART.axis }}
              stroke={CHART.grid}
            />
            <Tooltip content={<FacilityYtdTooltip />} cursor={{ fill: BAR_CURSOR_FILL }} />
            <Bar dataKey="ytd_gross" name={`YTD ${year} gross`} fill={CHART.ytd} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="ths-card-meta flex flex-wrap items-center gap-4">
        <LegendDot color={CHART.ytd} label={`YTD ${year} gross`} />
        <span className="ml-auto">Bar length = year-to-date gross.</span>
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
    <div className="ths-card ths-elev-md">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="ths-card-title">
          {facilityName} — {monthLabel}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close daily distribution"
          className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {facilityRows.length === 0 ? (
        <div className="ths-card-meta py-6 text-center">
          No data for this facility in {monthLabel}.
        </div>
      ) : (
        <div className="ths-scroll-x">
          <table className="ths-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Checks</th>
                <th className="num">EFT</th>
                <th className="num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {facilityRows.map((r) => (
                <tr key={r.payment_date}>
                  <td className="mono">{formatMmDdYyyy(r.payment_date)}</td>
                  <td className="num">{money(r.checks_amount)}</td>
                  <td className="num">{money(r.eft_amount)}</td>
                  <td className="num">{money(r.gross_amount)}</td>
                </tr>
              ))}
              <tr className="ths-table-total">
                <td>TOTALS</td>
                <td className="num">{money(totals.checks)}</td>
                <td className="num">{money(totals.eft)}</td>
                <td className="num">{money(totals.gross)}</td>
              </tr>
            </tbody>
          </table>
        </div>
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
    <div className="ths-card ths-elev-md">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="ths-card-title">
          {payer} — {monthLabel}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close facility breakdown"
          className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {payerRows.length === 0 ? (
        <div className="ths-card-meta py-6 text-center">
          No facility breakdown for this payer in {monthLabel}.
        </div>
      ) : (
        <div className="ths-scroll-x">
          <table className="ths-table">
            <thead>
              <tr>
                <th>Facility</th>
                <th className="num">Charged</th>
                <th className="num">Allowed</th>
                <th className="num">Paid</th>
                <th className="num">Gap</th>
              </tr>
            </thead>
            <tbody>
              {payerRows.map((r) => (
                <tr key={r.facility_name ?? OTHER_FACILITY_LABEL}>
                  <td>{r.facility_name ?? OTHER_FACILITY_LABEL}</td>
                  <td className="num">{money(r.total_charge)}</td>
                  <td className="num">{money(r.total_allowed)}</td>
                  <td className="num">{money(r.total_paid)}</td>
                  <td className="num">{money(r.total_collection_gap)}</td>
                </tr>
              ))}
              <tr className="ths-table-total">
                <td>TOTALS</td>
                <td className="num">{money(totals.charge)}</td>
                <td className="num">{money(totals.allowed)}</td>
                <td className="num">{money(totals.paid)}</td>
                <td className="num">{money(totals.gap)}</td>
              </tr>
            </tbody>
          </table>
        </div>
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

  // Dismissal is LOCAL and resets whenever the month changes. Unlike the two Overview reveal
  // panels, this table is the primary content of the By-Payer view rather than something the user
  // opened, so a sticky dismissal would leave that view looking empty with no obvious way back.
  // Re-selecting a month brings it straight back.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
  }, [monthLabel]);

  if (rows.length === 0 || dismissed) return null;

  return (
    <div className="ths-card ths-elev-md">
      <div className="flex items-center justify-between gap-3">
        <h3 className="ths-card-title">Payer breakdown — {monthLabel}</h3>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Close payer breakdown"
          className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="ths-card-meta mb-3 mt-0.5">
        Charged / Allowed / Paid / Collection gap per payer. Click a payer for its per-facility breakdown.
      </p>
      <div className="ths-scroll-x">
        <table className="ths-table">
          <thead>
            <tr>
              <th>Payer</th>
              <th className="num">Charged</th>
              <th className="num">Allowed</th>
              <th className="num">Paid</th>
              <th className="num">Collection Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const label = r.payer_name ?? '(blank)';
              const gapPct = r.total_charge > 0 ? (r.total_collection_gap / r.total_charge) * 100 : 0;
              const active = selectedPayer === label;
              return (
                <tr
                  key={`${label}-${i}`}
                  onClick={() => onPayerClick(label)}
                  className={`ths-row-click${active ? ' ths-row-active' : ''}`}
                >
                  <td>
                    {r.payer_name ?? <span className="ths-card-meta">(blank)</span>}
                  </td>
                  <td className="num">{money(r.total_charge)}</td>
                  <td className="num">{money(r.total_allowed)}</td>
                  <td className="num">{money(r.total_paid)}</td>
                  <td className="num">
                    <div className="flex items-center justify-end gap-2">
                      <span className="mono">{money(r.total_collection_gap)}</span>
                      <span className="w-14 shrink-0">
                        <MiniBar pct={gapPct} />
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr className="ths-table-total">
              <td>TOTALS</td>
              <td className="num">{money(totals.charge)}</td>
              <td className="num">{money(totals.allowed)}</td>
              <td className="num">{money(totals.paid)}</td>
              <td className="num">{money(totals.gap)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChartLoading() {
  return <div className="ths-card-meta py-12 text-center">Loading…</div>;
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
      <span className="ths-empty-icon">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="ths-card-title">{title}</div>
      {subtitle && <p className="ths-card-meta max-w-xs">{subtitle}</p>}
      {action && (
        <button type="button" className="ths-btn ths-btn-primary ths-btn-sm mt-1" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Overview chart entry point. For a single tenant (bxr/indigo) it renders one chart. For the
 * CONSOLIDATED view it renders TWO self-contained per-tenant charts stacked vertically — one
 * scoped to BXR, one to Indigo — instead of one commingled chart, so each tenant's facilities,
 * months, and drill-downs stand on their own. Consolidated is only ever shown to a super-admin
 * entitled to both tenants, so each child's server-side scope (bxr / indigo) is authorized; the
 * server re-derives entity ids from the view and never trusts this client hint.
 */
export function OverviewBarChart({
  scope = 'consolidated',
  forecastVersion = 0,
}: {
  scope?: DashboardView;
  /**
   * Bumped by the page when a forecast row is added, removed or reconciled. The expected
   * series re-reads on change, so a payment typed into the top-of-page form appears on this
   * chart immediately rather than after the next hourly CMD pull — which is the entire point
   * of the feature.
   */
  forecastVersion?: number;
}) {
  if (scope === 'consolidated') {
    return (
      <div className="space-y-6">
        <OverviewBarChartSingle scope="bxr" forecastVersion={forecastVersion} />
        <OverviewBarChartSingle scope="indigo" forecastVersion={forecastVersion} />
      </div>
    );
  }
  return <OverviewBarChartSingle scope={scope} forecastVersion={forecastVersion} />;
}

function OverviewBarChartSingle({
  scope,
  forecastVersion = 0,
}: {
  scope: DashboardView;
  forecastVersion?: number;
}) {
  // `scope` is the active tenant view. It is passed to every collections load* action (which
  // re-derives the entitled business_entity_id(s) SERVER-SIDE — the client value is only a hint)
  // and used as the useWidget/effect dependency so switching views re-fetches for the new tenant.
  // (`scope`, not `view`: this file's own `view` state is the By Facility/By Payer toggle.)

  // MTD data is the already-cached aggregate read for the active tenant.
  const kpisState = useWidget<CollectionsKpis>(() => loadCollectionsKpis(scope, 'overview'), [scope]);
  // Latest-month daily rows (cached) — backs the MTD facility drill-down panel.
  const dailyMtdState = useWidget<CollectionsDailyResult>(() => loadCollectionsDaily(scope, 'overview'), [scope]);
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

  /**
   * EXPECTED (operator-keyed) money, read LIVE from the staging forecast tables.
   *
   * Deliberately its own read rather than a column on the collections aggregate, because the
   * two live in different planes and must stay that way: collections.daily_collections_resolved
   * is MAX-GROSS-WINS per facility-day, so a forecast row written into it would either vanish
   * or REPLACE a real CMD deposit. Reading it here, and stacking it as a separate labelled
   * series, is the only shape of this feature that cannot corrupt a collected figure.
   *
   * FAIL-SOFT AND SILENT. An ok:false on either half degrades to "no expected money", which
   * renders exactly the chart that existed before this feature. That is the honest failure
   * direction: showing no asserted money is a smaller lie than showing collected money that
   * might be asserted. It also matters operationally — 023/024 are not applied in every
   * environment, and coupling the Master BXR Chart's health to them would take the primary
   * product surface down over a feed behaving as designed.
   */
  const [expectedRows, setExpectedRows] = useState<ResolvedForecastRow[]>([]);
  useEffect(() => {
    let live = true;
    setExpectedRows([]);
    Promise.all([loadUpcomingOverrides(scope), loadUpcomingManual(scope)])
      .then(([ovr, man]) => {
        if (!live) return;
        // BOTH partitions: an overdue expected payment is still money the operator says is
        // coming, and dropping it here would make the chart disagree with the tile.
        const resolved = resolveForecast(
          ovr.ok ? [...ovr.data.upcoming.rows, ...ovr.data.overdue.rows] : [],
          man.ok ? man.data.rows : [],
        );
        // `resolved.rows` ONLY — never `hidden` or `matched`. Both are money a human has
        // already accounted for elsewhere (suppressed, or covered by an 835 that is itself on
        // the tile), and adding either back here would re-render it as outstanding.
        setExpectedRows(resolved.rows);
      })
      .catch(() => {
        /* fail-soft — see above */
      });
    return () => {
      live = false;
    };
  }, [scope, forecastVersion]);

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
      loadCollectionsDailyRange({ year: anchorYear, month }, scope, 'overview')
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
        const cmd = await loadCmdPayerMonth(anchorYear, month, scope);
        if (!live) return;
        if (cmd.ok && cmd.data.summary.by_payer.length > 0) {
          setPast({ kind: 'payer', summary: cmd.data.summary, byFacility: cmd.data.by_facility });
          return;
        }
        // Empty CMD rollup (month not ingested). The fallback (loadPayerGapRange) reads the
        // claims matview, which is BXR-only and NOT tenant-scoped (claims.claims has no
        // business_entity_id — a separate tenancy follow-up). So use it ONLY when BXR is in
        // scope (bxr / consolidated); for an Indigo-only view show an empty payer result rather
        // than leak BXR claims data under Indigo.
        if (scope === 'indigo') {
          setPast({ kind: 'payer', summary: { rows_analyzed: 0, by_payer: [] }, byFacility: [] });
          return;
        }
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
  }, [view, month, isMtd, anchorYear, scope]);

  // --- Filtering + acronym relabeling (client-side over the loaded rows). ---
  // Filter facility rows by the active care-setting + facility selection, and relabel
  // each bar's category to its display acronym. Drill-down still keys on facility_code
  // (preserved by the spread). Generic so it serves both the MTD and past-month shapes.
  function filterFacilityRows<T extends { facility: string; facility_code: string | null }>(rows: T[]): T[] {
    return rows
      .filter((r) => {
        if (careFilter !== 'ALL') {
          const cs = r.facility_code ? dimByCode.get(r.facility_code)?.care_setting ?? null : null;
          // A 'BOTH' facility (serves inpatient AND outpatient) is a member of both filters.
          if (cs !== careFilter && cs !== 'BOTH') return false;
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
      const cs = dim?.care_setting ?? null;
      // 'BOTH' facilities appear under both the IP and OP filters (not a separate bucket).
      if (careFilter !== 'ALL' && cs !== careFilter && cs !== 'BOTH') continue;
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
  // One sentence for every month now that the current month renders through the same
  // chart as the rest; only the "month to date" qualifier differs.
  const description =
    view === 'facility'
      ? `${monthLabel} gross by facility${isMtd ? ' (month to date)' : ''}, sorted by gross.${clickHint}`
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
      // Sorted by the month's gross so the CSV row order matches the chart the user
      // is looking at. The YTD column rides along as context (it backs the YTD chart).
      const facilities = [...kpisState.data.by_facility].sort((a, b) => b.mtd_gross - a.mtd_gross);
      table = [
        ['Facility', 'Checks', 'EFT', 'Gross', 'YTD Gross'],
        ...facilities.map((r) => [
          overviewFacilityLabel(r),
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

  // YTD ranking rows — same KPI aggregate as the month chart, narrowed by the same
  // Setting/Facility filters so the two charts always describe the same set of
  // facilities. Independent of the Month picker on purpose: year-to-date is anchored
  // to as_of, not to the month being inspected above, and the heading says so.
  const ytdChartRows =
    kpisState.status === 'ready' ? filterFacilityRows(ytdRows(kpisState.data)) : [];

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

  /**
   * Expected cents per facility for the month currently on screen.
   *
   * Month-scoped, not whole-book: the chart shows one month at a time, and folding every
   * outstanding forecast row into whichever month happened to be selected would attribute
   * September's expected check to July's bar.
   *
   * Applied AFTER filterFacilityRows in the call sites below, so the Setting/Facility
   * dropdowns narrow the expected series exactly as they narrow the collected one — a
   * facility filtered out of the bars must not reappear carrying only expected money.
   */
  const expectedByCode = useMemo(
    () =>
      month === null
        ? new Map<string, number>()
        : expectedCentsByFacilityForMonth(expectedRows, anchorYear, month),
    [expectedRows, anchorYear, month],
  );

  /** Label a facility that has expected money but no collected row, using the same dimension
   *  source the bars use so its axis label matches its neighbours. */
  const labelForCode = (code: string): string | null =>
    dimByCode.get(code)?.display_acronym ?? null;

  /** Narrow to the visible facilities FIRST, then fold in that month's expected money. */
  function withExpected(rows: FacilityGrossRow[]): FacilityGrossRow[] {
    const visible = filterFacilityRows(rows);
    if (expectedByCode.size === 0) return visible;
    // Re-apply the same filters to the expected side, so a facility the dropdowns exclude
    // cannot re-enter the chart through the forecast series.
    const allowed = new Map(
      [...expectedByCode].filter(([code]) =>
        filterFacilityRows([{ facility: code, facility_code: code }]).length > 0,
      ),
    );
    return mergeExpectedIntoFacilityRows(visible, allowed, labelForCode);
  }

  function chartArea() {
    if (view === 'facility') {
      if (isMtd) {
        if (kpisState.status === 'loading') return <ChartLoading />;
        if (kpisState.status === 'error') return <ChartError />;
        const rows = withExpected(mtdGrossRows(kpisState.data));
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
        return <FacilityGrossBars rows={rows} monthLabel={monthName} onBarClick={setSelectedFacility} />;
      }
      if (past.kind === 'facility') {
        const rows = withExpected(past.rows);
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
    <section className="ths-card ths-elev-sm" data-tenant={scope}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="ths-card-title text-base">{chartTitleFor(scope)}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <TenantChip scope={scope} />
          {asOf && <span className="ths-card-meta">as of {asOf}</span>}
        </div>
      </header>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <ControlSelect
            className="ths-input"
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
            className="ths-input"
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
                className="ths-input"
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
                className="ths-input"
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
              className="ths-input"
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
            <button
              type="button"
              onClick={handleExport}
              disabled={!canExport}
              className="ths-btn ths-btn-secondary ths-btn-sm ml-auto"
            >
              <Download className="h-4 w-4" aria-hidden />
              Export CSV
            </button>
          )}
        </div>

        <p className="ths-card-body">{description}</p>

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
              <div className="ths-card ths-elev-md">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="ths-card-title">
                    {selectedFacilityName} — {monthLabel}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setSelectedFacility(null)}
                    aria-label="Close daily distribution"
                    className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <div className="ths-card-meta py-6 text-center">
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

      {/* ── Second chart: year-to-date. Its own heading, its own form (horizontal),
             its own single series — so it reads as a separate claim about the data
             rather than a segment sitting on top of the month above it. ────────── */}
      {view === 'facility' && kpisState.status === 'ready' && (
        <>
          <hr className="ths-hr" />
          <section>
            <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="ths-card-title">YTD gross by facility</h3>
              <span className="ths-card-meta">
                {anchorYear} year to date{asOf ? ` · as of ${asOf}` : ''}
              </span>
            </header>
            <p className="ths-card-body mb-3">
              Every facility&apos;s {anchorYear} collections to date, richest first. Not clickable —
              the daily breakdown above belongs to the selected month.
            </p>
            {ytdChartRows.length === 0 ? (
              <ChartEmpty
                variant={facilityFiltersActive ? 'filtered' : undefined}
                title={facilityFiltersActive ? 'No facilities match' : 'No collections yet'}
                subtitle={
                  facilityFiltersActive
                    ? 'Adjust the IP/OP setting or facility filter to see year-to-date gross.'
                    : `No ${anchorYear} collections have posted yet.`
                }
                action={facilityFiltersActive ? { label: 'Reset filters', onClick: resetFacilityFilters } : undefined}
              />
            ) : (
              <FacilityYtdBars rows={ytdChartRows} year={anchorYear} />
            )}
          </section>
        </>
      )}
    </section>
  );
}
