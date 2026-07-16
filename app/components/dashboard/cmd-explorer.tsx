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
  Check,
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
  Star,
  Table2,
  Trash2,
  TrendingDown,
  X,
} from 'lucide-react';
import {
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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
import { PHI_MASK } from '@/lib/phi';
import {
  loadCmdReport,
  loadCmdSearchSummary,
  loadCmdExplorerFacilities,
  loadCmdExplorerPayers,
  loadCohortCurve,
  loadCohortDrilldown,
  revealCmdReportRows,
  listGridViews,
  saveGridView,
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
import { deriveGridLayout } from '../../../src/collections/gridViewLayout';
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
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const IS_PHI = new Set<string>(COLUMNS.filter((c) => c.phi).map((c) => c.key));
const IS_NUMERIC = new Set<string>(COLUMNS.filter((c) => c.numeric).map((c) => c.key));
const DEFAULT_ORDER: ColKey[] = COLUMNS.map((c) => c.key);
// Columns hidden by default for users WITHOUT a saved view — data kept, re-showable via the column
// picker. A user's saved view carries its own explicit visibility (hidden_columns) and still governs.
const DEFAULT_HIDDEN = new Set<ColKey>(['adjustments']);
// Columns the grid can sort by (server-side; mirrors CMD_EXPLORER_SORTABLE_COLUMNS): the two
// date columns + every money column. Everything else (codes, facility, payer, PHI) is unsorted.
const SORTABLE_KEYS = new Set<string>([
  'charge_date',
  'payment_received',
  'charge_amount',
  'allowed_amount',
  'insurance_payments',
  'adjustments',
  'patient_balance_due',
  'pct_allowed',
  'pct_paid',
]);
// The two payer-gap columns render as percentages (formatPercent), not currency. They ARE numeric
// (right-aligned, sortable) — this set only overrides how cellText formats them.
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
const RECENCY_OPTIONS = [7, 14, 30] as const;
const RECENCY_LABEL: Record<number, string> = { 7: 'Past 7 days', 14: 'Past 14 days', 30: 'Past 30 days' };

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
  const seededDefaultView = seededViews?.find((v) => v.isDefault) ?? null;

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
  // Recency quick-filter: 0 = off (default — the grid still shows ALL months, an additive control,
  // not a changed default), or a rolling window of 7/14/30 days. Mutually exclusive with Month/Year.
  const [recencyDays, setRecencyDays] = useState(0);
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
  const hasAnySearch = facilitySelection.length > 0 || payerSelection.length > 0 || hasPhiSearch;
  // Stable dep keys for the selection sets (array identity changes on every toggle otherwise).
  const payerKey = payerSelection.join('\n');
  const facilityKey = facilitySelection.join(''); // control char can't appear in a facility name

  // Raw CMD facility text → curated friendly name from the already-loaded dimension options, for
  // DISPLAY only (the Top facilities summary card). Drill/filter values stay the raw facility text
  // the grid matches on, so no server change is needed. Falls back to raw when unmapped.
  const facilityDisplayName = useMemo(() => {
    const m = new Map(facilityOptions.map((o) => [o.facility, o.facility_name ?? o.facility]));
    return (raw: string) => m.get(raw) ?? raw;
  }, [facilityOptions]);

  // Options for the guided pickers. Facility carries a friendly display name + IP/OP/Both badge;
  // payer is a plain name. `value` (raw facility text / payer name) is what the grid filters on.
  const facilityPickerOptions = useMemo<PickerOption[]>(
    () =>
      facilityOptions.map((o) => ({
        value: o.facility,
        display: o.facility_name ?? o.facility,
        badge: o.care_setting,
      })),
    [facilityOptions],
  );
  const payerPickerOptions = useMemo<PickerOption[]>(
    () => payerOptions.map((p) => ({ value: p, display: p })),
    [payerOptions],
  );

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

  // Dismiss the Month/Year popover on outside pointer-down or Escape — the SAME dismiss behavior as
  // the view-switcher dropdown (D). Listeners attach only while it's open. (The popover holds
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
          const def = r.views.find((v) => v.isDefault);
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
      cpt_code?: string;
      revenue_code?: string;
      phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
    } = {};
    // Recency wins over Month/Year (they're mutually exclusive in the UI, but be explicit).
    if (recencyDays > 0) {
      f.recencyDays = recencyDays;
    } else if (month > 0) {
      f.year = year;
      f.month = month;
    }
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Facility multi-select is a top-level scope; a facility drill-down chip narrows to that ONE
    // facility (overriding the dropdown). Payer/CPT chips stay exact single-value refinements.
    if (facilitySelection.length > 0) f.facility = facilitySelection;
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
    // stable proxy for facilitySelection's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recencyDays, month, month > 0 ? year : 0, facilityKey, payerKey, refinement, hasPhiSearch, dMember, dAlpha, dGroup]);

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
      phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
    } = {};
    if (payerSelection.length > 0) f.primary_payers = payerSelection;
    // Top-level scope (date window + facility set) applies to the summary too — so the drill lists
    // describe the SAME population the grid shows. The chip refinement does NOT (it's a within-
    // results drill; the chips stay a stable facet navigator while drilling).
    if (recencyDays > 0) {
      f.recencyDays = recencyDays;
    } else if (month > 0) {
      f.year = year;
      f.month = month;
    }
    if (facilitySelection.length > 0) f.facility = facilitySelection;
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
  }, [hasPhiSearch, dMember, dAlpha, dGroup, recencyDays, month, month > 0 ? year : 0, facilityKey, payerKey, view]);

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

          {/* Unified time window (A): ONE segmented control — [7d][14d][30d][Month/Year ▾] — with an
              "All months" REST STATE (no segment active). Each segment drives the SAME state setters
              the three old controls did (selectRecency for the chips; the Month/Year selects' unchanged
              onChange), preserving the exact recency⇄Month/Year mutual exclusion. Because neither
              filterArg nor the summary effect is touched, the wire payload is byte-identical to the old
              three controls for any given selection — a presentational consolidation, not a behavior
              change. Reaching "All months": re-click the active chip (toggles off) or pick "All months"
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
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
              </Button>
              {columnsMenuOpen && (
                <ColumnViewManager
                  order={order}
                  hidden={hidden}
                  sensors={sensors}
                  onReorder={reorderColumns}
                  views={views}
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
 * The facility multi-select popover — the "which facilities' rows do I see" control. Empty selection
 * = ALL facilities, communicated explicitly at the top so the empty state never reads as
 * "broken / nothing selected". Offers
 * Select all / Clear, per-care-setting group selects (All IP / All OP, shown only when that group
 * exists — a facility classified BOTH counts for both), and individual checkboxes with a care-setting
 * badge. A full-screen invisible backdrop closes it on outside click.
 */
/** One option in a guided picker. `value` is the raw filter value the grid matches on; `display`
 *  is the friendly label shown; `badge` (facility only) shows the IP/OP/Both care setting. */
type PickerOption = { value: string; display: string; badge?: 'IP' | 'OP' | 'BOTH' | null };

/**
 * Guided multi-select "type-ahead + tags" picker — the search primitive that replaces the old
 * free-text bar + facility dropdown. The parent loads the full option list ONCE (facility ~30,
 * payer ~260 per tenant), so filtering is instant client-side as the user types — no per-keystroke
 * server round-trip. Selected values render as removable tags inside the control; a filtered list
 * drops below on focus/typing (capped, with a "keep typing" hint past the cap). Matches the
 * dashboard token system — no new design language.
 */
function MultiSelectTagPicker({
  label,
  placeholder,
  icon,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  placeholder: string;
  icon: React.ReactNode;
  options: PickerOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const displayOf = useMemo(() => new Map(options.map((o) => [o.value, o.display])), [options]);

  // Dismiss on outside pointer-down or Escape (same pattern as the Month/Year + view-switcher popovers).
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const CAP = 50;
  const matches = useMemo(
    () => (q === '' ? options : options.filter((o) => o.display.toLowerCase().includes(q))),
    [options, q],
  );
  const shown = matches.slice(0, CAP);

  return (
    <div ref={boxRef} className="relative min-w-[15rem] flex-1">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto font-normal normal-case text-ink400 underline-offset-2 transition-colors hover:text-[var(--brand-ink)] hover:underline"
          >
            Clear {selected.length}
          </button>
        )}
      </div>
      <div
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={[
          'flex min-h-10 w-full flex-wrap items-center gap-1 rounded-lg border bg-surface px-2 py-1.5 text-sm transition-colors',
          open ? 'border-[var(--brand-accent)] ring-2 ring-[var(--brand-accent)]/25' : 'border-line',
        ].join(' ')}
      >
        {selected.map((v) => (
          <span
            key={v}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-[var(--brand-soft)] py-0.5 pl-2 pr-1 text-xs font-medium text-[var(--brand-ink)]"
          >
            <span className="truncate">{displayOf.get(v) ?? v}</span>
            <button
              type="button"
              aria-label={`Remove ${displayOf.get(v) ?? v}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(v);
              }}
              className="shrink-0 rounded transition-colors hover:text-[var(--brand-accent)]"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? placeholder : 'Add more…'}
          aria-label={label}
          className="h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-ink900 outline-none placeholder:text-ink400"
        />
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-ths animate-ths-reveal">
          {options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink400">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink400">No matches for “{query.trim()}”.</p>
          ) : (
            shown.map((o) => {
              const on = selectedSet.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => onToggle(o.value)}
                  aria-pressed={on}
                  className={[
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    on ? 'bg-[var(--brand-soft)]' : 'hover:bg-[var(--brand-soft)]',
                  ].join(' ')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Check
                      className={['h-3.5 w-3.5 shrink-0 text-[var(--brand-accent)]', on ? '' : 'opacity-0'].join(' ')}
                      aria-hidden
                    />
                    <span className="truncate text-ink900">{o.display}</span>
                  </span>
                  {o.badge !== undefined && (
                    <span
                      className={[
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        o.badge ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]' : 'text-ink400',
                      ].join(' ')}
                    >
                      {o.badge ?? 'Other'}
                    </span>
                  )}
                </button>
              );
            })
          )}
          {matches.length > CAP && (
            <p className="px-2 py-1.5 text-[11px] text-ink400">
              Showing first {CAP} of {matches.length.toLocaleString()} — keep typing to narrow.
            </p>
          )}
        </div>
      )}
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
          <button
            type="button"
            onClick={onToggleSort}
            aria-label={`Sort by ${label}`}
            className="inline-flex cursor-pointer items-center gap-1 hover:text-[var(--brand-ink)]"
          >
            {label}
            {isSorted ? (
              direction === 'asc' ? (
                <ArrowUp className="h-3 w-3" aria-hidden />
              ) : (
                <ArrowDown className="h-3 w-3" aria-hidden />
              )
            ) : (
              <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
            )}
          </button>
        ) : (
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
          <div className="mt-3 grid animate-ths-reveal grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="Charged" value={MONEY0.format(s.total_charge)} />
            <StatTile label="Insurance Paid" value={MONEY0.format(s.total_paid)} />
            <StatTile label="Patient Balance" value={MONEY0.format(s.total_balance)} />
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

// Functional multi-series colors (per the design system, charts keep their own colors):
// Allowed = teal, Paid = violet, Dollars = amber. All read in light + dark, and amber stays
// distinct from the red degradation marker line. Selected-point highlight = blue (Session G) —
// distinct from all of the above, deliberately NOT --brand-accent (charts keep fixed functional
// colors regardless of tenant, so the selection marker reads the same for every view).
const COHORT_ALLOWED_COLOR = '#0d9488';
const COHORT_PAID_COLOR = '#7c3aed';
const COHORT_DOLLARS_COLOR = '#d97706';
const COHORT_SELECTED_COLOR = '#2563eb';

/** A cohort point plus the client-side dollar derivations (Phase 2). */
type CohortDollarPoint = CohortCurvePoint & {
  paid_per_patient: number;
  cum_paid_per_start: number | null;
};

/**
 * What the mini charts actually plot: a real (suppressed-floor-clearing) point OR an explicit GAP
 * placeholder for an interior bucket the server suppressed (<5 patients). Gap points carry null
 * metrics so the lines BREAK there (no connectNulls — a drawn line through missing data is a lie)
 * and patients: 0 so the exposure bar renders nothing; `suppressed` drives the tooltip's
 * "< 5 patients (suppressed)" read and blocks click-to-drilldown (the server would refuse anyway).
 */
type CohortChartDatum = {
  bucket: number;
  patients: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  paid_per_patient: number | null;
  cum_paid_per_start: number | null;
  pct_zero_paid: number | null;
  suppressed?: boolean;
};

/**
 * Fill INTERIOR suppressed buckets with explicit gap points so the x-axis is truthful (a missing
 * bucket used to silently vanish and the line connected straight across it). Only interior gaps:
 * leading/trailing suppressed buckets stay absent — we know nothing about where the axis "ends".
 */
function densifyBuckets(points: CohortDollarPoint[], step: number): CohortChartDatum[] {
  if (points.length === 0 || step <= 0) return points;
  const byBucket = new Map<number, CohortDollarPoint>(points.map((p) => [p.bucket, p]));
  const out: CohortChartDatum[] = [];
  for (let b = points[0]!.bucket; b <= points[points.length - 1]!.bucket; b += step) {
    out.push(
      byBucket.get(b) ?? {
        bucket: b,
        patients: 0,
        pct_allowed: null,
        pct_paid: null,
        paid_per_patient: null,
        cum_paid_per_start: null,
        pct_zero_paid: null,
        suppressed: true,
      },
    );
  }
  return out;
}

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
 * One SINGLE-SERIES cohort mini chart. The two %-series live on very different scales (~25% allowed
 * vs ~85% paid), so sharing one axis squashed the allowed line flat — each metric gets its own chart
 * + y-domain. `yMax` (when given) PINS the top of the axis: the same metric shown on both x-axes
 * side by side must share ONE scale, or the pair visually lies (the parent computes the max across
 * both). A faint patients-per-bucket bar on a hidden secondary axis (~quarter height) shows cohort
 * EXPOSURE, so a thinning tail reads as exactly that; the tooltip names the patient count per
 * bucket. The x-axis is NUMERIC and the data carries explicit gap points for suppressed interior
 * buckets (see densifyBuckets) — lines break at gaps instead of interpolating through missing data.
 * Self-labeled (name in its color) — no per-chart legend needed for one series.
 */
function CohortMiniChart({
  data,
  dataKey,
  name,
  def,
  color,
  xLabel,
  markerBucket,
  yMax,
  onPointClick,
  selectedBucket,
}: {
  data: CohortChartDatum[];
  dataKey: 'pct_allowed' | 'pct_paid';
  name: string;
  /** Optional small "definition" chip beside the series name, e.g. "allowed ÷ billed". */
  def?: string;
  color: string;
  xLabel: string;
  markerBucket?: number | null;
  /** Pinned y-axis top shared across this metric's sibling charts (see doc above). */
  yMax?: number;
  /** Session G: clicking anywhere on the chart opens that bucket's drilldown. Optional — the days-
   * axis %-paid chart etc. all pass it identically; only omitted where a click wouldn't make sense.
   * The parent guards against clicks on suppressed gap buckets. */
  onPointClick?: (bucket: number) => void;
  /** The currently-selected drilldown bucket, if it's on THIS chart's axis — drawn as a highlight
   * line distinct from the red degradation marker. */
  selectedBucket?: number | null;
}) {
  // Scale the hidden volume axis so the tallest exposure bar fills ~1/4 of the chart height.
  const maxPatients = Math.max(...data.map((p) => p.patients), 1);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold" style={{ color }}>{name}</span>
        {def && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{def}</span>}
      </div>
      <div className="h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
            onClick={
              onPointClick
                ? (s) => {
                    if (s?.activeLabel !== undefined && s.activeLabel !== null) onPointClick(Number(s.activeLabel));
                  }
                : undefined
            }
            style={onPointClick ? { cursor: 'pointer' } : undefined}
          >
            {/* Compact summary sparkline: no gridlines / axis chrome (the stat cards, the takeaway
                line, the hover tooltip, and the table toggle carry the numbers). The numeric axes are
                KEPT but hidden so bucket spacing + the ReferenceLine markers still map correctly. */}
            <XAxis dataKey="bucket" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} hide />
            <YAxis
              domain={[
                0,
                (dataMax: number) => {
                  const top = Math.max(Math.ceil((dataMax || 0) / 10) * 10, 20);
                  return yMax !== undefined ? Math.max(yMax, 20) : top;
                },
              ]}
              hide
            />
            <YAxis yAxisId="vol" hide domain={[0, maxPatients * 4]} />
            <Tooltip
              formatter={(v: number | string, n: string, item: { payload?: CohortChartDatum }) => {
                if (n === 'Patients') {
                  return item.payload?.suppressed
                    ? ['< 5 (suppressed)', 'Patients']
                    : [Number(v).toLocaleString(), 'Patients'];
                }
                return [v === null || v === undefined ? '—' : `${v}%`, n];
              }}
              labelFormatter={(l) => `${xLabel}: ${l}`}
            />
            {markerBucket != null && <ReferenceLine x={markerBucket} stroke="#dc2626" strokeDasharray="4 3" />}
            {selectedBucket != null && (
              <ReferenceLine x={selectedBucket} stroke={COHORT_SELECTED_COLOR} strokeWidth={2} strokeDasharray="2 2" />
            )}
            <Bar yAxisId="vol" dataKey="patients" name="Patients" fill={color} fillOpacity={0.12} isAnimationActive={false} />
            {/* NO connectNulls: a gap in the data must read as a gap, not an interpolated guess. */}
            <Line type="monotone" dataKey={dataKey} name={name} stroke={color} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * The Phase 2 dollar mini — per-bucket avg insurance $ per patient, in the same frame (grid, hidden
 * exposure bars, red drop marker) as the % minis. `name` states the UNIT per axis ("per visit" vs
 * "per 30 days") — the two axes measure different things and must say so. The cumulative-$ and
 * zero-pay reads moved OUT of the tooltip (they were invisible stroke-"none" series — four metrics
 * in a 112px chart's hover) into the caption below the chart and the point drilldown. The $ axis
 * floors at 0 but follows the data down if a reversal-heavy bucket nets negative, so no point is
 * ever clipped away.
 */
function CohortDollarMiniChart({
  data,
  name,
  xLabel,
  markerBucket,
  onPointClick,
  selectedBucket,
}: {
  data: CohortChartDatum[];
  /** Unit-bearing series label, e.g. "$ Paid / patient / visit" — differs per axis. */
  name: string;
  xLabel: string;
  markerBucket?: number | null;
  /** Session G: same click-to-drilldown affordance as CohortMiniChart. */
  onPointClick?: (bucket: number) => void;
  selectedBucket?: number | null;
}) {
  const maxPatients = Math.max(...data.map((p) => p.patients), 1);
  const usd = (v: number) => `$${Math.round(v).toLocaleString()}`;
  return (
    <div>
      <div className="text-[10px] font-semibold" style={{ color: COHORT_DOLLARS_COLOR }}>
        {name}
      </div>
      <div className="h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
            onClick={
              onPointClick
                ? (s) => {
                    if (s?.activeLabel !== undefined && s.activeLabel !== null) onPointClick(Number(s.activeLabel));
                  }
                : undefined
            }
            style={onPointClick ? { cursor: 'pointer' } : undefined}
          >
            {/* Compact summary sparkline — see CohortMiniChart; axes kept but hidden. */}
            <XAxis dataKey="bucket" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} hide />
            <YAxis
              domain={[
                (dataMin: number) => Math.min(0, dataMin),
                (dataMax: number) => Math.max(Math.ceil((dataMax || 0) / 50) * 50, 50),
              ]}
              hide
            />
            <YAxis yAxisId="vol" hide domain={[0, maxPatients * 4]} />
            <Tooltip
              formatter={(v: number | string, n: string, item: { payload?: CohortChartDatum }) => {
                if (n === 'Patients') {
                  return item.payload?.suppressed
                    ? ['< 5 (suppressed)', 'Patients']
                    : [Number(v).toLocaleString(), 'Patients'];
                }
                return [v === null || v === undefined ? '—' : usd(Number(v)), n];
              }}
              labelFormatter={(l) => `${xLabel}: ${l}`}
            />
            {markerBucket != null && <ReferenceLine x={markerBucket} stroke="#dc2626" strokeDasharray="4 3" />}
            {selectedBucket != null && (
              <ReferenceLine x={selectedBucket} stroke={COHORT_SELECTED_COLOR} strokeWidth={2} strokeDasharray="2 2" />
            )}
            <Bar
              yAxisId="vol"
              dataKey="patients"
              name="Patients"
              fill={COHORT_DOLLARS_COLOR}
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            {/* NO connectNulls — gaps in the data render as gaps (see CohortMiniChart). */}
            <Line
              type="monotone"
              dataKey="paid_per_patient"
              name={name}
              stroke={COHORT_DOLLARS_COLOR}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
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
  // Fold/unfold the panel body below the header (Session F) + the chart/table view toggle (the
  // table is the keyboard + screen-reader path to per-bucket values and drilldown). Local, resets
  // each session. Declared before the early returns (rules-of-hooks) even though the controls only
  // render in the 'ready'/'refreshing' branch below.
  const [collapsed, setCollapsed] = useState(false);
  const [showTable, setShowTable] = useState(false);
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
  // Chart data with explicit interior gap points (suppressed buckets break the line, not bridge it),
  // plus the REAL bucket sets so a click on a gap can't fire a doomed drilldown request.
  const posChart = densifyBuckets(posDollars, 1);
  const daysChart = densifyBuckets(daysDollars, dayBucketWidth);
  const posBuckets = new Set(c.by_position.map((p) => p.bucket));
  const dayBuckets = new Set(c.by_days.map((p) => p.bucket));
  const clickReal = (axis: 'position' | 'days', real: Set<number>) => (bucket: number) => {
    if (real.has(bucket)) onSelectPoint(axis, bucket);
  };
  // ONE y-scale per metric across BOTH x-axes — side-by-side charts of the same metric with
  // different y-maxes read as a comparison and lie. Headroom-rounded to the next 10.
  const metricYMax = (pick: (p: CohortCurvePoint) => number | null, floor: number) =>
    Math.max(
      floor,
      Math.ceil(
        Math.max(0, ...c.by_position.map((p) => pick(p) ?? 0), ...c.by_days.map((p) => pick(p) ?? 0)) / 10,
      ) * 10,
    );
  const allowedYMax = metricYMax((p) => p.pct_allowed, 20);
  const paidYMax = metricYMax((p) => p.pct_paid, 100);
  // End-state cumulative $/starting patient per axis — surfaced as a caption now that the invisible
  // tooltip series are gone.
  const lastCum = (pts: CohortDollarPoint[]) =>
    pts.length > 0 ? pts[pts.length - 1]!.cum_paid_per_start : null;
  const posCum = lastCum(posDollars);
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
            aria-pressed={showTable}
            aria-label={showTable ? 'Show charts' : 'Show data as table'}
            title={showTable ? 'Show charts' : 'Show data as table'}
            onClick={() => setShowTable((v) => !v)}
            className={`ml-1 shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)] ${
              showTable ? 'text-[var(--brand-ink)]' : 'text-ink400'
            }`}
          >
            <Table2 className="h-4 w-4" aria-hidden />
          </button>
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
        not just the patients shown in the grid below. Curves are dollar-weighted cohort averages, never
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
          {/* Whole-cohort END-TO-END yield (item 2) — three dollar-weighted stat cards + the identity
              caveat. Every number is from c.totals (the server aggregate); the block is absent below the
              min-patient floor (c.totals === null), the same gate the curve uses. */}
          {c.totals && (
            <div className="mt-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% collected of billed</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">paid ÷ billed</span>
                  </div>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(c.totals.pct_collected)}</div>
                  <div className="text-[11px] text-ink400">net yield end to end</div>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% allowed of billed</span>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(c.totals.pct_allowed)}</div>
                  <div className="text-[11px] text-ink400">what payer agreed to</div>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">% paid by payer</span>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink900">{formatPercentNum(c.totals.pct_paid)}</div>
                  <div className="text-[11px] text-ink400">of what was allowed</div>
                </div>
              </div>
              {c.totals.pct_allowed !== null && c.totals.pct_paid !== null && c.totals.pct_collected !== null && (
                <p className="mt-1.5 text-[10px] text-ink400">
                  ¹ {round(c.totals.pct_allowed)}% × {round(c.totals.pct_paid)}% ≈ {round(c.totals.pct_collected)}% — most of the gap
                  is expected contractual write-off, not lost revenue. Compare across payers/facilities rather than as a target.
                </p>
              )}
            </div>
          )}

          {/* Both axes, side by side — no toggle between them; the chart/table switch (header) is
              the keyboard + screen-reader path to the same per-bucket values and drilldown. */}
          <div className="mt-3 grid grid-cols-1 overflow-hidden rounded-lg border border-line lg:grid-cols-2">
            <div className="p-3 lg:border-r lg:border-line">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                By visit number
              </div>
              <div className="mb-1 text-[11px] text-ink400">{visitTakeaway} Click a point for details.</div>
              {showTable ? (
                <CohortBucketTable
                  points={posDollars}
                  bucketLabel={(b) => `Visit ${b}`}
                  usd={usd}
                  selectedBucket={selectedPoint?.axis === 'position' ? selectedPoint.bucket : null}
                  onSelectBucket={(b) => onSelectPoint('position', b)}
                />
              ) : (
                <div className="space-y-2">
                  <CohortMiniChart
                    data={posChart}
                    dataKey="pct_allowed"
                    name="% Allowed of billed"
                    def="allowed ÷ billed"
                    color={COHORT_ALLOWED_COLOR}
                    xLabel="Visit #"
                    markerBucket={deg?.dropAt ?? null}
                    yMax={allowedYMax}
                    onPointClick={clickReal('position', posBuckets)}
                    selectedBucket={selectedPoint?.axis === 'position' ? selectedPoint.bucket : null}
                  />
                  <CohortMiniChart
                    data={posChart}
                    dataKey="pct_paid"
                    name="% Paid by payer"
                    def="payer paid ÷ allowed"
                    color={COHORT_PAID_COLOR}
                    xLabel="Visit #"
                    yMax={paidYMax}
                    onPointClick={clickReal('position', posBuckets)}
                    selectedBucket={selectedPoint?.axis === 'position' ? selectedPoint.bucket : null}
                  />
                  <CohortDollarMiniChart
                    data={posChart}
                    name="$ Paid / patient / visit ²"
                    xLabel="Visit #"
                    markerBucket={deg?.dropAt ?? null}
                    onPointClick={clickReal('position', posBuckets)}
                    selectedBucket={selectedPoint?.axis === 'position' ? selectedPoint.bucket : null}
                  />
                  {posCum !== null && (
                    <p className="text-[10px] text-ink400">
                      ² Cumulative: ~{usd(posCum)} paid per starting patient through visit{' '}
                      {posDollars[posDollars.length - 1]!.bucket} (suppressed points excluded — a floor).
                    </p>
                  )}
                </div>
              )}
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
              <div className="mb-1 text-[11px] text-ink400">{daysTakeaway} Click a point for details.</div>
              {showTable ? (
                <CohortBucketTable
                  points={daysDollars}
                  bucketLabel={(b) => `Days ${b}–${b + dayBucketWidth - 1}`}
                  usd={usd}
                  selectedBucket={selectedPoint?.axis === 'days' ? selectedPoint.bucket : null}
                  onSelectBucket={(b) => onSelectPoint('days', b)}
                />
              ) : (
                <div className="space-y-2">
                  <CohortMiniChart
                    data={daysChart}
                    dataKey="pct_allowed"
                    name="% Allowed of billed"
                    def="allowed ÷ billed"
                    color={COHORT_ALLOWED_COLOR}
                    xLabel="Day window start"
                    yMax={allowedYMax}
                    onPointClick={clickReal('days', dayBuckets)}
                    selectedBucket={selectedPoint?.axis === 'days' ? selectedPoint.bucket : null}
                  />
                  <CohortMiniChart
                    data={daysChart}
                    dataKey="pct_paid"
                    name="% Paid by payer"
                    def="payer paid ÷ allowed"
                    color={COHORT_PAID_COLOR}
                    xLabel="Day window start"
                    yMax={paidYMax}
                    onPointClick={clickReal('days', dayBuckets)}
                    selectedBucket={selectedPoint?.axis === 'days' ? selectedPoint.bucket : null}
                  />
                  <CohortDollarMiniChart
                    data={daysChart}
                    name={`$ Paid / patient / ${dayBucketWidth} days ³`}
                    xLabel="Day window start"
                    onPointClick={clickReal('days', dayBuckets)}
                    selectedBucket={selectedPoint?.axis === 'days' ? selectedPoint.bucket : null}
                  />
                  {daysCum !== null && (
                    <p className="text-[10px] text-ink400">
                      ³ Cumulative: ~{usd(daysCum)} paid per starting patient through day{' '}
                      {daysDollars[daysDollars.length - 1]!.bucket + dayBucketWidth - 1} (suppressed
                      points excluded — a floor).
                    </p>
                  )}
                </div>
              )}
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
          {/* Legend strip (item 4) — replaces the old 8-sentence footnote. Def-of-metric text lives on
              the card / row def chips now; the surviving glossary is exactly these four reading aids.
              The grain/dollar-weighted note (#7) and $/patient definition (#8) were intentionally dropped
              from visible copy (per rulings); zero-paid (#9) + survivorship (#10) live in the takeaways. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink400">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-[1px] bg-current opacity-30" aria-hidden />
              bar = patients at point
            </span>
            <span>· gap = &lt;5 patients (suppressed)</span>
            <span>· “—” = allowed too small to divide</span>
            <span className="inline-flex items-center gap-1">
              · <Columns3 className="h-3 w-3" aria-hidden /> left vs right = different units, don’t compare $
            </span>
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
