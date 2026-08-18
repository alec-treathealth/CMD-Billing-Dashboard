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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
/** Mirrors CMD_NAME_SEARCH_ROW_CAP in app/lib/server.ts (ratified by Alec 2026-08-17). Used ONLY for
 *  the helper text — the server enforces the real ceiling and returns the authoritative number, so
 *  a drift here misleads the reader but cannot widen the decrypt. */
const NAME_SEARCH_CAP = 2000;

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
const RECENCY_OPTIONS = [7, 14, 30, 90] as const;
const RECENCY_LABEL: Record<number, string> = {
  7: 'Past 7 days',
  14: 'Past 14 days',
  30: 'Past 30 days',
  90: 'Past 90 days',
};

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

  const [rows, setRows] = useState<CmdExplorerRow[]>(() => (seededReport ? seededReport.rows : []));
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>(() =>
    seededReport ? 'ready' : 'loading',
  );

  // Guided search (replaces the old free-text bar): Facility + Payer are multi-select tag pickers
  // (facilitySelection / payerSelection below). `refinement` is now ONLY the (CPT × Revenue-code)
  // combo drill from the summary combo table — facility/payer summary clicks add tags instead of
  // setting a single refinement (see applyRefinement).
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const [year, setYear] = useState(YEAR_OPTIONS[0]!);
  const [month, setMonth] = useState(0); // 0 = All months
  // Recency quick-filter: a rolling window of 7/14/30/90 days, or 0 = off (all months). DEFAULT 90 —
  // the default nav carries a payment_received window so the summary aggregates hit the
  // (business_entity_id, payment_received) index path instead of an all-time seq scan of the whole
  // charge-rollup slice (measured: all-time Consolidated summary ~148–220ms/panel warm → ~80ms
  // worst-case with a 90d window). Re-clicking the active chip (or picking a Month/Year) still
  // returns to all-time. Mutually exclusive with Month/Year.
  const [recencyDays, setRecencyDays] = useState(90);
  // Month/Year picker popover — the [Month/Year ▾] segment of the unified time control (A).
  const [monthYearOpen, setMonthYearOpen] = useState(false);
  const monthYearRef = useRef<HTMLDivElement>(null);

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
  const [nameMatchIds, setNameMatchIds] = useState<string[] | null>(null);
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
  const gridRef = useRef<HTMLDivElement>(null);

  // A "search" is now any active guided selection: facility tags, payer tags, or a PHI lookup.
  // (The free-text term + column-scoped substring search were removed with the search bar.)
  const hasAnySearch =
    facilitySelection.length > 0 ||
    payerSelection.length > 0 ||
    hasPhiSearch;

  // Patient-name search is allowed only once something ELSE narrows the rows. Mirrors the
  // server-side `narrowed` check in searchCmdExplorerPatientName — the server is the real gate (a
  // client that skipped this must not be able to trigger an unbounded decrypt); this exists so the
  // UI can explain WHY the field is inert instead of just disabling it.
  //
  // A month/recency window counts: it is what most users narrow with first, and it bounds the set
  // just as effectively as a facility does.
  const nameSearchAllowed =
    canRevealPhi &&
    (facilitySelection.length > 0 ||
      payerSelection.length > 0 ||
      employerSelection.length > 0 ||
      recencyDays > 0 ||
      month > 0 ||
      hasPhiSearch);

  /**
   * Run the patient-name search.
   *
   * The term is PHI: it is sent ONCE, in a Server Action body, and what comes back is row IDS. It
   * is never written to the URL, a grid view, or storage. The server re-checks narrowing and the
   * row cap — this is a UX gate, not the security one.
   */
  const runNameSearch = useCallback(async () => {
    const term = nameQuery.trim();
    if (term === '' || !nameSearchAllowed) return;
    setNameSearching(true);
    setNameNotice(null);
    try {
      // Same narrowing fields the grid sends, so the count the user is told matches the rows they
      // are looking at. row_ids is deliberately ABSENT — searching within a prior name result would
      // compound filters and make "no matches" unexplainable.
      const f: Parameters<typeof searchCollectionsPatientName>[1] = {};
      if (recencyDays > 0) f.recencyDays = recencyDays;
      else if (month > 0) { f.year = year; f.month = month; }
      if (facilitySelection.length > 0) f.facility = expandFacilityKeys(facilitySelection, facilityGroups);
      if (payerSelection.length > 0) f.primary_payers = payerSelection;
      applyEmployerFilter(f, employerSelection, employerVocabulary);
      if (hasPhiSearch) {
        f.phiSearch = {
          ...(dMember !== '' ? { memberId: dMember } : {}),
          ...(dAlpha !== '' ? { alphaPrefix: dAlpha } : {}),
          ...(dGroup !== '' ? { groupNumber: dGroup } : {}),
        };
      }
      const res = await searchCollectionsPatientName(term, f, view);
      if (!res.ok) { setNameNotice(res.error); return; }
      const r = res.result;
      if (!r.ok) {
        setNameNotice(
          r.reason === 'too_broad'
            ? `Too many rows to search by name — ${r.count.toLocaleString()} in view, limit ${r.cap.toLocaleString()}. Narrow further.`
            : `Pick a facility, payer, date range, employer or member ID first.`,
        );
        return;
      }
      // [] is kept, not discarded: it means "searched, matched nothing", and the grid must show
      // empty rather than silently reverting to every row.
      setNameMatchIds(r.rowIds);
      setNameNotice(
        r.matched === 0
          ? `No patient name matched in the ${r.scanned.toLocaleString()} rows searched.`
          : `${r.matched.toLocaleString()} of ${r.scanned.toLocaleString()} rows matched.`,
      );
    } catch {
      setNameNotice('The name search could not be completed right now.');
    } finally {
      setNameSearching(false);
    }
  }, [nameQuery, nameSearchAllowed, recencyDays, month, year, facilitySelection, payerSelection,
      employerSelection, hasPhiSearch, dMember, dAlpha, dGroup, view]);
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

  // --- dual-mode yield + AI-analysis input assembly ------------------------
  // A prefix cohort is "resolved" when the alpha-prefix search is active AND the curve returned
  // whole-cohort totals (i.e., it cleared COHORT_MIN_PATIENTS). Then the green cards + AI read the
  // COHORT yield; otherwise the SELECTION yield (this summary's tile aggregate — never a new query).
  const cohortData = cohort.kind === 'ready' || cohort.kind === 'refreshing' ? cohort.data : null;
  const cohortResolved = cohortActive && cohortData !== null && cohortData.totals !== null;
  const cohortYield =
    cohortResolved && cohortData
      ? { pct: cohortData.totals!, cohortPatients: cohortData.cohort_patients, prefix: dAlpha }
      : null;

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
  const aiKey = [view, recencyDays, month > 0 ? year : 0, month, facilityKey, payerKey, dMember, dAlpha, dGroup].join('|');

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
  /** Curated key → its raw CMD spellings. The picker merges; the FILTER still matches raw text. */
  const facilityGroups = useMemo(() => facilityGroupsFrom(facilityOptions), [facilityOptions]);
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
    if (!monthYearOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!monthYearRef.current?.contains(e.target as Node)) setMonthYearOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMonthYearOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [monthYearOpen]);

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

  // The filter passed to the grid action: date window (recency OR month/year) + facility set +
  // (debounced) substring + chip refinement + gated PHI lookup. PHI terms are sent raw ONLY to the
  // server action, which HMACs them into blind-index tokens, gates to canRevealPhi, and audits —
  // never matched client-side.
  const filterArg = useMemo(() => {
    const f: {
      year?: number;
      month?: number;
      recencyDays?: number;
      facility?: string[];
      primary_payer?: string;
      primary_payers?: string[];
      employer_names?: string[];
        cpt_code?: string;
      revenue_code?: string;
      phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
      row_ids?: string[];
    } = {};
    // Recency wins over Month/Year (they're mutually exclusive in the UI, but be explicit).
    if (recencyDays > 0) {
      f.recencyDays = recencyDays;
    } else if (month > 0) {
      f.year = year;
      f.month = month;
    }
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Employer segment (0101). 'all' emits NOTHING — the server treats absent as unrestricted, and
    // sending an explicit 'all' would only add a no-op branch to every query plan.
    applyEmployerFilter(f, employerSelection, employerVocabulary);
    // Patient-name search result. `[]` is MEANINGFUL: it means "searched, matched nothing", and must
    // still be sent so the grid shows an empty result instead of silently dropping the filter and
    // widening back to every row. The name ITSELF is never sent here — only the ids it resolved to.
    if (nameMatchIds !== null) f.row_ids = nameMatchIds;
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
    // year only matters when a specific month is chosen (see original rationale); facilityKey is the
    // stable proxy for facilitySelection's contents (payerKey likewise).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recencyDays, month, month > 0 ? year : 0, facilityKey, payerKey, employerKey, refinement, hasPhiSearch, dMember, dAlpha, dGroup]);

  const loadPage = useCallback(
    async (
      target: number,
      cursor: CmdExplorerCursor | null,
      filter: typeof filterArg,
      sortArg: CmdExplorerSort,
    ) => {
      const myReq = ++reqRef.current;
      setStatus('loading');
      setPhi(new Map());
      setRevealed(false);
      setRevealing(false);
      setRevealError(null);
      try {
        const res: CmdReportResult = await loadCmdReport(cursor, filter, sortArg, view);
        if (myReq !== reqRef.current) return; // a newer navigation superseded this load
        if (!res.ok) {
          setStatus('error');
          return;
        }
        setRows(res.rows);
        setHasNext(res.nextCursor !== null);
        setCursors((prev) => {
          const next = [...prev];
          next[target] = cursor;
          if (res.nextCursor !== null) next[target + 1] = res.nextCursor;
          return next;
        });
        setPage(target);
        setStatus('ready');
      } catch {
        if (myReq === reqRef.current) setStatus('error');
      }
    },
    [view],
  );

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
      void loadPage(0, null, filterArg, sort);
    });
  }, [filterArg, sort, loadPage]);

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
      year?: number;
      month?: number;
      recencyDays?: number;
      facility?: string[];
      primary_payers?: string[];
      employer_names?: string[];
        phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
      row_ids?: string[];
    } = {};
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Employer segment (0101). 'all' emits NOTHING — the server treats absent as unrestricted, and
    // sending an explicit 'all' would only add a no-op branch to every query plan.
    applyEmployerFilter(f, employerSelection, employerVocabulary);
    // Patient-name search result. `[]` is MEANINGFUL: it means "searched, matched nothing", and must
    // still be sent so the grid shows an empty result instead of silently dropping the filter and
    // widening back to every row. The name ITSELF is never sent here — only the ids it resolved to.
    if (nameMatchIds !== null) f.row_ids = nameMatchIds;
    // Top-level scope (date window + facility set) applies to the summary too — so the drill lists
    // describe the SAME population the grid shows. The chip refinement does NOT (it's a within-
    // results drill; the chips stay a stable facet navigator while drilling).
    if (recencyDays > 0) {
      f.recencyDays = recencyDays;
    } else if (month > 0) {
      f.year = year;
      f.month = month;
    }
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
  }, [hasPhiSearch, dMember, dAlpha, dGroup, recencyDays, month, month > 0 ? year : 0, facilityKey, payerKey, employerKey, view]);

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
  function selectRecency(days: number) {
    setRecencyDays((prev) => (prev === days ? 0 : days));
    setMonth(0);
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
    requestAnimationFrame(() => gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
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
    requestAnimationFrame(() => gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
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

  function cellText(key: ColKey, row: CmdExplorerRow): string {
    if (IS_PHI.has(key)) {
      if (!revealed) return PHI_MASK;
      const p = phi.get(row.id);
      const v = p ? p[key as keyof CmdExplorerPhi] : null;
      return v ?? '—';
    }
    const v = row[key as keyof CmdExplorerRow] as string | null;
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
    recencyDays > 0
      ? RECENCY_LABEL[recencyDays]!
      : month > 0
        ? `${MONTH_NAMES[month - 1]} ${year}`
        : 'All months';
  const facilityLabel =
    facilitySelection.length === 0
      ? 'All facilities'
      : `${facilitySelection.length} facilit${facilitySelection.length === 1 ? 'y' : 'ies'}`;
  const payerLabel =
    payerSelection.length === 0
      ? 'All payers'
      : `${payerSelection.length} payer${payerSelection.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-4">
      {/* ---- Search hero -------------------------------------------------- */}
      <div className="rounded-xl border border-line bg-card p-4 shadow-ths">
        <div className="flex flex-wrap items-end gap-3">
          {/* Guided search — Facility + Payer multi-select tag pickers (replaces the old free-text
              bar + facility dropdown). Both scope the grid AND the summary; empty = no restriction.
              Options load once per tenant and filter client-side as the user types. */}
          <MultiSelectTagPicker
            label="Facility"
            placeholder="Type to find facilities…"
            icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
            options={facilityPickerOptions}
            selected={facilitySelection}
            onToggle={toggleFacility}
            onClear={clearFacilities}
          />
          <MultiSelectTagPicker
            label="Payer"
            placeholder="Type to find payers…"
            icon={<CreditCard className="h-3.5 w-3.5" aria-hidden />}
            options={payerPickerOptions}
            selected={payerSelection}
            onToggle={togglePayer}
            onClear={clearPayers}
          />
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
            <MultiSelectTagPicker
              label="Employer"
              placeholder="Type to find employers…"
              icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
              options={employerPickerOptions}
              selected={employerSelection}
              onToggle={toggleEmployer}
              onClear={clearEmployers}
            />
          )}
          {/* Unified time window (A): ONE segmented control — [7d][14d][30d][90d][Month/Year ▾].
              DEFAULT is 90d (see recencyDays init) so the first-load summary hits the index path;
              re-clicking the active chip or picking a Month/Year reaches the "All months" state (no
              segment active). Each segment drives the SAME state setters the three old controls did
              (selectRecency for the chips; the Month/Year selects' unchanged onChange), preserving the
              exact recency⇄Month/Year mutual exclusion. Because neither filterArg nor the summary
              effect is touched, the wire payload is byte-identical to the old three controls for any
              given selection — a presentational consolidation, plus the 90d default window.
              Reaching "All months": re-click the active chip (toggles off) or pick "All months"
              in the Month select — exactly as before. */}
          <div
            className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
            role="group"
            aria-label="Time window"
          >
            {RECENCY_OPTIONS.map((d) => {
              const active = recencyDays === d;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={active}
                  title={RECENCY_LABEL[d]}
                  onClick={() => selectRecency(d)}
                  className={[
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]'
                      : 'text-muted-foreground hover:bg-[var(--brand-soft)]',
                  ].join(' ')}
                >
                  {d}d
                </button>
              );
            })}
            {/* [Month/Year ▾] — opens a popover holding the SAME Month + Year selects (onChange bodies
                unchanged). Highlighted + labelled with the chosen window when a specific month is active. */}
            <div ref={monthYearRef} className="relative">
              <button
                type="button"
                aria-expanded={monthYearOpen}
                aria-haspopup="true"
                onClick={() => setMonthYearOpen((o) => !o)}
                className={[
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  month > 0
                    ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]'
                    : 'text-muted-foreground hover:bg-[var(--brand-soft)]',
                ].join(' ')}
              >
                {month > 0 ? `${MONTH_NAMES[month - 1]} ${year}` : 'Month/Year'}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
              </button>
              {monthYearOpen && (
                <div
                  role="dialog"
                  aria-label="Choose month and year"
                  className="absolute right-0 top-full z-50 mt-2 flex items-center gap-2 animate-ths-reveal rounded-lg border border-line bg-surface p-3 shadow-ths"
                >
                  <ControlSelect
                    label="Month"
                    value={month}
                    ariaLabel="Month"
                    onChange={(v) => {
                      setMonth(Number(v));
                      setRecencyDays(0); // Month/Year and recency are mutually exclusive windows.
                    }}
                  >
                    <option value={0}>All months</option>
                    {MONTH_NAMES.map((name, i) => (
                      <option key={name} value={i + 1}>
                        {name}
                      </option>
                    ))}
                  </ControlSelect>
                  <ControlSelect label="Year" value={year} ariaLabel="Year" onChange={(v) => setYear(Number(v))}>
                    {YEAR_OPTIONS.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </ControlSelect>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Gated patient lookup — only for PHI-entitled roles. Matched via keyed blind indexes
            server-side (exact member ID / 3-char alpha prefix / exact group #), audited, results
            masked. The raw value is never substring-matched and never revealed by the search. */}
        {canRevealPhi && (
          <div className="mt-3 rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Fingerprint className="h-3.5 w-3.5 text-[var(--brand-ink)]" aria-hidden />
              Patient lookup
              <span className="inline-flex items-center gap-1 font-normal normal-case text-ink400">
                <Lock className="h-3 w-3" aria-hidden /> encrypted · exact match · audited
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PhiField label="Member ID" value={phiMemberId} onChange={setPhiMemberId} placeholder="exact member ID" width="w-48" />
              <PhiField label="Alpha prefix" value={phiAlphaPrefix} onChange={setPhiAlphaPrefix} placeholder="3-letter" width="w-28" maxLength={3} />
              <PhiField label="Group #" value={phiGroup} onChange={setPhiGroup} placeholder="exact group #" width="w-40" />
            </div>

            {/* PATIENT NAME — deliberately SEPARATE from the exact-match fields above, because it
                behaves differently: partial match, and only over an already-narrowed set. Names are
                unique, but searching the whole book would mean decrypting it, so the input is inert
                until something else narrows the rows. RULED BY ALEC 2026-08-17: the reason is stated
                to the user rather than left as a dead input. */}
            <div className="mt-2 border-t border-line pt-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor="phi-patient-name" className="text-[11px] font-medium text-muted-foreground">
                    Patient name
                  </label>
                  <input
                    id="phi-patient-name"
                    type="text"
                    value={nameQuery}
                    maxLength={120}
                    disabled={!nameSearchAllowed}
                    onChange={(e) => setNameQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && nameSearchAllowed) runNameSearch();
                    }}
                    placeholder={nameSearchAllowed ? 'full or partial name' : 'narrow first'}
                    // autoComplete off: this value is PHI and must not be stored by the browser.
                    autoComplete="off"
                    className="w-56 rounded-md border border-line bg-canvas px-2 py-1 text-sm text-ink900 placeholder:text-ink400 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-describedby="phi-patient-name-help"
                  />
                </div>
                <button
                  type="button"
                  onClick={runNameSearch}
                  disabled={!nameSearchAllowed || nameQuery.trim() === '' || nameSearching}
                  className="rounded-md border border-line bg-surface px-3 py-1 text-sm font-medium text-ink900 transition-colors hover:bg-[var(--brand-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {nameSearching ? 'Searching…' : 'Search'}
                </button>
                {nameMatchIds !== null && (
                  <button
                    type="button"
                    onClick={() => { setNameMatchIds(null); setNameQuery(''); setNameNotice(null); }}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Clear name filter
                  </button>
                )}
              </div>
              {/* The WHY, always visible — never a silently disabled box. */}
              <p id="phi-patient-name-help" className="mt-1 text-[11px] text-muted-foreground">
                {nameNotice ??
                  (nameSearchAllowed
                    ? `Matches part of a name, over up to ${NAME_SEARCH_CAP.toLocaleString()} rows — names are encrypted, so each candidate row must be decrypted to compare. Narrow further if a name is missing.`
                    : `Pick a facility, payer, date range, employer or member ID first — name search decrypts each candidate row, so it runs over at most ${NAME_SEARCH_CAP.toLocaleString()} narrowed rows.`)}
              </p>
            </div>
          </div>
        )}

        {/* Active-scope line + active refinement pill. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {hasAnySearch
              ? `${facilityLabel} · ${payerLabel} · ${windowLabel}`
              : `Browsing ${facilityLabel} · ${payerLabel} · ${windowLabel} — pick a facility or payer to search`}
          </span>
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
      {hasAnySearch && (
        <SearchSummaryPanel
          state={summary}
          label="your selection"
          refinement={refinement}
          onDrill={applyRefinement}
          onDrillCombo={applyComboRefinement}
          facilityDisplayName={facilityDisplayName}
          cohortYield={cohortYield}
        />
      )}

      {/* ---- Alpha-prefix cohort payer-behavior curve (PHI-gated, Session D) --- */}
      {/* Kept mounted through its exit animation so it fades out instead of popping; during the exit
          window the live state has reset to idle, so render the frozen snapshot. */}
      {cohortPresence.rendered && (
        <div className={cohortPresence.exiting ? 'animate-ths-exit' : 'animate-ths-reveal'}>
          {cohortPresence.exiting && cohortSnapshotRef.current ? (
            // Frozen snapshot fading out — drilldownPoint is already cleared by the effect above
            // (it resets on any cohortActive/prefix change), so no live selection to render here.
            <CohortCurvePanel
              state={{ kind: 'ready', data: cohortSnapshotRef.current.data }}
              prefix={cohortSnapshotRef.current.prefix}
              selectedPoint={null}
              drilldown={null}
              onSelectPoint={() => {}}
              onCloseDrilldown={() => {}}
            />
          ) : (
            <CohortCurvePanel
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

      {/* ---- AI analysis (streamed, where the curves were; both modes) ------ */}
      {/* Keyed on the search signature: any filter/search/prefix/view change remounts it to idle and
          its unmount cleanup aborts an in-flight stream, so a stale summary can't linger. */}
      {hasAnySearch && <CollectionsAiPanel key={aiKey} input={aiInput} view={view} />}

      {/* ---- Detail grid -------------------------------------------------- */}
      <div ref={gridRef} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
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
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            That page could not be loaded. Try again.
          </div>
        )}

        {revealError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {revealError}
          </div>
        )}

        {status === 'loading' && rows.length === 0 ? (
          <GridSkeleton cols={visibleOrder.length} />
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {hasAnySearch ? 'No charge lines match this search.' : 'No charge lines match the current filters.'}
          </div>
        ) : (
          <div className="relative">
            {/* Non-blocking refetch: keep the current page visible, dimmed, with a thin progress bar
                on top — don't blank to a skeleton on every filter/sort/pagination change. */}
            {gridRefreshing && (
              <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse rounded-t-md bg-[var(--brand-accent)]" aria-hidden />
            )}
            <div
              aria-busy={gridRefreshing}
              className={`overflow-x-auto rounded-md border transition-opacity duration-150 ${gridRefreshing ? 'opacity-60' : ''}`}
            >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis]}
              onDragEnd={(e: DragEndEvent) => {
                if (e.over) reorderColumns(String(e.active.id), String(e.over.id));
              }}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableContext items={visibleOrder} strategy={horizontalListSortingStrategy}>
                      {visibleOrder.map((c) => (
                        <SortableHeadCell
                          key={c}
                          colKey={c}
                          sortable={SORTABLE_KEYS.has(c)}
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
                    <TableRow key={row.id} className="transition-colors hover:bg-[var(--brand-soft)]">
                      {visibleOrder.map((c) => (
                        <TableCell
                          key={c}
                          className={
                            IS_NUMERIC.has(c)
                              ? 'text-right tabular-nums'
                              : IS_PHI.has(c) && !revealed
                                ? 'text-muted-foreground'
                                : undefined
                          }
                        >
                          {cellText(c, row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DndContext>
            </div>
          </div>
        )}

        <Pager
          page={page + 1}
          hasPrev={page > 0}
          hasNext={hasNext}
          disabled={busy}
          onPrev={() => {
            if (page > 0) startTransition(() => void loadPage(page - 1, cursors[page - 1] ?? null, filterArg, sort));
          }}
          onNext={() => {
            if (hasNext) startTransition(() => void loadPage(page + 1, cursors[page + 1] ?? null, filterArg, sort));
          }}
        />
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
        numeric ? 'text-right' : '',
        isSorted ? 'text-[var(--brand-ink)]' : '',
        isDragging ? 'relative z-10 opacity-70' : '',
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

/** The three payer-behavior percentages both modes share (0–100 or null → "—"). */
type YieldPct = { pct_allowed: number | null; pct_paid: number | null; pct_collected: number | null };

/**
 * DUAL-MODE green cards, rendered directly beneath the money tiles. COHORT mode (a prefix cohort is
 * resolved) shows the prefix-wide, N-patient cohort yield; SELECTION mode shows the filter-wide yield
 * derived from the same rollup that feeds the CHARGED / INSURANCE PAID / PATIENT BALANCE tiles. The
 * header/scope pill make the population explicit so a biller never mistakes a cohort-of-N for the
 * whole filtered selection. Visual treatment (cardGreen + formatPercentNum) is byte-identical to the
 * retired cohort-panel cards — only POSITION and (in selection mode) the header label changed.
 */
type YieldMode =
  | { mode: 'cohort'; pct: YieldPct; cohortPatients: number; prefix: string }
  | { mode: 'selection'; pct: YieldPct; chargeLines: number };

function YieldCardsPanel({ view }: { view: YieldMode }) {
  const pct = view.pct;
  const round = (n: number) => Math.round(n);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {view.mode === 'cohort' ? (
          <>
            <span className="text-xs font-semibold text-ink900">Cohort payer behavior — “{view.prefix}”</span>
            <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              prefix-wide · ignores Member ID, facility &amp; date filters
            </span>
          </>
        ) : (
          <>
            <span className="text-xs font-semibold text-ink900">Selection payer behavior — all filtered charge lines</span>
            <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              matches the {view.chargeLines.toLocaleString()} charge lines &amp; filters above
            </span>
          </>
        )}
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {view.mode === 'cohort'
          ? `All ${view.cohortPatients.toLocaleString()} patients whose insurance member ID begins with “${view.prefix}” — dollar-weighted cohort averages, never one patient.`
          : 'Dollar-weighted across every charge line in the current selection (facility · payer · date · search) — a filtered aggregate, not a patient cohort.'}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_allowed)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% allowed of billed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">allowed ÷ billed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_allowed)}</div>
          <div className="text-[11px] text-ink400">what payer agreed to</div>
        </div>
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_paid)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% paid by payer</span>
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">payer paid ÷ allowed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_paid)}</div>
          <div className="text-[11px] text-ink400">of what was allowed</div>
        </div>
        <div className={`rounded-lg p-3 ${cardGreen(pct.pct_collected)}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% collected of billed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">paid ÷ billed</span>
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(pct.pct_collected)}</div>
          <div className="text-[11px] text-ink400">net yield end to end</div>
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
 * The search-engine result: headline count + money totals, the three single-dimension drill-down
 * lists, then the (CPT × Revenue-code) combination list full-width below them (it carries more
 * numbers per row — count, charge, %-allowed, %-paid — so it gets the full width to stay readable).
 */
function SearchSummaryPanel({
  state,
  label,
  refinement,
  onDrill,
  onDrillCombo,
  facilityDisplayName,
  cohortYield,
}: {
  state: SummaryState;
  label: string;
  refinement: Refinement | null;
  onDrill: (kind: RefineKind, value: string) => void;
  onDrillCombo: (cpt: string, revenue: string) => void;
  /** Raw facility text → curated friendly name, for the Top facilities card display only. */
  facilityDisplayName?: (raw: string) => string;
  /** When a prefix cohort is resolved, the green cards render its COHORT yield (+ framing) instead
   *  of the selection yield. Null → SELECTION mode (cards derive from this summary's tile aggregate). */
  cohortYield?: { pct: YieldPct; cohortPatients: number; prefix: string } | null;
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
          <div className="mt-3 grid animate-ths-reveal grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="Charged" value={MONEY0.format(s.total_charge)} />
            <StatTile label="Insurance Paid" value={MONEY0.format(s.total_paid)} />
            <StatTile label="Patient Balance" value={MONEY0.format(s.total_balance)} />
          </div>

          {/* Green payer-behavior cards — directly beneath the money tiles. Dual-mode: cohort yield
              (prefix cohort resolved) or filter-wide yield (this summary's tile aggregate). */}
          <YieldCardsPanel
            view={
              cohortYield
                ? { mode: 'cohort', pct: cohortYield.pct, cohortPatients: cohortYield.cohortPatients, prefix: cohortYield.prefix }
                : { mode: 'selection', pct: s.yield_pct, chargeLines: s.total_count }
            }
          />

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
 */
function ComboDrillList({
  groups,
  activeCombo,
  onDrill,
  revealDelayMs = 0,
}: {
  groups: CmdComboGroup[];
  activeCombo: { cpt: string; revenue: string } | null;
  onDrill: (cpt: string, revenue: string) => void;
  revealDelayMs?: number;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="mt-3 animate-ths-reveal rounded-lg border border-line bg-surface p-3" style={{ animationDelay: `${revealDelayMs}ms` }}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Layers className="h-3.5 w-3.5" aria-hidden />
        Top CPT × Revenue-code combinations
      </div>
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
            {groups.map((g, i) => {
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
  const [collapsed, setCollapsed] = useState(false);
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
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? 'Expand cohort payer behavior' : 'Collapse cohort payer behavior'}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((v) => !v)}
            className="shrink-0 rounded-md p-1 text-ink400 transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)]"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
          </button>
          </span>
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

      {!collapsed && (
        <div id={bodyId} className={memberIdActive ? 'opacity-70' : undefined}>
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
      )}
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
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface px-3 py-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-24" />
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
