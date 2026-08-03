'use client';

/**
 * Overview KPI row — small, modern KPI tiles sitting above the Master chart:
 *   • MTD Gross   — month-to-date collections gross, with a MoM trend.
 *   • YTD Gross   — year-to-date gross split IP / OP / IP+OP, with a YoY trend.
 *   • Year Forecast — a live linear-YTD run-rate projection, with a YoY-vs-prior-year trend.
 * Plus a toggle-button row: "All Facilities Table" (per-facility table for a selected
 * month) and "Future <tenant> Payments" (835-confirmed remits plus the operator-keyed
 * forecast, fetched only when opened). Each button reveals its panel below the row,
 * All-Facilities-style.
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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, Filter, Table2, X } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { ControlSelect } from '@/components/data-grid';
import { money } from '@/lib/format';
import {
  loadCollectionsDailyRange,
  loadCollectionsKpis,
  loadCollectionsYoy,
  loadEraUpcoming,
  loadFacilityDimension,
  loadUpcomingManual,
  loadUpcomingOverrides,
  saveUpcomingManual,
  deleteUpcomingManual,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type CollectionsYoy,
  type FacilityDimensionRow,
} from '@/lib/actions';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID, type DashboardView } from '@/lib/views';
import { EraUpcomingBody, type ForecastEditIntent } from './era-upcoming';
import type { EraUpcomingSummary } from '../../../src/veris/era835Upcoming.js';
import type { UpcomingOverrideSummary } from '../../../src/veris/upcomingOverride.js';
import type { ManualForecastRow } from '../../../src/veris/upcomingForecast';
import { useWidget } from './widgets';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The Future-Payments panel title, per view.
 *
 * NAMES THE TENANT rather than hardcoding "BXR", for the same reason chartTitleFor does in
 * overview-bar-chart.tsx: the 835-confirmed half of this panel is view-scoped, so on the
 * Indigo view a "Future BXR Payments" heading would sit directly above Indigo's remits, and on
 * Consolidated it would name one of the two books on screen. Consolidated stays unqualified
 * because it is both books and is not a tenant.
 *
 * NOTE the FORECAST half is BXR-only today regardless of this label — the sheet cron passes
 * BXR_TENANT_ID literally and the parser's alias table holds only BXR codes (023). So an Indigo
 * view shows Indigo's confirmed remits and no forecast rows. When an Indigo override tab exists
 * this label needs no change; the feed does.
 */
function futurePaymentsTitle(view: DashboardView): string {
  switch (view) {
    case 'bxr':
      return 'Future BXR Payments';
    case 'indigo':
      return 'Future Indigo Payments';
    case 'consolidated':
      return 'Future Payments';
  }
}

/** All Facilities care-setting filter. */
type FacilitySetting = 'ALL' | 'IP' | 'OP';

/**
 * All Facilities book (tenant) filter. Consolidated sums BXR + Indigo into one roster, so this
 * narrows it back to a single book. Meaningless on the bxr/indigo views — the book is already
 * fixed there — so the control is rendered ONLY for 'consolidated'.
 */
type FacilityBook = 'ALL' | 'BXR' | 'INDIGO';

/** Which book a row belongs to, from its (non-PHI) business_entity_id; null = neither/unknown. */
function bookOf(entityId: string | null): Exclude<FacilityBook, 'ALL'> | null {
  if (entityId === BXR_ENTITY_ID) return 'BXR';
  if (entityId === INDIGO_ENTITY_ID) return 'INDIGO';
  return null;
}

const BOOK_LABEL: Record<Exclude<FacilityBook, 'ALL'>, string> = { BXR: 'BXR', INDIGO: 'Indigo' };

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
    return <span className="ths-text-muted">— {label}</span>;
  }
  const up = pct > 0.05;
  const down = pct < -0.05;
  const cls = up ? 'ths-text-ok' : down ? 'ths-text-danger' : 'ths-text-muted';
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
      className="ths-notice"
    >
      <span className="ths-text-accent relative mt-[3px] flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      <p>
        <span className="ths-text-accent font-semibold">
          Showing {shownMonth} {y}
        </span>
        <span>
          {' '}— latest complete data, as of {asOf}. {nextMonth} collections post throughout the
          month; this view updates daily (~6&nbsp;AM).
        </span>
      </p>
    </div>
  );
}

/**
 * KPI tile, v2. Deliberately page-local rather than a new mode on the shared `Kpi`
 * in widgets.tsx: that component still dresses the Collections surface, which this
 * pass does not reskin, and a `variant` prop there would tie the two surfaces'
 * redesigns to each other. When Collections is ported, the two converge and this
 * one goes away.
 */
function V2Kpi({
  label,
  value,
  detail,
  sub,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="ths-card ths-elev-sm ths-kpi">
      <div className="ths-kpi-label">{label}</div>
      <div className="ths-kpi-value ths-num">{value}</div>
      {detail && <div className="ths-kpi-delta ths-num">{detail}</div>}
      {sub && <div className="ths-kpi-sub">{sub}</div>}
    </div>
  );
}

/** Loading skeleton: three KPI-shaped tiles. */
function KpiSkeletonRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="ths-card ths-elev-sm space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/**
 * The shared reveal-toggle (All Facilities / ERA). These two are the only way into their
 * panels, so they are sized and colored to be found: accent-outlined and tinted when
 * shut, filled accent when open (7.1:1 white-on-accent). The chevron flips with the
 * state — a conventional disclosure affordance — and aria-expanded carries the same fact
 * to assistive tech, so the state is never conveyed by color alone.
 */
function PanelToggleButton({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="ths-toggle">
      {children}
      <ChevronDown className="ths-toggle-chevron h-4 w-4" aria-hidden />
    </button>
  );
}

export function OverviewKpis({
  view,
  canEditForecast = false,
}: {
  view: DashboardView;
  /** super_admin only — surfaces the Future Payments edit controls. */
  canEditForecast?: boolean;
}) {
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  const [eraOpen, setEraOpen] = useState(false);
  // `view` is the active tenant scope. It is passed to every collections load* action (which
  // re-derives the entitled business_entity_id(s) SERVER-SIDE — the client value is only a hint)
  // and used as the useWidget/effect dependency, so switching the view re-fetches for the new
  // tenant. The facility dimension is tenant-agnostic reference data, so it is not view-scoped.
  const kpisState = useWidget<CollectionsKpis>(() => loadCollectionsKpis(view, 'overview'), [view]);
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
    loadCollectionsYoy(asOf, view)
      .then((r) => {
        if (live && r.ok) setYoy(r.data);
      })
      .catch(() => {});
    loadCollectionsDailyRange({ year, month }, view, 'overview')
      .then((r) => {
        if (live && r.ok) setPriorMonth(r.data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asOf, view]);

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
      <div className="ths-alert">Unable to load the headline metrics.</div>
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
        <V2Kpi
          label={monthName ? `MTD Gross · ${monthName}` : 'MTD Gross'}
          value={money(mtdGross)}
          detail={<Trend pct={momPct} label={priorMonthName ? `vs ${priorMonthName}` : 'vs last month'} />}
          sub={asOf ? `as of ${asOf}` : undefined}
        />
        <V2Kpi
          label="YTD Gross"
          value={money(ytdGross)}
          detail={
            <span>
              IP {money(ytdSplit.ip)} · OP {money(ytdSplit.op)}
            </span>
          }
          sub={<Trend pct={yoyPct} label={yoy ? `YoY collected vs ${yoy.prior_year}` : 'YoY'} />}
        />
        <V2Kpi
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

      <div className="flex flex-wrap items-center gap-2">
        <PanelToggleButton open={facilitiesOpen} onToggle={() => setFacilitiesOpen((s) => !s)}>
          <Table2 className="h-4 w-4" aria-hidden />
          All Facilities Table
        </PanelToggleButton>
        <PanelToggleButton open={eraOpen} onToggle={() => setEraOpen((s) => !s)}>
          <CalendarClock className="h-4 w-4" aria-hidden />
          {futurePaymentsTitle(view)}
        </PanelToggleButton>
      </div>

      <AllFacilitiesTable
        open={facilitiesOpen}
        onClose={() => setFacilitiesOpen(false)}
        kpis={kpis}
        dimByCode={dimByCode}
        asOf={asOf}
        view={view}
      />
      <EraUpcomingPanel
        open={eraOpen}
        onClose={() => setEraOpen(false)}
        view={view}
        canEdit={canEditForecast}
      />
    </div>
  );
}

/**
 * "Upcoming Payments" as a reveal panel — same interaction as the All Facilities table.
 * Fetches only while open (nothing is loaded for users who never click), re-fetching on each
 * open / view change so the figures are never stale-on-reveal.
 *
 * TWO READS, ONE PANEL, INDEPENDENTLY FAIL-SOFT. loadEraUpcoming is the 835-CONFIRMED half
 * and gates the panel: if it fails, the panel shows an error. loadUpcomingOverrides is the
 * operator-keyed FORECAST half (migration 023) and is strictly additive — an ok:false there
 * degrades to `overrides = null` and the confirmed half renders alone, with no error shown.
 * That is deliberate and load-bearing: 023 is not applied in every environment, and until it
 * is, that read fails on EVERY call. Coupling the panel's health to it would take a working
 * ERA tile down over a feed that is behaving exactly as designed.
 *
 * The two are requested concurrently, so the forecast never adds latency to the tile.
 */
function EraUpcomingPanel({
  open,
  onClose,
  view,
  canEdit,
}: {
  open: boolean;
  /** See AllFacilitiesTable.onClose — the toggle button owns this state. */
  onClose: () => void;
  view: DashboardView;
  /** super_admin only. Convenience for hiding controls; the Server Actions are the real gate. */
  canEdit: boolean;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [data, setData] = useState<EraUpcomingSummary | null>(null);
  const [overrides, setOverrides] = useState<UpcomingOverrideSummary | null>(null);
  const [manual, setManual] = useState<ManualForecastRow[]>([]);
  const [busy, setBusy] = useState(false);
  // Bumped after a successful write to re-run the loader — the tile must show the resolved
  // truth (correction applied, landed row gone) rather than optimistically patched state,
  // because the resolver's output depends on rows this component does not own.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setStatus('loading');
    setData(null);
    setOverrides(null);
    setManual([]);
    Promise.all([loadEraUpcoming(view), loadUpcomingOverrides(view), loadUpcomingManual(view)])
      .then(([era, ovr, man]) => {
        if (!live) return;
        // Neither the forecast feed nor the edit table gates the panel — see the note above.
        setOverrides(ovr.ok ? ovr.data : null);
        setManual(man.ok ? man.data.rows : []);
        if (era.ok) {
          setData(era.data);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, [open, view, reloadKey]);

  /**
   * Apply one edit intent from the tile. The Server Action re-checks super_admin and writes the
   * audit row — this handler only marshals and refetches, so nothing here is a security
   * boundary. Failures are left to the reload: the tile re-renders whatever the server actually
   * holds, which is the honest outcome whether the write landed or not.
   */
  async function applyEdit(intent: ForecastEditIntent) {
    setBusy(true);
    try {
      if (intent.op === 'delete-edit') {
        await deleteUpcomingManual(intent.id, view);
      } else if (intent.op === 'suppress') {
        await saveUpcomingManual(
          {
            kind: 'suppress',
            facilityCode: intent.facilityCode,
            payerLabel: intent.payerLabel,
            expectedDate: intent.expectedDate,
            amount: null,
            suppressReason: intent.reason,
            matchedEraKey: intent.matchedEraKey ?? null,
          },
          view,
        );
      } else {
        await saveUpcomingManual(
          {
            kind: 'correct',
            facilityCode: intent.facilityCode,
            payerLabel: intent.payerLabel,
            expectedDate: intent.expectedDate,
            amount: intent.amount,
          },
          view,
        );
      }
    } finally {
      setBusy(false);
      setReloadKey((k) => k + 1);
    }
  }

  if (!open) return null;
  return (
    <div className="ths-card ths-elev-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="ths-card-title">{futurePaymentsTitle(view)}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${futurePaymentsTitle(view).toLowerCase()}`}
          className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {status === 'error' ? (
        <div className="ths-alert">Unable to load future payments.</div>
      ) : status === 'ready' && data ? (
        <EraUpcomingBody
          data={data}
          overrides={overrides}
          manual={manual}
          canEdit={canEdit}
          busy={busy}
          onEdit={(intent) => void applyEdit(intent)}
        />
      ) : (
        <div className="ths-card-meta py-6 text-center">Loading…</div>
      )}
    </div>
  );
}

/** A per-facility row for the All Facilities table (summed for the selected month). */
interface FacilityTableRow {
  label: string;
  // CareSetting | null — includes 'BOTH' (a facility serving inpatient AND outpatient).
  careSetting: FacilityDimensionRow['care_setting'];
  /** Owning book (BXR / Indigo); null when the entity id is neither. Shown on Consolidated only. */
  book: Exclude<FacilityBook, 'ALL'> | null;
  checks: number;
  eft: number;
  gross: number;
}

/** A facility's per-month checks/eft/gross totals (the shape both sources reduce to). */
interface FacilityMonthTotals {
  facility_code: string | null;
  facility_name: string | null;
  /** Owning tenant — carried by BOTH sources (kpis.by_facility and the daily rows). Non-PHI. */
  business_entity_id: string | null;
  checks: number;
  eft: number;
  gross: number;
}

/**
 * "All Facilities Table" — the full (un-paginated) per-facility table summed for a
 * selected month, with an IP/OP setting filter and — on the Consolidated view only — a
 * BXR/Indigo book filter. `open` is owned by OverviewKpis (the
 * toggle button lives in its button row). Aggregate, non-PHI:
 * the current month reads the already-loaded MTD KPI rows; a past month fetches that
 * month's daily rows (loadCollectionsDailyRange) and sums them per facility. Joined to
 * the facility dimension for acronym labels + the IP/OP (care_setting) filter.
 *
 * The book filter needs no new query: business_entity_id already rides along on both
 * sources (CollectionsFacilityKpi and CollectionsDailyRow), so it filters client-side over
 * rows the panel has already loaded. Both filters are display-only narrowing — the TOTALS
 * row sums the VISIBLE rows, so it always ties to what's on screen.
 */
function AllFacilitiesTable({
  open,
  onClose,
  kpis,
  dimByCode,
  asOf,
  view,
}: {
  open: boolean;
  /** Dismiss control for the panel's own X — same state the toggle button owns, so the
   *  button un-presses when the panel closes itself. */
  onClose: () => void;
  kpis: CollectionsKpis;
  dimByCode: Map<string, FacilityDimensionRow>;
  asOf: string | null;
  view: DashboardView;
}) {
  const [setting, setSetting] = useState<FacilitySetting>('ALL');
  // The book filter only exists on Consolidated. Deriving the effective value (rather than
  // resetting state on view change) means switching away and back can never leave the table
  // silently narrowed by a control that isn't rendered.
  const [book, setBook] = useState<FacilityBook>('ALL');
  const showBook = view === 'consolidated';
  const effectiveBook: FacilityBook = showBook ? book : 'ALL';

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
    loadCollectionsDailyRange({ year: currentYear, month }, view, 'overview')
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setPastStatus('error');
          return;
        }
        // Grouped by facility AND owning book, matching the KPI reader's own grain (it groups
        // by facility_code, facility_name, business_entity_id). That keeps the book filter
        // exact: a code that somehow appeared under both tenants — and the '(unassigned)'
        // bucket, which legitimately can — stays attributable instead of being merged.
        const byFacility = new Map<string, FacilityMonthTotals>();
        for (const row of r.data.rows) {
          // Entity id first: it is a fixed-length uuid, so the join cannot be ambiguous
          // whatever characters a facility code contains.
          const key = `${row.business_entity_id}:${row.facility_code ?? '__unassigned__'}`;
          const e = byFacility.get(key);
          if (e) {
            e.checks += row.checks_amount;
            e.eft += row.eft_amount;
            e.gross += row.gross_amount;
          } else {
            byFacility.set(key, {
              facility_code: row.facility_code,
              facility_name: row.facility_name,
              business_entity_id: row.business_entity_id,
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
  }, [open, isCurrent, month, currentYear, view]);

  // Rows for display: current month → MTD KPI rows; past month → fetched + aggregated.
  // Joined to the dimension for the acronym label + IP/OP, then filtered by setting + book.
  const rows = useMemo<FacilityTableRow[]>(() => {
    const source: FacilityMonthTotals[] = isCurrent
      ? kpis.by_facility.map((f) => ({
          facility_code: f.facility_code,
          facility_name: f.facility_name,
          business_entity_id: f.business_entity_id,
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
          book: bookOf(f.business_entity_id),
          checks: f.checks,
          eft: f.eft,
          gross: f.gross,
        };
      })
      // A 'BOTH' facility (serves inpatient AND outpatient) is a member of both filters.
      .filter((r) => setting === 'ALL' || r.careSetting === setting || r.careSetting === 'BOTH')
      // Book filter: an unattributable row (book === null) is excluded by a specific book rather
      // than silently counted under it — the TOTALS row must equal the book actually selected.
      .filter((r) => effectiveBook === 'ALL' || r.book === effectiveBook)
      .sort((a, b) => b.gross - a.gross);
  }, [isCurrent, kpis, pastRows, dimByCode, setting, effectiveBook]);

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

  if (!open) return null;
  return (
    <div className="ths-card ths-elev-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="ths-card-title">
          {/* The heading names the active book so a narrowed table is never mistaken for the
              whole consolidated roster. */}
          {effectiveBook === 'ALL' ? 'All facilities' : `${BOOK_LABEL[effectiveBook]} facilities`}
          {monthName && currentYear ? ` — ${monthName} ${currentYear}` : ''}
          {isCurrent ? (isComplete ? ' (final)' : ' (MTD)') : ''}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <ControlSelect
            className="ths-input"
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
          {/* Consolidated only — the bxr/indigo views are already a single book. */}
          {showBook && (
            <ControlSelect
              className="ths-input"
              label="Book"
              value={book}
              ariaLabel="BXR / Indigo book filter"
              onChange={(v) => setBook(v as FacilityBook)}
            >
              <option value="ALL">BXR &amp; Indigo</option>
              <option value="BXR">BXR only</option>
              <option value="INDIGO">Indigo only</option>
            </ControlSelect>
          )}
          <ControlSelect
            className="ths-input"
            label="Setting"
            value={setting}
            ariaLabel="Inpatient / Outpatient filter"
            onChange={(v) => setSetting(v as FacilitySetting)}
          >
            <option value="ALL">IP &amp; OP</option>
            <option value="IP">IP only</option>
            <option value="OP">OP only</option>
          </ControlSelect>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close all facilities table"
            className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {loadingPast ? (
        <div className="ths-card-meta py-6 text-center">Loading…</div>
      ) : errorPast ? (
        <div className="ths-alert">Could not load that month.</div>
      ) : rows.length === 0 ? (
        // "Filtered to nothing" is a different story from "no data" — say which filters did it and
        // offer a one-click way back, rather than implying the month is empty.
        setting !== 'ALL' || effectiveBook !== 'ALL' ? (
          <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            <span className="ths-empty-icon mb-1">
              <Filter className="h-5 w-5" aria-hidden />
            </span>
            <div className="ths-card-title">
              No{' '}
              {[effectiveBook === 'ALL' ? null : BOOK_LABEL[effectiveBook], setting === 'ALL' ? null : setting]
                .filter(Boolean)
                .join(' ')}{' '}
              facilities this month
            </div>
            <button
              type="button"
              onClick={() => {
                setSetting('ALL');
                setBook('ALL');
              }}
              className="ths-btn ths-btn-primary ths-btn-sm mt-1"
            >
              {setting !== 'ALL' && effectiveBook === 'ALL' ? <>Show IP &amp; OP</> : 'Clear filters'}
            </button>
          </div>
        ) : (
          <div className="ths-card-meta py-8 text-center">
            No collections recorded{monthName ? ` for ${monthName}` : ''} yet.
          </div>
        )
      ) : (
        <div className="ths-scroll-x">
          <table className="ths-table">
            <thead>
              <tr>
                <th>Facility</th>
                {/* Only on Consolidated: on a single-book view every row would read the same. */}
                {showBook && <th>Book</th>}
                <th>Setting</th>
                <th className="num">Checks</th>
                <th className="num">EFT</th>
                <th className="num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.label}-${i}`}>
                  <td>{r.label}</td>
                  {showBook && (
                    <td className="ths-text-muted">{r.book ? BOOK_LABEL[r.book] : '—'}</td>
                  )}
                  <td className="ths-text-muted">{r.careSetting ?? '—'}</td>
                  <td className="num">{money(r.checks)}</td>
                  <td className="num">{money(r.eft)}</td>
                  <td className="num">{money(r.gross)}</td>
                </tr>
              ))}
              <tr className="ths-table-total">
                <td>TOTALS</td>
                {showBook && <td />}
                <td />
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
