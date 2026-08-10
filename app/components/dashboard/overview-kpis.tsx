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
import { CalendarClock, ChevronDown, Filter, Plus, Table2, X } from 'lucide-react';

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
  matchUpcomingManual,
  loadManualDeposits,
  addManualDeposit,
  removeManualDeposit,
  type ManualDepositRow,
  type CollectionsDailyResult,
  type CollectionsKpis,
  type CollectionsYoy,
  type FacilityDimensionRow,
} from '@/lib/actions';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID, viewToEntityIds, type DashboardView } from '@/lib/views';
import {
  AddForecastForm,
  EraUpcomingBody,
  ForecastEditBanner,
  payerSuggestions,
  type ForecastEditIntent,
  type ForecastFacilityOption,
} from './era-upcoming';
import { runForecastEdit, type ForecastEditOutcome } from '@/lib/forecast/edit-feedback';
import {
  activeFacilityCodesForEntity,
  facilityCodesForEntity,
} from '../../../src/collections/cmdCustomers';
// The Overview tab's name for the no-facility bucket. Deliberately NOT the shared
// UNASSIGNED_FACILITY_LABEL, which the Collections tab still uses — see OTHER_FACILITY_LABEL.
import { OTHER_FACILITY_LABEL } from '../../../src/collections/summaryTypes';
import type { EraUpcomingSummary } from '../../../src/veris/era835Upcoming.js';
import type { UpcomingOverrideSummary } from '../../../src/veris/upcomingOverride.js';
import { resolveForecast, type ManualForecastRow } from '../../../src/veris/upcomingForecast';
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
  forecastVersion = 0,
  onForecastChange,
}: {
  view: DashboardView;
  /** super_admin only — surfaces the Future Payments edit controls. */
  canEditForecast?: boolean;
  /**
   * Bumped by ANY successful forecast write on the page, including one made by a sibling.
   * Folded into this subtree's loader deps so the Future Payments tile re-reads after the
   * top-level Add form writes — the two are no longer parent and child, so a shared counter
   * is what keeps them from disagreeing about what the operator just did.
   */
  forecastVersion?: number;
  /** Call after a successful forecast write so the Master BXR Chart re-reads too. */
  onForecastChange?: () => void;
}) {
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  const [eraOpen, setEraOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
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

  // Facilities a manual forecast row may name. The ROSTER decides tenancy (collections.facilities
  // is tenant-agnostic reference data and cannot), so the dimension is narrowed by
  // activeFacilityCodesForEntity — which is also exactly what the Server Action re-checks (it
  // applies facilityBelongsToEntity AND facilityIsActiveForEntity). Consolidated resolves to two
  // tenants, so it yields NOTHING and the form is replaced by an explanation rather than offering
  // choices the server would reject.
  //
  // ACTIVE, not merely owned: this form CREATES a forecast, and a retired CMD account can never
  // receive a payment, so offering one would guarantee a row that never resolves. Retired
  // facilities stay owned (their history remains attributable) — they are just not selectable here.
  const activeCodes = new Set(
    view === 'consolidated' ? [] : activeFacilityCodesForEntity(viewToEntityIds(view)[0] ?? ''),
  );
  const forecastFacilityOptions: ForecastFacilityOption[] =
    view === 'consolidated'
      ? []
      : activeFacilityCodesForEntity(viewToEntityIds(view)[0] ?? '')
          .map((code) => {
            const dim = dimByCode.get(code);
            // Label with everything a human needs to pick confidently; fall back to the bare
            // code rather than hiding a roster facility the dimension has not seeded.
            const name = dim?.facility_name;
            const acr = dim?.display_acronym;
            return { code, label: acr && name ? `${acr} — ${name}` : (name ?? acr ?? code) };
          })
          .sort((a, b) => a.label.localeCompare(b.label));

  /**
   * Facilities a manual DEPOSIT may name — OWNED, including retired.
   *
   * Deliberately a different list from forecastFacilityOptions above, for the same reason
   * addManualDeposit deliberately omits the liveness guard: a deposit records money that ALREADY
   * ARRIVED, and a facility whose CMD account closed last month still has every dollar it
   * collected before that. Offering only active facilities would make historical entry
   * impossible for exactly the books that most need closing out.
   *
   * Still ownership-scoped, so the cross-tenant guard the Server Action re-checks has the same
   * answer: retirement removes a facility from polling, never from a book.
   */
  const depositFacilityOptions: ForecastFacilityOption[] =
    view === 'consolidated'
      ? []
      : facilityCodesForEntity(viewToEntityIds(view)[0] ?? '')
          .map((code) => {
            const dim = dimByCode.get(code);
            const name = dim?.facility_name;
            const acr = dim?.display_acronym;
            const label = acr && name ? `${acr} — ${name}` : (name ?? acr ?? code);
            // Name the state rather than hiding it: picking a closed account for a historical
            // payment is correct, but doing it by accident for a recent one is not.
            const retired = !activeCodes.has(code);
            return { code, label: retired ? `${label} (closed account)` : label };
          })
          .sort((a, b) => a.label.localeCompare(b.label));

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
        {/* SUPER-ADMIN ONLY, and gated on the SAME two conditions as every other forecast
            control: the role (canEditForecast, decided server-side in page.tsx) AND a single
            tenant in scope (forecastFacilityOptions is empty exactly on Consolidated, where
            singleWriteEntity would reject the write). Rendering it on Consolidated would be a
            button whose every submission fails — the dead-control class this codebase has
            already been bitten by. The Server Action re-checks both regardless. */}
        {canEditForecast && forecastFacilityOptions.length > 0 && (
          <PanelToggleButton open={addOpen} onToggle={() => setAddOpen((s) => !s)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add expected payment
          </PanelToggleButton>
        )}
      </div>

      {/* Above both reveal panels: this is a CREATE control, and burying it under the lists it
          feeds is what made it undiscoverable in its old table-bottom position. */}
      <AddForecastPanel
        open={addOpen}
        onClose={() => setAddOpen(false)}
        view={view}
        facilityOptions={forecastFacilityOptions}
        depositFacilityOptions={depositFacilityOptions}
        onSaved={onForecastChange}
      />
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
        facilityOptions={forecastFacilityOptions}
        externalVersion={forecastVersion}
        onChanged={onForecastChange}
      />
    </div>
  );
}

/**
 * "Add an expected payment" as its own reveal panel at the top of Overview.
 *
 * WHY IT IS NOT INSIDE THE FUTURE PAYMENTS TILE ANY MORE. It was rendered at the bottom of
 * that tile — below the upcoming list, the overdue strip and the hidden strip — and the tile
 * itself is collapsed by default. Creating a forecast row therefore took a click to open the
 * panel, a scroll past three sections, and prior knowledge that a form was down there at all.
 * A create control has to be reachable before you have read the list it adds to.
 *
 * IT FETCHES ITS OWN COPY OF THE FORECAST, and only while open. The payer type-ahead is built
 * from the same `payerSuggestions(resolved.rows, era.groups)` the tile used, so hoisting the
 * form without hoisting that read would have silently downgraded the field to a bare text box.
 * The duplicate read is bounded (one on-demand open, three actions) and buys one definition of
 * the suggestion list instead of two that drift.
 *
 * NOT A SECURITY BOUNDARY. The caller renders this only for a super admin with one tenant in
 * scope; saveUpcomingManual re-checks the role, re-derives the tenant server-side, re-checks
 * facility ownership and liveness, and writes the claims.access_audit row.
 */
function AddForecastPanel({
  open,
  onClose,
  view,
  facilityOptions,
  depositFacilityOptions,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  view: DashboardView;
  /** ACTIVE facilities — a forecast about the future cannot name a closed account. */
  facilityOptions: ForecastFacilityOption[];
  /** OWNED facilities incl. retired — a historical deposit legitimately names a closed one. */
  depositFacilityOptions: ForecastFacilityOption[];
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ForecastEditOutcome | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Suggestions only. A failure here degrades the payer field to free text — which is exactly
  // what it was before this panel existed — so it is deliberately silent and never blocks the
  // form. The form is the point; the type-ahead is an affordance.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSuggestions([]);
    Promise.all([loadEraUpcoming(view), loadUpcomingOverrides(view), loadUpcomingManual(view)])
      .then(([era, ovr, man]) => {
        if (!live || !era.ok) return;
        // BOTH partitions, exactly as EraUpcomingBody does it. An overdue row's payer is just
        // as valid a suggestion as an upcoming one — and on a book that is entirely overdue
        // (a real state this tile has a dedicated branch for) `upcoming` alone is empty.
        const resolved = resolveForecast(
          ovr.ok ? [...ovr.data.upcoming.rows, ...ovr.data.overdue.rows] : [],
          man.ok ? man.data.rows : [],
        );
        setSuggestions(payerSuggestions(resolved.rows, era.data.groups));
      })
      .catch(() => {
        /* type-ahead only — see above */
      });
    return () => {
      live = false;
    };
  }, [open, view]);

  // Clear stale feedback on close/view change, matching EraUpcomingPanel. Not on a save: the
  // success message is the whole point of the save and must outlive it.
  useEffect(() => {
    setOutcome(null);
  }, [open, view]);

  async function applyEdit(intent: ForecastEditIntent) {
    setBusy(true);
    setOutcome({ tone: 'busy', text: 'Saving…' });
    const { outcome: result, refetch } = await runForecastEdit(intent, view, {
      save: saveUpcomingManual,
      remove: deleteUpcomingManual,
      match: matchUpcomingManual,
    });
    setOutcome(result);
    setBusy(false);
    // Tell the page, not just this panel. The write has to reach the Future Payments tile AND
    // the Master BXR Chart's forecast series — the operator's whole reason for adding a row is
    // that it should show up, and "it appears after the next cron" is the bug being fixed.
    if (refetch) onSaved?.();
  }

  if (!open) return null;
  return (
    <div className="ths-card ths-elev-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="ths-card-title">Add an expected payment</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close add expected payment"
          className="ths-btn ths-btn-ghost ths-btn-icon ths-btn-sm"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ForecastEditBanner outcome={outcome} />
      <ManualDepositSection
        view={view}
        facilityOptions={depositFacilityOptions}
        onChanged={onSaved}
      />
      <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--color-divider)' }}>
        <p className="ths-card-meta mb-2">
          Or schedule a <span className="font-medium">future</span> expected payment. This does
          not count toward MTD until the money actually arrives — it appears on the Future
          Payments tile only.
        </p>
        <AddForecastForm
          facilityOptions={facilityOptions}
          payerSuggestions={suggestions}
          busy={busy}
          onEdit={(intent) => void applyEdit(intent)}
        />
      </div>
    </div>
  );
}

/**
 * RECORD A PAYMENT CMD HAS NOT POSTED YET — the half that actually moves the numbers.
 *
 * Writes `collections.daily_collections` with source_tag='manual' (migration 0096), which the
 * MTD/YTD cards, the All Facilities table and the Master chart all read through
 * daily_collections_resolved. A forecast row does none of that, which is what made the original
 * feature useless: "if it doesn't add to the actual MTD total or All Facilities table it's
 * useless" (Alec, 2026-08-10).
 *
 * NO PAYER FIELD, and that is a real limitation rather than an oversight. daily_collections is
 * facility-day grain — checks, EFT, gross — with no payer column anywhere in it, and none of
 * the three surfaces this feeds displays a payer. Collecting one here would either be silently
 * discarded on write or force a second row in a second table to hold it. The Future Payments
 * forecast form below still takes a payer, because 023/024 do have the column.
 *
 * DOUBLE COUNTING IS FLAGGED, NEVER AUTO-RESOLVED. Once CMD posts a deposit for the same
 * facility-day, `cmd_now_covers` goes true and the row is marked — but it keeps counting until
 * a human removes it. Auto-suppressing would swallow a genuine second same-day payment
 * invisibly; that trade was considered and rejected.
 */
function ManualDepositSection({
  view,
  facilityOptions,
  onChanged,
}: {
  view: DashboardView;
  facilityOptions: ForecastFacilityOption[];
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ManualDepositRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ForecastEditOutcome | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    loadManualDeposits(view)
      .then((r) => {
        if (live) setRows(r.ok ? r.data.rows : []);
      })
      .catch(() => {
        /* the form still works without the list; a failed read must not block a write */
      });
    return () => {
      live = false;
    };
  }, [view, tick]);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setNote({ tone: 'busy', text: 'Recording…' });
    const r = await addManualDeposit(
      {
        facilityCode: String(data.get('facility') ?? ''),
        paymentDate: String(data.get('date') ?? ''),
        method: String(data.get('method') ?? 'EFT') === 'Check' ? 'Check' : 'EFT',
        amount: String(data.get('amount') ?? '').trim(),
      },
      view,
    );
    setBusy(false);
    if (r.ok) {
      // NAME THE MONTH IT LANDED IN. A historical payment is fully supported (the view carries
      // it into that month's All Facilities figures and into YTD — measured 2026-08-10: a March
      // deposit moved March by exactly its amount and YTD by the same), but the MTD card and
      // whichever month the table is showing will NOT move for a back-dated one. Saying
      // "Recorded — counts toward MTD" there would be a flat lie, and silence would read as the
      // write having failed, which is the confusion this whole feature has already produced once.
      const iso = String(data.get('date') ?? '');
      const monthName = MONTH_NAMES[Number(iso.slice(5, 7)) - 1] ?? '';
      const isCurrentPeriod = iso.slice(0, 7) === new Date().toISOString().slice(0, 7);
      setNote({
        tone: 'ok',
        text: isCurrentPeriod
          ? 'Recorded — it now counts toward MTD, All Facilities and the chart.'
          : `Recorded into ${monthName} ${iso.slice(0, 4)} — it counts toward that month and YTD, not MTD. Switch the month picker to ${monthName} to see it.`,
      });
      form.reset();
      setTick((t) => t + 1);
      // The chart and the KPI cards live outside this subtree; the page counter reaches them.
      onChanged?.();
    } else {
      setNote({ tone: 'error', text: depositErrorText(r.error) });
    }
  }

  async function remove(id: number) {
    setBusy(true);
    setNote({ tone: 'busy', text: 'Removing…' });
    const r = await removeManualDeposit(id, view);
    setBusy(false);
    // `removed: false` means the row was already gone — honest, and still worth reloading,
    // because it means this list is stale (same reasoning as the forecast delete path).
    setNote(
      r.ok
        ? r.removed
          ? { tone: 'ok', text: 'Removed — it no longer counts toward MTD.' }
          : { tone: 'info', text: 'That payment was already removed. Nothing changed.' }
        : { tone: 'error', text: depositErrorText(r.error) },
    );
    setTick((t) => t + 1);
    onChanged?.();
  }

  return (
    <div>
      <p className="ths-card-meta mb-2">
        Record a payment you have received that CollaborateMD has not posted yet. It counts
        toward <span className="font-medium">MTD</span>, the All Facilities table and the chart
        immediately.
      </p>
      <ForecastEditBanner outcome={note} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          Facility
          <select name="facility" required className="ths-input" aria-label="Facility">
            {facilityOptions.map((f) => (
              <option key={f.code} value={f.code}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Date received
          <input type="date" name="date" required className="ths-input" aria-label="Date received" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Method
          <select name="method" className="ths-input" aria-label="Payment method">
            <option value="EFT">EFT</option>
            <option value="Check">Check</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Amount
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            required
            // Mirrors the MONEY regex in actions.ts and 0096's positive-amount CHECK. The
            // browser blocks a bad value and announces it ON the field, before any round trip.
            pattern="\d{1,10}(\.\d{1,2})?"
            title="Dollars, up to two decimals — e.g. 4200 or 4200.50"
            className="ths-input ths-num"
            aria-label="Amount received"
          />
        </label>
        <button type="submit" className="ths-btn ths-btn-primary ths-btn-sm" disabled={busy}>
          Record payment
        </button>
      </form>

      {rows.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="ths-tag ths-tag-accent-2">Recorded</span>
              <span className="ths-num tabular-nums">{money(d.gross_amount)}</span>
              <span>
                {d.facility_code} · {d.payment_date} ·{' '}
                {Number(d.checks_amount) > 0 ? 'Check' : 'EFT'}
              </span>
              {/* The prompt, not an automatic removal — see the component header. */}
              {d.cmd_now_covers && (
                <span className="ths-tag ths-tag-warn">
                  CMD has now posted this facility-day — remove to avoid double counting
                </span>
              )}
              <button
                type="button"
                className="ths-btn ths-btn-ghost ths-btn-sm"
                disabled={busy}
                aria-label={`Remove recorded payment: ${d.facility_code} ${d.payment_date}`}
                onClick={() => void remove(d.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Server codes → an operator-actionable sentence. Unknown codes never print the code. */
function depositErrorText(code: string): string {
  switch (code) {
    case 'forbidden':
      return 'You do not have permission to record payments.';
    case 'pick_a_tenant_view':
      return 'Switch to the BXR or Indigo view first — a payment has to name one company’s book.';
    case 'facility_not_in_tenant':
      return 'That facility is not in this view’s book. Switch to the view that owns it.';
    case 'facility_retired':
      return 'That facility’s account is closed, so no payment can arrive for it.';
    case 'bad_amount':
      return 'Enter an amount in dollars, up to two decimals — e.g. 4200 or 4200.50.';
    case 'bad_date':
      return 'Enter the date received as a calendar date.';
    default:
      // write_failed and anything unrecognised: the outcome is genuinely unknown, so the
      // message must not claim either way, and internals never reach the operator.
      return 'That may not have been saved. Reopen this panel to check before trying again.';
  }
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
  canEdit: hasEditRole,
  facilityOptions,
  externalVersion,
  onChanged,
}: {
  open: boolean;
  /** See AllFacilitiesTable.onClose — the toggle button owns this state. */
  onClose: () => void;
  view: DashboardView;
  /** super_admin only. Convenience for hiding controls; the Server Actions are the real gate. */
  canEdit: boolean;
  /** The active tenant's facilities — the only valid targets for a manual add. Empty on
   *  Consolidated, where a write has no single tenant to name. */
  facilityOptions: ForecastFacilityOption[];
  /**
   * Page-level forecast counter. Bumped by a SIBLING's write (the top-of-page Add form), and
   * folded into the loader deps below so this tile re-reads. Without it, adding a payment from
   * the new button would leave an already-open tile showing the pre-write list — the row would
   * be in the database and absent from the surface that exists to display it.
   */
  externalVersion: number;
  /** Bubble this panel's own successful writes up, so the chart's forecast series re-reads. */
  onChanged?: () => void;
}) {
  /**
   * EDITABLE = THE ROLE **AND** A SINGLE TENANT IN SCOPE.
   *
   * The role alone is not enough, and shipping row controls on the overdue rows is what made
   * that bite. Every write resolves its tenant through singleWriteEntity, which returns null
   * whenever the view maps to more than one entity — so on Consolidated a super admin gets a
   * full set of live-looking controls whose every invocation is rejected with
   * 'pick_a_tenant_view'. That is the same class of lie as the dead buttons this change exists
   * to remove: a control that cannot succeed must not render.
   *
   * facilityOptions is the signal because it is the SAME one the server re-checks — the caller
   * derives it from activeFacilityCodesForEntity, empty exactly on Consolidated, and
   * AddForecastForm has been using it for this purpose since 024. Reusing it keeps one definition
   * of "a write has somewhere to land" instead of two that can drift.
   */
  const canEdit = hasEditRole && facilityOptions.length > 0;
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [data, setData] = useState<EraUpcomingSummary | null>(null);
  const [overrides, setOverrides] = useState<UpcomingOverrideSummary | null>(null);
  const [manual, setManual] = useState<ManualForecastRow[]>([]);
  const [busy, setBusy] = useState(false);
  // Bumped after a successful write to re-run the loader — the tile must show the resolved
  // truth (correction applied, landed row gone) rather than optimistically patched state,
  // because the resolver's output depends on rows this component does not own.
  const [reloadKey, setReloadKey] = useState(0);
  // The last edit's outcome, held HERE and not in the body, for three reasons: the body is a
  // pure leaf by contract, the body UNMOUNTS on the refetch that follows a write (the loader
  // sets status='loading' and data=null), and a live region only announces reliably when it was
  // already in the DOM before its text changed. All three say the same thing — the message must
  // outlive the thing it is about.
  const [editOutcome, setEditOutcome] = useState<ForecastEditOutcome | null>(null);
  // "Could not read the edits" is NOT "there are no edits" — see the banner below.
  const [manualFailed, setManualFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setStatus('loading');
    setData(null);
    setOverrides(null);
    setManual([]);
    setManualFailed(false);
    Promise.all([loadEraUpcoming(view), loadUpcomingOverrides(view), loadUpcomingManual(view)])
      .then(([era, ovr, man]) => {
        if (!live) return;
        // Neither the forecast feed nor the edit table gates the panel — see the note above.
        setOverrides(ovr.ok ? ovr.data : null);
        setManual(man.ok ? man.data.rows : []);
        setManualFailed(!man.ok);
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
    // externalVersion sits alongside reloadKey deliberately rather than replacing it: this
    // panel's own writes stay local and instant, while a sibling's write reaches it through
    // the page counter. Collapsing the two would make every tile write also re-render the
    // chart's forecast series, which is correct but noisier than it needs to be.
  }, [open, view, reloadKey, externalVersion]);

  // Clear the feedback on panel close and on a view change — deliberately NOT on reloadKey.
  // reloadKey is bumped by the very write whose outcome we are showing, so folding this into the
  // loader effect above would erase the message the instant it appeared. EraUpcomingPanel stays
  // MOUNTED while closed (`if (!open) return null` is a render guard, not an unmount), so
  // without this a failure from a previous open reappears on reopen.
  useEffect(() => {
    setEditOutcome(null);
  }, [open, view]);

  /**
   * Apply one edit intent from the tile. The Server Action re-checks super_admin and writes the
   * audit row — this handler only marshals, surfaces the result, and decides whether to refetch;
   * nothing here is a security boundary.
   *
   * THE RESULT IS NOT DISCARDED. It used to be, on the reasoning that "the tile re-renders
   * whatever the server actually holds, which is the honest outcome whether the write landed or
   * not". That is false when nothing was attempted: an unchanged tile after a rejection is
   * indistinguishable from an unchanged tile after a no-op, which is exactly how a guaranteed
   * no-op (a bigint id arriving as a string) survived unnoticed. Every rejection now reaches the
   * operator through the panel's live region.
   *
   * REFETCH ONLY WHEN THE SERVER MAY HAVE CHANGED STATE — see shouldRefetch in
   * app/lib/forecast/edit-feedback.ts.
   */
  async function applyEdit(intent: ForecastEditIntent) {
    setBusy(true);
    // Also empties the alert region, which is load-bearing rather than cosmetic: two identical
    // consecutive failures produce identical text, and a live region with no empty transition in
    // between does not re-announce.
    setEditOutcome({ tone: 'busy', text: 'Saving…' });
    const { outcome, refetch } = await runForecastEdit(intent, view, {
      save: saveUpcomingManual,
      remove: deleteUpcomingManual,
      // 033: confirming a landed MANUAL add reconciles the row in place instead of writing a
      // second 'suppress' beside it. Without this dep a 'match' intent reports unreachable.
      match: matchUpcomingManual,
    });
    setEditOutcome(outcome);
    setBusy(false);
    if (refetch) {
      setReloadKey((k) => k + 1);
      // A Remove or a Mark-landed here changes what the chart's forecast series should show,
      // so the page has to hear about it too — not just this tile.
      onChanged?.();
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
      {/* ABOVE the branch switch on purpose: the post-write refetch drops the tile into
          'loading' and unmounts the body, so a message rendered inside it would flash and
          vanish — and its live region would be torn down mid-announcement. */}
      <ForecastEditBanner outcome={editOutcome} />
      {/* ⚠️ "COULD NOT READ THE EDITS" IS NOT "THERE ARE NO EDITS", and the two fail-soft reads
          on this panel are NOT symmetric — do not collapse them into one policy.
          A failed OVERRIDES read (023) REMOVES forecast rows. Subtractive, safe, and the
          documented reason it degrades in silence: 023 is not applied in every environment.
          A failed MANUAL read (024) ADDS MONEY BACK. `manual: []` is indistinguishable from
          "no edits exist", so every suppression un-applies and every correction reverts —
          a payment the operator marked landed reappears as live forecast, on a tile that looks
          authoritative. That has to be said out loud, not degraded through.
          Rendered beside the body rather than instead of it: the ERA-confirmed half is still
          true, and blanking a working tile over the edit feed would be its own lie. */}
      {status === 'ready' && manualFailed && (
        <p className="ths-alert mb-3" role="status">
          Your saved edits could not be read, so this tile is showing the sheet feed unresolved —
          anything marked landed or corrected is not applied here. Reopen the panel to retry.
        </p>
      )}
      {/* Said ONCE, up front, instead of on every rejected click. A super admin on Consolidated
          has the role but no single tenant for a write to land in, so no row control renders —
          this replaces them with the reason. AddForecastForm carries the same sentence for the
          case where it is the only control on screen; the wording is deliberately identical so
          the two never read as different rules. */}
      {hasEditRole && !canEdit && status === 'ready' && (
        <p className="ths-card-meta mb-3">
          Switch to the BXR or Indigo view to change future payments — an edit has to name one
          company&apos;s book.
        </p>
      )}
      {status === 'error' ? (
        <div className="ths-alert">Unable to load future payments.</div>
      ) : status === 'ready' && data ? (
        // Same height bound as the All Facilities table. This tile is the taller of the two —
        // a group list, an overdue strip, a stale strip, a hidden strip and a reconciled strip
        // can all be on screen at once — so unbounded it buried the Master chart entirely.
        <div className="ths-panel-scroll">
          <EraUpcomingBody
            data={data}
            overrides={overrides}
            manual={manual}
            canEdit={canEdit}
            busy={busy}
            facilityOptions={facilityOptions}
            onEdit={(intent) => void applyEdit(intent)}
          />
        </div>
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
          // "Interest Payments/Other", not "(unassigned)" — Alec, 2026-08-10. See
          // OTHER_FACILITY_LABEL for why this is a display name and NOT a classifier, and why
          // the Collections tab deliberately keeps the older wording.
          label: dim?.display_acronym ?? f.facility_name ?? OTHER_FACILITY_LABEL,
          careSetting: dim?.care_setting ?? null,
          book: bookOf(f.business_entity_id),
          checks: f.checks,
          eft: f.eft,
          gross: f.gross,
        };
      })
      // A 'BOTH' facility (serves inpatient AND outpatient) is a member of both filters.
      //
      // ⚠️ AN UNCLASSIFIED ROW (careSetting === null) SURVIVES EVERY SETTING FILTER, and that
      // is the fix, not an oversight. It used to be dropped — `r.careSetting === setting` is
      // false for null — while the MTD/YTD cards above kept counting it, because those read
      // `kpis.mtd`/`kpis.ytd`, which sum `by_facility` UNFILTERED. So selecting IP or OP
      // silently removed money from the TOTALS row while the card above still showed it, with
      // nothing on screen saying the two now disagreed.
      //
      // Nothing triggers it today: all 15 BXR facilities carry a care_setting (measured
      // 2026-08-10, 9 IP / 6 OP) and there are zero null-facility deposit rows. It is one
      // unmapped facility away from being live, which is exactly when a silent subtraction is
      // hardest to notice — the number just looks a bit low.
      //
      // Showing it under an IP filter is the lesser wrong: it is money, it is real, and it is
      // labelled "Interest Payments/Other" so a reader can see it is not classified rather
      // than having it vanish.
      .filter((r) => setting === 'ALL' || r.careSetting === null || r.careSetting === setting || r.careSetting === 'BOTH')
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

  /**
   * RECONCILIATION AGAINST THE MTD CARD — the whole point of this block.
   *
   * The MTD Gross card above sums `kpis.by_facility` with no filter at all. This table's TOTALS
   * row sums the FILTERED rows. Those are two different numbers by construction whenever a
   * Setting or Book filter is active, and until now nothing on screen said so — a reader
   * comparing the card to the table had no way to tell a legitimate narrowing from money going
   * missing.
   *
   * So: state which it is. When no filter is active the two MUST agree, and a discrepancy is a
   * real defect the caption surfaces instead of hiding. When a filter IS active the caption
   * names the excluded amount, so the arithmetic closes either way.
   *
   * Current month only. A past month's rows come from loadCollectionsDailyRange, which the MTD
   * card never reads, so there is no card to reconcile against and claiming one would be a
   * fabricated check.
   */
  const reconciliation = useMemo(() => {
    if (!isCurrent) return null;
    const unfiltered = kpis.mtd.gross;
    // Cents, because these are two float sums of the same decimal data and an exact === would
    // report a phantom discrepancy on a rounding artifact.
    const diff = Math.round((unfiltered - totals.gross) * 100) / 100;
    return { unfiltered, diff, filtered: setting !== 'ALL' || effectiveBook !== 'ALL' };
  }, [isCurrent, kpis, totals.gross, setting, effectiveBook]);

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
        // Bounded height + sticky head/total: 15 facilities plus a header pushed the Master
        // chart off the page, so opening this to read a number cost you the chart you were
        // comparing it to. See .ths-panel-scroll in ths-v2.css.
        <div className="ths-scroll-x ths-panel-scroll">
          <table className="ths-table ths-table-sticky">
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
          {/* THE TIE-OUT TO THE MTD CARD. Without this the reader has two gross figures on one
              screen and no way to tell a deliberate narrowing from money going missing. Three
              honest states, never silence:
                · filtered      → name the excluded amount, so the arithmetic closes
                · unfiltered OK → say so positively; this is the claim being made
                · unfiltered ≠  → a real defect. Surface it rather than let the reader find it. */}
          {reconciliation && (
            <p className="ths-card-meta mt-2" role="status">
              {reconciliation.filtered ? (
                <>
                  Filtered view. These totals cover the rows shown;{' '}
                  {money(reconciliation.diff)} of the {money(reconciliation.unfiltered)} MTD Gross
                  above sits outside the current filters.
                </>
              ) : reconciliation.diff === 0 ? (
                <>Ties to MTD Gross above ({money(reconciliation.unfiltered)}).</>
              ) : (
                <span className="ths-text-danger">
                  These totals do not tie to MTD Gross above ({money(reconciliation.unfiltered)}) —
                  a difference of {money(reconciliation.diff)} with no filter applied. Report this.
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
