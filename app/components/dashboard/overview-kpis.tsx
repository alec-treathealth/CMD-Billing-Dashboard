'use client';

/**
 * Overview KPI row — small, modern KPI tiles sitting above the Master chart:
 *   • MTD Gross   — month-to-date collections gross, with a MoM trend.
 *   • YTD Gross   — year-to-date gross split IP / OP / IP+OP, with a YoY trend.
 *   • Year Forecast — a live linear-YTD run-rate projection, with a YoY-vs-prior-year trend.
 * Plus an "All Facilities Table" button that opens a paginated, per-facility table for
 * the current month.
 *
 * Data sources (all NON-PHI, reader-only; no row fetch, no LLM):
 *   • MTD/YTD gross, per-facility rows, the anchor date  → loadCollectionsKpis (live
 *     daily_collections_resolved). This is the headline series and ties exactly to the
 *     chart below.
 *   • IP/OP classification                               → loadFacilityDimension
 *     (collections.facilities.care_setting, migration 0016), joined on facility_code.
 *   • MoM (current vs prior month, same period)          → loadCollectionsDailyRange.
 *   • YoY (collected, current vs prior year) + prior full year → loadCollectionsYoy
 *     (payment_lines — the only multi-year collections series; the live deposit series
 *     is 2026-only, so YoY cannot come from it). Labeled "collected" to be honest about
 *     the source/measure difference.
 *
 * The `view` prop selects the data scope via the viewToEntityIds seam (app/lib/views.ts).
 * Until Indigo data is ingested, every view resolves to BXR-or-stub: the entity ids are
 * computed and carried here, but the dashboard readers are not yet entity-scoped (see the
 * seam note in views.ts), so all three views render BXR data. This is the only component
 * that needs to change scope once the real data layer lands.
 */
import { useEffect, useMemo, useState } from 'react';
import { Filter, Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect } from '@/components/data-grid';
import { money } from '@/lib/format';
import {
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadCollectionsYoy,
  loadFacilityDimension,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type CollectionsYoy,
  type FacilityDimensionRow,
} from '@/lib/actions';
import { type DashboardView, viewToEntityIds } from '@/lib/views';
import { Kpi, useWidget } from './widgets';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** All Facilities care-setting filter. */
type FacilitySetting = 'ALL' | 'IP' | 'OP';

// --- pure date/number helpers (anchored to the live as_of, not wall-clock) --------

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** 1-based day index within the year for an ISO 'YYYY-MM-DD' (UTC math, TZ-safe). */
function dayOfYear(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const start = Date.UTC(y!, 0, 1);
  const cur = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return Math.floor((cur - start) / 86_400_000) + 1;
}

/** Prior calendar month + its year for an ISO anchor (wraps Jan → prior Dec). */
function priorMonthOf(iso: string): { year: number; month: number } {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Percent change cur vs prior; null when prior is non-positive (can't divide). */
function pctChange(cur: number, prior: number): number | null {
  if (!Number.isFinite(prior) || prior <= 0) return null;
  return ((cur - prior) / prior) * 100;
}

/** A small colored trend line: ▲ green / ▼ red / – neutral, with a label. */
function Trend({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) {
    return <span className="text-status-neutral">— {label}</span>;
  }
  const up = pct > 0.05;
  const down = pct < -0.05;
  const cls = up ? 'text-status-ok' : down ? 'text-status-danger' : 'text-status-neutral';
  const arrow = up ? '▲' : down ? '▼' : '–';
  return (
    <span className={cls}>
      {arrow} {Math.abs(pct).toFixed(1)}% {label}
    </span>
  );
}

/**
 * True when the latest-data month (`asOf`) is an already-completed calendar month — i.e. the
 * wall-clock month is later than the last day of data. This is the "new month, data pending"
 * case (e.g. it's July 1 but collections only run through June 30). Wall-clock is legitimate
 * here: the whole point is to compare the DATA anchor against today's calendar.
 */
function anchorIsBehindCalendar(asOf: string): boolean {
  const now = new Date();
  const curYM = now.getFullYear() * 12 + now.getMonth(); // getMonth() is 0-based
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  return y * 12 + (m - 1) < curYM;
}

/**
 * Freshness ribbon — a calm status strip shown ONLY when the latest data month trails the
 * current calendar month (the first-of-month gap). It states what period is shown, that it's
 * the latest complete data, and that the new month fills in over time — so a user landing on
 * the 1st never mistakes "showing June" for a stale/broken dashboard. Self-hides once the
 * current month has data. Non-PHI; brand-tokened; the pulsing dot signals "live".
 */
function FreshnessRibbon({ asOf }: { asOf: string }) {
  if (!anchorIsBehindCalendar(asOf)) return null;
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  const shownMonth = MONTH_NAMES[m - 1];
  const nextMonth = MONTH_NAMES[m % 12]; // month after m (Dec → January)
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-line border-l-2 border-l-[var(--brand-accent)] bg-[var(--brand-soft)] px-3.5 py-2.5"
    >
      <span className="relative mt-[3px] flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand-accent)] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand-accent)]" />
      </span>
      <p className="text-sm leading-snug">
        <span className="font-semibold text-[var(--brand-ink)]">
          Showing {shownMonth} {y}
        </span>
        <span className="text-muted-foreground">
          {' '}— latest complete data, as of {asOf}. {nextMonth} collections post throughout the
          month; this view updates daily (~6&nbsp;AM).
        </span>
      </p>
    </div>
  );
}

/** Loading skeleton: three KPI-shaped tiles. */
function KpiSkeletonRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="border-t-2 border-t-[var(--brand-accent)]">
          <CardContent className="space-y-2 pb-4 pt-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-24" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function OverviewKpis({ view }: { view: DashboardView }) {
  // The view → entity-id seam. Carried (and logged-in-spirit) but not yet consumed by
  // the readers below — see the seam note in app/lib/views.ts. All three views render
  // BXR-or-stub data today; this is the one line that gains meaning when Indigo lands.
  const entityIds = viewToEntityIds(view);
  void entityIds;

  const kpisState = useWidget<CollectionsKpis>(loadCollectionsKpis);
  const dimState = useWidget<FacilityDimensionRow[]>(loadFacilityDimension);

  const asOf = kpisState.status === 'ready' ? kpisState.data.as_of : null;

  // Anchor-dependent fetches (YoY + prior-month MoM base), loaded once the anchor is known.
  const [yoy, setYoy] = useState<CollectionsYoy | null>(null);
  const [priorMonth, setPriorMonth] = useState<CollectionsDailyResult | null>(null);
  useEffect(() => {
    if (!asOf) return;
    let live = true;
    setYoy(null);
    setPriorMonth(null);
    const { year, month } = priorMonthOf(asOf);
    loadCollectionsYoy(asOf)
      .then((r) => {
        if (live && r.ok) setYoy(r.data);
      })
      .catch(() => {});
    loadCollectionsDailyRange({ year, month })
      .then((r) => {
        if (live && r.ok) setPriorMonth(r.data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asOf]);

  // facility_code → dimension row, for IP/OP and acronym labels.
  const dimByCode = useMemo(() => {
    const m = new Map<string, FacilityDimensionRow>();
    if (dimState.status === 'ready') for (const d of dimState.data) m.set(d.facility_code, d);
    return m;
  }, [dimState]);

  // YTD gross split IP / OP / total (IP+OP = the full YTD total incl. unclassified).
  const ytdSplit = useMemo(() => {
    if (kpisState.status !== 'ready') return { ip: 0, op: 0, total: 0 };
    let ip = 0;
    let op = 0;
    for (const f of kpisState.data.by_facility) {
      const cs = f.facility_code ? dimByCode.get(f.facility_code)?.care_setting ?? null : null;
      if (cs === 'IP') ip += f.ytd_gross;
      else if (cs === 'OP') op += f.ytd_gross;
    }
    return { ip, op, total: kpisState.data.ytd.gross };
  }, [kpisState, dimByCode]);

  // Prior-month-same-period gross (MoM base): sum prior month's days up to as_of's day.
  const priorMonthSamePeriod = useMemo(() => {
    if (!asOf || !priorMonth) return null;
    const dom = Number(asOf.slice(8, 10));
    return priorMonth.rows
      .filter((r) => Number(r.payment_date.slice(8, 10)) <= dom)
      .reduce((acc, r) => acc + r.gross_amount, 0);
  }, [asOf, priorMonth]);

  if (kpisState.status === 'loading') return <KpiSkeletonRow />;
  if (kpisState.status === 'error') {
    return (
      <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
        Unable to load the headline metrics.
      </div>
    );
  }

  const kpis = kpisState.data;

  // --- card metrics ---------------------------------------------------------------
  const mtdGross = kpis.mtd.gross;
  const ytdGross = kpis.ytd.gross;

  // Linear YTD run-rate forecast (recomputes live from ytd gross + anchor day-of-year):
  //   forecast = ytd_gross / day_of_year(as_of) × days_in_year(year).
  // Chosen over a trailing-window run-rate because it needs only the already-loaded
  // ytd.gross + as_of (zero extra query work) and is the most legible projection at
  // this data scale; it auto-updates as new collections land (never hardcoded).
  const year = asOf ? Number(asOf.slice(0, 4)) : null;
  const forecast =
    asOf && year
      ? (ytdGross / dayOfYear(asOf)) * (isLeap(year) ? 366 : 365)
      : null;

  // Trend guardrail: only show a MoM % when there's a real current-period basis. Off a zero
  // (or not-yet-posted) month, a computed % would render a misleading ▼100% / spike — show a
  // neutral em-dash instead (pctChange already guards a non-positive prior).
  const momPct =
    priorMonthSamePeriod !== null && mtdGross > 0 ? pctChange(mtdGross, priorMonthSamePeriod) : null;
  const yoyPct = yoy ? pctChange(yoy.current_ytd_paid, yoy.prior_ytd_paid) : null;
  const forecastYoyPct = yoy && forecast !== null ? pctChange(forecast, yoy.prior_full_year_paid) : null;

  const priorMonthName = asOf ? MONTH_NAMES[priorMonthOf(asOf).month - 1] : null;
  const monthName = asOf ? MONTH_NAMES[Number(asOf.slice(5, 7)) - 1] : null;

  return (
    <div className="space-y-3">
      {asOf && <FreshnessRibbon asOf={asOf} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label={monthName ? `MTD Gross · ${monthName}` : 'MTD Gross'}
          value={money(mtdGross)}
          detail={<Trend pct={momPct} label={priorMonthName ? `vs ${priorMonthName}` : 'vs last month'} />}
          sub={asOf ? `as of ${asOf}` : undefined}
        />
        <Kpi
          label="YTD Gross"
          value={money(ytdGross)}
          detail={
            <span>
              IP {money(ytdSplit.ip)} · OP {money(ytdSplit.op)}
            </span>
          }
          sub={<Trend pct={yoyPct} label={yoy ? `YoY collected vs ${yoy.prior_year}` : 'YoY'} />}
        />
        <Kpi
          label="Year Forecast"
          value={forecast === null ? '—' : money(forecast)}
          detail={
            <Trend
              pct={forecastYoyPct}
              label={yoy ? `vs ${yoy.prior_year} collected` : 'vs prior year'}
            />
          }
          sub={asOf ? `Linear YTD run-rate · as of ${asOf}` : 'Linear YTD run-rate'}
        />
      </div>

      <AllFacilitiesTable kpis={kpis} dimByCode={dimByCode} asOf={asOf} />
    </div>
  );
}

/** A per-facility row for the All Facilities table (summed for the selected month). */
interface FacilityTableRow {
  label: string;
  careSetting: 'IP' | 'OP' | null;
  checks: number;
  eft: number;
  gross: number;
}

/** A facility's per-month checks/eft/gross totals (the shape both sources reduce to). */
interface FacilityMonthTotals {
  facility_code: string | null;
  facility_name: string | null;
  checks: number;
  eft: number;
  gross: number;
}

/**
 * "All Facilities Table" — a toggle that reveals the full (un-paginated) per-facility
 * table summed for a selected month, with an IP/OP setting filter. Aggregate, non-PHI:
 * the current month reads the already-loaded MTD KPI rows; a past month fetches that
 * month's daily rows (loadCollectionsDailyRange) and sums them per facility. Joined to
 * the facility dimension for acronym labels + the IP/OP (care_setting) filter.
 */
function AllFacilitiesTable({
  kpis,
  dimByCode,
  asOf,
}: {
  kpis: CollectionsKpis;
  dimByCode: Map<string, FacilityDimensionRow>;
  asOf: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [setting, setSetting] = useState<FacilitySetting>('ALL');

  const currentYear = asOf ? Number(asOf.slice(0, 4)) : null;
  const currentMonth = asOf ? Number(asOf.slice(5, 7)) : null;
  // The anchor month is already complete when today's calendar month is later (first-of-month
  // gap) — then it's the "latest/final" month, not the live "current (MTD)" one.
  const isComplete = asOf ? anchorIsBehindCalendar(asOf) : false;
  const [month, setMonth] = useState<number | null>(currentMonth);
  // Re-anchor the selected month when the live anchor first resolves / changes.
  useEffect(() => {
    setMonth(currentMonth);
  }, [currentMonth]);

  const isCurrent = month !== null && month === currentMonth;

  // Past-month totals (fetched). The current month uses the already-loaded MTD KPI rows,
  // so no fetch is issued for it. Only fetch while the panel is open.
  const [pastRows, setPastRows] = useState<FacilityMonthTotals[] | null>(null);
  const [pastStatus, setPastStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  useEffect(() => {
    if (!open || isCurrent || month === null || currentYear === null) {
      setPastRows(null);
      setPastStatus('idle');
      return;
    }
    let live = true;
    setPastStatus('loading');
    loadCollectionsDailyRange({ year: currentYear, month })
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setPastStatus('error');
          return;
        }
        const byFacility = new Map<string, FacilityMonthTotals>();
        for (const row of r.data.rows) {
          const key = row.facility_code ?? '__unassigned__';
          const e = byFacility.get(key);
          if (e) {
            e.checks += row.checks_amount;
            e.eft += row.eft_amount;
            e.gross += row.gross_amount;
          } else {
            byFacility.set(key, {
              facility_code: row.facility_code,
              facility_name: row.facility_name,
              checks: row.checks_amount,
              eft: row.eft_amount,
              gross: row.gross_amount,
            });
          }
        }
        setPastRows([...byFacility.values()]);
        setPastStatus('ready');
      })
      .catch(() => {
        if (live) setPastStatus('error');
      });
    return () => {
      live = false;
    };
  }, [open, isCurrent, month, currentYear]);

  // Rows for display: current month → MTD KPI rows; past month → fetched + aggregated.
  // Joined to the dimension for the acronym label + IP/OP, then filtered by setting.
  const rows = useMemo<FacilityTableRow[]>(() => {
    const source: FacilityMonthTotals[] = isCurrent
      ? kpis.by_facility.map((f) => ({
          facility_code: f.facility_code,
          facility_name: f.facility_name,
          checks: f.mtd_checks,
          eft: f.mtd_eft,
          gross: f.mtd_gross,
        }))
      : (pastRows ?? []);
    return source
      .map((f) => {
        const dim = f.facility_code ? dimByCode.get(f.facility_code) : undefined;
        return {
          label: dim?.display_acronym ?? f.facility_name ?? '(unassigned)',
          careSetting: dim?.care_setting ?? null,
          checks: f.checks,
          eft: f.eft,
          gross: f.gross,
        };
      })
      .filter((r) => setting === 'ALL' || r.careSetting === setting)
      .sort((a, b) => b.gross - a.gross);
  }, [isCurrent, kpis, pastRows, dimByCode, setting]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          checks: acc.checks + r.checks,
          eft: acc.eft + r.eft,
          gross: acc.gross + r.gross,
        }),
        { checks: 0, eft: 0, gross: 0 },
      ),
    [rows],
  );

  // Month options: current month + every preceding month of the current year (reverse-chron).
  const monthOptions = currentMonth ? Array.from({ length: currentMonth }, (_, i) => currentMonth - i) : [];
  const monthName = month ? MONTH_NAMES[month - 1] : null;
  const loadingPast = !isCurrent && pastStatus === 'loading';
  const errorPast = !isCurrent && pastStatus === 'error';

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className={open ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]' : undefined}
      >
        <Table2 className="h-4 w-4" />
        All Facilities Table
      </Button>

      {open && (
        <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink900">
              All facilities{monthName && currentYear ? ` — ${monthName} ${currentYear}` : ''}
              {isCurrent ? (isComplete ? ' (final)' : ' (MTD)') : ''}
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <ControlSelect
                label="Month"
                value={month ?? ''}
                ariaLabel="Month"
                onChange={(v) => setMonth(Number(v))}
              >
                {monthOptions.map((m) => (
                  <option key={m} value={m}>
                    {m === currentMonth
                      ? `${MONTH_NAMES[m - 1]} ${isComplete ? '(latest)' : '(current)'}`
                      : MONTH_NAMES[m - 1]}
                  </option>
                ))}
              </ControlSelect>
              <ControlSelect
                label="Setting"
                value={setting}
                ariaLabel="Inpatient / Outpatient filter"
                onChange={(v) => setSetting(v as FacilitySetting)}
              >
                <option value="ALL">IP &amp; OP</option>
                <option value="IP">IP only</option>
                <option value="OP">OP only</option>
              </ControlSelect>
            </div>
          </div>

          {loadingPast ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : errorPast ? (
            <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
              Could not load that month.
            </div>
          ) : rows.length === 0 ? (
            setting !== 'ALL' ? (
              <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                <Filter className="h-5 w-5 text-muted-foreground" aria-hidden />
                <div className="text-sm font-medium text-ink900">No {setting} facilities this month</div>
                <button
                  type="button"
                  onClick={() => setSetting('ALL')}
                  className="text-xs font-medium text-[var(--brand-ink)] underline underline-offset-2"
                >
                  Show IP &amp; OP
                </button>
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No collections recorded{monthName ? ` for ${monthName}` : ''} yet.
              </div>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Facility</TableHead>
                  <TableHead>Setting</TableHead>
                  <TableHead className="text-right">Checks</TableHead>
                  <TableHead className="text-right">EFT</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${r.label}-${i}`}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-muted-foreground">{r.careSetting ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.eft)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.gross)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>TOTALS</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{money(totals.checks)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(totals.eft)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(totals.gross)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}
