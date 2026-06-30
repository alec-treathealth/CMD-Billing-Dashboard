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
import { Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pager } from '@/components/data-grid';
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

const FACILITIES_PAGE_SIZE = 8;

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

/** Loading skeleton: three KPI-shaped tiles. */
function KpiSkeletonRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="border-t-2 border-t-teal500">
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

  const momPct = priorMonthSamePeriod !== null ? pctChange(mtdGross, priorMonthSamePeriod) : null;
  const yoyPct = yoy ? pctChange(yoy.current_ytd_paid, yoy.prior_ytd_paid) : null;
  const forecastYoyPct = yoy && forecast !== null ? pctChange(forecast, yoy.prior_full_year_paid) : null;

  const priorMonthName = asOf ? MONTH_NAMES[priorMonthOf(asOf).month - 1] : null;
  const monthName = asOf ? MONTH_NAMES[Number(asOf.slice(5, 7)) - 1] : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="MTD Gross"
          value={money(mtdGross)}
          detail={<Trend pct={momPct} label={priorMonthName ? `vs ${priorMonthName}` : 'vs last month'} />}
          sub={asOf ? `${monthName} — as of ${asOf}` : undefined}
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

      <AllFacilitiesTable kpis={kpis} dimByCode={dimByCode} monthName={monthName} year={year} />
    </div>
  );
}

/** A per-facility row for the All Facilities table (MTD, summed for the current month). */
interface FacilityTableRow {
  label: string;
  setting: string;
  checks: number;
  eft: number;
  gross: number;
}

/**
 * "All Facilities Table" — a toggle that reveals a paginated, per-facility table summed
 * for the current month (MTD), reusing the shared Pager. Aggregate, non-PHI: reads only
 * the already-loaded KPI by-facility rows + the facility dimension (acronym / IP-OP).
 */
function AllFacilitiesTable({
  kpis,
  dimByCode,
  monthName,
  year,
}: {
  kpis: CollectionsKpis;
  dimByCode: Map<string, FacilityDimensionRow>;
  monthName: string | null;
  year: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);

  const rows = useMemo<FacilityTableRow[]>(() => {
    return kpis.by_facility
      .map((f) => {
        const dim = f.facility_code ? dimByCode.get(f.facility_code) : undefined;
        const label = dim?.display_acronym ?? f.facility_name ?? '(unassigned)';
        return {
          label,
          setting: dim?.care_setting ?? '—',
          checks: f.mtd_checks,
          eft: f.mtd_eft,
          gross: f.mtd_gross,
        };
      })
      .sort((a, b) => b.gross - a.gross);
  }, [kpis, dimByCode]);

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

  const pageRows = rows.slice(page * FACILITIES_PAGE_SIZE, page * FACILITIES_PAGE_SIZE + FACILITIES_PAGE_SIZE);
  const hasPrev = page > 0;
  const hasNext = rows.length > (page + 1) * FACILITIES_PAGE_SIZE;

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className={open ? 'border-teal500 text-teal700' : undefined}
      >
        <Table2 className="h-4 w-4" />
        All Facilities Table
      </Button>

      {open && (
        <div className="rounded-lg border border-line bg-card p-4 shadow-ths">
          <h3 className="mb-3 text-sm font-semibold text-ink900">
            All facilities{monthName && year ? ` — ${monthName} ${year}` : ''} (MTD)
          </h3>
          {rows.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No facilities to show.</div>
          ) : (
            <>
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
                  {pageRows.map((r, i) => (
                    <TableRow key={`${r.label}-${i}`}>
                      <TableCell>{r.label}</TableCell>
                      <TableCell className="text-muted-foreground">{r.setting}</TableCell>
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
              {(hasPrev || hasNext) && (
                <div className="mt-3">
                  <Pager
                    page={page + 1}
                    hasPrev={hasPrev}
                    hasNext={hasNext}
                    onPrev={() => setPage((p) => Math.max(0, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
