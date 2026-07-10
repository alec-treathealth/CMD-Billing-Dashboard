'use client';

/**
 * "Collections" grid (Derek's 14-column CMD batch export) — DB-backed charge-line detail,
 * fronted by a SMART SEARCH: type a term and the panel first shows an aggregate summary of
 * everything matching (count + money totals + the top facilities / payers / CPT codes), each
 * of which is a clickable drill-down chip that refines the detail grid below. The noisy rows
 * stay one click away instead of being the first thing you face.
 *
 * Search is a SERVER-SIDE substring (ILIKE) match. Scope FOLLOWS the visible columns — there is one
 * "columns" concept: the term matches the SEARCHABLE columns currently shown (non-PHI, non-percent;
 * the 3 PHI columns are encrypted at rest and can't be substring-searched — the gated Patient lookup
 * handles those). Typing is debounced (~350ms) so a large dataset isn't hammered on every keystroke.
 * A Month/Year window still scopes everything server-side. Row PHI renders •••••• until "Reveal all"
 * decrypts the current page in one audited call (held in memory only, dropped on page/filter change).
 * The "Columns" menu controls which columns are shown (+ their order) and persists that as a named
 * per-user saved view; shown columns are also what search matches. Rows order by the sort key.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  Building2,
  Check,
  ChevronDown,
  Columns3,
  CreditCard,
  Fingerprint,
  GripVertical,
  Hospital,
  Layers,
  Lock,
  RotateCcw,
  Save,
  Search,
  Star,
  Stethoscope,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ControlSelect, Pager, useColumnDnD } from '@/components/data-grid';
import { PHI_MASK } from '@/lib/phi';
import {
  loadCmdReport,
  loadCmdSearchSummary,
  loadCmdExplorerFacilities,
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
  type GridViewRow,
} from '@/lib/actions';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../../src/collections/cmdExplorer';
import type { DashboardView } from '@/lib/views';

type ColKey =
  | keyof Omit<CmdExplorerRow, 'id' | 'ingested_at'>
  | 'patient_name'
  | 'member_id_raw'
  | 'group_number';

const COLUMNS: readonly { key: ColKey; label: string; phi: boolean; numeric: boolean }[] = [
  { key: 'charge_date', label: 'Charge From Date', phi: false, numeric: false },
  { key: 'payment_received', label: 'Payment Received', phi: false, numeric: false },
  { key: 'cpt_code', label: 'CPT Code', phi: false, numeric: false },
  { key: 'revenue_code', label: 'Revenue Code', phi: false, numeric: false },
  { key: 'facility', label: 'Facility', phi: false, numeric: false },
  { key: 'patient_name', label: 'Patient Name', phi: true, numeric: false },
  { key: 'member_id_raw', label: 'Member ID', phi: true, numeric: false },
  { key: 'group_number', label: 'Group Number', phi: true, numeric: false },
  { key: 'charge_amount', label: 'Charge Amount', phi: false, numeric: true },
  { key: 'allowed_amount', label: 'Allowed Amount', phi: false, numeric: true },
  { key: 'pct_allowed', label: '% Allowed', phi: false, numeric: true },
  { key: 'insurance_payments', label: 'Insurance Payments', phi: false, numeric: true },
  { key: 'pct_paid', label: '% Paid', phi: false, numeric: true },
  { key: 'adjustments', label: 'Adjustments', phi: false, numeric: true },
  { key: 'patient_balance_due', label: 'Patient Balance Due', phi: false, numeric: true },
  { key: 'primary_payer', label: 'Primary Payer', phi: false, numeric: false },
];
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const IS_PHI = new Set<string>(COLUMNS.filter((c) => c.phi).map((c) => c.key));
const IS_NUMERIC = new Set<string>(COLUMNS.filter((c) => c.numeric).map((c) => c.key));
const DEFAULT_ORDER: ColKey[] = COLUMNS.map((c) => c.key);
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

// Search scope FOLLOWS the visible columns — one unified "columns" concept, no separate search-scope
// picker. The free-text term matches the SEARCHABLE columns currently shown: non-PHI (the 3 PHI
// columns are encrypted bytea and can't be substring-searched — the gated Patient lookup handles
// those) and non-percent (the pct_* ratios aren't in the server's search allowlist). This set mirrors
// the server's CMD_EXPLORER_SEARCH_COLUMNS exactly; the server independently re-enforces it.
const SEARCHABLE_KEYS = new Set<string>(
  COLUMNS.filter((c) => !c.phi && !IS_PERCENT.has(c.key)).map((c) => c.key),
);

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

type SummaryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: CmdSearchSummary };

export function CmdCollectionsExplorer({
  view,
  canRevealPhi,
}: {
  view: DashboardView;
  canRevealPhi: boolean;
}) {
  const [rows, setRows] = useState<CmdExplorerRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');

  // Smart search. `searchInput` is the raw box; `term` is its debounced value (drives fetches).
  // The term matches the SEARCHABLE columns that are currently SHOWN (see `searchCols`, derived from
  // `order` below) — there is no separate search-scope picker. `refinement` is an exact filter
  // applied by clicking a summary chip. Month/Year window is retained.
  const [searchInput, setSearchInput] = useState('');
  const term = useDebouncedValue(searchInput, 350);
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const [year, setYear] = useState(YEAR_OPTIONS[0]!);
  const [month, setMonth] = useState(0); // 0 = All months
  // Recency quick-filter: 0 = off (default — the grid still shows ALL months, an additive control,
  // not a changed default), or a rolling window of 7/14/30 days. Mutually exclusive with Month/Year.
  const [recencyDays, setRecencyDays] = useState(0);

  // Facility multi-select. Empty selection = ALL facilities (no restriction), NOT zero rows. Options
  // are tenant-scoped (loaded per view); the selection is tenant-specific, so it resets on view change.
  const [facilityOptions, setFacilityOptions] = useState<CmdFacilityOption[]>([]);
  const [facilitySelection, setFacilitySelection] = useState<string[]>([]);
  const [facilityPickerOpen, setFacilityPickerOpen] = useState(false);

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

  const [summary, setSummary] = useState<SummaryState>({ kind: 'idle' });

  // A facility/payer refinement AND the facility multi-select are tenant-specific; a term is generic.
  // Reset both when the view (tenant) changes so a stale drill-down / facility set doesn't filter the
  // new tenant to zero rows. (React "adjust state on prop change" — runs once before the reload effect.)
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    setPrevView(view);
    setRefinement(null);
    setFacilitySelection([]);
  }

  // Server-side sort. Default: most-recent Payment Received first.
  const [sort, setSort] = useState<CmdExplorerSort>({ column: 'payment_received', direction: 'desc' });

  // Keyset pagination: cursors[p] is the cursor used to fetch page p (cursors[0] = null).
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(CmdExplorerCursor | null)[]>([null]);
  const [hasNext, setHasNext] = useState(false);

  // VISIBLE columns, in display order (membership = visibility). Starts as all columns; a saved
  // default view (if any) overrides it on mount. Reorder by dragging headers; toggle visibility in
  // the "Columns" menu. Persisted per-user as a named view via the server actions below.
  const [order, setOrder] = useState<ColKey[]>([...DEFAULT_ORDER]);
  const dnd = useColumnDnD(order, (next) => setOrder(next as ColKey[]));

  // Per-user saved column views (server-side, private). Loaded once on mount; the caller's default
  // view (if one exists) sets the initial layout, else all columns (DEFAULT_ORDER).
  const [views, setViews] = useState<GridViewRow[]>([]);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const defaultViewAppliedRef = useRef(false);

  // PHI for the current page, revealed in bulk (memory only; cleared on page/filter change).
  const [phi, setPhi] = useState<Map<number, CmdExplorerPhi>>(() => new Map());
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  // Guards against out-of-order page responses (fast Prev/Next clicks).
  const reqRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // Search scope FOLLOWS visibility: the term matches the searchable columns currently shown (in
  // display order). Hiding a column removes it from search too; there is one "columns" concept.
  const searchCols = order.filter((k) => SEARCHABLE_KEYS.has(k));
  const hasSearch = term.trim() !== '' && searchCols.length > 0;
  const hasAnySearch = hasSearch || hasPhiSearch;
  // Stable dep keys for the sets (array identity changes on every toggle otherwise).
  const searchColsKey = searchCols.join(',');
  const facilityKey = facilitySelection.join(''); // control char can't appear in a facility name

  // Load the tenant-scoped facility options for the multi-select whenever the view changes.
  useEffect(() => {
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

  const refreshViews = useCallback(async () => {
    const r = await listGridViews();
    if (r.ok) setViews(r.views);
  }, []);

  // Load the caller's saved views ONCE on mount; apply their default layout if one exists (guarded so
  // it never clobbers a manual column edit the user makes before/after the fetch resolves). Views are
  // per-USER, not per-tenant-view, so this does NOT depend on `view` and runs a single time.
  useEffect(() => {
    let live = true;
    listGridViews()
      .then((r) => {
        if (!live || !r.ok) return;
        setViews(r.views);
        if (!defaultViewAppliedRef.current) {
          defaultViewAppliedRef.current = true;
          const def = r.views.find((v) => v.isDefault);
          if (def) {
            const known = def.columns.filter((c): c is ColKey => (DEFAULT_ORDER as string[]).includes(c));
            if (known.length > 0) setOrder(known);
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
      q?: string;
      searchColumns?: string[];
      facility?: string[];
      primary_payer?: string;
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
    if (hasSearch) {
      f.q = term.trim();
      f.searchColumns = searchCols;
    }
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
  }, [term, searchColsKey, hasSearch, recencyDays, month, month > 0 ? year : 0, facilityKey, refinement, hasPhiSearch, dMember, dAlpha, dGroup]);

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

  // (Re)load the first page whenever the filter OR sort changes (resets keyset pagination).
  useEffect(() => {
    setCursors([null]);
    void loadPage(0, null, filterArg, sort);
  }, [filterArg, sort, loadPage]);

  // Fetch the aggregate search summary whenever the (debounced) term / columns / window change.
  // Skipped entirely when there's no active search. The summary reflects the SEARCH level (term +
  // window), NOT the chip refinement — so the chips stay a stable facet navigator while drilling.
  useEffect(() => {
    if (!hasAnySearch) {
      setSummary({ kind: 'idle' });
      return;
    }
    let live = true;
    setSummary({ kind: 'loading' });
    const f: {
      q?: string;
      searchColumns?: string[];
      year?: number;
      month?: number;
      recencyDays?: number;
      facility?: string[];
      phiSearch?: { memberId?: string; alphaPrefix?: string; groupNumber?: string };
    } = {};
    if (hasSearch) {
      f.q = term.trim();
      f.searchColumns = searchCols;
    }
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
        if (!live) return;
        setSummary(r.ok ? { kind: 'ready', data: r.summary } : { kind: 'error' });
      })
      .catch(() => {
        if (live) setSummary({ kind: 'error' });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, searchColsKey, hasSearch, hasPhiSearch, dMember, dAlpha, dGroup, recencyDays, month, month > 0 ? year : 0, facilityKey, view]);

  const busy = status === 'loading';

  function moveColumn(key: ColKey, dir: 'left' | 'right') {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = dir === 'left' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function toggleSort(key: CmdExplorerSort['column']) {
    setSort((prev) =>
      prev.column === key
        ? { column: key, direction: prev.direction === 'desc' ? 'asc' : 'desc' }
        : { column: key, direction: 'desc' },
    );
  }

  // --- column visibility + saved views --------------------------------------
  // Toggle a column's VISIBILITY: hidden → append (shows rightmost); visible → remove. Never remove
  // the last visible column (a zero-column grid is broken).
  function toggleColumnVisible(key: ColKey) {
    setOrder((prev) => {
      if (prev.includes(key)) return prev.length <= 1 ? prev : prev.filter((k) => k !== key);
      return [...prev, key];
    });
  }
  function resetColumns() {
    setOrder([...DEFAULT_ORDER]);
  }
  /** Apply a saved view's layout — keep only still-known columns, in the saved order. */
  function applyView(cols: string[]) {
    const known = cols.filter((c): c is ColKey => (DEFAULT_ORDER as string[]).includes(c));
    setOrder(known.length > 0 ? known : [...DEFAULT_ORDER]);
  }
  /** Save the CURRENT visible-column layout as a named view (create/overwrite by name). */
  async function handleSaveView(name: string, makeDefault: boolean): Promise<GridViewMutationOutcome> {
    const res = await saveGridView(name, order as string[], makeDefault);
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

  // --- facility multi-select handlers ---------------------------------------
  function toggleFacility(value: string) {
    setFacilitySelection((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }
  function selectAllFacilities() {
    setFacilitySelection(facilityOptions.map((o) => o.facility));
  }
  function clearFacilities() {
    setFacilitySelection([]);
  }
  /**
   * Add every facility in a care-setting group to the selection (union — composes with other
   * groups). A facility classified 'BOTH' matches BOTH the IP and OP groups, mirroring migration
   * 0035's chart semantics. Facilities with no care_setting (Unclassified) join no group.
   */
  function selectCareSettingGroup(cs: 'IP' | 'OP') {
    const matches = facilityOptions
      .filter((o) => o.care_setting === cs || o.care_setting === 'BOTH')
      .map((o) => o.facility);
    setFacilitySelection((prev) => [...new Set([...prev, ...matches])]);
  }

  /** Pick a rolling recency window (toggle off if re-clicked); clears any Month/Year selection. */
  function selectRecency(days: number) {
    setRecencyDays((prev) => (prev === days ? 0 : days));
    setMonth(0);
  }

  /** Apply (or toggle off) a single-field drill-down refinement from a summary chip. */
  function applyRefinement(kind: RefineKind, value: string) {
    setRefinement((prev) =>
      prev && prev.kind === kind && 'value' in prev && prev.value === value ? null : { kind, value },
    );
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

  async function toggleRevealAll() {
    if (revealed) {
      setRevealed(false);
      return;
    }
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
  }

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

  return (
    <div className="space-y-4">
      {/* ---- Search hero -------------------------------------------------- */}
      <div className="rounded-xl border border-line bg-card p-4 shadow-ths">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search box — grows to fill the row. */}
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400" aria-hidden />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search collections — facility, CPT, payer, amount, date…"
              aria-label="Search collections"
              maxLength={120}
              className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-ink900 outline-none transition-colors placeholder:text-ink400 focus:border-[var(--brand-accent)] focus:ring-2 focus:ring-[var(--brand-accent)]/25"
            />
          </div>

          {/* Facility multi-select — scopes WHICH facilities' rows show. Empty = all facilities. */}
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={facilityPickerOpen}
              aria-haspopup="true"
              onClick={() => setFacilityPickerOpen((o) => !o)}
            >
              <Hospital className="h-4 w-4" />
              Facilities
              <span className="ml-1 rounded-full bg-[var(--brand-soft)] px-1.5 text-[11px] font-semibold text-[var(--brand-ink)]">
                {facilitySelection.length === 0 ? 'All' : facilitySelection.length}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
            </Button>
            {facilityPickerOpen && (
              <FacilityFilter
                options={facilityOptions}
                selected={facilitySelection}
                onToggle={toggleFacility}
                onSelectAll={selectAllFacilities}
                onClear={clearFacilities}
                onSelectGroup={selectCareSettingGroup}
                onClose={() => setFacilityPickerOpen(false)}
              />
            )}
          </div>

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

          {/* Recency quick-filters (Derek's "past 7/14/30 days" ask). ADDITIVE: the default window is
              still All months — these are one-click shortcuts, not a changed default. Picking one
              clears Month/Year; re-clicking toggles it off (back to All months). */}
          <div className="flex items-center gap-1" role="group" aria-label="Recency quick filters">
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
                    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'border-[var(--brand-accent)] bg-[var(--brand-soft)] text-[var(--brand-ink)]'
                      : 'border-line text-muted-foreground hover:bg-[var(--brand-soft)]',
                  ].join(' ')}
                >
                  {d}d
                </button>
              );
            })}
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
              ? `${hasSearch ? `Searching ${searchCols.length} shown column${searchCols.length === 1 ? '' : 's'}` : 'Patient lookup'} · ${facilityLabel} · ${windowLabel}`
              : `Browsing ${facilityLabel} · ${windowLabel} — type to search`}
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
          label={hasSearch ? `“${term.trim()}”` : 'your search'}
          refinement={refinement}
          onDrill={applyRefinement}
          onDrillCombo={applyComboRefinement}
        />
      )}

      {/* ---- Detail grid -------------------------------------------------- */}
      <div ref={gridRef} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {hasAnySearch ? 'Matching charge lines' : 'Charge lines'} · {rows.length.toLocaleString()} on this page
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
              >
                <Columns3 className="h-4 w-4" />
                Columns
                <span className="ml-1 rounded-full bg-[var(--brand-soft)] px-1.5 text-[11px] font-semibold text-[var(--brand-ink)]">
                  {order.length}/{COLUMNS.length}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
              </Button>
              {columnsMenuOpen && (
                <ColumnViewManager
                  order={order}
                  views={views}
                  onToggleColumn={toggleColumnVisible}
                  onReset={resetColumns}
                  onLoadView={(v) => applyView(v.columns)}
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
                aria-pressed={revealed}
                onClick={() => void toggleRevealAll()}
                className={revealed ? 'border-[var(--brand-accent)] text-[var(--brand-ink)]' : undefined}
              >
                {revealing ? 'Revealing…' : revealed ? 'Hide identifiers' : 'Reveal all'}
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
          <p className="text-sm text-muted-foreground">Loading collections…</p>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {hasAnySearch ? 'No charge lines match this search.' : 'No charge lines match the current filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {order.map((c) => {
                    const dragging = dnd.draggingKey === c;
                    const isTarget = dnd.dropTargetKey === c && dnd.draggingKey !== c;
                    const sortable = SORTABLE_KEYS.has(c);
                    const isSorted = sort.column === c;
                    return (
                      <TableHead
                        key={c}
                        {...dnd.itemProps(c)}
                        aria-grabbed={dragging}
                        aria-sort={
                          isSorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                        }
                        title="Drag to reorder"
                        className={[
                          'cursor-grab select-none border-l-2 active:cursor-grabbing',
                          IS_NUMERIC.has(c) ? 'text-right' : '',
                          isSorted ? 'text-[var(--brand-ink)]' : '',
                          isTarget ? 'border-l-[var(--brand-accent)]' : 'border-l-transparent',
                          dragging ? 'opacity-50' : '',
                        ].join(' ')}
                      >
                        <span className={`inline-flex items-center gap-1 ${IS_NUMERIC.has(c) ? 'flex-row-reverse' : ''}`}>
                          <button
                            type="button"
                            aria-label={`Reorder ${COLUMN_LABEL[c] ?? c}`}
                            onKeyDown={(e) => {
                              if (e.key === 'ArrowLeft') {
                                e.preventDefault();
                                moveColumn(c, 'left');
                              } else if (e.key === 'ArrowRight') {
                                e.preventDefault();
                                moveColumn(c, 'right');
                              }
                            }}
                            className="shrink-0 cursor-grab text-ink400 active:cursor-grabbing"
                          >
                            <GripVertical className="h-3 w-3" aria-hidden />
                          </button>
                          {sortable ? (
                            <button
                              type="button"
                              draggable={false}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSort(c as CmdExplorerSort['column']);
                              }}
                              aria-label={`Sort by ${COLUMN_LABEL[c] ?? c}`}
                              className="inline-flex cursor-pointer items-center gap-1 hover:text-[var(--brand-ink)]"
                            >
                              {COLUMN_LABEL[c] ?? c}
                              {isSorted ? (
                                sort.direction === 'asc' ? (
                                  <ArrowUp className="h-3 w-3" aria-hidden />
                                ) : (
                                  <ArrowDown className="h-3 w-3" aria-hidden />
                                )
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                              )}
                            </button>
                          ) : (
                            (COLUMN_LABEL[c] ?? c)
                          )}
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className="transition-colors hover:bg-[var(--brand-soft)]">
                    {order.map((c) => (
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
          </div>
        )}

        <Pager
          page={page + 1}
          hasPrev={page > 0}
          hasNext={hasNext}
          disabled={busy}
          onPrev={() => {
            if (page > 0) void loadPage(page - 1, cursors[page - 1] ?? null, filterArg, sort);
          }}
          onNext={() => {
            if (hasNext) void loadPage(page + 1, cursors[page + 1] ?? null, filterArg, sort);
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
function FacilityFilter({
  options,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onSelectGroup,
  onClose,
}: {
  options: CmdFacilityOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSelectGroup: (cs: 'IP' | 'OP') => void;
  onClose: () => void;
}) {
  const selectedSet = new Set(selected);
  const hasIp = options.some((o) => o.care_setting === 'IP' || o.care_setting === 'BOTH');
  const hasOp = options.some((o) => o.care_setting === 'OP' || o.care_setting === 'BOTH');
  return (
    <>
      <button
        type="button"
        aria-label="Close facility filter"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Filter by facility"
        className="absolute left-0 top-full z-50 mt-2 w-80 rounded-lg border border-line bg-surface p-3 shadow-ths"
      >
        <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Show facilities</span>
          <span className="font-normal normal-case">
            {selected.length === 0 ? 'All facilities' : `${selected.length} selected`}
          </span>
        </div>
        {selected.length === 0 && (
          <p className="mb-2 text-[11px] text-ink400">
            No filter — showing every facility. Check any below to narrow.
          </p>
        )}

        <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={options.length === 0}
            className="rounded-md border border-line px-2 py-0.5 text-xs text-ink900 transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-40"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={selected.length === 0}
            className="rounded-md border border-line px-2 py-0.5 text-xs text-ink900 transition-colors hover:bg-[var(--brand-soft)] disabled:opacity-40"
          >
            Clear
          </button>
          {hasIp && (
            <button
              type="button"
              onClick={() => onSelectGroup('IP')}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-ink900 transition-colors hover:bg-[var(--brand-soft)]"
            >
              + All IP
            </button>
          )}
          {hasOp && (
            <button
              type="button"
              onClick={() => onSelectGroup('OP')}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-ink900 transition-colors hover:bg-[var(--brand-soft)]"
            >
              + All OP
            </button>
          )}
        </div>

        {options.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No facilities available.</p>
        ) : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {options.map((o) => (
              <label
                key={o.facility}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink900 hover:bg-[var(--brand-soft)]"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(o.facility)}
                  onChange={() => onToggle(o.facility)}
                  className="h-4 w-4 shrink-0 accent-[var(--brand-accent)]"
                />
                <span className="flex-1 truncate">{o.facility_name ?? o.facility}</span>
                <span
                  className={[
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    o.care_setting
                      ? 'bg-[var(--brand-soft)] text-[var(--brand-ink)]'
                      : 'text-ink400',
                  ].join(' ')}
                >
                  {o.care_setting ?? 'Other'}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Column layout + saved-views manager — the "Columns" popover. A two-section manager (top = which
 * columns are VISIBLE + reset; bottom = the user's private saved layouts, with load / set-default /
 * delete / save-current), living on the grid toolbar. This is the SINGLE columns control: the shown
 * columns are both what the grid displays AND (for the searchable ones) what the search term matches.
 */
function ColumnViewManager({
  order,
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
  views: GridViewRow[];
  onToggleColumn: (key: ColKey) => void;
  onReset: () => void;
  onLoadView: (v: GridViewRow) => void;
  onSaveView: (name: string, makeDefault: boolean) => Promise<GridViewMutationOutcome>;
  onSetDefault: (name: string) => void | Promise<void>;
  onDeleteView: (name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const visible = new Set<string>(order);
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
        className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-line bg-surface p-3 shadow-ths"
      >
        {/* Section 1 — visibility */}
        <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Visible columns</span>
          <span className="font-normal normal-case">{order.length} of {COLUMNS.length}</span>
        </div>
        <p className="mb-1.5 text-[11px] text-ink400">Shown columns are also what search matches.</p>
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {COLUMNS.map((c) => {
            const shown = visible.has(c.key);
            const isLastVisible = shown && order.length <= 1;
            return (
              <label
                key={c.key}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink900 ${
                  isLastVisible ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--brand-soft)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={shown}
                  disabled={isLastVisible}
                  onChange={() => onToggleColumn(c.key)}
                  className="h-4 w-4 accent-[var(--brand-accent)]"
                />
                <span className="flex-1 truncate">{c.label}</span>
                {c.phi && <Lock className="h-3 w-3 shrink-0 text-ink400" aria-hidden />}
              </label>
            );
          })}
        </div>
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
}: {
  title: string;
  icon: React.ReactNode;
  kind: RefineKind;
  groups: CmdSearchGroup[];
  activeValue: string | null;
  onDrill: (kind: RefineKind, value: string) => void;
}) {
  if (groups.length === 0) return null;
  const max = Math.max(...groups.map((g) => g.charge), 1);
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">
        {groups.map((g) => {
          const label = g.label ?? '(blank)';
          // A NULL/blank value can't be exact-matched through the filter, so it's shown as a
          // non-interactive stat rather than a drill link that would silently no-op.
          const drillable = g.label !== null && g.label !== '';
          const active = drillable && activeValue === g.label;
          const pct = Math.max(2, Math.round((g.charge / max) * 100));
          const stats = (
            <span className="relative flex items-center justify-between gap-2">
              <span className="truncate text-ink900">{label}</span>
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
}: {
  state: SummaryState;
  label: string;
  refinement: Refinement | null;
  onDrill: (kind: RefineKind, value: string) => void;
  onDrillCombo: (cpt: string, revenue: string) => void;
}) {
  if (state.kind === 'loading') {
    return (
      <div className="rounded-xl border border-line bg-card p-4 text-sm text-muted-foreground shadow-ths">
        Searching…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        The search summary could not be loaded.
      </div>
    );
  }
  if (state.kind === 'idle') return null;

  const s = state.data;
  if (s.total_count === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-6 text-center text-sm text-muted-foreground shadow-ths">
        No charge lines match {label}. Try a different term or add columns to search.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-ths">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink900">
          <span className="tabular-nums">{s.total_count.toLocaleString()}</span> charge line
          {s.total_count === 1 ? '' : 's'} match {label}
        </h3>
        <span className="text-xs text-muted-foreground">Click a facility, payer, CPT, or CPT×Rev combo to drill in.</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile label="Charged" value={MONEY0.format(s.total_charge)} />
        <StatTile label="Insurance Paid" value={MONEY0.format(s.total_paid)} />
        <StatTile label="Patient Balance" value={MONEY0.format(s.total_balance)} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <DrillList
          title="Top facilities"
          icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
          kind="facility"
          groups={s.by_facility}
          activeValue={refinement?.kind === 'facility' ? refinement.value : null}
          onDrill={onDrill}
        />
        <DrillList
          title="Top payers"
          icon={<CreditCard className="h-3.5 w-3.5" aria-hidden />}
          kind="primary_payer"
          groups={s.by_payer}
          activeValue={refinement?.kind === 'primary_payer' ? refinement.value : null}
          onDrill={onDrill}
        />
        <DrillList
          title="Top CPT codes"
          icon={<Stethoscope className="h-3.5 w-3.5" aria-hidden />}
          kind="cpt_code"
          groups={s.by_cpt}
          activeValue={refinement?.kind === 'cpt_code' ? refinement.value : null}
          onDrill={onDrill}
        />
      </div>

      {/* Fourth list, full-width: the (CPT × Revenue-code) combination with dollar-weighted
          %-allowed / %-paid — one click drills the grid by BOTH codes at once. */}
      <ComboDrillList
        groups={s.by_combo}
        activeCombo={refinement?.kind === 'combo' ? { cpt: refinement.cpt, revenue: refinement.revenue } : null}
        onDrill={onDrillCombo}
      />
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
}: {
  groups: CmdComboGroup[];
  activeCombo: { cpt: string; revenue: string } | null;
  onDrill: (cpt: string, revenue: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface p-3">
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
              <th className="px-2 py-1 text-right font-medium">% Allowed</th>
              <th className="px-2 py-1 text-right font-medium">% Paid</th>
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
