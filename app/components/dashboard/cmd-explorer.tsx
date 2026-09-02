'use client';

/**
 * "Collections" grid (Derek's 14-column CMD batch export) — DB-backed charge-line detail,
 * fronted by a SMART SEARCH: type a term and the panel first shows an aggregate summary of
 * everything matching (count + money totals + the top facilities / payers / CPT codes), each
 * of which is a clickable drill-down chip that refines the detail grid below. The noisy rows
 * stay one click away instead of being the first thing you face.
 *
 * Search is a SERVER-SIDE substring (ILIKE) match over the 4 TEXT columns (facility / payer / CPT /
 * revenue code) — the numeric + date columns aren't substring-searchable (a leading-wildcard ILIKE on
 * them can't use an index and doubled the cost; use the date window / sort / drill chips instead), and
 * the 3 PHI columns are encrypted at rest (the gated Patient lookup handles those). Scope still FOLLOWS
 * the visible columns — hiding a searchable column drops it from search too. Typing is debounced
 * (~550ms) and needs at least 3 characters, so a large dataset isn't hammered by throwaway prefixes.
 * A Month/Year window still scopes everything server-side. Row PHI renders •••••• until "Reveal all"
 * decrypts the current page in one audited call (held in memory only, dropped on page/filter change).
 * The "Columns" menu controls which columns are shown (+ their order) and persists that as a named
 * per-user saved view; shown columns are also what search matches. Rows order by the sort key.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  Building2,
  CalendarRange,
  ChevronDown,
  Columns3,
  CreditCard,
  Eye,
  EyeOff,
  Fingerprint,
  GripVertical,
  Layers,
  Lock,
  Minus,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Trash2,
  TrendingDown,
  X,
} from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
// `Table` is deliberately NOT imported: this grid renders its own <table> so the scrollport can be
// the ONE scroll container (see the scrollport comment below). The semantic wrappers still come
// from the shared primitive, so the markup is unchanged.
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect, Pager } from '@/components/data-grid';
import { MultiSelectTagPicker, type PickerOption } from '@/components/ui/multi-select-tag-picker';
// Pure, and deliberately OUTSIDE this file so it can be unit-tested: importing this component pulls
// in lib/actions.ts → lib/access.ts, which calls React `cache` at module scope and cannot load under
// the test runner at all.
import {
  expandFacilityKeys,
  facilityGroupsFrom,
  facilityPickerOptionsFrom,
} from '@/lib/collections/facilityPickerOptions';
import { applyEmployerFilter } from '@/lib/collections/employerSegment';
import { expandEmployerKeys } from '../../../src/collections/employerCanonical.js';
// The AI panel's prompt ASKS for markdown; this renders it as markup instead of printing `**`/`##`.
import { Markdown } from '@/components/ui/markdown';
import { PHI_MASK } from '@/lib/phi';
import {
  loadCmdReport,
  searchCollectionsPatientName,
  loadCmdSearchSummary,
  loadCmdExplorerFacilities,
  loadCmdExplorerPayers,
  loadCollectionsEmployerCoverage,
  loadCollectionsEmployerVocabulary,
  loadCmdReportGrouped,
  type CmdGroupedResult,
  type CmdExplorerGroupRow,
  type CanonicalEmployer,
  loadCohortCurve,
  loadCohortDrilldown,
  generateCollectionsAiAnalysis,
  type CollectionsAiAnalysisResult,
  revealCmdReportRows,
  listGridViews,
  saveGridView,
  saveGridLayout,
  setDefaultGridView,
  deleteGridView,
  type CmdReportResult,
  type CmdSearchGroup,
  type CmdComboGroup,
  type CmdSearchSummary,
  type CmdExplorerCursor,
  type CmdExplorerSort,
  type CmdFacilityOption,
  type CmdFacilitiesResult,
  type GridViewsResult,
  type CohortCurve,
  type CohortCurvePoint,
  type CohortDrilldownResult,
  type CohortDrilldownTable,
  type GridViewRow,
} from '@/lib/actions';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../../src/collections/cmdExplorer';
// The Facility cell lives in its own PURE module so the hermetic render suite can assert it
// directly — this file is a hooks-and-effects client island that renderToStaticMarkup cannot run.
import { FacilityCell } from './facility-cell';
import { PaymentDateCell } from './payment-date-cell';
import { COMBO_RANKING_EXPLAINER, rankCombos } from '../../../src/collections/comboRanking';
import { deriveGridLayout, isAutoGridView } from '../../../src/collections/gridViewLayout';
import { facilityCodesForEntity } from '../../../src/collections/cmdCustomers';
import { INDIGO_ENTITY_ID } from '../../../src/tenants';
import {
  isSufficientForAi,
  parseAiSections,
  INSUFFICIENT_COPY,
  AI_SECTIONS,
  type CollectionsAiInput,
} from '../../../src/collections/aiAnalysis';
import type { DashboardView } from '@/lib/views';

type ColKey =
  | keyof Omit<CmdExplorerRow, 'id' | 'ingested_at'>
  | 'patient_name'
  | 'member_id_raw'
  | 'group_number';

// Default column order (drives DEFAULT_ORDER). Per Alec: Primary Payer sits right after Revenue
// Code (up front with the other coding fields), and Facility moves down next to the money block
// (between Group Number and Charge Amount). Users can still drag/hide from here; this is the default.
const COLUMNS: readonly { key: ColKey; label: string; phi: boolean; numeric: boolean }[] = [
  { key: 'charge_date', label: 'Charge From Date', phi: false, numeric: false },
  { key: 'payment_received', label: 'Payment Received', phi: false, numeric: false },
  { key: 'cpt_code', label: 'CPT Code', phi: false, numeric: false },
  { key: 'revenue_code', label: 'Revenue Code', phi: false, numeric: false },
  { key: 'primary_payer', label: 'Primary Payer', phi: false, numeric: false },
  // Plan sponsor (migration 0101). Sits beside Primary Payer because it is the same KIND of
  // fact — a plan-level attribute of the coverage, not an attribute of the person. phi:false is
  // the 2026-08-14 ruling: this is the EMPLOYER, never the employee (that is Patient Name, two
  // rows down, which stays phi:true). Rendering it masked would defeat the whole feature.
  { key: 'employer_name', label: 'Employer', phi: false, numeric: false },
  { key: 'patient_name', label: 'Patient Name', phi: true, numeric: false },
  { key: 'member_id_raw', label: 'Member ID', phi: true, numeric: false },
  { key: 'group_number', label: 'Group Number', phi: true, numeric: false },
  { key: 'facility', label: 'Facility', phi: false, numeric: false },
  { key: 'charge_amount', label: 'Charge Amount', phi: false, numeric: true },
  { key: 'allowed_amount', label: 'Allowed Amount', phi: false, numeric: true },
  { key: 'pct_allowed', label: '% Allowed of Billed', phi: false, numeric: true },
  { key: 'insurance_payments', label: 'Insurance Payments', phi: false, numeric: true },
  { key: 'pct_paid', label: '% Paid by Payer', phi: false, numeric: true },
  { key: 'adjustments', label: 'Adjustments', phi: false, numeric: true },
  { key: 'patient_balance_due', label: 'Patient Balance Due', phi: false, numeric: true },
];
/**
 * Minimum characters before the employer type-ahead queries the server. MIRRORS
 * CMD_SEARCH_TERM_MIN in src/collections/cmdExplorerQuery.ts — this copy exists only to avoid
 * firing a request the server would reject anyway, and is NOT the boundary: the server enforces the
 * same floor, because a client-side gate is a UX optimisation and never a guarantee. (As of
 * 2026-08-17 the Collections employer picker loads its whole 1,073-entry vocabulary once and filters
 * client-side, so this floor no longer gates a Collections round trip — it still gates Payer Intel's
 * per-keystroke employer search, which shares the constant.)
 */
const MIN_SEARCH_LEN = 3;
/** Directory staleness (minutes) past which the name search warns. The sync runs hourly, so this is
 *  three consecutive failures — well clear of one slow run, well short of a day of silence. */
const STALE_INDEX_MINUTES = 180;

/**
 * Indigo's facility codes, for deciding what a BLANK employer cell means on a per-ROW basis.
 *
 * Indigo does not enter an employer name in CMD at all, so its column is structurally empty rather
 * than "not yet populated" — the row says so explicitly instead of showing a bare dash that reads
 * as an app failure. Derived from the SHARED roster (src/collections/cmdCustomers.ts) rather than a
 * second hardcoded list, so onboarding or retiring an Indigo facility cannot desync this.
 *
 * Facility is the only tenant signal the grid row carries — business_entity_id is not projected —
 * and one CMD customer IS one facility, so the mapping is exact. Set for O(1) lookup per cell.
 */
const INDIGO_FACILITY_CODES = new Set(facilityCodesForEntity(INDIGO_ENTITY_ID));


const COLUMN_LABEL: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const IS_PHI = new Set<string>(COLUMNS.filter((c) => c.phi).map((c) => c.key));
const IS_NUMERIC = new Set<string>(COLUMNS.filter((c) => c.numeric).map((c) => c.key));
/**
 * Columns that read as FIGURES even though they are not money, so they get the house numeric face
 * (`ths-num` → IBM Plex Mono, tabular) like the money columns already do via `tabular-nums`.
 * The design system names "numeric dates" and codes as part of that role, and the practical win is
 * column alignment: proportional digits make a stack of ISO dates and CPT codes ragged, tabular
 * ones line up, which is most of what makes a 17-column financial grid scannable.
 *
 * PHI columns are deliberately EXCLUDED. They render as `••••••` until an audited reveal, so the
 * face would apply to a mask most of the time — and this change must not touch the masking path.
 */
const IS_MONO = new Set<string>(['charge_date', 'payment_received', 'cpt_code', 'revenue_code']);
const DEFAULT_ORDER: ColKey[] = COLUMNS.map((c) => c.key);
// Columns hidden by default for users WITHOUT a saved view — data kept, re-showable via the column
// picker. A user's saved view carries its own explicit visibility (hidden_columns) and still governs.
const DEFAULT_HIDDEN = new Set<ColKey>(['adjustments']);
// Columns the grid can sort by (server-side; MIRRORS CMD_EXPLORER_SORTABLE_COLUMNS and must stay in
// lockstep with it — a key here that the server rejects silently falls back to the default sort, so
// the header would show an arrow the rows do not obey). Two dates + seven money/ratio columns +
// four text columns.
//
// The four text columns (cpt_code, revenue_code, primary_payer, facility) were added 2026-08-17 to
// make the grid orderable "just like Excel". They live on the rollup, so no schema change; only
// primary_payer has a supporting btree and the other three were MEASURED against an already-shipped
// unindexed sort before shipping (facility 155.9 ms vs charge_amount 169.5 ms, same plan shape).
//
// ⚠ Employer and the three PHI columns stay OUT, for two different reasons — see
// CMD_EXPLORER_SORTABLE_COLUMNS. Short version: employer is joined outside the keyset subquery, so
// sorting it would reorder only the fetched page; PHI exists on the rollup as blind indexes only,
// and HMAC order is not alphabetical order.
const SORTABLE_KEYS = new Set<string>([
  'charge_date',
  'payment_received',
  'cpt_code',
  'revenue_code',
  'primary_payer',
  'facility',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'pct_paid',
  'insurance_payments',
  'adjustments',
  'patient_balance_due',
]);
// The two payer-gap columns render as percentages (formatPercent), not currency. They ARE numeric
// (right-aligned) — this set only overrides how cellText formats them.
const IS_PERCENT = new Set<string>(['pct_allowed', 'pct_paid']);


/**
 * A grid row. Identical to the server row in ungrouped mode; in GROUPED mode it also carries how
 * many charge lines were condensed and where the service-date span ends.
 *
 * Both extras are `__`-prefixed because they are PRESENTATION-ONLY and must never be mistaken for
 * columns: they are absent from `ColKey`, so the column picker cannot show them, a saved view cannot
 * reference them, and `sanitizeGridColumns` would drop them if one ever tried.
 */
type GridRow = CmdExplorerRow & {
  __lines?: number;
  __chargeDateEnd?: string | null;
  __cptMixed?: boolean;
  __revenueMixed?: boolean;
};

/**
 * Map one grouped row onto the grid shape.
 *
 * The grouped row is deliberately made to LOOK like an ordinary row so the table, the column picker,
 * saved views, drag-reorder and the PHI reveal all keep working with no branch. That is legitimate
 * rather than a trick because `id` is a REAL row id — the group's representative (latest) rollup id —
 * so revealing it decrypts exactly one row belonging to exactly one patient, which is what the group
 * is. `member_id_bidx` is the group key, so a group is never more than one patient.
 *
 * `cpt_code` / `revenue_code` arrive null when the group genuinely spans several values; that is
 * rendered as "Multiple" rather than an em dash, because "—" would read as "no CPT" when the truth
 * is "several". `ingested_at` has no meaning for a group and is left empty.
 */
function toGridRow(g: CmdExplorerGroupRow): GridRow {
  return {
    id: g.id,
    charge_date: g.charge_date,
    payment_received: g.payment_received,
    cpt_code: g.cpt_code,
    revenue_code: g.revenue_code,
    facility: g.facility,
    charge_amount: g.charge_amount,
    allowed_amount: g.allowed_amount,
    insurance_payments: g.insurance_payments,
    adjustments: g.adjustments,
    patient_balance_due: g.patient_balance_due,
    primary_payer: g.primary_payer,
    pct_allowed: g.pct_allowed,
    pct_paid: g.pct_paid,
    employer_name: g.employer_name,
    // 0086 attribution rides through unchanged — the grouped query resolves it on the group's
    // REPRESENTATIVE row, which is exact because facility_alias is functionally dependent on the
    // group key (measured; see the join comment in buildCmdExplorerGroupedQuery). So a group renders
    // the same Facility cell its lines would.
    facility_resolved: g.facility_resolved,
    facility_method: g.facility_method,
    // A grouped row IS one payment date, so the server's per-row predicate holds exactly. Dropping
    // it here would let the scheduled toggle move a total with no marker — the failure the badge
    // exists to prevent.
    is_scheduled: g.is_scheduled,
    ingested_at: '',
    __lines: g.line_count,
    __chargeDateEnd: g.charge_date_end,
    __cptMixed: g.cpt_mixed,
    __revenueMixed: g.revenue_mixed,
  } as GridRow;
}

/**
 * Reconstruct a saved view into this component's { order, hidden } layout. Thin typed wrapper over the
 * pure, unit-tested `deriveGridLayout` (which handles the legacy-format fallback, allowlist repair,
 * PHI-lock, and the at-least-one-visible guard) — keeps load-view and default-on-mount in lockstep.
 */
function deriveLayout(v: GridViewRow): { order: ColKey[]; hidden: Set<ColKey> } {
  const { order, hidden } = deriveGridLayout(v, DEFAULT_ORDER, IS_PHI);
  return { order: order as ColKey[], hidden: hidden as Set<ColKey> };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const YEAR_OPTIONS = [2026, 2025, 2024];
/** Rolling recency quick-filters (days). Mutually exclusive with the Month/Year window. */
/**
 * The window presets. 6m/1y are TRAILING 180/365-day spans, not calendar periods — the chip label
 * is a shorthand, and src/businessWindow.ts reports windowDays accordingly.
 *
 * There is deliberately NO "all time" chip (ruled 2026-08-30): the consolidated-scope grouped sort
 * already spills to disk at 1y, and an unbounded scan is how that becomes a timeout.
 */
const WINDOW_PRESETS = [
  { days: 7, chip: '7d', label: 'Past 7 days' },
  { days: 14, chip: '14d', label: 'Past 14 days' },
  { days: 30, chip: '30d', label: 'Past 30 days' },
  { days: 90, chip: '90d', label: 'Past 90 days' },
  { days: 180, chip: '6m', label: 'Past 180 days' },
  { days: 365, chip: '1y', label: 'Past 365 days' },
] as const;

/** Mirrors CMD_CUSTOM_MAX_DAYS at the server boundary. The SERVER is authoritative and rejects an
 *  over-wide range; this copy exists only so the user is told BEFORE a round-trip. */
const CUSTOM_MAX_DAYS = 366;

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const MONEY0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** DB numerics arrive as clean decimal strings ('250.00', '-1660.05'); format as USD. */
function formatMoney(s: string | null): string {
  if (s === null || s === '') return '—';
  const n = Number(s);
  return Number.isFinite(n) ? MONEY.format(n) : s;
}

/**
 * Payer-gap ratios (pct_allowed / pct_paid) arrive as decimal strings already rounded to 2 dp by
 * the generated column ('92.34', '100.00'), or null when the denominator was 0/negative/null.
 * Render as a percent, dropping trailing-zero noise ('92.34%', '100%', '92.5%'); null → em dash.
 */
function formatPercent(s: string | null): string {
  if (s === null || s === '') return '—';
  const n = Number(s);
  return Number.isFinite(n) ? `${n}%` : '—';
}

/**
 * Same percent rendering for the combo list's dollar-weighted ratios, which arrive as JS `number`
 * (float8) already rounded to 2 dp server-side — or null when the denominator was 0/negative/null.
 */
function formatPercentNum(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '—' : `${n}%`;
}

/** Debounce a fast-changing value (search box) so downstream fetches don't fire per keystroke. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Exact drill-down refinement set by clicking a summary chip. Single-field chips (facility / payer /
 * CPT) carry one value; the (CPT, Revenue-code) COMBO chip carries BOTH codes and sets/clears them
 * together — so the grid narrows to that exact pairing, not just one of the two.
 */
type RefineKind = 'facility' | 'primary_payer' | 'cpt_code';
type Refinement =
  | { kind: RefineKind; value: string }
  | { kind: 'combo'; cpt: string; revenue: string };
/** Result of a save from the column-view manager (mirrors the server action's shape). */
type GridViewMutationOutcome = { ok: true } | { ok: false; error: string };
const REFINE_LABEL: Record<RefineKind, string> = {
  facility: 'Facility',
  primary_payer: 'Payer',
  cpt_code: 'CPT',
};
/** Human label for the active-refinement pill (the combo case shows both codes). */
function refinementLabel(r: Refinement): string {
  return r.kind === 'combo' ? `CPT×Rev: ${r.cpt} / ${r.revenue}` : `${REFINE_LABEL[r.kind]}: ${r.value}`;
}

// `refreshing` = a refetch is in flight but we ALREADY have data from a prior fetch: keep it on
// screen (dimmed) instead of collapsing to a skeleton. `loading` = genuine first load / no prior
// data → show a skeleton. (Session E: non-blocking refetch feel, no fetch-architecture change.)
type SummaryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: CmdSearchSummary }
  | { kind: 'refreshing'; data: CmdSearchSummary };

type CohortState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: CohortCurve }
  | { kind: 'refreshing'; data: CohortCurve };

/** One clicked cohort-curve point — which axis + which bucket on that axis. */
type CohortPoint = { axis: 'position' | 'days'; bucket: number };

/** Fetch state for the drilldown of the currently-selected cohort point (Session G). */
type DrilldownState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: CohortDrilldownResult };

/**
 * Keep a conditionally-rendered node mounted through its exit animation. Returns `rendered` (mount
 * flag) and `exiting` (true during the exit window) so the caller can swap enter/exit animations.
 * Pure presentation — no data or fetch involvement. Respects reduced motion transparently (the
 * global CSS reset makes the exit animation near-instant; the timer still fires to unmount).
 */
function useDelayedUnmount(active: boolean, exitMs = 200): { rendered: boolean; exiting: boolean } {
  const [rendered, setRendered] = useState(active);
  useEffect(() => {
    if (active) {
      setRendered(true);
      return;
    }
    const t = setTimeout(() => setRendered(false), exitMs);
    return () => clearTimeout(t);
  }, [active, exitMs]);
  return { rendered, exiting: rendered && !active };
}

/**
 * Server-rendered bootstrap for the explorer's initial view: the first page of rows + the facility
 * options + the caller's saved views, fetched in the Collections Server Component and passed down.
 * When present, the grid paints WITH data in the initial HTML and the client SKIPS its three mount
 * fetches — removing the serialized round-trips that dominated first-load latency. Each slice
 * degrades independently: an absent/failed one falls back to its client fetch. Carries only the same
 * masked, non-PHI CmdExplorerRow the client action already returns (the page is auth-gated) — no PHI.
 */
export type CmdExplorerInitialData = {
  report?: CmdReportResult;
  facilities?: CmdFacilitiesResult;
  views?: GridViewsResult;
};

export function CmdCollectionsExplorer({
  view,
  canRevealPhi,
  initialData,
}: {
  view: DashboardView;
  canRevealPhi: boolean;
  initialData?: CmdExplorerInitialData;
}) {
  // Narrow the optional server-seeded slices once. Used ONLY by the useState initializers and the
  // one-shot skip refs below (all mount-only), so recomputing each render is free.
  const reportRes = initialData?.report;
  const seededReport = reportRes && reportRes.ok ? reportRes : null;
  const facilitiesRes = initialData?.facilities;
  const seededFacilities = facilitiesRes && facilitiesRes.ok ? facilitiesRes.facilities : null;
  const viewsRes = initialData?.views;
  const seededViews = viewsRes && viewsRes.ok ? viewsRes.views : null;
  // The LIVE layout wins over the named default view — it is by definition the most recent thing the
  // user did with their columns. The named default is the starting point for a user who has no live
  // layout yet (first ever load, or right after a reset). See AUTO_GRID_VIEW_NAME.
  const seededDefaultView =
    seededViews?.find((v) => isAutoGridView(v.name)) ??
    seededViews?.find((v) => v.isDefault) ??
    null;

  /**
   * A grid row. In GROUPED mode a row is several charge lines condensed into the payment they
   * arrived on, so it carries two extras the ungrouped shape has no place for. They are prefixed
   * because they are presentation-only and must never be mistaken for columns that exist on the
   * server row (a saved view can never reference them — they are not in the ColKey allowlist).
   */
  const [rows, setRows] = useState<GridRow[]>(() => (seededReport ? seededReport.rows : []));
  /**
   * GROUPED MODE — one row per (patient x payment date x facility x payer).
   *
   * DEFAULT OFF, and that is a considered default rather than caution: most work on this tab is
   * charge-line work, and a grouped row cannot answer "which CPT on which date". Grouping is what
   * you turn on to read a payment; the raw grain is what you leave on to audit one.
   */
  const [grouped, setGrouped] = useState(false);
  /**
   * Toggling grouping NORMALIZES the sort column, keeping the chosen direction.
   *
   * ⚠ WITHOUT THIS THE HEADER LIES. Grouped requests always order by payment_received and use only
   * the direction, so a user who had sorted by Charge Amount and then grouped would see the sort
   * arrow still on Charge Amount while the rows were ordered by payment date — the indicator and the
   * server disagreeing, with nothing on screen saying so. The direction is deliberately preserved:
   * asc/desc was an intentional choice and grouping is not a reason to discard it.
   */
  const toggleGrouped = useCallback(() => {
    setGrouped((wasGrouped) => {
      if (!wasGrouped) {
        setSort((prev) =>
          prev.column === 'payment_received' ? prev : { column: 'payment_received', direction: prev.direction },
        );
      }
      return !wasGrouped;
    });
  }, []);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>(() =>
    seededReport ? 'ready' : 'loading',
  );

  // Guided search (replaces the old free-text bar): Facility + Payer are multi-select tag pickers
  // (facilitySelection / payerSelection below). `refinement` is now ONLY the (CPT × Revenue-code)
  // combo drill from the summary combo table — facility/payer summary clicks add tags instead of
  // setting a single refinement (see applyRefinement).
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  // Trailing-window preset, in days: one of WINDOW_PRESETS (7/14/30/90/180/365), or 0 meaning "a
  // CUSTOM RANGE is active instead" — the two are mutually exclusive and customActive is the other
  // half of that pair. DEFAULT 90: the default nav carries a payment_received window so the summary
  // aggregates hit the (business_entity_id, payment_received) index path instead of a seq scan of
  // the whole charge-rollup slice (measured: unbounded Consolidated summary ~148–220ms/panel warm →
  // ~80ms worst-case with a 90d window).
  //
  // ⚠ 0 NO LONGER MEANS "ALL MONTHS", AND RE-CLICKING THE ACTIVE CHIP NO LONGER TOGGLES TO IT.
  // This comment said both until 2026-08-31 and had been false since the window control landed —
  // there is no unbounded state any more (ruled), and the Month/Year picker it also named was
  // folded into the custom range in the same change. Kept as a correction rather than a silent
  // rewrite because the repo's standing rule is that a stale comment is a defect, not a cosmetic.
  const [recencyDays, setRecencyDays] = useState(90);
  /** Custom range, INCLUSIVE dates as picked. Empty strings = no custom range active. */
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customError, setCustomError] = useState('');
  /** Off by default, and NEVER hidden or disabled — see the toggle's comment. */
  const [includeScheduled, setIncludeScheduled] = useState(false);
  const customActive = customFrom !== '' && customTo !== '';
  /** Draft values while the popover is open — the applied range only changes on Apply, so a
   *  half-typed date never fires a fetch. */
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  // Month/Year picker popover — the [Month/Year ▾] segment of the unified time control (A).
  /** The custom-range popover's outside-click ref. Named for what it holds now, not what it held
   *  before the 2026-08-30 fold. */
  const customRef = useRef<HTMLDivElement>(null);

  // Facility multi-select. Empty selection = ALL facilities (no restriction), NOT zero rows. Options
  // are tenant-scoped (loaded per view); the selection is tenant-specific, so it resets on view change.
  const [facilityOptions, setFacilityOptions] = useState<CmdFacilityOption[]>(
    () => seededFacilities ?? [],
  );
  const [facilitySelection, setFacilitySelection] = useState<string[]>([]);
  // Payer multi-select (guided payer search). The distinct-payer vocabulary is near-static, so it's
  // loaded once per view (like facilities) and filtered client-side as the user types.
  const [payerOptions, setPayerOptions] = useState<string[]>([]);
  // Employer segment (migration 0101). 'all' is the default and emits NO server predicate.
  // --- Patient-name search (PHI; gated + audited server-side) -----------------------------------
  // nameQuery is PHI and lives ONLY here, in component state. It is never lifted into the URL, never
  // persisted, and never put in a grid view — same posture as IdentityForm. What leaves this
  // component is the term (once, in a Server Action body) and what comes back is row IDS only.
  const [nameQuery, setNameQuery] = useState('');
  const [nameSearching, setNameSearching] = useState(false);
  /** null = no name filter applied. [] = searched and matched NOTHING (an empty grid is correct,
   *  and is deliberately distinguished from "no filter" so it cannot silently widen to every row). */
  // ⚠ THE RESOLVING VIEW IS STORED WITH THE RESULT, not just the result. A member token is a keyed
  // HMAC of the member id and nothing else, so it is tenant-agnostic; a result resolved in one view
  // and left in state across a view switch would be applied to the next tenant's rows. Binding the
  // result to its origin makes that structurally impossible instead of relying on a reset effect
  // firing in the right order.
  const [nameMatch, setNameMatch] = useState<
    { view: DashboardView | undefined; members: Array<{ entity: string; member: string }> } | null
  >(null);
  // Only the CURRENT view's result may reach a filter. A stale one is ignored, not applied.
  const nameMatchTokens = nameMatch !== null && nameMatch.view === view ? nameMatch.members : null;
  const [nameNotice, setNameNotice] = useState<string | null>(null);
  // Picked employers, as CANONICAL KEYS ('TESLA'), expanded to their raw spellings at filter time.
  const [employerSelection, setEmployerSelection] = useState<string[]>([]);
  // Whether ANY employer value exists in this tenant scope — see the coverage effect below.
  const [hasEmployerData, setHasEmployerData] = useState(false);
  // EVERY tenant in scope has employer data. Distinct from hasEmployerData on purpose: in
  // Consolidated, BXR has employers and Indigo structurally does not, so `has` is true (keep the
  // filter available) while `all` is false (a blank must not claim "Individual").
  const [allHaveEmployerData, setAllHaveEmployerData] = useState(false);
  /**
   * The CANONICAL employer vocabulary, loaded whole per view (2026-08-17).
   *
   * ⚠ THIS WAS A SERVER-DRIVEN PER-KEYSTROKE TYPE-AHEAD until 2026-08-17, on the belief that the
   * vocabulary was "far too large to load whole, unlike the ~260-entry facility/payer lists". That
   * was measured on the VOB plane. The COLLECTIONS book carries 1,073 distinct spellings — the same
   * order as facility and payer — so it now loads once per view and filters client-side exactly like
   * they do. That is what makes the Employer picker behave like its neighbours instead of lagging a
   * debounce behind every keystroke.
   *
   * It is also required for correctness: each option's `variants` become the grid predicate, so a
   * group assembled from a term-matched page would under-select. See employerCanonical.ts.
   */
  const [employerVocabulary, setEmployerVocabulary] = useState<CanonicalEmployer[]>([]);
  const [payerSelection, setPayerSelection] = useState<string[]>([]);

  // Searchable PHI (gated to canRevealPhi + audited server-side). These are matched via keyed
  // blind indexes (exact member ID / 3-char alpha prefix / exact group #) — the raw value is
  // HMAC'd server-side, never substring-matched, and results keep the name masked.
  const [phiMemberId, setPhiMemberId] = useState('');
  const [phiAlphaPrefix, setPhiAlphaPrefix] = useState('');
  const [phiGroup, setPhiGroup] = useState('');
  const dMember = useDebouncedValue(phiMemberId, 350).trim();
  const dAlpha = useDebouncedValue(phiAlphaPrefix, 350).trim();
  const dGroup = useDebouncedValue(phiGroup, 350).trim();
  const hasPhiSearch = canRevealPhi && (dMember !== '' || dAlpha !== '' || dGroup !== '');
  // The alpha-prefix cohort curve (Session D) is gated to PHI-entitled roles AND an active ≥3-char
  // alpha-prefix search (the blind-index token needs ≥3 chars). The raw prefix goes ONLY to the
  // server action, which HMACs + gates + audits it; it is never matched or held client-side.
  const cohortActive = canRevealPhi && dAlpha.length >= 3;

  const [summary, setSummary] = useState<SummaryState>({ kind: 'idle' });
  const [cohort, setCohort] = useState<CohortState>({ kind: 'idle' });
  // Mark grid refetches (filter/sort/pagination) as non-urgent so typing/clicking stays responsive;
  // `isPending` also feeds the grid's subtle "refreshing" treatment. This wraps the EXISTING fetch
  // calls — it changes nothing about what is fetched or when. Keep the cohort panel mounted through
  // its exit animation so it doesn't pop out when the alpha-prefix search clears.
  const [isPending, startTransition] = useTransition();
  const cohortPresence = useDelayedUnmount(cohortActive, 200);
  // Freeze the last resolved cohort (data + the prefix it was for) so the panel can keep showing it
  // while it fades OUT — by exit time the live `cohort` state has already reset to idle.
  const cohortSnapshotRef = useRef<{ data: CohortCurve; prefix: string } | null>(null);

  // Cohort-point drilldown (Session G): which point is selected (null = none), and its fetch state.
  // Independent of `cohort`/`cohortPresence` above — selecting a point does not affect the curve.
  const [drilldownPoint, setDrilldownPoint] = useState<CohortPoint | null>(null);
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);

  // A facility/payer refinement AND the facility multi-select are tenant-specific; a term is generic.
  // Reset both when the view (tenant) changes so a stale drill-down / facility set doesn't filter the
  // new tenant to zero rows. (React "adjust state on prop change" — runs once before the reload effect.)
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    setPrevView(view);
    setRefinement(null);
    setFacilitySelection([]);
    setPayerSelection([]);
  }

  // Server-side sort. Default: most-recent Payment Received first.
  const [sort, setSort] = useState<CmdExplorerSort>({ column: 'payment_received', direction: 'desc' });

  // Keyset pagination: cursors[p] is the cursor used to fetch page p (cursors[0] = null).
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(CmdExplorerCursor | null)[]>(() =>
    seededReport && seededReport.nextCursor ? [null, seededReport.nextCursor] : [null],
  );
  const [hasNext, setHasNext] = useState(() => Boolean(seededReport && seededReport.nextCursor));

  // Column layout, split into two pieces (superseding the old "membership = visibility" single array):
  //   • `order`  — ALL columns in display order (the single draggable list in the Columns popover).
  //   • `hidden` — which of those columns are hidden. PHI columns are never in here (locked-visible).
  // The TABLE renders `visibleOrder` (order minus hidden). Reorder by dragging in the popover OR the
  // table headers; toggle visibility in the popover. Both are persisted per-user as a named view.
  const [order, setOrder] = useState<ColKey[]>(() =>
    seededDefaultView ? deriveLayout(seededDefaultView).order : [...DEFAULT_ORDER],
  );
  const [hidden, setHidden] = useState<Set<ColKey>>(() =>
    seededDefaultView ? deriveLayout(seededDefaultView).hidden : new Set(DEFAULT_HIDDEN),
  );
  const visibleOrder = order.filter((k) => !hidden.has(k));

  // @dnd-kit drag: activation lives on the grip handles only (see the Sortable* components), so
  // clicking a sort button or checkbox never starts a drag. Keyboard drag (Space to lift, arrows to
  // move, Space to drop) comes from the KeyboardSensor. Shared by the popover list AND the table
  // headers; both reorder the SAME full `order` via keys, so they stay perfectly in sync.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorderColumns = useCallback((activeKey: string, overKey: string) => {
    if (activeKey === overKey) return;
    setOrder((prev) => {
      const from = prev.indexOf(activeKey as ColKey);
      const to = prev.indexOf(overKey as ColKey);
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
  }, []);

  // Per-user saved column views (server-side, private). Loaded once on mount; the caller's default
  // view (if one exists) sets the initial layout, else all columns (DEFAULT_ORDER).
  const [views, setViews] = useState<GridViewRow[]>(() => seededViews ?? []);
  /** Saved views the USER created. The reserved auto-layout row lives in the same table and must
   *  never appear as something the user can rename, delete or set as default. */
  const namedViews = views.filter((v) => !isAutoGridView(v.name));
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  // If views were server-seeded, the default layout is already applied via the order/hidden
  // initializers above — mark it applied so the (skipped) mount effect never re-applies it.
  const defaultViewAppliedRef = useRef(Boolean(seededViews));

  // One-shot guards: when a slice was server-seeded, skip its FIRST client fetch on mount (the
  // seeded data already covers the initial view). They flip to false after the first effect run,
  // so any later change (view switch, filter/sort) fetches normally.
  const skipInitialRowFetchRef = useRef(Boolean(seededReport));
  const skipFacilitiesFetchRef = useRef(Boolean(seededFacilities));
  const skipViewsFetchRef = useRef(Boolean(seededViews));

  // PHI for the current page, revealed in bulk (memory only; cleared on page/filter change).
  const [phi, setPhi] = useState<Map<number, CmdExplorerPhi>>(() => new Map());
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  // STICKY reveal preference: once a PHI-entitled user turns "Reveal all" on, it STAYS on across
  // page/filter/sort changes — the new page auto-reveals so they don't re-click every navigation
  // (Alec's painpoint). Each page is still decrypted via the audited server action (one audit per
  // page), and loadPage still drops the decrypted PHI from memory on every navigation.
  const [revealAll, setRevealAll] = useState(false);

  // Guards against out-of-order page responses (fast Prev/Next clicks).
  const reqRef = useRef(0);
  /**
   * The server's ABSOLUTE next-business-day-rollover instant (epoch ms), re-armed on every load.
   * 0 until the first load lands — the server-seeded first page does not carry one, and 0 simply
   * means "nothing to compare against yet", never "reload now".
   */
  const rolloverRef = useRef(0);
  /** The results scrollport — the grid's own scroll container. Reset to the top on a re-query. */
  const scrollportRef = useRef<HTMLDivElement>(null);
  /**
   * The <table> inside the scrollport. Observed for resize ALONGSIDE the scrollport, and it is not
   * redundant: hiding a column changes the TABLE's width while the scrollport's box is unchanged
   * (it is `flex-1` against a fixed parent), so a ResizeObserver watching only the scrollport never
   * fires for a column show/hide — the case the edge fades most need to re-evaluate for.
   */
  const gridTableRef = useRef<HTMLTableElement>(null);
  /**
   * WHICH EDGES HAVE CONTENT SCROLLED OUT OF VIEW — the four edge fades' only input.
   *
   * One object rather than four `useState` booleans so a scroll tick commits at most ONE state
   * update; `measureScrollEdges` returns the previous object unless a boolean actually flipped, so
   * React bails out of the re-render entirely on the overwhelming majority of ticks (scroll fires
   * far more often than an edge changes).
   */
  const [scrollEdges, setScrollEdges] = useState({ top: false, right: false, bottom: false, left: false });
  /** In-flight rAF handle for the edge measurement; 0 = none pending. See scheduleEdgeMeasure. */
  const edgeRafRef = useRef(0);

  // A "search" is now any active guided selection: facility tags, payer tags, or a PHI lookup.
  // (The free-text term + column-scoped substring search were removed with the search bar.)
  const hasAnySearch =
    facilitySelection.length > 0 ||
    payerSelection.length > 0 ||
    hasPhiSearch;

  // Patient-name search needs nothing but the PHI entitlement now.
  //
  // ⚠ THE NARROWING GATE IS GONE (0105), AND ITS REMOVAL IS NOT A RELAXATION OF A PHI CONTROL.
  // It required a facility / payer / employer / date / member filter before a name could be
  // searched, and it existed for exactly one reason: the search decrypted CANDIDATE ROWS, so the
  // work was proportional to how many rows were in view and had to be capped at 2,000 of 686,503.
  // 0105 makes the candidate set the ~11k distinct (tenant, member, name) triples instead, which
  // is bounded by the PATIENT ROSTER rather than by the filters — so there is no longer anything
  // for a narrowing requirement to protect. The PHI gate that does matter, `canRevealPhi`, is
  // unchanged and is still re-checked server-side.
  const nameSearchAllowed = canRevealPhi;

  /**
   * Clear the patient-name search when the tenant changes.
   *
   * ⚠ THE TOKEN GUARD ALONE LEFT A PHANTOM SEARCH. Binding the result to its originating view (see
   * `nameMatch` above) correctly stops the FILTER applying after a view switch — but it left the
   * term sitting in the input and "148 of 9,986 patients matched" sitting under it, describing a
   * search that was no longer affecting anything. The grid was unfiltered while the UI claimed
   * otherwise, which is a worse failure than the one the guard fixed.
   *
   * BOTH are kept on purpose and they are not redundant: the guard is SYNCHRONOUS, so it is already
   * correct during the render that happens before this effect flushes; the effect is what makes the
   * VISIBLE state agree. A reset effect alone would leave one render with the stale filter applied.
   */
  useEffect(() => {
    setNameMatch(null);
    setNameQuery('');
    setNameNotice(null);
  }, [view]);

  /** Curated key → its raw CMD spellings. The picker merges; the FILTER still matches raw text. */
  const facilityGroups = useMemo(() => facilityGroupsFrom(facilityOptions), [facilityOptions]);

  /**
   * Run the patient-name search.
   *
   * The term is PHI: it is sent ONCE, in a Server Action body, and what comes back is one-way HMAC
   * MEMBER TOKENS. It is never written to the URL, a grid view, or storage.
   *
   * ⚠ IT SENDS NO FILTER (0105). The search covers the caller's whole tenant scope, so a patient is
   * found wherever they are in the book; the grid's own filters then intersect the result. That
   * means the match count can EXCEED what the grid shows when another filter is also active, and
   * the notice below says so rather than quietly reconciling the two.
   */
  const runNameSearch = useCallback(async () => {
    const term = nameQuery.trim();
    if (term === '' || !nameSearchAllowed) return;
    setNameSearching(true);
    setNameNotice(null);
    try {
      const res = await searchCollectionsPatientName(term, view);
      if (!res.ok) { setNameNotice(res.error); return; }
      const r = res.result;
      if (!r.ok) {
        setNameNotice(
          r.reason === 'too_broad'
            ? `That matched ${r.count.toLocaleString()} patient policies — more than the ${r.cap.toLocaleString()} limit. Use more of the name.`
            : r.reason === 'term_too_short'
              ? `Type at least ${r.min} characters of a name.`
              : r.reason === 'directory_empty'
                ? 'The patient name index has not been built yet, so name search cannot answer. This is not "no matches".'
                : 'Patient name search is unavailable on this deployment (the name index is missing).',
        );
        return;
      }
      // [] is kept, not discarded: it means "searched, matched nobody", and the grid must show
      // empty rather than silently reverting to every row.
      setNameMatch({ view, members: r.members });
      setNameNotice(
        r.matchedPatients === 0
          ? `No patient name matched across all ${r.patientsInScope.toLocaleString()} patients.`
          : `${r.matchedPatients.toLocaleString()} of ${r.patientsInScope.toLocaleString()} patients matched` +
            `${hasAnySearch ? ' — the grid also applies your other filters.' : '.'}`,
      );
      // ⚠ IT TAKES BOTH NUMBERS, AND EACH ALONE WAS WRONG ONCE — this condition has been broken in
      // both directions and the two failures are worth keeping side by side:
      //
      //   `lag > 0` alone           — fires on a HEALTHY system. ~6,000 lines land per day against
      //                               an hourly sync, so lag is non-zero most of every hour, and
      //                               nearly all of it is patients already indexed. Always-on.
      //   `staleMinutes > N` alone  — fires on a QUIET system. The CMD feed adds nothing overnight,
      //                               so the sync legitimately has no work and `refreshed_at` only
      //                               moves when there IS work. Cries wolf every night.
      //
      // Together they are exact: unindexed rows EXIST and the sync has not collected them for three
      // hourly cycles. A directory with nothing outstanding is current by definition, whenever it
      // last ran; a sync that clears its backlog each hour is healthy, however big the backlog got.
      if (r.indexLagRows > 0 && r.indexStaleMinutes > STALE_INDEX_MINUTES) {
        setNameNotice((prev) =>
          `${prev ?? ''} ⚠ The name index last updated ${Math.round(r.indexStaleMinutes / 60)}h ago ` +
          `(${r.indexLagRows.toLocaleString()} charge lines unindexed), so a recent patient may be missing.`.trim(),
        );
      }
    } catch {
      setNameNotice('The name search could not be completed right now.');
    } finally {
      setNameSearching(false);
    }
  }, [nameQuery, nameSearchAllowed, view, hasAnySearch]);

  /**
   * Stable dep key for the name-search result, mirroring payerKey/facilityKey.
   *
   * ⚠ THIS EXISTS BECAUSE THE DEPENDENCY WAS MISSING AND THE FEATURE SILENTLY DID NOTHING (Qodo #4,
   * 2026-08-18). `filterArg` and the summary effect both READ the name result, but neither listed it,
   * and an `eslint-disable exhaustive-deps` on both meant the lint rule that exists to catch exactly
   * this said nothing. A search updated the notice and the grid kept its previous rows.
   *
   * 'none' vs '' is load-bearing: `null` (never searched) must produce a DIFFERENT key from `[]`
   * (searched, matched nobody), because the two send different filters and must refetch apart.
   */
  const nameMatchKey =
    nameMatchTokens === null ? 'none' : nameMatchTokens.map((p) => `${p.entity}${p.member}`).join('|');
  // Stable dep keys for the selection sets (array identity changes on every toggle otherwise).
  const payerKey = payerSelection.join('\n');
  /**
   * Stable string proxy for what the employer filter ACTUALLY SENDS, mirroring payerKey. A raw array
   * in a dependency list is compared by identity, so a new array with identical contents would
   * refetch every render; the newline join is safe because employer names cannot contain one.
   *
   * ⚠ KEYED ON THE EXPANSION, NOT THE SELECTION (2026-08-17). The selection holds canonical keys and
   * the wire carries their raw spellings, so the expansion is the thing whose change must trigger a
   * refetch. Keying on the selection alone would miss a vocabulary that arrives AFTER a selection
   * exists — the grid would keep showing results for an expansion it no longer sends.
   *
   * Deliberately '' while nothing is selected, so the vocabulary loading on mount (every page load,
   * [] → 1,073 options) does NOT invalidate this key and trigger a second grid + summary fetch. That
   * is why this is a derived key rather than `employerVocabulary` in the dependency arrays.
   */
  const employerKey =
    employerSelection.length > 0
      ? expandEmployerKeys(employerSelection, employerVocabulary).join('\n')
      : '';
  const facilityKey = facilitySelection.join(''); // control char can't appear in a facility name

  // --- cohort resolution + AI-analysis input assembly ----------------------
  // A prefix cohort is "resolved" when the alpha-prefix search is active AND the curve returned
  // whole-cohort totals (i.e., it cleared COHORT_MIN_PATIENTS). The AI read then analyzes the
  // COHORT yield; otherwise the SELECTION yield (this summary's tile aggregate — never a new
  // query). The header cards no longer switch modes (cohort card mode retired 2026-08-31) — they
  // always show the selection yield; the curve panel remains the cohort's visual surface.
  const cohortData = cohort.kind === 'ready' || cohort.kind === 'refreshing' ? cohort.data : null;
  const cohortResolved = cohortActive && cohortData !== null && cohortData.totals !== null;

  const summaryData = summary.kind === 'ready' || summary.kind === 'refreshing' ? summary.data : null;
  // The non-PHI aggregate the AI panel analyzes — mirrors EXACTLY what's on screen (tiles + green
  // cards + drill lists). No field can carry a member id / alpha-prefix / patient name (the server
  // schema is strict). Cohort mode adds the N + the deleted curves' per-bucket VALUES; selection
  // mode carries the tile scalars incl. the zero-allowed scalar (total_allowed) for the gate.
  const aiInput = useMemo<CollectionsAiInput | null>(() => {
    if (!summaryData) return null;
    const s = summaryData;
    const top_payers = s.by_payer.slice(0, 25).map((g) => ({ name: g.label, count: g.count, charge: g.charge }));
    const top_facilities = s.by_facility.slice(0, 25).map((g) => ({ name: g.label, count: g.count, charge: g.charge }));
    const top_cpt_rev = s.by_combo
      .slice(0, 25)
      .map((g) => ({ cpt: g.cpt, revenue: g.revenue, lines: g.count, pct_allowed: g.pct_allowed, pct_paid: g.pct_paid }));
    const scope = {
      charge_lines: s.total_count,
      total_charge: s.total_charge,
      total_allowed: s.total_allowed,
      total_paid: s.total_paid,
      total_balance: s.total_balance,
    };
    if (cohortResolved && cohortData && cohortData.totals) {
      const c = cohortData;
      const pt = (p: CohortCurvePoint) => ({
        bucket: p.bucket,
        patients: p.patients,
        charge_lines: p.claims,
        pct_allowed: p.pct_allowed,
        pct_paid: p.pct_paid,
      });
      return {
        mode: 'cohort',
        yield_pct: c.totals!,
        scope: { ...scope, cohort_patients: c.cohort_patients },
        top_payers,
        top_facilities,
        top_cpt_rev,
        series: { by_visit: c.by_position.slice(0, 40).map(pt), by_days: c.by_days.slice(0, 40).map(pt) },
      };
    }
    return { mode: 'selection', yield_pct: s.yield_pct, scope, top_payers, top_facilities, top_cpt_rev };
  }, [summaryData, cohortResolved, cohortData]);

  // Invalidation key: any filter / search / prefix / view change remounts the AI panel (→ idle, and
  // its unmount cleanup aborts an in-flight stream), so a stale summary can never describe a new
  // selection. Mirrors the summary-fetch dep tuple.
  // The window is now (preset | custom range) + the scheduled override — all four dimensions must
  // key the AI panel, or a re-analysis after changing the window would return the previous answer.
  const aiKey = [view, recencyDays, customFrom, customTo, includeScheduled, facilityKey, payerKey, dMember, dAlpha, dGroup].join('|');

  // Raw CMD facility text → curated friendly name from the already-loaded dimension options, for
  // DISPLAY only (the Top facilities summary card). Drill/filter values stay the raw facility text
  // the grid matches on, so no server change is needed. Falls back to raw when unmapped.
  const facilityDisplayName = useMemo(() => {
    const m = new Map(facilityOptions.map((o) => [o.facility, o.facility_name ?? o.facility]));
    return (raw: string) => m.get(raw) ?? raw;
  }, [facilityOptions]);

  // Options for the guided pickers. Facility carries a friendly display name + IP/OP/Both badge;
  // payer is a plain name. `value` (raw facility text / payer name) is what the grid filters on.
  // Display-only disambiguation of facilities whose CMD export carries more than one spelling.
  // ⚠ GRAIN STAYS RAW — see facilityPickerOptions.ts for why collapsing to one option per
  // facility_code (Qualify's behaviour) was explicitly ruled out for this surface.
  const facilityPickerOptions = useMemo<PickerOption[]>(
    () => facilityPickerOptionsFrom(facilityOptions),
    [facilityOptions],
  );
  const payerPickerOptions = useMemo<PickerOption[]>(
    () => payerOptions.map((p) => ({ value: p, display: p })),
    [payerOptions],
  );
  // One row per CANONICAL employer. `value` is the key, and the second line names how many raw CMD
  // spellings it covers — so a merged group is visible as a merge rather than looking like the only
  // spelling there is.
  const employerPickerOptions = useMemo<PickerOption[]>(
    () =>
      employerVocabulary.map((e) => ({
        value: e.key,
        display: e.key,
        ...(e.variantCount > 1 ? { detail: `${e.variantCount} spellings` } : {}),
        // The raw spellings stay findable: someone who knows the book types "TESLA,INC." and must
        // still land on TESLA. `display` alone would not match it.
        searchText: e.variants,
      })),
    [employerVocabulary],
  );
  const toggleEmployer = useCallback((v: string) => {
    setEmployerSelection((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }, []);
  const clearEmployers = useCallback(() => setEmployerSelection([]), []);
  // Load the tenant-scoped facility options for the multi-select whenever the view changes.
  useEffect(() => {
    // Server-seeded on first mount → skip the initial fetch (the seed is for this view already).
    if (skipFacilitiesFetchRef.current) {
      skipFacilitiesFetchRef.current = false;
      return;
    }
    let live = true;
    loadCmdExplorerFacilities(view)
      .then((r) => {
        if (live) setFacilityOptions(r.ok ? r.facilities : []);
      })
      .catch(() => {
        if (live) setFacilityOptions([]);
      });
    return () => {
      live = false;
    };
  }, [view]);

  // Load the tenant-scoped payer options for the guided payer search whenever the view changes.
  // No server seed for payers (unlike facilities), so this always fetches on mount + view change.
  useEffect(() => {
    let live = true;
    loadCmdExplorerPayers(view)
      .then((r) => {
        if (live) setPayerOptions(r.ok ? r.payers : []);
      })
      .catch(() => {
        if (live) setPayerOptions([]);
      });
    return () => {
      live = false;
    };
  }, [view]);

  // Does this tenant have ANY employer data yet? Gates the segment toggle AND the "Individual"
  // cell label. Both are wrong before the data lands: `employer_name IS NULL` cannot tell
  // "individual policy" from "not yet populated", so an ungated toggle would select the entire
  // book and an ungated label would call every row Individual.
  //
  // Fails CLOSED to false on error or refusal — the toggle stays hidden and cells stay em-dashed.
  // Defaulting to true on failure would surface a filter that looks functional and lies.
  useEffect(() => {
    let live = true;
    loadCollectionsEmployerCoverage(view)
      .then((r) => {
        if (live) {
          setHasEmployerData(r.ok ? r.hasEmployerData : false);
          setAllHaveEmployerData(r.ok ? r.allHaveEmployerData : false);
        }
      })
      .catch(() => {
        if (live) setHasEmployerData(false);
      });
    return () => {
      live = false;
    };
  }, [view]);

  // The employer VOCABULARY, loaded once per view alongside facility and payer.
  //
  // ⚠ REPLACED A 250 ms-DEBOUNCED PER-KEYSTROKE SERVER SEARCH (2026-08-17). One 118 ms index scan
  // per view beats a query per keystroke against a 686k-row table, and it is what lets the canonical
  // grouping carry COMPLETE variant lists — see employerCanonical.ts for why a term-matched page
  // would silently under-select.
  //
  // Fails CLOSED to an empty vocabulary: the picker then finds nothing, which is visible. Leaving a
  // stale vocabulary from a previous view would be worse — it would offer employers from a tenant
  // the caller may not be scoped to.
  useEffect(() => {
    let live = true;
    loadCollectionsEmployerVocabulary(view)
      .then((r) => {
        if (live) setEmployerVocabulary(r.ok ? r.employers : []);
      })
      .catch(() => {
        if (live) setEmployerVocabulary([]);
      });
    return () => {
      live = false;
    };
  }, [view]);

  // Dismiss the Month/Year popover on outside pointer-down or Escape — the SAME dismiss behavior as
  // the tenant switcher that used to live in the top bar (D). Listeners attach only while it's open. (The popover holds
  // focusable selects, so Escape is a document listener rather than a trigger-local keydown.)
  useEffect(() => {
    if (!customOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!customRef.current?.contains(e.target as Node)) setCustomOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setCustomOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [customOpen]);

  /**
   * STICKY COLUMNS — auto-save the live layout after every change (2026-08-17).
   *
   * Reported as *"the column setting sticky and savable … doesn't work"*. The named-view machinery
   * was verified healthy end to end (definer upserts, grants, RLS, and the default view applies on
   * load); what was missing is that reordering or hiding a column changed component state ONLY, so a
   * reload discarded it unless the user performed the save-a-named-view ritual. Production showed
   * that failure precisely: one view ever saved, created_at = updated_at.
   *
   * Debounced 800 ms because a drag fires a reorder per pointer move — without it, dragging one
   * column across the grid would issue a write per frame. The trailing edge is what persists, which
   * is also the only state the user can see when they stop.
   *
   * NOT persisted with `makeDefault`: this row must never steal the `is_default` flag from a real
   * named view. Precedence is resolved at LOAD time (auto beats default) rather than by mutating
   * anyone's default.
   *
   * ⚠ SKIPS THE FIRST RUN. The effect fires once on mount with the just-applied layout; saving it
   * would rewrite the row with what we only just read, and — worse — would overwrite a good layout
   * with DEFAULT_ORDER on any mount where the load failed and left the defaults in place.
   *
   * Fire-and-forget with an explicit catch: a failed layout save must never surface an error over
   * the grid. The cost of losing one is that the columns are not sticky for that one change, which
   * the next change repairs.
   */
  const autoSaveSkipRef = useRef(true);
  /** A layout save is in flight. Writes are SERIALIZED through this — see the effect below. */
  const layoutSavingRef = useRef(false);
  /** The newest layout that has not been written yet, if a save was in flight when it changed. */
  const layoutPendingRef = useRef<{ order: string[]; hidden: string[] } | null>(null);
  /** The last save came back !ok. Surfaced on the Columns button — never as an error over the grid. */
  const [layoutSaveFailed, setLayoutSaveFailed] = useState(false);

  useEffect(() => {
    if (autoSaveSkipRef.current) {
      autoSaveSkipRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      const payload = { order: order as string[], hidden: [...hidden] as string[] };
      // ⚠ SERIALIZED, NOT FIRE-AND-FORGET (Qodo #2). Independent overlapping requests are upserted by
      // whichever COMMITS last, so a delayed older request could overwrite a newer layout and the
      // user would get yesterday's columns back on reload. Debouncing alone does not prevent it —
      // it only spaces the requests out. At most one write is in flight; anything that changes while
      // it runs is stashed and written immediately after, so the LAST state the user chose always
      // wins and no intermediate state is lost.
      if (layoutSavingRef.current) {
        layoutPendingRef.current = payload;
        return;
      }
      const run = (p: { order: string[]; hidden: string[] }) => {
        layoutSavingRef.current = true;
        void saveGridLayout(p.order, p.hidden)
          // ⚠ OBSERVE THE RESULT (Qodo #3). saveGridLayout converts a DB exception into {ok:false},
          // so `.catch()` alone sees only transport failures and an ordinary save failure was
          // completely silent — the user believed their columns were sticky until a reload proved
          // otherwise. Recorded in state and shown on the Columns button; deliberately NOT a toast or
          // a banner, because a failed layout save must not interrupt work over the grid.
          .then((res) => setLayoutSaveFailed(!res.ok))
          .catch(() => setLayoutSaveFailed(true))
          .finally(() => {
            layoutSavingRef.current = false;
            const next = layoutPendingRef.current;
            if (next) {
              layoutPendingRef.current = null;
              run(next);
            }
          });
      };
      run(payload);
    }, 800);
    return () => clearTimeout(t);
  }, [order, hidden]);

  const refreshViews = useCallback(async () => {
    const r = await listGridViews();
    if (r.ok) setViews(r.views);
  }, []);

  // Load the caller's saved views ONCE on mount; apply their default layout if one exists (guarded so
  // it never clobbers a manual column edit the user makes before/after the fetch resolves). Views are
  // per-USER, not per-tenant-view, so this does NOT depend on `view` and runs a single time.
  useEffect(() => {
    // Server-seeded on first mount → views + default layout are already applied; skip the fetch.
    if (skipViewsFetchRef.current) {
      skipViewsFetchRef.current = false;
      return;
    }
    let live = true;
    listGridViews()
      .then((r) => {
        if (!live || !r.ok) return;
        setViews(r.views);
        if (!defaultViewAppliedRef.current) {
          defaultViewAppliedRef.current = true;
          const def = r.views.find((v) => isAutoGridView(v.name)) ?? r.views.find((v) => v.isDefault);
          if (def) {
            const layout = deriveLayout(def);
            setOrder(layout.order);
            setHidden(layout.hidden);
          }
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The filter passed to the grid action: date window (preset OR custom range) + facility set +
  // (debounced) substring + chip refinement + gated PHI lookup. PHI terms are sent raw ONLY to the
  // server action, which HMACs them into blind-index tokens, gates to canRevealPhi, and audits —
  // never matched client-side.
  const filterArg = useMemo(() => {
    const f: {
      windowDays?: number;
      customFrom?: string;
      customTo?: string;
      includeScheduled?: boolean;
      facility?: string[];
      primary_payer?: string;
      primary_payers?: string[];
      employer_names?: string[];
        cpt_code?: string;
      revenue_code?: string;
      phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
      patient_members?: Array<{ entity: string; member: string }>;
    } = {};
    // A custom range wins over a preset — they are mutually exclusive windows.
    if (customActive) {
      f.customFrom = customFrom;
      f.customTo = customTo;
    } else if (recencyDays > 0) {
      f.windowDays = recencyDays;
    }
    // The scheduled toggle is an upper-bound OVERRIDE, not a different window — it never changes
    // which preset is active, only how far the fetch reaches. Sent only when ON so the wire payload
    // (and therefore the cache key) is unchanged for the default view.
    if (includeScheduled) f.includeScheduled = true;
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Employer segment (0101). 'all' emits NOTHING — the server treats absent as unrestricted, and
    // sending an explicit 'all' would only add a no-op branch to every query plan.
    applyEmployerFilter(f, employerSelection, employerVocabulary);
    // Patient-name search result. `[]` is MEANINGFUL: it means "searched, matched nothing", and must
    // still be sent so the grid shows an empty result instead of silently dropping the filter and
    // widening back to every row. The name ITSELF is never sent here — only the ids it resolved to.
    if (nameMatchTokens !== null) f.patient_members = nameMatchTokens;
    // Facility multi-select is a top-level scope; a facility drill-down chip narrows to that ONE
    // facility (overriding the dropdown). Payer/CPT chips stay exact single-value refinements.
    if (facilitySelection.length > 0) f.facility = expandFacilityKeys(facilitySelection, facilityGroups);
    if (refinement) {
      switch (refinement.kind) {
        case 'facility':
          f.facility = [refinement.value];
          break;
        case 'primary_payer':
          f.primary_payer = refinement.value;
          break;
        case 'cpt_code':
          f.cpt_code = refinement.value;
          break;
        case 'combo':
          // A combo chip narrows by BOTH codes at once (and clears both together).
          f.cpt_code = refinement.cpt;
          f.revenue_code = refinement.revenue;
          break;
      }
    }
    if (hasPhiSearch) {
      f.phiSearch = {
        ...(dMember !== '' ? { memberId: dMember } : {}),
        ...(dAlpha !== '' ? { alphaPrefix: dAlpha } : {}),
        ...(dGroup !== '' ? { groupNumber: dGroup } : {}),
      };
    }
    return f;
    // stable proxy for facilitySelection's contents (payerKey likewise).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recencyDays, customFrom, customTo, includeScheduled, facilityKey, payerKey, employerKey, nameMatchKey, refinement, hasPhiSearch, dMember, dAlpha, dGroup]);

  /**
   * Put the results grid back at row 1, on BOTH axes.
   *
   * REPLACES `gridRef.scrollIntoView()`. That call existed because the grid sat below the fold and
   * the page had to be scrolled down to it; the grid now lives in its own always-visible scrollport,
   * so moving the DOCUMENT is both unnecessary and wrong.
   *
   * ⚠ CALLED FROM `loadPage`, NOT FROM THE INDIVIDUAL HANDLERS — and that placement is the fix for
   * a real bug (Qodo, PR #314). It was originally wired to the two refinement handlers only, which
   * left FOUR other paths that replace the rows without resetting: the pager's Prev/Next, the
   * filter/sort/group effect, and the midnight-rollover reload. Paging while scrolled to row 40
   * opened the next page still at row 40, hiding its first results — and this change is what made
   * that the NORMAL interaction rather than a rare one, because the pager is now always on screen
   * instead of below 50 rows. `loadPage` is the single function every one of those paths goes
   * through and the only place `rows` is replaced, so resetting here cannot be missed by a new
   * call site. Every current caller loads a logically new result set (all four reset the page or
   * the cursor), so there is no background same-page refresh whose position must be preserved;
   * the audited PHI reveal does not go through here.
   *
   * Horizontal resets too: a column offset is just as stale as a vertical one once the row set
   * changes, and a 17-column grid is usually panned right when the user hits Next.
   *
   * `prefers-reduced-motion` is honoured explicitly. globals.css zeroes CSS animation and
   * `scroll-behavior`, but a scripted `scrollTo({behavior:'smooth'})` passes its own behaviour and
   * ignores the stylesheet, so the check has to happen here (WCAG 2.3.3).
   *
   * Declared ABOVE `loadPage` deliberately: it is in that callback's dependency array, and a
   * `const` referenced in a dep array evaluated before its own declaration is a TDZ crash.
   */
  const resetGridScroll = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollportRef.current;
      if (!el) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      el.scrollTo({ top: 0, left: 0, behavior: reduced ? 'auto' : 'smooth' });
    });
  }, []);

  /**
   * ── THE EDGE-FADE MEASUREMENT ────────────────────────────────────────────────────────────────
   *
   * Sets the four booleans that drive the edge fades: is there content scrolled out of view past
   * this edge? Pure geometry off the scrollport — no layout is written, so this never itself
   * triggers the reflow it is reading.
   *
   * WHY THE FADES EXIST AT ALL: a macOS overlay scrollbar is invisible at idle under the default
   * "Show scroll bars: When scrolling" setting, so the ONLY affordance telling a reader that 11
   * more columns exist to the right was one that appears after you already scrolled. The fades are
   * deliberately NOT a second scrollbar — no `scrollbar-width`/`scrollbar-color` is set anywhere on
   * this surface, because two overlapping mechanisms is how you get a styled bar on one OS setting
   * and a fade on the other. One affordance, identical under both settings.
   *
   * THE 1px TOLERANCE IS LOAD-BEARING, not defensive slop. Fractional device pixels and browser
   * zoom leave `scrollTop` at values like 0.5, and `scrollHeight - clientHeight` off by a similar
   * fraction, so an exact `> 0` / `< scrollHeight` comparison paints a fade at a TRUE extreme and
   * chatters on and off as you nudge against it. One CSS pixel is below the perceptual threshold
   * for "is there more content" and kills both.
   */
  const measureScrollEdges = useCallback(() => {
    const el = scrollportRef.current;
    if (!el) return;
    const { scrollTop, scrollLeft, scrollWidth, scrollHeight, clientWidth, clientHeight } = el;
    const slack = 1;
    const next = {
      top: scrollTop > slack,
      left: scrollLeft > slack,
      bottom: scrollTop + clientHeight < scrollHeight - slack,
      right: scrollLeft + clientWidth < scrollWidth - slack,
    };
    setScrollEdges((prev) =>
      prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom && prev.left === next.left
        ? prev
        : next,
    );
  }, []);

  /**
   * rAF-COALESCED so a wheel gesture measures once per painted frame instead of once per event.
   * `scroll` on a trackpad fires far faster than the compositor paints, and the read touches six
   * layout properties — unthrottled, that is a forced synchronous layout per event on the one
   * surface in this app that is already the heaviest thing on screen.
   */
  const scheduleEdgeMeasure = useCallback(() => {
    if (edgeRafRef.current) return; // a measurement is already queued for this frame
    edgeRafRef.current = requestAnimationFrame(() => {
      edgeRafRef.current = 0;
      measureScrollEdges();
    });
  }, [measureScrollEdges]);

  /**
   * FOUR DISTINCT TRIGGERS, each closing a gap the others do not. Do not prune this to one
   * "obvious" mechanism — every one of them was needed to keep the fades from going stale:
   *
   *   1. `scroll` (PASSIVE — this listener never calls preventDefault, and declaring that lets the
   *      browser keep scrolling off the main thread) — the reader moved.
   *   2. ResizeObserver on the SCROLLPORT — window resize, and browser zoom, which changes the
   *      viewport-derived height this box resolves against.
   *   3. ResizeObserver on the TABLE — a column show/hide, which changes the table's width and
   *      therefore `scrollWidth` while leaving the scrollport's own box untouched. Observer (2)
   *      structurally cannot see this; one ResizeObserver watching both targets can.
   *   4. `rows` in the dependency array — a row REPLACEMENT. Paging 1 → 2 swaps 50 rows for 50
   *      rows: same table height (so no RO fires) and `resetGridScroll` scrolls to an offset that
   *      may already be 0,0 (so no `scroll` fires), yet the scroll extent can differ — a short
   *      final page would otherwise keep painting a bottom fade over content that has none.
   *
   * The effect body measures synchronously on every run, which is what makes (4) work, and it is
   * also the initial measurement — the fades must be correct on first paint, before any input.
   * `scrollportRef.current` is null while the empty/skeleton branches are rendered instead of the
   * grid; the early return covers that, and the `rows` dependency is what re-runs this to wire up
   * once real rows arrive.
   */
  useEffect(() => {
    const el = scrollportRef.current;
    if (!el) return;
    measureScrollEdges();
    el.addEventListener('scroll', scheduleEdgeMeasure, { passive: true });
    const ro = new ResizeObserver(scheduleEdgeMeasure);
    ro.observe(el);
    if (gridTableRef.current) ro.observe(gridTableRef.current);
    return () => {
      el.removeEventListener('scroll', scheduleEdgeMeasure);
      ro.disconnect();
      if (edgeRafRef.current) cancelAnimationFrame(edgeRafRef.current);
      edgeRafRef.current = 0;
    };
  }, [rows, measureScrollEdges, scheduleEdgeMeasure]);

  const loadPage = useCallback(
    async (
      target: number,
      cursor: CmdExplorerCursor | null,
      filter: typeof filterArg,
      sortArg: CmdExplorerSort,
      isGrouped: boolean,
    ) => {
      const myReq = ++reqRef.current;
      setStatus('loading');
      setPhi(new Map());
      setRevealed(false);
      setRevealing(false);
      setRevealError(null);
      try {
        // Grouped mode has its own action (and its own SQL); the two share every validation step
        // server-side, so the only thing that differs here is the row SHAPE. Grouped rows are mapped
        // into the grid shape so the table, the column picker, saved views and the PHI reveal all
        // keep working untouched — the representative id is a real row id, which is what makes the
        // reveal legitimate rather than a re-implementation.
        const res: CmdReportResult | CmdGroupedResult = isGrouped
          ? await loadCmdReportGrouped(cursor, filter, sortArg.direction, view)
          : await loadCmdReport(cursor, filter, sortArg, view);
        if (myReq !== reqRef.current) return; // a newer navigation superseded this load
        if (!res.ok) {
          setStatus('error');
          return;
        }
        setRows(isGrouped ? (res.rows as CmdExplorerGroupRow[]).map(toGridRow) : (res.rows as CmdExplorerRow[]));
        // The server's absolute next-rollover instant. Re-armed on every load, so a reload driven by
        // the rollover itself picks up the FOLLOWING boundary without any client-side date maths.
        rolloverRef.current = res.nextRolloverAt;
        setHasNext(res.nextCursor !== null);
        setCursors((prev) => {
          const next = [...prev];
          next[target] = cursor;
          if (res.nextCursor !== null) next[target + 1] = res.nextCursor;
          return next;
        });
        setPage(target);
        setStatus('ready');
        // The rows just changed, so any surviving scroll offset now points at different data.
        // After the early return above, so a superseded load never yanks the winner's position.
        resetGridScroll();
      } catch {
        if (myReq === reqRef.current) setStatus('error');
      }
    },
    [view, resetGridScroll],
  );

  /**
   * RELOAD ONCE WHEN THE BUSINESS DAY ROLLS OVER (#304).
   *
   * `is_scheduled` and the default window's upper bound are both REQUEST-TIME data. A tab left open
   * across midnight Pacific keeps rendering the booleans it was served, so a payment that has since
   * settled still reads "scheduled" and newly-current payments never appear.
   *
   * ⚠ THE TIMER IS A HINT, NOT THE TRIGGER, and that is the whole design. Browsers throttle timers
   * in background tabs, and a laptop asleep for nine hours fires one hours late — a bare setTimeout
   * would either miss the boundary or fire at a 00:00 the user never saw. So three things can wake
   * this (the timer, the tab becoming visible, the window regaining focus) and ALL THREE funnel
   * through the same guard: reload only if `Date.now()` has actually passed the server's instant.
   * That makes it idempotent — still ONE reload per crossing, never a poll.
   *
   * ⚠ NO businessDayIso() HERE, AND NO DATE PARSING AT ALL. The client compares two integers. The
   * ops timezone stays server-side, which is the same reason is_scheduled is projected rather than
   * derived (see cmdExplorerQuery.ts) — a Denver reader and a Los Angeles reader must flag the same
   * rows.
   *
   * Reloads the FIRST page, deliberately, even if the user has paged deep: a keyset cursor is
   * anchored to a row set the old window defined, and silently re-seating it across a day boundary
   * would change which rows it means. loadPage's own reqRef guard makes a rollover reload lose to
   * any newer user-initiated navigation, so this can never land stale over a fresh filter.
   */
  useEffect(() => {
    const maybeReload = (): void => {
      const at = rolloverRef.current;
      if (at === 0 || Date.now() < at) return;
      // Consume it, so two events firing together (timer + visibilitychange) reload once.
      rolloverRef.current = 0;
      setCursors([null]);
      startTransition(() => {
        void loadPage(0, null, filterArg, sort, grouped);
      });
    };

    // setTimeout clamps to ~24.8 days; every rollover is far inside that, but a 0 ref means
    // "unknown" and must not schedule anything.
    const at = rolloverRef.current;
    const timer =
      at === 0 ? undefined : setTimeout(maybeReload, Math.max(0, at - Date.now()) + 1_000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') maybeReload();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', maybeReload);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', maybeReload);
    };
  }, [loadPage, filterArg, sort, grouped, rows]);

  // (Re)load the first page whenever the filter OR sort changes (resets keyset pagination). The
  // fetch call is UNCHANGED — wrapping it in a transition just marks the refetch non-urgent so the
  // current page stays interactive and shows the "refreshing" treatment rather than blanking.
  useEffect(() => {
    // Server-seeded first page on mount → skip this initial load (filter/sort are still at their
    // defaults, which is exactly what the seed represents). Any later filter/sort/view change flips
    // the ref off and loads normally, so pagination + refinement are unaffected.
    if (skipInitialRowFetchRef.current) {
      skipInitialRowFetchRef.current = false;
      return;
    }
    setCursors([null]);
    startTransition(() => {
      void loadPage(0, null, filterArg, sort, grouped);
    });
  }, [filterArg, sort, grouped, loadPage]);

  // Fetch the aggregate search summary whenever the (debounced) term / columns / window change.
  // Skipped entirely when there's no active search. The summary reflects the SEARCH level (term +
  // window), NOT the chip refinement — so the chips stay a stable facet navigator while drilling.
  useEffect(() => {
    if (!hasAnySearch) {
      setSummary({ kind: 'idle' });
      return;
    }
    // Cancel a superseded in-flight summary via an AbortController: each keystroke burst aborts the
    // previous one, so a stale response can never clobber the fresh one. NOTE the server action is
    // invoked through Next's direct-call API, which exposes no request signal — so this cancels the
    // CLIENT-observed request (the result is dropped), it does NOT kill the DB query mid-flight. The
    // min-length gate + longer debounce are what actually stop the expensive queries from firing.
    const controller = new AbortController();
    const { signal } = controller;
    // Keep prior results on screen (dimmed) during a refetch; skeleton only on genuine first load.
    setSummary((prev) =>
      prev.kind === 'ready' || prev.kind === 'refreshing' ? { kind: 'refreshing', data: prev.data } : { kind: 'loading' },
    );
    const f: {
      windowDays?: number;
      customFrom?: string;
      customTo?: string;
      includeScheduled?: boolean;
      facility?: string[];
      primary_payers?: string[];
      employer_names?: string[];
        phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
      patient_members?: Array<{ entity: string; member: string }>;
    } = {};
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Employer segment (0101). 'all' emits NOTHING — the server treats absent as unrestricted, and
    // sending an explicit 'all' would only add a no-op branch to every query plan.
    applyEmployerFilter(f, employerSelection, employerVocabulary);
    // Patient-name search result. `[]` is MEANINGFUL: it means "searched, matched nothing", and must
    // still be sent so the grid shows an empty result instead of silently dropping the filter and
    // widening back to every row. The name ITSELF is never sent here — only the ids it resolved to.
    if (nameMatchTokens !== null) f.patient_members = nameMatchTokens;
    // Top-level scope (date window + facility set) applies to the summary too — so the drill lists
    // describe the SAME population the grid shows. The chip refinement does NOT (it's a within-
    // results drill; the chips stay a stable facet navigator while drilling).
    if (customActive) {
      f.customFrom = customFrom;
      f.customTo = customTo;
    } else if (recencyDays > 0) {
      f.windowDays = recencyDays;
    }
    // The scheduled toggle is an upper-bound OVERRIDE, not a different window — it never changes
    // which preset is active, only how far the fetch reaches. Sent only when ON so the wire payload
    // (and therefore the cache key) is unchanged for the default view.
    if (includeScheduled) f.includeScheduled = true;
    if (facilitySelection.length > 0) f.facility = expandFacilityKeys(facilitySelection, facilityGroups);
    if (hasPhiSearch) {
      f.phiSearch = {
        ...(dMember !== '' ? { memberId: dMember } : {}),
        ...(dAlpha !== '' ? { alphaPrefix: dAlpha } : {}),
        ...(dGroup !== '' ? { groupNumber: dGroup } : {}),
      };
    }
    loadCmdSearchSummary(f, view)
      .then((r) => {
        if (signal.aborted) return;
        setSummary(r.ok ? { kind: 'ready', data: r.summary } : { kind: 'error' });
      })
      .catch(() => {
        if (!signal.aborted) setSummary({ kind: 'error' });
      });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPhiSearch, dMember, dAlpha, dGroup, recencyDays, customFrom, customTo, includeScheduled, facilityKey, payerKey, employerKey, nameMatchKey, view]);

  // Fetch the alpha-prefix cohort curve when a ≥3-char alpha-prefix search is active (PHI-gated).
  // Independent of the term/window/facility filters: the cohort is defined solely by the prefix +
  // tenant, so a patient's full lifetime sequence stays intact (not truncated to the grid window).
  useEffect(() => {
    // A changed prefix/tenant invalidates any drilldown selection from the PRIOR curve — a bucket
    // number from one cohort means nothing against another.
    setDrilldownPoint(null);
    if (!cohortActive) {
      setCohort({ kind: 'idle' });
      return;
    }
    let live = true;
    // Keep the prior cohort curve visible (dimmed) while re-analyzing a changed prefix.
    setCohort((prev) =>
      prev.kind === 'ready' || prev.kind === 'refreshing' ? { kind: 'refreshing', data: prev.data } : { kind: 'loading' },
    );
    loadCohortCurve(dAlpha, view)
      .then((r) => {
        if (live) setCohort(r.ok ? { kind: 'ready', data: r.curve } : { kind: 'error' });
      })
      .catch(() => {
        if (live) setCohort({ kind: 'error' });
      });
    return () => {
      live = false;
    };
  }, [cohortActive, dAlpha, view]);

  // Fetch the drilldown for the currently-selected cohort point (Session G). Independent of the
  // curve fetch above — re-fires only when the SELECTED POINT changes, not on every curve refresh.
  useEffect(() => {
    if (!drilldownPoint) {
      setDrilldown(null);
      return;
    }
    let live = true;
    setDrilldown({ kind: 'loading' });
    loadCohortDrilldown(dAlpha, drilldownPoint.axis, drilldownPoint.bucket, view)
      .then((r) => {
        if (live) setDrilldown(r.ok ? { kind: 'ready', data: r.drilldown } : { kind: 'error', message: r.error });
      })
      .catch(() => {
        if (live) setDrilldown({ kind: 'error', message: 'The point detail could not be loaded right now.' });
      });
    return () => {
      live = false;
    };
  }, [drilldownPoint, dAlpha, view]);

  // Snapshot the last resolved cohort so the panel can render it while fading out (by exit time the
  // live state has reset to idle). Presentation only — no fetch involvement.
  useEffect(() => {
    if (cohort.kind === 'ready' || cohort.kind === 'refreshing') {
      cohortSnapshotRef.current = { data: cohort.data, prefix: dAlpha };
    }
  }, [cohort, dAlpha]);

  const busy = status === 'loading' || isPending;
  // A refetch is in flight but we still have rows on screen → dim + progress bar (don't blank).
  const gridRefreshing = busy && rows.length > 0;

  function toggleSort(key: CmdExplorerSort['column']) {
    setSort((prev) =>
      prev.column === key
        ? { column: key, direction: prev.direction === 'desc' ? 'asc' : 'desc' }
        : { column: key, direction: 'desc' },
    );
  }

  // --- column visibility + saved views --------------------------------------
  // Toggle a column's VISIBILITY in place (position is preserved — visibility and order are now
  // independent). PHI columns are locked-visible (never toggle). Never hide the last visible column.
  function toggleColumnVisible(key: ColKey) {
    if (IS_PHI.has(key)) return; // locked-visible; masking is handled separately
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key); // show
        return next;
      }
      // Hiding: refuse if it would leave zero visible columns.
      const visibleCount = order.reduce((n, k) => n + (next.has(k) ? 0 : 1), 0);
      if (visibleCount <= 1) return prev;
      next.add(key);
      return next;
    });
  }
  function resetColumns() {
    setOrder([...DEFAULT_ORDER]);
    setHidden(new Set());
  }
  /** Apply a saved view's layout (full order + hidden set), tolerant of the legacy format. */
  function applyView(v: GridViewRow) {
    const layout = deriveLayout(v);
    setOrder(layout.order);
    setHidden(layout.hidden);
  }
  /** Save the CURRENT layout as a named view: the full column order + the hidden set. */
  async function handleSaveView(name: string, makeDefault: boolean): Promise<GridViewMutationOutcome> {
    const res = await saveGridView(name, order as string[], [...hidden] as string[], makeDefault);
    if (res.ok) await refreshViews();
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  async function handleSetDefaultView(name: string) {
    const res = await setDefaultGridView(name);
    if (res.ok) await refreshViews();
  }
  async function handleDeleteView(name: string) {
    const res = await deleteGridView(name);
    if (res.ok) await refreshViews();
  }

  // --- facility + payer multi-select handlers (guided search) ---------------
  function toggleFacility(value: string) {
    setFacilitySelection((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }
  function clearFacilities() {
    setFacilitySelection([]);
  }
  function togglePayer(value: string) {
    setPayerSelection((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }
  function clearPayers() {
    setPayerSelection([]);
  }

  /** Pick a rolling recency window (toggle off if re-clicked); clears any Month/Year selection. */
  /**
   * Validate and apply a custom range.
   *
   * ⚠ THE SERVER IS AUTHORITATIVE — applyDateWindow re-validates every one of these rules and
   * returns false on any violation. This is a UX pre-check so the reader is told BEFORE a
   * round-trip, not a trust boundary. Never relax the server side to match a client change here.
   *
   * REJECTS, never clamps: a clamped range would return different data than the one asked for,
   * without saying so.
   */
  function applyCustomRange() {
    if (draftFrom === '' || draftTo === '') {
      setCustomError('Pick both a start and an end date.');
      return;
    }
    if (draftFrom > draftTo) {
      setCustomError('The start date must be on or before the end date.');
      return;
    }
    // Both dates are INCLUSIVE, so an N-day span is (to - from) + 1.
    const span =
      Math.round((Date.parse(`${draftTo}T00:00:00Z`) - Date.parse(`${draftFrom}T00:00:00Z`)) / 86_400_000) + 1;
    if (!Number.isFinite(span) || span < 1) {
      setCustomError('That range is not a valid pair of dates.');
      return;
    }
    if (span > CUSTOM_MAX_DAYS) {
      setCustomError(`That range is ${span} days. The maximum is ${CUSTOM_MAX_DAYS}.`);
      return;
    }
    setCustomError('');
    setCustomFrom(draftFrom);
    setCustomTo(draftTo);
    setRecencyDays(0); // a custom range and a preset are mutually exclusive
    setCustomOpen(false);
  }

  /** Drop back to the 90-day default — never to an unbounded window, which no longer exists. */
  function clearCustomRange() {
    setCustomFrom('');
    setCustomTo('');
    setDraftFrom('');
    setDraftTo('');
    setCustomError('');
    setRecencyDays(90);
    setCustomOpen(false);
  }

  function selectRecency(days: number) {
    // A preset and a custom range are mutually exclusive windows, exactly as the preset and the old
    // Month/Year picker were. Re-clicking the active chip no longer toggles to an unbounded "all
    // months" state — there is no such state any more (ruled: no unbounded window).
    setCustomFrom('');
    setCustomTo('');
    // ⚠ THE DRAFTS GO TOO, exactly as clearCustomRange does it (fixed 2026-08-31, Qodo review of
    // PR #298). Clearing only the APPLIED values left the popover's drafts loaded with the range
    // that was just superseded, so re-opening Custom and pressing Apply resurrected it. The two
    // exits from a custom range must leave identical state; the asymmetry was an oversight, not a
    // design.
    setDraftFrom('');
    setDraftTo('');
    setCustomError('');
    setRecencyDays(days);
  }

  /** Apply (or toggle off) a single-field drill-down refinement from a summary chip. */
  function applyRefinement(kind: RefineKind, value: string) {
    // Facility/payer summary clicks ADD a tag to the guided search (dedup) — unifying the drill with
    // the pickers. Any other kind falls back to the single refinement (none is emitted today; the CPT
    // card was replaced by facilities). The CPT×Rev combo table uses applyComboRefinement, not this.
    if (kind === 'facility') {
      setFacilitySelection((prev) => (prev.includes(value) ? prev : [...prev, value]));
    } else if (kind === 'primary_payer') {
      setPayerSelection((prev) => (prev.includes(value) ? prev : [...prev, value]));
    } else {
      setRefinement((prev) =>
        prev && prev.kind === kind && 'value' in prev && prev.value === value ? null : { kind, value },
      );
    }
    // No resetGridScroll() here on purpose: every branch above changes a value `filterArg` depends
    // on, which drives the reload effect into loadPage, which owns the reset. A second call here
    // would fire before the new rows exist and is exactly the two-mechanisms-for-one-job split that
    // left the pager unwired in the first place.
  }

  /**
   * Apply (or toggle off) a (CPT, Revenue-code) COMBO refinement — narrows the grid by BOTH codes
   * at once. Re-clicking the active combo clears both together (back to the search-level results).
   */
  function applyComboRefinement(cpt: string, revenue: string) {
    setRefinement((prev) =>
      prev && prev.kind === 'combo' && prev.cpt === cpt && prev.revenue === revenue
        ? null
        : { kind: 'combo', cpt, revenue },
    );
    // See applyRefinement: loadPage owns the scroll reset, reached via the filterArg reload effect.
  }

  /**
   * Select (or toggle off) a cohort-curve point to open its drilldown. Purely a UI selection — it
   * does not touch the grid's `refinement`/search state, unlike applyRefinement above.
   */
  function selectDrilldownPoint(axis: 'position' | 'days', bucket: number) {
    setDrilldownPoint((prev) => (prev && prev.axis === axis && prev.bucket === bucket ? null : { axis, bucket }));
  }

  // Decrypt the CURRENT page's PHI via the audited server action. Unchanged reveal logic — just
  // extracted so the sticky preference can call it on each page (incl. after navigation).
  const revealCurrentPage = useCallback(async () => {
    if (rows.length === 0) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await revealCmdReportRows(rows.map((r) => r.id));
      if (res.ok) {
        const map = new Map<number, CmdExplorerPhi>();
        for (const r of res.rows) {
          const { id, ...phiFields } = r;
          map.set(id, phiFields);
        }
        setPhi(map);
        setRevealed(true);
      } else {
        setRevealError(res.error);
      }
    } catch {
      setRevealError('The identifiers could not be revealed right now.');
    } finally {
      setRevealing(false);
    }
  }, [rows]);

  // Honor the sticky preference: when ON, auto-reveal the current page (loadPage resets `revealed`
  // to false for each fresh page, so this re-fires after every navigation — each audited). When
  // OFF, hide immediately. Gated on canRevealPhi so a non-entitled role can never trigger a reveal.
  // The `status === 'ready'` guard is essential: it waits until the NEW page's rows have landed, so
  // a mid-navigation fire can't reveal the stale page and leave the new one masked.
  useEffect(() => {
    if (!canRevealPhi) return;
    if (revealAll && status === 'ready' && !revealed && !revealing && rows.length > 0) {
      void revealCurrentPage();
    } else if (!revealAll && revealed) {
      setRevealed(false);
    }
  }, [revealAll, revealed, revealing, rows, status, canRevealPhi, revealCurrentPage]);

  function cellText(key: ColKey, row: GridRow): string {
    // GROUPED MODE, two columns only.
    //
    // Charge From Date becomes the SPAN the group covers — the "multiple days ... all on a payment
    // that came in on a single day" the grouping was asked for. A single-day group prints one date,
    // so the arrow only appears when it is actually saying something.
    if (grouped && key === 'charge_date' && row.__chargeDateEnd && row.__chargeDateEnd !== row.charge_date) {
      return `${row.charge_date ?? '—'} → ${row.__chargeDateEnd}`;
    }
    // THREE states, not two. A null code means either "the group spans several values" or "no line
    // in the group has one at all", and those are different facts: "Multiple" understates the second
    // and an em dash understates the first. The server sends a `*_mixed` flag precisely so the UI
    // does not have to guess from a null.
    if (grouped && (key === 'cpt_code' || key === 'revenue_code')) {
      if (row[key] !== null) return row[key] as string;
      const mixed = key === 'cpt_code' ? row.__cptMixed : row.__revenueMixed;
      return mixed ? 'Multiple' : '—';
    }
    if (IS_PHI.has(key)) {
      if (!revealed) return PHI_MASK;
      const p = phi.get(row.id);
      const v = p ? p[key as keyof CmdExplorerPhi] : null;
      return v ?? '—';
    }
    const v = row[key as keyof GridRow] as string | null;
    if (IS_PERCENT.has(key)) return formatPercent(v);
    if (IS_NUMERIC.has(key)) return formatMoney(v);
    // Employer: a null means "this policy has no plan sponsor" — an individual policy — but ONLY
    // once employer data actually exists for this tenant. Before the CMD reports carry the column
    // and the one-shot backfill lands, EVERY row is null, and printing "Individual" across the
    // whole book would state a fact we do not have. Gate on coverage and fall back to the ordinary
    // em dash, which correctly reads as "no value" rather than as a classification.
    // Nothing is ever written to the row to mark it individual (ruled 2026-08-15) — this label is
    // derived at render time only.
    // A blank employer means THREE different things, and the row's own tenant is what tells them
    // apart. RULED BY ALEC 2026-08-17:
    //
    //   Indigo row  -> "No Employer Name in CMD". Indigo's facilities do not enter an employer at
    //                  the source AT ALL, so the column is structurally empty. A bare dash reads as
    //                  a UI failure; naming the source makes it clear the app is not dropping data.
    //   BXR row     -> "Individual" — a real classification: the policy has no plan sponsor. Only
    //                  valid once employer data EXISTS for that tenant, otherwise every row would
    //                  be labelled from a book that is simply not populated yet.
    //   otherwise   -> the ordinary em dash, which reads as "no value" rather than a claim.
    //
    // Decided per ROW, not per view, so Consolidated stays honest in both directions: an Indigo row
    // says why it is empty while a BXR row beside it can still say "Individual".
    // Nothing is ever written to the row to mark it (ruled 2026-08-15) — derived at render only.
    if (key === 'employer_name') {
      if (v !== null && v !== '') return v;
      if (INDIGO_FACILITY_CODES.has(row.facility)) return 'No Employer Name in CMD';
      return allHaveEmployerData || hasEmployerData ? 'Individual' : '—';
    }
    return v ?? '—';
  }

  const windowLabel =
    customActive
      ? `${customFrom} → ${customTo}`
      : recencyDays > 0
      ? (WINDOW_PRESETS.find((p) => p.days === recencyDays)?.label ?? `Past ${recencyDays} days`)
      : 'Past 90 days';
  const facilityLabel =
    facilitySelection.length === 0
      ? 'All facilities'
      : `${facilitySelection.length} facilit${facilitySelection.length === 1 ? 'y' : 'ies'}`;
  const payerLabel =
    payerSelection.length === 0
      ? 'All payers'
      : `${payerSelection.length} payer${payerSelection.length === 1 ? '' : 's'}`;

  return (
    /* THE HEIGHT CHAIN, top to bottom: <main> (collections/page.tsx) is bounded to the viewport;
       this root is its growing child; the detail grid below is THIS element's growing child; the
       scrollport is the grid's. Every link needs `min-h-0`, because a flex item's default
       `min-height:auto` refuses to shrink below its content — one missing `min-h-0` anywhere in
       the chain and the whole thing silently reverts to a page-scrolling table.

       CollectionsView renders no DOM of its own, so this div is a DIRECT flex child of <main>.
       `gap-4` replaces `space-y-4` — same spacing, but margins on flex children interact badly
       with shrink calculations, and gap does not. */
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* ---- Search hero -------------------------------------------------- */}
      {/* `shrink-0`: the filter panel must stay whole and always visible — it is the control
          surface for the grid below it. Allowed to shrink, it squashes and its content overlaps
          the panel beneath. */}
      <div className="shrink-0 rounded-xl border border-line bg-card px-4 py-3 shadow-ths">
        {/* `items-start`, NOT `items-end`. Every cell here is label-over-control, so bottom-aligning
            them only lines up the CONTROLS — and because the Window cell used to carry a third row
            (the Include-scheduled checkbox), its label floated ~26px above the other three. Four
            labels on four different baselines is what read as "bad spacing"; top-aligning puts them
            on one line. The checkbox itself has moved down to the scope line, where there is unused
            width, so the Window cell is now label+control like its siblings.
            `ml-auto` on the Window cell sends the slack to the middle instead of trailing off the
            right edge, and the picker wrappers cap the pickers so they stop sprawling to ~430px on
            a wide monitor. */}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          {/* Guided search — Facility + Payer multi-select tag pickers (replaces the old free-text
              bar + facility dropdown). Both scope the grid AND the summary; empty = no restriction.
              Options load once per tenant and filter client-side as the user types. */}
          {/* Each picker is wrapped only to CAP its width. The picker's own root is
              `min-w-[15rem] flex-1` (a shared component — 4 other surfaces mount it, so it is not
              edited here), which on an 1800px container stretches each one to ~430px of empty
              type-ahead. The wrapper keeps the floor and adds a ceiling. */}
          <div className="min-w-[15rem] max-w-[22rem] flex-1">
            <MultiSelectTagPicker
              label="Facility"
              placeholder="Type to find facilities…"
              icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
              options={facilityPickerOptions}
              selected={facilitySelection}
              onToggle={toggleFacility}
              onClear={clearFacilities}
            />
          </div>
          <div className="min-w-[15rem] max-w-[22rem] flex-1">
            <MultiSelectTagPicker
              label="Payer"
              placeholder="Type to find payers…"
              icon={<CreditCard className="h-3.5 w-3.5" aria-hidden />}
              options={payerPickerOptions}
              selected={payerSelection}
              onToggle={togglePayer}
              onClear={clearPayers}
            />
          </div>
          {/* ⚠ ALWAYS MOUNTED as of 2026-08-17 — it used to be gated on `employerMode === 'employer'`.
              THE MOUNT ITSELF WAS THE BUG. Every picker in this row is `min-w-[15rem] flex-1`, so
              adding a third one makes flexbox re-divide the free space: Facility and Payer visibly
              SHRANK when Employer appeared and grew back when it vanished. Toggling the segment slid
              the whole bar left and right, which is what "the filter back and forth sets the bar to
              the left or the right" describes. Conditional mounting inside a flex row cannot be
              styled out of that — the element has to stay.

              Employer is now searchable in All as well, which is the other half of the request: the
              segment is a partition (has a sponsor / has none), and narrowing BY NAME is a different
              question that should not require picking a partition first.

              Individual is the one place it stays inert: that segment means "no plan sponsor", so a
              named employer there could only ever return zero rows. Disabled — NOT unmounted —
              because unmounting is the reflow we just removed. serverDriven: onQueryChange feeds the
              debounced search and the returned set is passed through unfiltered (server-matched). */}
          {hasEmployerData && (
            <div className="min-w-[15rem] max-w-[22rem] flex-1">
              <MultiSelectTagPicker
                label="Employer"
                placeholder="Type to find employers…"
                icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
                options={employerPickerOptions}
                selected={employerSelection}
                onToggle={toggleEmployer}
                onClear={clearEmployers}
              />
            </div>
          )}
          {/* Time window: ONE segmented control — [7d][14d][30d][90d][6m][1y][Custom ▾] plus the
              "Include scheduled" toggle beneath it.

              DEFAULT is 90d (see recencyDays init) so the first-load summary hits the index path.

              ⚠ THERE IS NO UNBOUNDED STATE ANY MORE (ruled 2026-08-30). Re-clicking the active chip
              used to toggle to "All months" — an unbounded scan, which is how the consolidated-scope
              sort spill becomes a timeout. A chip now simply stays selected, and Clear on the custom
              popover returns to 90d rather than to nothing.

              ⚠ THE MONTH/YEAR PICKER IS GONE, FOLDED INTO CUSTOM. A calendar month is expressible as
              a custom range and resolves to byte-identical bounds (pinned in
              test/businessWindow.test.ts), so the fold costs the LABEL and nothing else. `year` and
              `month` are removed from the wire — two ways to say one window is how drift starts.

              Every bound comes from src/businessWindow.ts. This component does NO date arithmetic
              and reads no clock: even the "scheduled" flag arrives pre-computed per row, so there is
              no timezone dependency here and nothing to go stale across midnight Pacific. */}
          {/* ⚠ THIS WAS "small and unnoticeable" (Alec, 2026-08-18). Three causes, all fixed here:
                · the group's border was `border-line` (#E4E9E6) — 1.23:1 against the white surface
                  it sits on — so the control had no perceptible boundary and read as loose text
                  rather than a control. WCAG 1.4.11 wants >=3:1 for a control boundary; ink400
                  (#63756E) measures 4.61:1 on the #FBF8F4 ground. Same invisible token, and the
                  same fix, as the tenant tabs.
                · every sibling in this row (Facility / Payer / Employer) carries a visible uppercase
                  label; this one had only an aria-label, making it the single facet a sighted user
                  could not name.
                · the segments were text-xs at px-2.5/py-1 — the smallest thing in the row — and the
                  ACTIVE segment was marked by a pale --brand-soft fill ALONE, with no weight change
                  and no boundary, so "which window am I on" was barely readable.
              Now: labelled like its siblings, bordered in a token that can actually be seen, text-sm
              at px-3/py-1.5 (~48x34, comfortably over the 24x24 WCAG 2.5.8 target minimum), and the
              active segment carries fill + WEIGHT + an inset ring so selection never rests on tint
              alone (WCAG 1.4.1 — colour must not be the only channel). */}
          <div className="ml-auto">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden />
              Window
            </div>
            <div
              className="inline-flex items-center gap-1 rounded-lg border border-ink400 bg-surface p-1"
              role="group"
              aria-label="Time window"
            >
            {WINDOW_PRESETS.map((p) => {
              const active = !customActive && recencyDays === p.days;
              return (
                <button
                  key={p.days}
                  type="button"
                  aria-pressed={active}
                  title={p.label}
                  onClick={() => selectRecency(p.days)}
                  className={[
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-[var(--brand-soft)] font-semibold text-[var(--brand-ink)] ring-1 ring-inset ring-[var(--brand-ink)]'
                      : 'font-medium text-muted-foreground hover:bg-[var(--brand-soft)] hover:text-ink900',
                  ].join(' ')}
                >
                  {p.chip}
                </button>
              );
            })}
            {/* [Custom ▾] — replaces the Month/Year popover (ruled 2026-08-30). A calendar month is
                expressible as a custom range and resolves to byte-identical bounds
                (test/businessWindow.test.ts pins it), so the fold costs the LABEL and nothing else.
                Two ways to say one window is how the next drift starts. */}
            <div ref={customRef} className="relative">
              <button
                type="button"
                aria-expanded={customOpen}
                aria-haspopup="true"
                onClick={() => setCustomOpen((o) => !o)}
                className={[
                  'flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors',
                  customActive
                    ? 'bg-[var(--brand-soft)] font-semibold text-[var(--brand-ink)] ring-1 ring-inset ring-[var(--brand-ink)]'
                    : 'font-medium text-muted-foreground hover:bg-[var(--brand-soft)] hover:text-ink900',
                ].join(' ')}
              >
                {customActive ? `${customFrom} → ${customTo}` : 'Custom'}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
              </button>
              {customOpen && (
                <div
                  role="dialog"
                  aria-label="Choose a custom date range"
                  className="absolute right-0 top-full z-50 mt-2 w-[22rem] animate-ths-reveal rounded-lg border border-line bg-surface p-3 shadow-ths"
                >
                  <div className="flex items-end gap-2">
                    <label className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      From
                      <input
                        type="date"
                        value={draftFrom}
                        onChange={(e) => setDraftFrom(e.target.value)}
                        className="mt-1 w-full rounded-md border border-ink400 bg-surface px-2 py-1.5 text-sm font-normal normal-case text-ink900"
                      />
                    </label>
                    <label className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      To
                      <input
                        type="date"
                        value={draftTo}
                        onChange={(e) => setDraftTo(e.target.value)}
                        className="mt-1 w-full rounded-md border border-ink400 bg-surface px-2 py-1.5 text-sm font-normal normal-case text-ink900"
                      />
                    </label>
                  </div>
                  {/* Both dates are INCLUSIVE, and saying so matters: the server turns `to` into a
                      half-open bound of to+1, and a reader who assumes exclusive would think the
                      last day was missing. */}
                  <p className="mt-2 text-xs text-ink400">
                    Both dates included. Maximum {CUSTOM_MAX_DAYS} days.
                  </p>
                  {customError !== '' && (
                    <p role="alert" className="mt-2 text-xs font-medium text-coral600">
                      {customError}
                    </p>
                  )}
                  <div className="mt-3 flex justify-end gap-2">
                    {customActive && (
                      <button
                        type="button"
                        onClick={clearCustomRange}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-[var(--brand-soft)] hover:text-ink900"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={applyCustomRange}
                      className="rounded-md bg-[var(--brand-ink)] px-3 py-1.5 text-sm font-semibold text-white"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </div>

        {/* Gated patient lookup — only for PHI-entitled roles. Matched via keyed blind indexes
            server-side (exact member ID / 3-char alpha prefix / exact group #), audited, results
            masked. The raw value is never substring-matched and never revealed by the search.

            Type size: `text-xs` (13px) throughout, NOT the `text-[11px]` this block shipped with —
            the design system's 12px floor for meaning-bearing text is repo-wide ("no text-[…px]
            below it, anywhere") and text-xs is the smallest house size. Same correction the tag
            picker already took. It costs a few pixels back; the row merge below more than pays. */}
        {canRevealPhi && (
          <div className="mt-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Fingerprint className="h-3.5 w-3.5 text-[var(--brand-ink)]" aria-hidden />
              Patient lookup
              <span className="inline-flex items-center gap-1 font-normal normal-case text-ink400">
                <Lock className="h-3 w-3" aria-hidden /> encrypted · exact match · audited
              </span>
            </div>
            {/* ONE ROW, not two stacked ones. The exact-match fields and the partial-match name
                search are still visibly SEPARATE — that distinction is real and documented below —
                but the separator is now a vertical rule inside a wrapping row instead of a
                horizontal border between two rows, which reclaims ~70px of panel height. On a
                narrow viewport the row simply wraps and the rule hides, so nothing is lost. */}
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <PhiField label="Member ID" value={phiMemberId} onChange={setPhiMemberId} placeholder="exact member ID" width="w-48" />
              <PhiField label="Alpha prefix" value={phiAlphaPrefix} onChange={setPhiAlphaPrefix} placeholder="3-letter" width="w-28" maxLength={3} />
              <PhiField label="Group #" value={phiGroup} onChange={setPhiGroup} placeholder="exact group #" width="w-40" />
              <div aria-hidden className="hidden h-8 w-px shrink-0 bg-line lg:block" />

              {/* PATIENT NAME — deliberately SEPARATE from the exact-match fields to its left,
                  because it behaves differently: it is a PARTIAL match, over the whole book. The
                  separation is now the vertical rule above rather than a horizontal border; the
                  distinction is unchanged, only its geometry.

                  It used to be inert until something else narrowed the rows, because the search
                  decrypted candidate ROWS and had to be capped at 2,000 of 686,503. Migration 0105
                  made the candidate set the ~11k distinct patients instead, so the gate had nothing
                  left to protect and is gone. What has NOT changed is the entitlement: the entire
                  block is behind canRevealPhi, and the server re-checks it.

                  The label now sits INLINE, matching PhiField, so all four controls share one
                  baseline instead of this one hanging 20px lower than its neighbours. */}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="whitespace-nowrap">Patient name</span>
                <input
                  id="phi-patient-name"
                  type="text"
                  value={nameQuery}
                  maxLength={120}
                  onChange={(e) => setNameQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runNameSearch();
                  }}
                  placeholder="full or partial name"
                  // autoComplete off: this value is PHI and must not be stored by the browser.
                  autoComplete="off"
                  className="h-8 w-56 rounded-md border border-line bg-canvas px-2 text-sm text-ink900 outline-none transition-colors placeholder:text-ink400 focus:border-[var(--brand-accent)] focus:ring-2 focus:ring-[var(--brand-accent)]/25 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-describedby="phi-patient-name-help"
                />
              </label>
              <button
                type="button"
                onClick={runNameSearch}
                disabled={nameQuery.trim() === '' || nameSearching}
                className="h-8 rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink900 transition-colors hover:bg-[var(--brand-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {nameSearching ? 'Searching…' : 'Search'}
              </button>
              {nameMatchTokens !== null && (
                <button
                  type="button"
                  onClick={() => { setNameMatch(null); setNameQuery(''); setNameNotice(null); }}
                  className="h-8 rounded-md px-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Clear name filter
                </button>
              )}
            </div>
            {/* The WHAT, always visible. It used to explain a restriction; now it sets the one
                expectation that is still worth setting — the search spans the whole book, so the
                grid may show fewer rows than the match count when other filters are active. */}
            <p id="phi-patient-name-help" className="mt-1.5 text-xs text-muted-foreground">
              {nameNotice ??
                'Matches part of a name across every patient in this view — no need to narrow first. Your other filters still apply to the rows shown.'}
            </p>
          </div>
        )}

        {/* Active-scope line + Include-scheduled + active refinement pill.
            The scope line is one short sentence on a full-width row, so it had the spare width to
            adopt the Include-scheduled toggle from the Window cell — which is what let that cell
            drop to label+control and pulled ~26px out of the panel. It also reads better here:
            the toggle changes the WINDOW's upper bound, and this line is where the active window
            is stated in words. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <span>
            {hasAnySearch
              ? `${facilityLabel} · ${payerLabel} · ${windowLabel}`
              : `Browsing ${facilityLabel} · ${payerLabel} · ${windowLabel} — pick a facility or payer to search`}
          </span>
          {/* INCLUDE SCHEDULED — an upper-bound override, off by default.
              ⚠ NEVER HIDDEN OR DISABLED, even when it currently changes nothing (ruled
              2026-08-30). All 106 future-dated charges today are Indigo, so on the BXR tab this
              toggle is inert — but a control that appears and disappears with the data is worse
              than an inert one: the reader cannot learn what it does, and its absence looks like
              a bug rather than an empty set. Moved here from the Window cell 2026-09-02; still
              always rendered, still always enabled. */}
          <label className="flex items-center gap-1.5 font-medium">
            <input
              type="checkbox"
              checked={includeScheduled}
              onChange={(e) => setIncludeScheduled(e.target.checked)}
              className="h-4 w-4 rounded border-ink400"
            />
            Include scheduled payments
          </label>
          {refinement && (
            <button
              type="button"
              onClick={() => setRefinement(null)}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2 py-0.5 font-medium text-[var(--brand-ink)] transition-colors hover:bg-[var(--brand-accent)]/20"
            >
              {refinementLabel(refinement)}
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* ---- Search summary (search-engine result) ------------------------ */}
      {/* Wrapped only for `shrink-0` — see the note on the search hero above. Same for the AI and
          cohort panels below: each is a fixed-size block in the column, and only the detail grid
          grows. */}
      {hasAnySearch && (
        <div className="shrink-0">
          <SearchSummaryPanel
            state={summary}
            label="your selection"
            refinement={refinement}
            onDrill={applyRefinement}
            onDrillCombo={applyComboRefinement}
            facilityDisplayName={facilityDisplayName}
          />
        </div>
      )}

      {/* ---- AI analysis (streamed, both modes) ---------------------------- */}
      {/* Keyed on the search signature: any filter/search/prefix/view change remounts it to idle and
          its unmount cleanup aborts an in-flight stream, so a stale answer can't describe a new
          selection.
          ⚠ ORDER: this sits ABOVE the cohort panel as of 2026-08-31 (it is the primary read; the
          prefix-wide cohort panel below is reference and now opens collapsed). This is a PLAIN
          SIBLING reorder — `aiInput` is computed in THIS component from the `cohort` state, never
          from anything CohortCurvePanel renders, and the two carry different render gates
          (`hasAnySearch` vs `cohortPresence.rendered`), so neither has ever been able to assume the
          other is mounted. Moving them changes paint order and nothing else. */}
      {hasAnySearch && (
        <div className="shrink-0">
          <CollectionsAiPanel key={aiKey} input={aiInput} view={view} />
        </div>
      )}

      {/* ---- Alpha-prefix cohort payer-behavior curve (PHI-gated, Session D) --- */}
      {/* Kept mounted through its exit animation so it fades out instead of popping; during the exit
          window the live state has reset to idle, so render the frozen snapshot. */}
      {cohortPresence.rendered && (
        <div className={`shrink-0 ${cohortPresence.exiting ? 'animate-ths-exit' : 'animate-ths-reveal'}`}>
          {cohortPresence.exiting && cohortSnapshotRef.current ? (
            // Frozen snapshot fading out — drilldownPoint is already cleared by the effect above
            // (it resets on any cohortActive/prefix change), so no live selection to render here.
            <CohortCurvePanel
              // Deliberately the SAME key the live panel carried a moment ago (same view, and the
              // snapshot's prefix IS the prefix that just cleared), so the instance survives into
              // the exit fade and the panel fades out in the state the user left it — rather than
              // snapping shut on its way off screen.
              key={`${view}|${cohortSnapshotRef.current.prefix}`}
              state={{ kind: 'ready', data: cohortSnapshotRef.current.data }}
              prefix={cohortSnapshotRef.current.prefix}
              selectedPoint={null}
              drilldown={null}
              onSelectPoint={() => {}}
              onCloseDrilldown={() => {}}
            />
          ) : (
            <CohortCurvePanel
              // KEYED ON COHORT IDENTITY (Qodo #313, 2026-09-01). `collapsed` lives inside the panel
              // and its useState initializer runs ONLY at mount — but the panel does not unmount on a
              // prefix or tenant change: `cohortActive` stays true across "ABC" → "XYZ", the fetch
              // converts ready → refreshing to keep the prior curve visible, and this JSX position is
              // otherwise stable. So an expanded panel stayed expanded for the NEXT cohort, defeating
              // the collapsed-by-default ruling in exactly the search-one-prefix-then-another flow the
              // panel exists for. The key remounts it per (tenant, prefix) — the React-idiomatic
              // "reset all state when the identity changes", rather than a second source of truth.
              key={`${view}|${dAlpha}`}
              state={cohort}
              prefix={dAlpha}
              // P1 scope disclosure: with an exact Member-ID lookup active the grid narrows to
              // (usually) one patient while this panel still shows the whole prefix cohort — the
              // panel de-emphasizes itself and says so.
              memberIdActive={dMember !== ''}
              selectedPoint={drilldownPoint}
              drilldown={drilldown}
              onSelectPoint={selectDrilldownPoint}
              onCloseDrilldown={() => setDrilldownPoint(null)}
            />
          )}
        </div>
      )}

      {/* ---- Detail grid -------------------------------------------------- */}
      {/* The growing link in the height chain (see the root div). Its own children then split that
          height three ways: toolbar and pager hold their size, the scrollport takes the rest. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 items-center justify-between gap-3">
          {/* The grid pages SNAPSHOT/POSTING rows (full history — one charge line can appear once
              per payment posting/state change), while the summary above counts logical charge
              lines on the 0050 rollup. Two grains, two labels — on purpose. */}
          <p className="text-sm text-muted-foreground">
            {hasAnySearch ? 'Matching posting rows' : 'Posting rows'} · {rows.length.toLocaleString()} on this
            page · one charge line may appear once per payment posting
          </p>
          <div className="flex items-center gap-2">
            {/* Column layout + saved views — a GRID control (lives on the grid toolbar, not the search
                hero). Shown columns are both what the grid displays and what the search term matches. */}
            <div className="relative">
              {/* GROUP BY PAYMENT — condense the charge lines that arrived on one payment.
                  Measured live: 497,337 rollup rows collapse to 101,158 groups (4.92 lines each), so
                  a 50-row page carries ~246 lines' worth of content.

                  DEFAULT OFF on purpose: a grouped row cannot answer "which CPT on which date", and
                  that is most of what this tab is used for. `aria-pressed` (not a checkbox) because
                  it toggles how the SAME data is shaped, rather than selecting a thing. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={grouped}
                onClick={toggleGrouped}
                title={
                  grouped
                    ? 'Showing one row per payment. Turn off to see every charge line.'
                    : 'Condense the charge lines that arrived on the same payment into one row.'
                }
                className={[
                  'gap-1.5',
                  grouped ? 'bg-[var(--brand-soft)] ring-1 ring-[var(--brand-accent)]/40' : '',
                ].join(' ')}
              >
                <Layers className="h-4 w-4" aria-hidden />
                Group by payment
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={columnsMenuOpen}
                aria-haspopup="true"
                onClick={() => setColumnsMenuOpen((o) => !o)}
                className={[
                  'border-line bg-[var(--brand-soft)]/50 text-ink900 hover:bg-[var(--brand-soft)]',
                  columnsMenuOpen ? 'bg-[var(--brand-soft)] ring-1 ring-[var(--brand-accent)]/40' : '',
                ].join(' ')}
              >
                <Columns3 className="h-4 w-4" aria-hidden />
                Columns
                <span className="ml-1 rounded-full bg-[var(--brand-soft)] px-1.5 text-[11px] font-semibold text-[var(--brand-ink)]">
                  {visibleOrder.length}/{COLUMNS.length}
                </span>
                {/* The layout auto-saves; when that FAILS the user must not be left believing their
                    columns are sticky. Quiet by design — a failed layout save is not worth a banner
                    over the grid, but silence is what made it a bug (Qodo #3). */}
                {layoutSaveFailed && (
                  <span
                    className="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800"
                    title="Your column layout could not be saved, so it will not persist on reload."
                  >
                    not saved
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
              </Button>
              {columnsMenuOpen && (
                <ColumnViewManager
                  order={order}
                  hidden={hidden}
                  sensors={sensors}
                  onReorder={reorderColumns}
                  views={namedViews}
                  onToggleColumn={toggleColumnVisible}
                  onReset={resetColumns}
                  onLoadView={applyView}
                  onSaveView={handleSaveView}
                  onSetDefault={handleSetDefaultView}
                  onDeleteView={handleDeleteView}
                  onClose={() => setColumnsMenuOpen(false)}
                />
              )}
            </div>
            {rows.length > 0 && canRevealPhi && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revealing}
                aria-pressed={revealAll}
                onClick={() => setRevealAll((v) => !v)}
                className={[
                  'border-line bg-[var(--brand-soft)]/50 text-ink900 hover:bg-[var(--brand-soft)]',
                  revealAll ? 'border-[var(--brand-accent)] bg-[var(--brand-soft)] text-[var(--brand-ink)]' : '',
                ].join(' ')}
              >
                {revealAll ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                {revealing ? 'Revealing…' : revealAll ? 'Hide identifiers' : 'Reveal all'}
              </Button>
            )}
          </div>
        </div>

        {status === 'error' && (
          <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            That page could not be loaded. Try again.
          </div>
        )}

        {revealError && (
          <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {revealError}
          </div>
        )}

        {/* The three branches below are siblings in the same flex column as the pager, so the two
            that are NOT the scrollport need `shrink-0` for the same reason everything else does:
            allowed to shrink, a tall skeleton squashes and paints over the pager beneath it. */}
        {status === 'loading' && rows.length === 0 ? (
          <div className="shrink-0">
            <GridSkeleton cols={visibleOrder.length} />
          </div>
        ) : rows.length === 0 ? (
          <div className="shrink-0 py-8 text-center text-sm text-muted-foreground">
            {hasAnySearch ? 'No charge lines match this search.' : 'No charge lines match the current filters.'}
          </div>
        ) : (
          /* MIN-HEIGHT FLOOR, and it is load-bearing. `flex-1` with no floor lets a tall filter
             panel squeeze the grid to a few pixels on a short viewport — which is exactly the
             200%-zoom case (WCAG 1.4.4) this change exists to satisfy. The floor wins over
             `flex-1`, the column overflows <main>, and the document scrolls instead. Deliberately
             NOT `min-h-0` here: the floor is the point. */
          <div className="relative flex min-h-[20rem] flex-1 flex-col">
            {/* Non-blocking refetch: keep the current page visible, dimmed, with a thin progress bar
                on top — don't blank to a skeleton on every filter/sort/pagination change.
                z-30 so it stays above the sticky header (z-20) it now overlaps. */}
            {gridRefreshing && (
              <div className="absolute inset-x-0 top-0 z-30 h-0.5 animate-pulse rounded-t-md bg-[var(--brand-accent)]" aria-hidden />
            )}
            {/* DndContext moved OUTSIDE the scrollport (it used to sit inside it). It renders no box
                of its own, but it DOES render two dnd-kit accessibility nodes as siblings of its
                children; keeping them out of the scrollport means the scroll extent is exactly the
                table and nothing else. Drag behaviour is unchanged — this is a context provider. */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis]}
              onDragEnd={(e: DragEndEvent) => {
                if (e.over) reorderColumns(String(e.active.id), String(e.over.id));
              }}
            >
              {/* ── THE SCROLLPORT ──────────────────────────────────────────────────────────
                  The ONE scroll container for this grid, on both axes. It replaces a page-level
                  scroll on both: vertically the document used to move (scrolling the filter panel
                  out of view), and horizontally the scrollbar belonged to the shadcn <Table>
                  wrapper — an unbounded-height div, so its bar sat at the bottom of 50 rows and you
                  had to scroll to the end of the page to reach Facility/Employer.

                  ⚠ WHY A BARE <table> AND NOT <Table>: the shadcn primitive wraps its <table> in its
                  OWN `overflow-auto` div (components/ui/table.tsx:7), and that div's className is a
                  hardcoded literal — the `className` prop lands on the inner <table>, so a call site
                  CANNOT neutralize it. Two nested scrollports is how the horizontal bar ended up in
                  the wrong place. ui/table.tsx has 11 consumers and is deliberately NOT edited here,
                  so this one call site drops the wrapper and renders the same <table> markup
                  directly. The semantic children (TableHeader/Row/Head/Cell) are unchanged.

                  `tabIndex`/`role`/`aria-label`: a scrollable div is unreachable by keyboard unless
                  it is focusable (WCAG 2.1.1) — with these, Tab lands here and the arrow keys,
                  PageUp/PageDown, Home/End all scroll it. Do not remove the focus ring; restyle it
                  if it looks wrong.

                  `overscroll-contain`: reaching the end of the table must not chain the scroll on to
                  the document and drag the filter panel away. */}
              <div
                ref={scrollportRef}
                aria-busy={gridRefreshing}
                tabIndex={0}
                role="region"
                aria-label="Collections results"
                className={`min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border transition-opacity duration-150 ${gridRefreshing ? 'opacity-60' : ''}`}
              >
              {/* RATIFIED: a bare <table>, NOT the shared <Table>. The scrollport above is the ONE
                  scroll container; <Table> wraps its table in a second `overflow-auto` div whose
                  class is a hardcoded literal (the className prop lands on the inner <table>), so
                  it cannot be neutralized from here — it would nest a second scrollport and put the
                  horizontal scrollbar back at the bottom of 50 rows. These are the exact classes
                  the primitive applies. Do not "restore" <Table>. */}
              {/* DENSITY: `text-xs` is 13px in this config (tailwind.config.ts fontSize.xs), not the
                  browser's 12px — it is the house scale's smallest size and sits above the design
                  system's 12px floor for meaning-bearing text. Down from `text-sm` (15px), which is
                  a body size and too large for a 17-column financial grid: at 15px with p-2 cells a
                  row is 39px, so a 1440x900 laptop showed SEVEN rows. Never substitute an arbitrary
                  `text-[11px]` to squeeze further — that floor is machine-enforced elsewhere in the
                  repo and this grid should not be the exception. */}
              <table ref={gridTableRef} className="w-full caption-bottom text-xs">
                {/* THE OTHER HALF OF THE STICKY-UNDERLINE FIX (see SortableHeadCell).
                    The cell now draws the line itself, so the collapsed border grid's copy has to
                    go or the two stack 1px apart — 2px of underline at rest, 1px while stuck.
                    TWO overrides because the primitive contributes the border TWICE, from two
                    different elements: `[&_tr]:border-b` on <TableHeader> and `border-b` on
                    <TableRow>.
                    ⚠ AND THE ROW OVERRIDE ALONE IS INERT. `[&_tr]:border-b` compiles to
                    `.\[\&_tr\]\:border-b tr`, specificity (0,1,1), which BEATS a plain
                    `.border-b-0` (0,1,0) on the row — so the obvious one-line call-site fix loses
                    a cascade race silently and the header keeps its doubled line. Each override is
                    therefore placed on the SAME element as the class it cancels, where twMerge
                    DELETES it outright and no specificity comparison ever happens.
                    ui/table.tsx is untouched; its 10 other consumers keep the row border. */}
                <TableHeader className="[&_tr]:border-b-0">
                  <TableRow className="border-b-0">
                    <SortableContext items={visibleOrder} strategy={horizontalListSortingStrategy}>
                      {visibleOrder.map((c) => (
                        <SortableHeadCell
                          key={c}
                          colKey={c}
                          // GROUPED MODE sorts by payment_received only (v1). Ordering groups by an
                          // aggregate is possible but needs its own cursor path per column, and a
                          // half-tested keyset does not fail loudly — it skips or repeats rows while
                          // looking right. The other headers render as plain text rather than as a
                          // control that would silently do nothing.
                          sortable={grouped ? c === 'payment_received' : SORTABLE_KEYS.has(c)}
                          isSorted={sort.column === c}
                          direction={sort.direction}
                          onToggleSort={() => toggleSort(c as CmdExplorerSort['column'])}
                        />
                      ))}
                    </SortableContext>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    /* `scroll-mt-8` = the sticky header's height, which is now `h-8` (was h-10, and
                       this was scroll-mt-10 to match). Nothing in a body row is focusable today, so
                       this is pre-emptive: the moment a row gains a control, scrolling it into view
                       would otherwise park it UNDER the pinned header (WCAG 2.4.3 / 2.4.11). These
                       two numbers must move together — a source pin asserts it. */
                    <TableRow key={row.id} className="scroll-mt-8 transition-colors hover:bg-[var(--brand-soft)]">
                      {visibleOrder.map((c) => (
                        <TableCell
                          key={c}
                          /* `px-2.5 py-1` overrides the primitive's `p-2` (cn() runs twMerge, so the
                             call-site value wins). Vertical padding is what sets row height, and at
                             13px type 4px is enough to keep the row legible — 8px was tuned for 15px
                             body text. Horizontal stays roomy so columns don't collide.
                             `ths-num` on the date/code columns: see IS_MONO. */
                          className={[
                            'px-2.5 py-1',
                            IS_NUMERIC.has(c) ? 'text-right tabular-nums' : '',
                            IS_MONO.has(c) ? 'ths-num' : '',
                            IS_PHI.has(c) && !revealed ? 'text-muted-foreground' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {c === 'facility' ? (
                            <FacilityCell row={row} fallback={cellText(c, row)} />
                          ) : c === 'payment_received' ? (
                            /* One render site serves BOTH row and grouped mode — toGridRow passes
                               is_scheduled straight through, and a grouped row IS one payment date
                               so the flag is exact there too. */
                            <PaymentDateCell row={row} text={cellText(c, row)} />
                          ) : (
                            cellText(c, row)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </table>
              </div>
            </DndContext>
            {/* ── EDGE FADES ──────────────────────────────────────────────────────────────────
                The idle affordance for "there is more content this way". Each one paints only
                when `measureScrollEdges` says content is actually scrolled out past that edge, so
                a grid that fits shows none of them.

                THEY REPLACE NOTHING — this surface never had scrollbar CSS. The bar you see while
                dragging is the OS overlay scrollbar, which is invisible at idle under macOS's
                DEFAULT "Show scroll bars: When scrolling". So the affordance was previously
                OS-preference-dependent by construction, and 11 of the 17 columns sat past the
                right edge with nothing to indicate it.

                ⚠ SIBLINGS OF THE SCROLLPORT, NOT CHILDREN, and that is not a style preference: an
                absolutely-positioned child of a scroll container scrolls WITH the content, so a
                fade parked inside would slide out of view the moment it became relevant. They
                position against the floor wrapper, which is already `relative` and whose box is
                exactly the scrollport's (the scrollport is its only in-flow child, `flex-1`). This
                is the same pattern the refetch progress bar above already uses — no new wrapper.

                ⚠ WHY THEY START BELOW THE HEADER INSTEAD OF RELYING ON z-index. The offset is
                `calc(2rem + 1px)` — 2rem is the sticky header's `h-8`, and the 1px is the
                scrollport's own border, which pushes the header's box down by that much. Together
                they clear the header's LAST pixel row, which is where its underline now lives (see
                the box-shadow on SortableHeadCell). So no fade overlaps the header at all, and the
                separation is geometric rather than a paint-order bet.

                IT HAS TO BE GEOMETRIC, and this was measured rather than assumed. `opacity-60`
                during a refetch makes the scrollport a stacking context, which pulls the header's
                `z-20` INSIDE it — so in that one state a `z-10` sibling paints above the whole
                scrollport, header included. At the earlier `top-8` (a 1px overlap) the underline
                measured 231 → 251 in exactly that state: erased, and only while refetching, which
                is precisely the kind of state-dependent bug that never shows up in review. The
                extra pixel removes the overlap so no state can reach it.

                `z-10` is still set — below the header's `z-20`, the drag branch's `z-30` and the
                progress bar's `z-30` — so the two mechanisms agree instead of one silently
                carrying the whole thing.

                `inset` by 1px on every side that meets the frame: the scrollport draws a 1px
                `border`, and a gradient whose opaque stop is ground would erase it along whichever
                edge is fading. The `rounded-b*` classes clip the two bottom corners to the
                scrollport's own rounding, as the progress bar does with `rounded-t-md`.

                `to-ground/0` rather than `to-transparent`: same hue at zero alpha. `transparent`
                is rgba(0,0,0,0), and an engine that interpolates without premultiplying renders
                that as a grey smudge over a warm ground.

                NO TRANSITION, deliberately, for anyone — so there is no `motion-reduce:` variant
                to get wrong. Appearance is a mount, not an animation, which satisfies "static
                presence" and WCAG 2.3.3 by construction rather than by opt-out. The 1px slack in
                the measurement is what keeps that from reading as a flicker at the extremes. */}
            {scrollEdges.top && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-px top-[calc(2rem_+_1px)] z-10 h-6 bg-gradient-to-b from-ground to-ground/0"
              />
            )}
            {scrollEdges.bottom && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-px bottom-px z-10 h-6 rounded-b-md bg-gradient-to-t from-ground to-ground/0"
              />
            )}
            {scrollEdges.left && (
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-px left-px top-[calc(2rem_+_1px)] z-10 w-8 rounded-bl-md bg-gradient-to-r from-ground to-ground/0"
              />
            )}
            {scrollEdges.right && (
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-px right-px top-[calc(2rem_+_1px)] z-10 w-8 rounded-br-md bg-gradient-to-l from-ground to-ground/0"
              />
            )}
          </div>
        )}

        {/* OUTSIDE the scrollport and `shrink-0`, so Previous/Page N/Next stay on screen instead of
            sitting below 50 rows of table. Wrapped because Pager is shared by four surfaces
            (claims-explorer, collections, work-table, here) and must not be restyled for one. */}
        <div className="shrink-0">
        <Pager
          page={page + 1}
          hasPrev={page > 0}
          hasNext={hasNext}
          disabled={busy}
          onPrev={() => {
            if (page > 0) startTransition(() => void loadPage(page - 1, cursors[page - 1] ?? null, filterArg, sort, grouped));
          }}
          onNext={() => {
            if (hasNext) startTransition(() => void loadPage(page + 1, cursors[page + 1] ?? null, filterArg, sort, grouped));
          }}
        />
        </div>
      </div>
    </div>
  );
}

/**
 * A drag-reorderable table header cell (@dnd-kit sortable). Drag activates on the GRIP handle only —
 * so the sort button still clicks normally and text stays selectable. Keyboard reorder (focus grip →
 * Space → arrows → Space) is handled by the shared KeyboardSensor. Reordering is applied to the full
 * column `order` by the parent (via key lookup), so headers and the popover list stay in sync.
 */
function SortableHeadCell({
  colKey,
  sortable,
  isSorted,
  direction,
  onToggleSort,
}: {
  colKey: ColKey;
  sortable: boolean;
  isSorted: boolean;
  direction: 'asc' | 'desc';
  onToggleSort: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: colKey });
  const numeric = IS_NUMERIC.has(colKey);
  const label = COLUMN_LABEL[colKey] ?? colKey;
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <TableHead
      ref={setNodeRef}
      style={style}
      aria-sort={isSorted ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className={[
        'select-none',
        /* PINNED HEADER. Sticky lives on the <th> cells, not on <thead>: a <thead> is not a
           positioned box in the table layout model, so `position:sticky` on it is a no-op in
           Safari and historically elsewhere. The cells are what actually pin.

           `bg-ground` (#FBF8F4) is the OPAQUE background, and it must stay opaque — a transparent
           <th> lets body rows show through as they scroll under it. It matches what the table
           already renders on: the scrollport sets no background, so the page ground shows through.
           If the scrollport ever gains its own background, this must change with it.

           ⚠ THE DND-KIT INTERACTION IS THE SUBTLE PART. `useSortable` writes a `transform` into
           this cell's inline `style` while dragging, and the drag state used to add
           `relative z-10` — which, merged LAST by twMerge, would have replaced `sticky` with
           `relative` and silently unpinned the header mid-drag. So the drag state now changes only
           the stacking order (z-30, above the sticky z-20 of its neighbours), never the position.
           Do not reintroduce `relative` here. */
        /* `h-8` overrides the primitive's `h-10` (twMerge). The header is a label row, not a data
           row — at 13px it needs 32px, and the 8px it gives back is a third of a body row. */
        'sticky top-0 z-20 h-8 bg-ground',
        /* THE UNDERLINE, AS A SHADOW ON THE CELL RATHER THAN A BORDER ON THE ROW.
           `<table>` is `border-collapse: collapse` (Tailwind preflight), so a `border-b` on the
           header <tr> belongs to the TABLE'S BORDER GRID, not to the cell. The grid scrolls with
           the content while the cell is pinned, so the underline slid away the moment the header
           stuck — measured on merged main: at rest the seam reads as a uniform dark row
           (stddev 0), while stuck it reads as text glyphs and the dark row is simply gone. That
           landed with the sticky header in #314 and was invisible in review because a pinned
           opaque header against a light ground looks nearly right without it.
           An inset box-shadow is painted by the CELL, so it pins with the cell. The row's own
           `border-b` is switched off at the call site (see <TableRow> in the header) so the two
           cannot double up at rest — the shadow is the single source of this line in BOTH states.
           `hsl(var(--border))` is the same token the row border used; never a hex. */
        'shadow-[inset_0_-1px_0_hsl(var(--border))]',
        numeric ? 'text-right' : '',
        isSorted ? 'text-[var(--brand-ink)]' : '',
        isDragging ? 'z-30 opacity-70' : '',
      ].join(' ')}
    >
      <span className={`inline-flex items-center gap-1 ${numeric ? 'flex-row-reverse' : ''}`}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${label}`}
          title="Drag to reorder"
          className="shrink-0 cursor-grab touch-none text-ink400 hover:text-ink600 active:cursor-grabbing"
        >
          <GripVertical className="h-3 w-3" aria-hidden />
        </button>
        {sortable ? (
          /* VISIBLY sortable (2026-08-17). The capability shipped long ago; the affordance was a
             12px chevron pair at opacity-40 with no hover/underline, so "the columns should be
             orderable … making it VISIBLE to the user" was a discoverability report, not a missing
             feature. Three changes, all resting-state:
               · the idle icon goes 40% → 70% opacity and to full opacity on hover,
               · the header underlines on hover, the standard "this is clickable" cue,
               · the ACTIVE column gets a tinted icon chip so the sorted column is findable in one
                 glance across a 16-column grid instead of by hunting a small grey arrow.
             `title` states the next action rather than the current state — a tooltip reading
             "Sorted descending" tells the user what they can already see. */
          <button
            type="button"
            onClick={onToggleSort}
            aria-label={`Sort by ${label}`}
            title={
              isSorted
                ? `Sorted ${direction === 'asc' ? 'ascending' : 'descending'} — click to reverse`
                : `Click to sort by ${label}`
            }
            className="group inline-flex cursor-pointer items-center gap-1 hover:text-[var(--brand-ink)] hover:underline hover:underline-offset-2"
          >
            {label}
            {isSorted ? (
              <span className="inline-flex shrink-0 items-center rounded bg-[var(--brand-soft)] p-0.5 text-[var(--brand-ink)]">
                {direction === 'asc' ? (
                  <ArrowUp className="h-3 w-3" aria-hidden />
                ) : (
                  <ArrowDown className="h-3 w-3" aria-hidden />
                )}
              </span>
            ) : (
              <ArrowUpDown className="h-3 w-3 shrink-0 opacity-70 group-hover:opacity-100" aria-hidden />
            )}
          </button>
        ) : (
          /* Not sortable — see SORTABLE_KEYS for the two distinct reasons (employer is joined
             outside the keyset; PHI exists only as blind indexes). Rendered as plain text with NO
             icon, deliberately: a greyed-out sort icon would advertise a control that can never
             work, which is worse than no affordance at all. */
          label
        )}
      </span>
    </TableHead>
  );
}

/**
 * One drag-reorderable row in the Columns popover: grip handle + show/hide checkbox + label (+ a PHI
 * lock badge). Drag activates on the grip only. `lockHide` disables the checkbox (PHI columns are
 * locked-visible; and the last remaining visible column can't be hidden) — the row is still fully
 * draggable regardless, so a locked column's POSITION is freely reorderable.
 */
function SortableColumnItem({
  colKey,
  label,
  phi,
  shown,
  lockHide,
  onToggle,
}: {
  colKey: ColKey;
  label: string;
  phi: boolean;
  shown: boolean;
  lockHide: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: colKey });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink900',
        isDragging ? 'relative z-10 bg-surface shadow-ths' : 'hover:bg-[var(--brand-soft)]',
      ].join(' ')}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none text-ink400 hover:text-ink600 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      <label className={`flex min-w-0 flex-1 items-center gap-2 ${lockHide ? '' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          checked={shown}
          disabled={lockHide}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 accent-[var(--brand-accent)]"
        />
        <span className={`flex-1 truncate ${shown ? '' : 'text-ink400'}`}>{label}</span>
      </label>
      {phi && <Lock className="h-3 w-3 shrink-0 text-ink400" aria-hidden />}
    </div>
  );
}

/**
 * Column layout + saved-views manager — the "Columns" popover. A two-section manager (top = a single
 * DRAG-TO-REORDER list of every column with a show/hide checkbox; bottom = the user's private saved
 * layouts, with load / set-default / delete / save-current), living on the grid toolbar. This is the
 * SINGLE columns control: the shown columns are both what the grid displays AND (for the searchable
 * ones) what the search term matches. Dragging a row reorders the actual table columns instantly.
 */
function ColumnViewManager({
  order,
  hidden,
  sensors,
  onReorder,
  views,
  onToggleColumn,
  onReset,
  onLoadView,
  onSaveView,
  onSetDefault,
  onDeleteView,
  onClose,
}: {
  order: ColKey[];
  hidden: Set<ColKey>;
  sensors: SensorDescriptor<SensorOptions>[];
  onReorder: (activeKey: string, overKey: string) => void;
  views: GridViewRow[];
  onToggleColumn: (key: ColKey) => void;
  onReset: () => void;
  onLoadView: (v: GridViewRow) => void;
  onSaveView: (name: string, makeDefault: boolean) => Promise<GridViewMutationOutcome>;
  onSetDefault: (name: string) => void | Promise<void>;
  onDeleteView: (name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const visibleCount = order.reduce((n, k) => n + (hidden.has(k) ? 0 : 1), 0);
  const [saveName, setSaveName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitSave() {
    const name = saveName.trim();
    if (name === '') {
      setError('Name your view first.');
      return;
    }
    setSaving(true);
    setError(null);
    const res = await onSaveView(name, makeDefault);
    setSaving(false);
    if (res.ok) {
      setSaveName('');
      setMakeDefault(false);
    } else {
      setError(res.error);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close columns menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Columns and saved views"
        className="absolute right-0 top-full z-50 mt-2 w-80 animate-ths-reveal rounded-lg border border-line bg-surface p-3 shadow-ths"
      >
        {/* Section 1 — reorder + visibility (single drag-to-reorder list of every column) */}
        <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Visible columns</span>
          <span className="font-normal normal-case">{visibleCount} of {COLUMNS.length}</span>
        </div>
        <p className="mb-1.5 text-[11px] text-ink400">Drag to reorder · shown columns are also what search matches.</p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={(e: DragEndEvent) => {
            if (e.over) onReorder(String(e.active.id), String(e.over.id));
          }}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {order.map((key) => {
                const phi = IS_PHI.has(key);
                const shown = !hidden.has(key);
                // PHI columns are locked-visible; a non-PHI column can't be hidden if it's the last one shown.
                const lockHide = phi || (shown && visibleCount <= 1);
                return (
                  <SortableColumnItem
                    key={key}
                    colKey={key}
                    label={COLUMN_LABEL[key] ?? key}
                    phi={phi}
                    shown={shown}
                    lockHide={lockHide}
                    onToggle={() => onToggleColumn(key)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
        <button
          type="button"
          onClick={onReset}
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-[var(--brand-ink)]"
        >
          <RotateCcw className="h-3 w-3" aria-hidden /> Reset to all columns
        </button>

        {/* Section 2 — saved views */}
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Bookmark className="h-3.5 w-3.5" aria-hidden /> Saved views
          </div>
          {views.length === 0 ? (
            <p className="px-1 py-1 text-xs text-ink400">No saved views yet — save the current layout below.</p>
          ) : (
            <ul className="space-y-0.5">
              {views.map((v) => (
                <li key={v.name} className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-[var(--brand-soft)]">
                  <button
                    type="button"
                    onClick={() => onLoadView(v)}
                    className="flex-1 truncate text-left text-sm text-ink900"
                    title={`Load “${v.name}” (${v.columns.length} columns)`}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onSetDefault(v.name)}
                    aria-pressed={v.isDefault}
                    aria-label={v.isDefault ? `${v.name} is your default view` : `Make ${v.name} your default`}
                    title={v.isDefault ? 'Default view' : 'Set as default'}
                    className="shrink-0 rounded p-1 text-ink400 hover:text-[var(--brand-ink)]"
                  >
                    <Star className={`h-3.5 w-3.5 ${v.isDefault ? 'fill-[var(--brand-accent)] text-[var(--brand-accent)]' : ''}`} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteView(v.name)}
                    aria-label={`Delete ${v.name}`}
                    title="Delete view"
                    className="shrink-0 rounded p-1 text-ink400 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Save current layout */}
          <div className="mt-2 space-y-1.5">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitSave();
                }
              }}
              placeholder="Save current layout as…"
              aria-label="New view name"
              maxLength={80}
              className="h-8 w-full rounded-md border border-line bg-card px-2 text-sm text-ink900 outline-none transition-colors placeholder:text-ink400 focus:border-[var(--brand-accent)] focus:ring-2 focus:ring-[var(--brand-accent)]/25"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={makeDefault}
                  onChange={(e) => setMakeDefault(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--brand-accent)]"
                />
                Make default
              </label>
              <Button type="button" size="sm" disabled={saving || saveName.trim() === ''} onClick={() => void submitSave()}>
                <Save className="h-3.5 w-3.5" aria-hidden />
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </div>
    </>
  );
}

/** A single money stat tile in the summary header. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink900">{value}</div>
    </div>
  );
}

/** The three payer-behavior percentages (0–100 or null → "—"). */
type YieldPct = { pct_allowed: number | null; pct_paid: number | null; pct_collected: number | null };

/** The selection's dollar totals, folded into the percentage cards as secondary lines. */
type YieldMoney = { charged: number; allowed: number; paid: number; balance: number };

/**
 * The consolidated selection header cards: each green percentage card carries its own dollar total
 * as a secondary line (allowed / paid / charged), and Patient Balance stands as a fourth,
 * dollar-only card — replacing the separate CHARGED / INSURANCE PAID / PATIENT BALANCE tile row
 * (folded in 2026-08-31 to reclaim vertical space; the tile values are the SAME aggregate, so
 * nothing new is fetched). The COHORT display mode was retired in the same change: a resolved
 * prefix cohort still drives the curve panel and the AI read (cohortResolved/cohortData are
 * untouched), but the header cards always show the filter-wide selection yield.
 * Visual treatment (cardGreen + formatPercentNum) is unchanged from the dual-mode cards.
 */
function YieldCardsPanel({ pct, chargeLines, money }: { pct: YieldPct; chargeLines: number; money: YieldMoney }) {
  const round = (n: number) => Math.round(n);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-ink900">Selection payer behavior — all filtered charge lines</span>
        <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          matches the {chargeLines.toLocaleString()} charge lines &amp; filters above
        </span>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Dollar-weighted across every charge line in the current selection (facility · payer · date · search) — a filtered aggregate, not a patient cohort.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_allowed)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% allowed of billed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">allowed ÷ billed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_allowed)}</div>
          <div className="text-[11px] tabular-nums text-ink600">
            <span className="font-semibold">{MONEY0.format(money.allowed)}</span> allowed
          </div>
        </div>
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_paid)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% paid by payer</span>
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">payer paid ÷ allowed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_paid)}</div>
          <div className="text-[11px] tabular-nums text-ink600">
            <span className="font-semibold">{MONEY0.format(money.paid)}</span> insurance paid
          </div>
        </div>
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_collected)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% collected of billed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">paid ÷ billed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_collected)}</div>
          <div className="text-[11px] tabular-nums text-ink600">
            <span className="font-semibold">{MONEY0.format(money.charged)}</span> charged
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Patient balance</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">owed by patients</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{MONEY0.format(money.balance)}</div>
          <div className="text-[11px] text-ink400">not a payer yield — collected separately</div>
        </div>
      </div>
      {pct.pct_allowed !== null && pct.pct_paid !== null && pct.pct_collected !== null && (
        <p className="mt-1.5 text-[10px] text-ink400">
          ¹ {round(pct.pct_allowed)}% × {round(pct.pct_paid)}% ≈ {round(pct.pct_collected)}% — most of the gap is
          expected contractual write-off, not lost revenue. Compare across payers/facilities rather than as a target.
        </p>
      )}
    </div>
  );
}

type AiState =
  | { kind: 'idle' }
  | { kind: 'loading' } // request sent, awaiting first token
  | { kind: 'streaming'; text: string }
  | { kind: 'ready'; text: string }
  | { kind: 'error' }
  | { kind: 'insufficient' };

/**
 * Render one parsed section of a streamed answer.
 *
 * ⚠ THIS USED TO HALF-PARSE THE MARKDOWN AND LOSE THE OTHER HALF (fixed 2026-08-09). It stripped a
 * leading `-`/`*` off each line to fake a list, then printed the rest into `whitespace-pre-wrap` —
 * so a bullet became a bullet and the `**AETNA**` inside it stayed literal asterisks, on the same
 * line. The list-vs-prose branch was also decided by the section TITLE rather than by the content,
 * so a TL;DR the model chose to bullet rendered as one run-on paragraph.
 * <Markdown> replaces both halves with one scan (headings, both list kinds, bold/em/code) and no
 * raw-HTML sink — see its header. Empty/whitespace bodies still render nothing.
 */
function AiSection({ title, body }: { title: string; body: string }) {
  if (!body.trim()) return null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <Markdown text={body.trim()} className="mt-0.5 text-sm text-ink900" />
    </div>
  );
}

/**
 * The AI analysis panel — where the deleted curves were, in BOTH modes. Manual "Generate AI Analysis"
 * trigger (no auto-regen). Streams the model's TL;DR / Signals / Risks back through the server action
 * and renders each section progressively. Five states: idle (button) / loading (skeleton) /
 * streaming+ready (sections) / error (generic notice) / insufficient (fixed sentence, button
 * disabled). The panel is KEYED on the search signature by the parent, so any filter/search change
 * remounts it to idle and its unmount cleanup aborts an in-flight stream — a stale summary describing
 * a different selection can never linger.
 */
function CollectionsAiPanel({ input, view }: { input: CollectionsAiInput | null; view: DashboardView }) {
  const [state, setState] = useState<AiState>({ kind: 'idle' });
  // A mutable guard read inside the async stream loop; flipped on unmount so a superseded stream
  // stops updating state (and cancels its reader) after a filter/search-change remount.
  const guardRef = useRef({ cancelled: false });
  useEffect(() => {
    const guard = guardRef.current;
    return () => {
      guard.cancelled = true;
    };
  }, []);

  const sufficient = input != null && isSufficientForAi(input);
  const mode = input?.mode ?? 'selection';
  const busy = state.kind === 'loading' || state.kind === 'streaming';

  async function generate() {
    if (!input || !sufficient) return;
    setState({ kind: 'loading' });
    let result: CollectionsAiAnalysisResult;
    try {
      result = await generateCollectionsAiAnalysis(input, view);
    } catch {
      if (!guardRef.current.cancelled) setState({ kind: 'error' });
      return;
    }
    if (guardRef.current.cancelled) return;
    if (!result.ok) {
      setState({ kind: result.reason === 'insufficient' ? 'insufficient' : 'error' });
      return;
    }
    const reader = result.stream.getReader();
    let acc = '';
    setState({ kind: 'streaming', text: '' });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (guardRef.current.cancelled) {
          await reader.cancel();
          return;
        }
        if (done) break;
        acc += value;
        setState({ kind: 'streaming', text: acc });
      }
    } catch {
      if (!guardRef.current.cancelled) setState({ kind: 'error' });
      return;
    }
    if (!guardRef.current.cancelled) setState(acc.trim() ? { kind: 'ready', text: acc } : { kind: 'error' });
  }

  const text = state.kind === 'streaming' || state.kind === 'ready' ? state.text : '';
  const sections = text ? parseAiSections(text) : null;

  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-ths">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink900">
          <Sparkles className="h-4 w-4 text-[var(--brand-ink)]" aria-hidden />
          AI analysis
          <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {mode === 'cohort' ? 'cohort' : 'selection'} · aggregates only
          </span>
        </h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!sufficient || busy}
          aria-busy={busy}
          onClick={generate}
          className="border-line bg-[var(--brand-soft)]/50 text-ink900 hover:bg-[var(--brand-soft)]"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {state.kind === 'ready' ? 'Regenerate' : busy ? 'Generating…' : 'Generate AI Analysis'}
        </Button>
      </div>

      <div className="relative mt-3">
        {busy && (
          <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse rounded-t bg-[var(--brand-accent)]" aria-hidden />
        )}
        {state.kind === 'idle' && (
          <p className="text-sm text-muted-foreground">
            {sufficient
              ? 'Generate a short AI read (TL;DR, signals, risks) of the percentages, payers, facilities and CPT×Rev rows above. Aggregates only — no patient data leaves the server.'
              : INSUFFICIENT_COPY[mode]}
          </p>
        )}
        {state.kind === 'insufficient' && <p className="text-sm text-muted-foreground">{INSUFFICIENT_COPY[mode]}</p>}
        {state.kind === 'loading' && (
          <div className="space-y-2" aria-live="polite">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        )}
        {state.kind === 'error' && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            The AI analysis could not be generated. Try again.
          </div>
        )}
        {sections && (
          <div className="space-y-3" aria-live="polite">
            {AI_SECTIONS.map((s) => (
              <AiSection key={s} title={s} body={sections[s]} />
            ))}
            {state.kind === 'streaming' && <span className="inline-block h-3 w-2 animate-pulse bg-ink400 align-middle" aria-hidden />}
          </div>
        )}
      </div>
    </div>
  );
}

/** One ranked drill-down list (Top facilities / payers / CPTs) — each row refines the grid. */
function DrillList({
  title,
  icon,
  kind,
  groups,
  activeValue,
  onDrill,
  revealDelayMs = 0,
  displayFor,
}: {
  title: string;
  icon: React.ReactNode;
  kind: RefineKind;
  groups: CmdSearchGroup[];
  activeValue: string | null;
  onDrill: (kind: RefineKind, value: string) => void;
  revealDelayMs?: number;
  /** Optional map from a group's raw label (the drill/filter value) to a friendlier DISPLAY
   *  string — e.g. facility raw CMD text → curated dimension name. Drill value stays `g.label`. */
  displayFor?: (rawLabel: string) => string;
}) {
  if (groups.length === 0) return null;
  const max = Math.max(...groups.map((g) => g.charge), 1);
  return (
    <div className="animate-ths-reveal rounded-lg border border-line bg-surface p-3" style={{ animationDelay: `${revealDelayMs}ms` }}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">
        {groups.map((g) => {
          const label = g.label ?? '(blank)';
          // DISPLAY may differ from the drill value (e.g. facility friendly name); the raw label is
          // still what drills/filters. Blank stays '(blank)'.
          const display = g.label && displayFor ? displayFor(g.label) : label;
          // A NULL/blank value can't be exact-matched through the filter, so it's shown as a
          // non-interactive stat rather than a drill link that would silently no-op.
          const drillable = g.label !== null && g.label !== '';
          const active = drillable && activeValue === g.label;
          const pct = Math.max(2, Math.round((g.charge / max) * 100));
          const stats = (
            <span className="relative flex items-center justify-between gap-2">
              <span className="truncate text-ink900" title={display}>{display}</span>
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {g.count.toLocaleString()} · {MONEY0.format(g.charge)}
              </span>
            </span>
          );
          const bar = (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-[var(--brand-accent)]/10"
              style={{ width: `${pct}%` }}
            />
          );
          return (
            <li key={label}>
              {drillable ? (
                <button
                  type="button"
                  onClick={() => onDrill(kind, g.label as string)}
                  aria-pressed={active}
                  className={[
                    'group relative w-full overflow-hidden rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    active ? 'ring-1 ring-[var(--brand-accent)]' : 'hover:bg-[var(--brand-soft)]',
                  ].join(' ')}
                >
                  {bar}
                  {stats}
                </button>
              ) : (
                <div className="relative w-full overflow-hidden rounded-md px-2 py-1.5 text-sm text-muted-foreground">
                  {bar}
                  {stats}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One gated PHI lookup input (member id / alpha prefix / group #). */
function PhiField({
  label,
  value,
  onChange,
  placeholder,
  width,
  maxLength = 120,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width: string;
  maxLength?: number;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        className={`${width} h-8 rounded-md border border-line bg-card px-2 text-sm text-ink900 outline-none transition-colors placeholder:text-ink400 focus:border-[var(--brand-accent)] focus:ring-2 focus:ring-[var(--brand-accent)]/25`}
      />
    </label>
  );
}

/**
 * The search-engine result: headline count + the consolidated %-with-dollar cards, the two
 * single-dimension drill-down lists (payers, facilities), then the (CPT × Revenue-code)
 * combination list full-width below them (it carries more numbers per row — count, charge,
 * %-allowed, %-paid — so it gets the full width to stay readable).
 */
function SearchSummaryPanel({
  state,
  label,
  refinement,
  onDrill,
  onDrillCombo,
  facilityDisplayName,
}: {
  state: SummaryState;
  label: string;
  refinement: Refinement | null;
  onDrill: (kind: RefineKind, value: string) => void;
  onDrillCombo: (cpt: string, revenue: string) => void;
  /** Raw facility text → curated friendly name, for the Top facilities card display only. */
  facilityDisplayName?: (raw: string) => string;
}) {
  // Fold/unfold the panel body below the header (Session F). Local, resets each session — not a
  // saved-view mechanism. Conditional render (not a max-height transition) so the drill buttons
  // inside are fully removed from the tab order while collapsed, not just visually hidden.
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();

  // First load (no prior data) → footprint-matched skeleton (no blank flash, no layout shift).
  if (state.kind === 'loading') return <SummaryPanelSkeleton />;
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        The search summary could not be loaded.
      </div>
    );
  }
  if (state.kind === 'idle') return null;

  // 'ready' or 'refreshing' both carry data. On a refetch we keep the prior panel visible + dimmed
  // (see the refresh treatment below) rather than collapsing it to a skeleton on every keystroke.
  const refreshing = state.kind === 'refreshing';
  const s = state.data;
  if (s.total_count === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-6 text-center text-sm text-muted-foreground shadow-ths">
        No charge lines match {label}. Try a different term or add columns to search.
      </div>
    );
  }

  return (
    <div
      aria-busy={refreshing}
      className={`relative rounded-xl border border-line bg-card p-4 shadow-ths transition-opacity duration-150 ${
        refreshing ? 'opacity-60' : ''
      }`}
    >
      {refreshing && (
        <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse rounded-t-xl bg-[var(--brand-accent)]" aria-hidden />
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink900">
          <span className="tabular-nums">{s.total_count.toLocaleString()}</span> charge line
          {s.total_count === 1 ? '' : 's'} match {label}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Click a payer, CPT, or CPT×Rev combo to drill in.</span>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? 'Expand search results' : 'Collapse search results'}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((c) => !c)}
            className="shrink-0 rounded-md p-1 text-ink400 transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)]"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div id={bodyId}>
          {/* Staged reveal: the four groups arrive in ONE response (single Promise.all), so this is a
              bounded, capped visual settle (0→180ms), not a slow per-panel cascade. It runs once on
              mount; a refetch keeps the same mounted elements, so it doesn't re-animate on each keystroke. */}
          {/* Consolidated header cards — the three percentage cards each carry their own dollar
              total as a secondary line, plus a dollar-only Patient Balance card. Replaces the
              former CHARGED / INSURANCE PAID / PATIENT BALANCE tile row (same aggregate, no new
              query) and always shows the filter-wide selection yield — the cohort display mode
              was retired 2026-08-31 (the curve panel + AI read still consume the cohort data). */}
          <div className="animate-ths-reveal">
            <YieldCardsPanel
              pct={s.yield_pct}
              chargeLines={s.total_count}
              money={{ charged: s.total_charge, allowed: s.total_allowed, paid: s.total_paid, balance: s.total_balance }}
            />
          </div>

          {/* Top Results groups: Payer + Facility single-dimension lists, then the full-width CPT×Rev
              combo below. The standalone CPT list was dropped here — the CPT×Rev combo table below
              already carries CPT (with its revenue code + dollar-weighted %s), so a top-facilities
              list is the more useful second card. Render-only: the summary still returns by_cpt
              (unused now, mirroring how by_facility used to be), so its shape and the server groups
              are unchanged; facility drill reuses the existing refinement path (case 'facility' →
              filter.facility). */}
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <DrillList
              title="Top payers"
              icon={<CreditCard className="h-3.5 w-3.5" aria-hidden />}
              kind="primary_payer"
              groups={s.by_payer}
              activeValue={refinement?.kind === 'primary_payer' ? refinement.value : null}
              onDrill={onDrill}
              revealDelayMs={60}
            />
            <DrillList
              title="Top facilities"
              icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
              kind="facility"
              groups={s.by_facility}
              activeValue={refinement?.kind === 'facility' ? refinement.value : null}
              onDrill={onDrill}
              revealDelayMs={120}
              displayFor={facilityDisplayName}
            />
          </div>

          {/* Fourth list, full-width: the (CPT × Revenue-code) combination with dollar-weighted
              %-allowed / %-paid — one click drills the grid by BOTH codes at once. */}
          <ComboDrillList
            groups={s.by_combo}
            activeCombo={refinement?.kind === 'combo' ? { cpt: refinement.cpt, revenue: refinement.revenue } : null}
            onDrill={onDrillCombo}
            revealDelayMs={180}
            fallbackPctAllowed={s.yield_pct.pct_allowed}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The (CPT × Revenue-code) combination drill list. Distinct from DrillList: each row carries TWO
 * labels (CPT + Revenue code) and FOUR numbers (count, charge, dollar-weighted %-allowed and
 * %-paid), so it renders full-width as a compact table rather than a ranked bar list. A row is
 * drillable only when BOTH codes are present (a partial-null combo can't be exact-matched, so it
 * shows as a non-interactive stat row — mirroring DrillList's blank-label convention). The two
 * percentages are already dollar-weighted server-side (ratio of sums, not average of ratios).
 *
 * DISPLAY ORDER (2026-08-31): rows render S-ranked via the pure scoring module
 * (src/collections/comboRanking.ts) — shrunk allowed rate × charged, boosted for per-line
 * earnings — instead of the server's charge-DESC order. Rendering only: the group rows, their
 * drill values, handlers and query params are the server's, byte-identical. Recency decay is held
 * at w = 1.0 because the payload carries no service-date aggregate (see the module header).
 */
function ComboDrillList({
  groups,
  activeCombo,
  onDrill,
  revealDelayMs = 0,
  fallbackPctAllowed = null,
}: {
  groups: CmdComboGroup[];
  activeCombo: { cpt: string; revenue: string } | null;
  onDrill: (cpt: string, revenue: string) => void;
  revealDelayMs?: number;
  /** Selection-wide %-allowed (0–100 or null) — the prior fallback for CPTs with no pooled rate. */
  fallbackPctAllowed?: number | null;
}) {
  if (groups.length === 0) return null;
  const ranked = rankCombos(groups, fallbackPctAllowed);
  return (
    <div className="mt-3 animate-ths-reveal rounded-lg border border-line bg-surface p-3" style={{ animationDelay: `${revealDelayMs}ms` }}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Layers className="h-3.5 w-3.5" aria-hidden />
        Top CPT × Revenue-code combinations
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">{COMBO_RANKING_EXPLAINER}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1 text-left font-medium">CPT</th>
              <th className="px-2 py-1 text-left font-medium">Revenue</th>
              <th className="px-2 py-1 text-right font-medium">Lines</th>
              <th className="px-2 py-1 text-right font-medium">Charged</th>
              <th className="px-2 py-1 text-right font-medium">% Allowed of Billed</th>
              <th className="px-2 py-1 text-right font-medium">% Paid by Payer</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ row: g }, i) => {
              const drillable = g.cpt !== null && g.cpt !== '' && g.revenue !== null && g.revenue !== '';
              const active = drillable && activeCombo?.cpt === g.cpt && activeCombo?.revenue === g.revenue;
              const key = `${g.cpt ?? '∅'}|${g.revenue ?? '∅'}|${i}`;
              return (
                <tr
                  key={key}
                  onClick={drillable ? () => onDrill(g.cpt as string, g.revenue as string) : undefined}
                  onKeyDown={
                    drillable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onDrill(g.cpt as string, g.revenue as string);
                          }
                        }
                      : undefined
                  }
                  role={drillable ? 'button' : undefined}
                  tabIndex={drillable ? 0 : undefined}
                  aria-pressed={drillable ? active : undefined}
                  aria-label={drillable ? `Drill into CPT ${g.cpt} with revenue code ${g.revenue}` : undefined}
                  className={[
                    'border-t border-line/60 tabular-nums',
                    drillable ? 'cursor-pointer' : 'text-muted-foreground',
                    active ? 'bg-[var(--brand-soft)] ring-1 ring-inset ring-[var(--brand-accent)]' : drillable ? 'hover:bg-[var(--brand-soft)]' : '',
                  ].join(' ')}
                >
                  <td className="px-2 py-1.5 text-left font-medium text-ink900">{g.cpt ?? '(blank)'}</td>
                  <td className="px-2 py-1.5 text-left text-ink900">{g.revenue ?? '(blank)'}</td>
                  <td className="px-2 py-1.5 text-right">{g.count.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right">{MONEY0.format(g.charge)}</td>
                  <td className="px-2 py-1.5 text-right">{formatPercentNum(g.pct_allowed)}</td>
                  <td className="px-2 py-1.5 text-right">{formatPercentNum(g.pct_paid)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- alpha-prefix cohort payer-behavior curve (Session D) -------------------

// Stat-card background: one green step per 20% band (higher % = heavier green). Semi-transparent
// emerald reads correctly over the card in BOTH light and dark themes (no per-mode variants needed).
const CARD_GREEN_SHADES = [
  'bg-emerald-500/15',
  'bg-emerald-500/25',
  'bg-emerald-500/35',
  'bg-emerald-500/45',
  'bg-emerald-500/55',
] as const;
function cardGreen(pct: number | null): string {
  const lvl = pct == null || !Number.isFinite(pct) ? 0 : Math.min(4, Math.max(0, Math.floor(pct / 20)));
  return CARD_GREEN_SHADES[lvl]!;
}

/** A cohort point plus the client-side dollar derivations (Phase 2). */
type CohortDollarPoint = CohortCurvePoint & {
  paid_per_patient: number;
  cum_paid_per_start: number | null;
};

/**
 * Derive the dollar series from the suppressed buckets. `paid_per_patient` = the point's insurance $
 * ÷ its patients (on the position axis each patient has exactly ONE visit per bucket, so this is
 * "$ the payer puts behind visit N"). `cum_paid_per_start` = running Σ paid_total ÷ the FIXED
 * starting-cohort count — never the shrinking survivor count, which would restate the survivorship
 * bias this metric exists to counter. Suppressed buckets' dollars are absent by design, so the
 * cumulative line is a FLOOR (the footnote says so); patients >= 5 always, so no division guard.
 */
function withDollarSeries(points: CohortCurvePoint[], cohortPatients: number): CohortDollarPoint[] {
  let running = 0;
  return points.map((p) => {
    running += p.paid_total;
    return {
      ...p,
      paid_per_patient: p.paid_total / p.patients,
      cum_paid_per_start: cohortPatients > 0 ? running / cohortPatients : null,
    };
  });
}

/**
 * Plain-language degradation read of the claim-position curve: the FIRST bucket whose dollar-
 * weighted %-allowed falls more than `dropPts` points below the cohort's OWN first-bucket baseline.
 * A simple, maintainable threshold rule — deliberately NOT a statistical model. Returns null when
 * there aren't enough surviving buckets to say anything.
 */
function cohortDegradation(
  points: CohortCurvePoint[],
  dropPts = 10,
): { baseline: number; dropAt: number | null; dropTo: number | null; lastBucket: number } | null {
  const withPct = points.filter((p) => p.pct_allowed !== null);
  if (withPct.length < 2) return null;
  const baseline = withPct[0]!.pct_allowed!;
  const hit = withPct.find((p, i) => i > 0 && p.pct_allowed! <= baseline - dropPts);
  return {
    baseline,
    dropAt: hit ? hit.bucket : null,
    dropTo: hit ? hit.pct_allowed! : null,
    lastBucket: withPct[withPct.length - 1]!.bucket,
  };
}

/**
 * The chart-free view of ONE axis's buckets — the keyboard + screen-reader path to the same numbers
 * and to the point drilldown (each row's Detail button mirrors clicking the chart point). Renders
 * only real (floor-clearing) buckets; suppressed buckets are absent here exactly as on the curve.
 */
function CohortBucketTable({
  points,
  bucketLabel,
  usd,
  selectedBucket,
  onSelectBucket,
}: {
  points: CohortDollarPoint[];
  bucketLabel: (bucket: number) => string;
  usd: (n: number) => string;
  selectedBucket: number | null;
  onSelectBucket: (bucket: number) => void;
}) {
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">Point</th>
            <th className="px-2 py-1 text-right font-medium">Patients</th>
            <th className="px-2 py-1 text-right font-medium">Charge lines</th>
            <th className="px-2 py-1 text-right font-medium">% Allowed of Billed</th>
            <th className="px-2 py-1 text-right font-medium">% Paid by Payer</th>
            <th className="px-2 py-1 text-right font-medium">$ Paid / patient</th>
            <th className="px-2 py-1 text-right font-medium">Cum $ / start</th>
            <th className="px-2 py-1 text-right font-medium">Zero-paid</th>
            <th className="px-2 py-1 text-right font-medium">
              <span className="sr-only">Point detail</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr
              key={p.bucket}
              className={`border-t border-line/60 tabular-nums ${
                selectedBucket === p.bucket ? 'bg-[var(--brand-soft)]' : ''
              }`}
            >
              <td className="px-2 py-1 text-left text-ink900">{bucketLabel(p.bucket)}</td>
              <td className="px-2 py-1 text-right">{p.patients.toLocaleString()}</td>
              <td className="px-2 py-1 text-right">{p.claims.toLocaleString()}</td>
              <td className="px-2 py-1 text-right">{pct(p.pct_allowed)}</td>
              <td className="px-2 py-1 text-right">{pct(p.pct_paid)}</td>
              <td className="px-2 py-1 text-right">{usd(p.paid_per_patient)}</td>
              <td className="px-2 py-1 text-right">{p.cum_paid_per_start === null ? '—' : usd(p.cum_paid_per_start)}</td>
              <td className="px-2 py-1 text-right">{p.pct_zero_paid}%</td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  onClick={() => onSelectBucket(p.bucket)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-[var(--brand-ink)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-accent)]"
                >
                  Detail
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The alpha-prefix cohort payer-behavior curve — the MERGED attrition-rate / days-authorized metric.
 * Renders only for PHI-entitled roles with an active ≥3-char alpha-prefix search (gated by the
 * caller). A header status chip summarizes the degradation read; three whole-cohort yield cards
 * (collected / allowed / paid of billed) sit under it; then BOTH x-axes (claim/visit position + days
 * since first claim) side by side in one bordered card, each with a plain-language takeaway line and
 * compact sparklines. Every value is a cohort AGGREGATE that already passed server-side min-5-patient
 * suppression — no single patient's figures reach here. When the whole cohort is too small (all
 * buckets suppressed), it shows a "not enough data" notice, never a partial (re-identifiable) curve.
 */
function CohortCurvePanel({
  state,
  prefix,
  memberIdActive = false,
  selectedPoint,
  drilldown,
  onSelectPoint,
  onCloseDrilldown,
}: {
  state: CohortState;
  prefix: string;
  /**
   * An exact Member-ID lookup is ALSO active: the grid below is narrowed to (usually) one patient
   * while this panel still describes the whole prefix cohort. The panel then de-emphasizes itself
   * and says so explicitly — the "136 patients vs 1-patient grid" misread was a real product-owner
   * incident (2026-07-13), not a hypothetical.
   */
  memberIdActive?: boolean;
  /** Session G: the currently-selected cohort-curve point (null = none selected). */
  selectedPoint: CohortPoint | null;
  drilldown: DrilldownState | null;
  onSelectPoint: (axis: 'position' | 'days', bucket: number) => void;
  onCloseDrilldown: () => void;
}) {
  // Fold/unfold the panel body below the header (Session F). Local, resets each session. Declared
  // before the early returns (rules-of-hooks) even though the control only renders in the
  // 'ready'/'refreshing' branch below. (The chart/table toggle is gone — the curves were removed;
  // the panel now shows the per-bucket tables directly.)
  //
  // ⚠ COLLAPSED BY DEFAULT — RULED 2026-08-31. The cohort read is prefix-wide and deliberately
  // ignores the grid's filters, so it is REFERENCE rather than the primary answer; it now opens
  // folded and the AI analysis panel sits above it. This is a PRESENTATION default only:
  //   · the fetch is NOT gated on expansion (see the effect on `cohortActive` in the parent) — the
  //     panel is collapsed-but-LOADED, because `aiInput` reads the same `cohort` state and a lazy
  //     fetch would silently empty the AI read's cohort branch;
  //   · it is NOT persisted (no localStorage / sessionStorage) — it resets every render by design.
  // Nothing below the fold was removed: the per-bucket tables and the click-to-drilldown are intact
  // and reachable on expand (#309's pins still assert they exist).
  const [collapsed, setCollapsed] = useState(true);
  const bodyId = useId();

  if (state.kind === 'idle') return null;
  // First analysis (no prior data) → footprint-matched skeleton, no blank flash.
  if (state.kind === 'loading') return <CohortPanelSkeleton prefix={prefix} />;
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        The cohort trend could not be loaded.
      </div>
    );
  }

  // 'ready' or 'refreshing' → both carry data; re-analyzing a changed prefix keeps the prior curve
  // visible + dimmed rather than collapsing to a skeleton.
  const refreshing = state.kind === 'refreshing';
  const c = state.data;
  // Fail-closed: an empty position curve means every bucket fell below the min-patient floor (or the
  // cohort doesn't exist). Show a notice — never a partial, potentially re-identifiable curve.
  if (c.by_position.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-4 shadow-ths">
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink900">
          <Activity className="h-4 w-4 text-[var(--brand-ink)]" aria-hidden />
          Cohort payer behavior — “{prefix}”
        </div>
        <p className="text-sm text-muted-foreground">
          Not enough patients share this alpha prefix to show a cohort trend without risking
          identifying an individual. Try a broader prefix.
        </p>
      </div>
    );
  }

  const deg = cohortDegradation(c.by_position);
  const round = (n: number) => Math.round(n);
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  // Client-side dollar derivations (Phase 2) — per-bucket $/patient + cumulative-$/starting-patient.
  const posDollars = withDollarSeries(c.by_position, c.cohort_patients);
  const daysDollars = withDollarSeries(c.by_days, c.cohort_patients);
  // Day-bucket width read from the data (never hardcoded, so copy/labels can't drift from the
  // server's bucketing); falls back to 30 when only one day bucket survives.
  const dayBucketWidth =
    c.by_days.length >= 2 ? c.by_days[1]!.bucket - c.by_days[0]!.bucket : 30;
  // End-state cumulative $/starting patient for the days axis — surfaced in the days takeaway.
  const lastCum = (pts: CohortDollarPoint[]) =>
    pts.length > 0 ? pts[pts.length - 1]!.cum_paid_per_start : null;
  const daysCum = lastCum(daysDollars);
  // Charge-line-weighted zero-pay share over a run of buckets (never avg-of-shares). `claims` is
  // the API field name; each unit is a logical CHARGE LINE (0050 rollup grain).
  const zeroPayOver = (pts: CohortDollarPoint[], pick: (p: CohortDollarPoint) => number) => {
    const lines = pts.reduce((s, p) => s + p.claims, 0);
    return lines > 0 ? round((pts.reduce((s, p) => s + (pick(p) / 100) * p.claims, 0) / lines) * 100) : 0;
  };

  // Header status chip: the degradation read (cohortDegradation) reduced to ONE label — a >=10-pt
  // %-allowed drop from the cohort's own first-visit baseline is "degrading" (amber, the drop size +
  // where it hit), a surviving-but-steady curve is "no degradation" (green), too few sequenced buckets
  // is "not enough data" (grey). Same threshold that drove the old callout; no new rule invented.
  const status: { tone: 'good' | 'warn' | 'muted'; label: string } =
    deg && deg.dropAt !== null && deg.dropTo !== null
      ? { tone: 'warn', label: `Allowed dropped ${round(deg.baseline - deg.dropTo)} pts by visit ${deg.dropAt}` }
      : deg
        ? { tone: 'good', label: 'No degradation detected' }
        : { tone: 'muted', label: 'Not enough data yet' };

  // Per-column takeaway lines: SHORTER restatements of exactly what the old callout / days line
  // asserted for each axis — no new statistic. The survivorship caveat (#10) is appended to BOTH
  // columns: each x-axis thins toward the right by the SAME attrition mechanism (a patient who stops
  // early contributes only to their early visits / early day-windows), so late points on either axis
  // reflect continuing patients only. Zero-pay (#9) folds in only when it's actually present.
  const SURVIVORSHIP = ' Tracks continuing patients only — early drop-offs aren’t reflected in later points.';
  let visitTakeaway: string;
  if (deg && deg.dropAt !== null && deg.dropTo !== null) {
    const at = posDollars.find((p) => p.bucket >= deg.dropAt!) ?? posDollars[posDollars.length - 1]!;
    const fromDrop = posDollars.filter((p) => p.bucket >= deg.dropAt!);
    const zeroPct = zeroPayOver(fromDrop, (p) => p.pct_zero_paid);
    visitTakeaway =
      `Allowed slips ~${round(deg.baseline)}% → ~${round(deg.dropTo)}% by visit ${deg.dropAt}, $/visit ~${usd(posDollars[0]!.paid_per_patient)} → ~${usd(at.paid_per_patient)}.` +
      (zeroPct > 0 ? ` ${zeroPct}% of later charge lines zero-paid → moved to patient balance, not necessarily denied.` : '') +
      SURVIVORSHIP;
  } else if (deg) {
    const zeroPct = zeroPayOver(posDollars, (p) => p.pct_zero_paid);
    visitTakeaway =
      `Stable across visits — ~${round(deg.baseline)}% allowed, ~${usd(posDollars[0]!.paid_per_patient)}/visit, flat through visit ${deg.lastBucket}.` +
      (zeroPct > 0 ? ` ${zeroPct}% of charge lines zero-paid → patient balance, not necessarily denied.` : '') +
      SURVIVORSHIP;
  } else {
    visitTakeaway = 'Not enough sequenced visits to read a trend yet.';
  }

  // Days axis (Alec's "how long does full authorization last"): cumulative-$ through the last surviving
  // WINDOW ("days 210–239", never an open-ended "day 210+") + first-vs-last %-allowed. Same assertion
  // the old days line made, shortened, plus the survivorship caveat.
  const days = c.by_days.filter((p) => p.pct_allowed !== null);
  const lastDay = days.length > 0 ? days[days.length - 1]! : null;
  const daysTakeaway =
    days.length >= 2 && lastDay
      ? `${daysCum !== null ? `~${usd(daysCum)} collected per starting patient through day ${daysDollars[daysDollars.length - 1]!.bucket + dayBucketWidth - 1}; ` : ''}~${round(days[0]!.pct_allowed!)}% allowed in the first ${dayBucketWidth} days, ~${round(lastDay.pct_allowed!)}% by days ${lastDay.bucket}–${lastDay.bucket + dayBucketWidth - 1}.` + SURVIVORSHIP
      : 'Not enough elapsed time to read a trend yet.';

  return (
    <div
      aria-busy={refreshing}
      className={`relative rounded-xl border border-line bg-card p-4 shadow-ths transition-opacity duration-150 ${
        refreshing ? 'opacity-60' : ''
      }`}
    >
      {refreshing && (
        <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse rounded-t-xl bg-[var(--brand-accent)]" aria-hidden />
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink900">
          <Activity className="h-4 w-4 text-[var(--brand-ink)]" aria-hidden />
          Cohort payer behavior — “{prefix}”
          {/* Scope pill: this panel deliberately IGNORES the grid's narrower filters (see the fetch
              effect) — say so at the point of reading, not only in the fine print. */}
          <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium normal-case text-muted-foreground">
            prefix-wide · ignores Member ID, facility &amp; date filters
          </span>
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              status.tone === 'warn'
                ? 'border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200'
                : status.tone === 'good'
                  ? 'border-emerald-300/60 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-line bg-surface text-muted-foreground'
            }`}
          >
            {status.tone === 'warn' ? <TrendingDown className="h-3 w-3" aria-hidden /> : <Minus className="h-3 w-3" aria-hidden />}
            {status.label}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden />
            {c.cohort_patients.toLocaleString()} patients · dollar-weighted · min 5/bucket
          </span>
          {/* Disclosure trigger. A real <button> (never a div+onClick) so it is in the tab order for
              free; aria-controls points at the body region, which is why that region is ALWAYS
              rendered and hidden with the `hidden` attribute rather than unmounted — an
              aria-controls target that doesn't exist is an ARIA violation, and with the panel now
              collapsed BY DEFAULT that would be the default state rather than an edge case. */}
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? 'Expand cohort payer behavior' : 'Collapse cohort payer behavior'}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((v) => !v)}
            className="shrink-0 rounded-md p-1 text-ink400 transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-accent)]"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        All {c.cohort_patients.toLocaleString()} patients whose insurance member ID begins with “{prefix}” —
        not just the patients shown in the grid below. These are dollar-weighted cohort averages, never
        one patient.
      </p>
      {memberIdActive && (
        <p className="mt-1 rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
          Your grid is filtered to one member ID; this panel still describes the full{' '}
          {c.cohort_patients.toLocaleString()}-patient “{prefix}” cohort.
        </p>
      )}

      {/* Always MOUNTED, hidden with the `hidden` attribute when folded (the census-panel
          precedent: `hidden` rather than CSS-hidden-but-focusable, so the subtree leaves the a11y
          tree AND the tab order). Kept in the DOM so `aria-controls` above always resolves. */}
      <div id={bodyId} hidden={collapsed} className={memberIdActive ? 'opacity-70' : undefined}>
        {/* Two axes side by side — per-bucket TABLES (the recharts curves were removed; the tables
            carry the same values + the click-to-drilldown affordance). The whole-cohort yield cards
            moved UP into the summary panel above, deduplicated across cohort + selection modes. */}
        <div className="mt-3 grid grid-cols-1 overflow-hidden rounded-lg border border-line lg:grid-cols-2">
          <div className="p-3 lg:border-r lg:border-line">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              By visit number
            </div>
            <div className="mb-1 text-[11px] text-ink400">{visitTakeaway} Click a row for details.</div>
            <CohortBucketTable
              points={posDollars}
              bucketLabel={(b) => `Visit ${b}`}
              usd={usd}
              selectedBucket={selectedPoint?.axis === 'position' ? selectedPoint.bucket : null}
              onSelectBucket={(b) => onSelectPoint('position', b)}
            />
            {selectedPoint?.axis === 'position' && drilldown && (
              <CohortDrilldownPanel
                axis="position"
                bucket={selectedPoint.bucket}
                state={drilldown}
                onClose={onCloseDrilldown}
              />
            )}
          </div>
          <div className="p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              By days since first visit
            </div>
            <div className="mb-1 text-[11px] text-ink400">{daysTakeaway} Click a row for details.</div>
            <CohortBucketTable
              points={daysDollars}
              bucketLabel={(b) => `Days ${b}–${b + dayBucketWidth - 1}`}
              usd={usd}
              selectedBucket={selectedPoint?.axis === 'days' ? selectedPoint.bucket : null}
              onSelectBucket={(b) => onSelectPoint('days', b)}
            />
            {selectedPoint?.axis === 'days' && drilldown && (
              <CohortDrilldownPanel
                axis="days"
                bucket={selectedPoint.bucket}
                dayBucketWidth={dayBucketWidth}
                state={drilldown}
                onClose={onCloseDrilldown}
              />
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink400">
          <span>&lt;5-patient buckets are suppressed</span>
          <span>· “—” = allowed too small to divide</span>
        </div>
      </div>
    </div>
  );
}

// --- cohort-point drilldown (Session G) -------------------------------------

/**
 * The drilldown for ONE clicked cohort-curve point — an aggregate breakdown (payer mix, CPT ×
 * Revenue-code mix, allowed/paid/zero-paid) for that exact bucket, plus an OPTIONAL masked patient
 * table gated by a stricter, separate floor (COHORT_DRILLDOWN_TABLE_MIN_PATIENTS). The aggregate is
 * a pure SQL aggregate — no row egress, non-PHI; the table (when shown) reuses the SAME masking +
 * audited per-row reveal as the main grid, never a new PHI surface. `state` is fetch state owned by
 * the parent (CmdCollectionsExplorer) — this component is purely presentational.
 */
function CohortDrilldownPanel({
  axis,
  bucket,
  dayBucketWidth = 30,
  state,
  onClose,
}: {
  axis: 'position' | 'days';
  bucket: number;
  /** Width of a days-axis bucket, read from the curve data by the parent — a days bucket is a
   * WINDOW ("Days 210–239"), never an open-ended "Day 210+" (that mislabel was a confirmed defect). */
  dayBucketWidth?: number;
  state: DrilldownState;
  onClose: () => void;
}) {
  const label = axis === 'position' ? `Visit ${bucket}` : `Days ${bucket}–${bucket + dayBucketWidth - 1}`;
  return (
    <div className="mt-2 animate-ths-reveal rounded-lg border border-line bg-card p-3 shadow-ths">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink900">{label} detail</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close point detail"
          className="shrink-0 rounded p-1 text-ink400 transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)]"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {state.kind === 'loading' && (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {state.kind === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
      {state.kind === 'ready' && <CohortDrilldownContent data={state.data} />}
    </div>
  );
}

/**
 * One read-only payer bar row. Deliberately NOT DrillList — that component's rows apply a GRID-WIDE
 * refinement on click, which would be the wrong behavior here (this is informational context for
 * ONE point, not a search-level filter), so this is a small, non-interactive, visually-matching twin.
 */
function DrilldownPayerRow({ group, max }: { group: CmdSearchGroup; max: number }) {
  const pct = Math.max(2, Math.round((group.charge / max) * 100));
  return (
    <div className="relative overflow-hidden rounded-md px-2 py-1 text-sm">
      <span aria-hidden className="absolute inset-y-0 left-0 bg-[var(--brand-accent)]/10" style={{ width: `${pct}%` }} />
      <span className="relative flex items-center justify-between gap-2">
        <span className="truncate text-ink900">{group.label ?? '(blank)'}</span>
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {group.count.toLocaleString()} · {MONEY0.format(group.charge)}
        </span>
      </span>
    </div>
  );
}

/** The read-only breakdown: patient/claims/%-stats + payer mix + CPT×Rev mix + the patient table. */
function CohortDrilldownContent({ data }: { data: CohortDrilldownResult }) {
  const { aggregate: a, table } = data;
  const maxPayerCharge = Math.max(...a.by_payer.map((g) => g.charge), 1);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Patients" value={a.patients.toLocaleString()} />
        <StatTile label="Charge lines" value={a.claims.toLocaleString()} />
        <StatTile label="% Allowed of Billed" value={formatPercentNum(a.pct_allowed)} />
        <StatTile label="% Paid by Payer" value={formatPercentNum(a.pct_paid)} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-line bg-surface p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            By payer
          </div>
          {a.by_payer.length === 0 ? (
            <p className="px-2 py-1 text-xs text-ink400">No payer data for this point.</p>
          ) : (
            <div className="space-y-0.5">
              {a.by_payer.map((g) => (
                <DrilldownPayerRow key={g.label ?? '(blank)'} group={g} max={maxPayerCharge} />
              ))}
            </div>
          )}
        </div>
        <div className="rounded-md border border-line bg-surface p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            By CPT × Revenue code
          </div>
          {a.by_cpt_revenue.length === 0 ? (
            <p className="px-2 py-1 text-xs text-ink400">No CPT/revenue data for this point.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">CPT</th>
                    <th className="px-2 py-1 text-left font-medium">Revenue</th>
                    <th className="px-2 py-1 text-right font-medium">Lines</th>
                    <th className="px-2 py-1 text-right font-medium">Charged</th>
                  </tr>
                </thead>
                <tbody>
                  {a.by_cpt_revenue.map((g, i) => (
                    <tr key={`${g.cpt ?? '∅'}|${g.revenue ?? '∅'}|${i}`} className="border-t border-line/60 tabular-nums">
                      <td className="px-2 py-1 text-left text-ink900">{g.cpt ?? '(blank)'}</td>
                      <td className="px-2 py-1 text-left text-ink900">{g.revenue ?? '(blank)'}</td>
                      <td className="px-2 py-1 text-right">{g.count.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right">{MONEY0.format(g.charge)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <p className="text-[11px] text-ink400">
        {a.pct_zero_paid}% of charge lines were zero-paid
        {a.pct_patient_shifted > 0 ? ` (${a.pct_patient_shifted}% → patient balance)` : ''}; {MONEY0.format(a.paid_total)}{' '}
        total insurance paid at this point.
      </p>
      <CohortDrilldownTableView table={table} />
    </div>
  );
}

/**
 * The patient table (masked, audited reveal — reusing revealCmdReportRows verbatim, the SAME action
 * the main grid's "Reveal all" uses) or the suppression notice. Never a partial table: `table` is
 * already one or the other by construction (the reader never returns a truncated row set).
 */
function CohortDrilldownTableView({ table }: { table: CohortDrilldownTable }) {
  const [phi, setPhi] = useState<Map<number, CmdExplorerPhi>>(() => new Map());
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  if (table.kind === 'suppressed') {
    return (
      <div className="rounded-md border border-line bg-surface p-2 text-xs text-muted-foreground">
        Fewer than {table.floor} patients back this point — the patient list is hidden to protect
        identifiability. The breakdown above is still a full, dollar-weighted aggregate.
      </div>
    );
  }

  const rows = table.rows;

  async function reveal() {
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await revealCmdReportRows(rows.map((r) => r.id));
      if (res.ok) {
        const map = new Map<number, CmdExplorerPhi>();
        for (const r of res.rows) {
          const { id, ...phiFields } = r;
          map.set(id, phiFields);
        }
        setPhi(map);
        setRevealed(true);
      } else {
        setRevealError(res.error);
      }
    } catch {
      setRevealError('The identifiers could not be revealed right now.');
    } finally {
      setRevealing(false);
    }
  }

  function maskedCell(key: 'patient_name' | 'member_id_raw', row: CmdExplorerRow): string {
    if (!revealed) return PHI_MASK;
    return phi.get(row.id)?.[key] ?? '—';
  }

  return (
    <div className="rounded-md border border-line bg-surface p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Patients at this point ({rows.length})
        </div>
        <Button type="button" variant="outline" size="sm" disabled={revealing} onClick={() => void reveal()}>
          {revealing ? 'Revealing…' : revealed ? 'Hide identifiers' : 'Reveal identifiers'}
        </Button>
      </div>
      {revealError && <p className="mb-1 text-xs text-destructive">{revealError}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1 text-left font-medium">Charge date</th>
              <th className="px-2 py-1 text-left font-medium">CPT</th>
              <th className="px-2 py-1 text-left font-medium">Revenue</th>
              <th className="px-2 py-1 text-left font-medium">Payer</th>
              <th className="px-2 py-1 text-right font-medium">Charge</th>
              <th className="px-2 py-1 text-right font-medium">Allowed</th>
              <th className="px-2 py-1 text-right font-medium">Paid</th>
              <th className="px-2 py-1 text-left font-medium">Patient</th>
              <th className="px-2 py-1 text-left font-medium">Member ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line/60 tabular-nums">
                <td className="px-2 py-1 text-left">{row.charge_date}</td>
                <td className="px-2 py-1 text-left">{row.cpt_code}</td>
                <td className="px-2 py-1 text-left">{row.revenue_code ?? '—'}</td>
                <td className="px-2 py-1 text-left">{row.primary_payer ?? '—'}</td>
                <td className="px-2 py-1 text-right">{formatMoney(row.charge_amount)}</td>
                <td className="px-2 py-1 text-right">{formatMoney(row.allowed_amount)}</td>
                <td className="px-2 py-1 text-right">{formatMoney(row.insurance_payments)}</td>
                <td className={`px-2 py-1 text-left ${revealed ? '' : 'text-muted-foreground'}`}>
                  {maskedCell('patient_name', row)}
                </td>
                <td className={`px-2 py-1 text-left ${revealed ? '' : 'text-muted-foreground'}`}>
                  {maskedCell('member_id_raw', row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- skeletons (Session E) --------------------------------------------------
// Each is sized to the REAL panel's footprint so content swapping in causes no layout shift (CLS).
// Reserved for genuine first-load; a refetch of already-shown content keeps it visible + dimmed.

/** Grid table skeleton — a header row + rows of `cols`-wide cells, matching the real grid frame. */
function GridSkeleton({ cols }: { cols: number }) {
  const n = Math.max(1, cols);
  return (
    <div className="overflow-hidden rounded-md border" aria-hidden>
      <div className="flex gap-4 border-b bg-muted/30 px-3 py-2.5">
        {Array.from({ length: n }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-3 py-3 last:border-b-0">
          {Array.from({ length: n }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Search-summary skeleton — header + 3 stat tiles + 3 drill lists + the combo list, same layout. */
function SummaryPanelSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-ths" aria-hidden>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-3.5 w-48" />
      </div>
      {/* Footprint-matches the consolidated header cards: four %-with-dollar cards in one row. */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-7 w-20" />
            <Skeleton className="mt-1.5 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-3">
            <Skeleton className="mb-2 h-3 w-24" />
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, r) => (
                <Skeleton key={r} className="h-5 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-line bg-surface p-3">
        <Skeleton className="mb-2 h-3 w-56" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, r) => (
            <Skeleton key={r} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Cohort-curve skeleton — keeps the real title (with prefix) + three chart-sized placeholders per column. */
function CohortPanelSkeleton({ prefix }: { prefix: string }) {
  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-ths" aria-hidden>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-[var(--brand-ink)]" aria-hidden />
          <span className="text-sm font-semibold text-ink900">Cohort payer behavior — “{prefix}”</span>
        </div>
        <Skeleton className="h-3.5 w-56" />
      </div>
      <Skeleton className="mt-3 h-10 w-full rounded-lg" />
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <Skeleton className="mb-1 h-3 w-24" />
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="mt-2 h-28 w-full rounded-md" />
          <Skeleton className="mt-2 h-28 w-full rounded-md" />
        </div>
        <div>
          <Skeleton className="mb-1 h-3 w-36" />
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="mt-2 h-28 w-full rounded-md" />
          <Skeleton className="mt-2 h-28 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
