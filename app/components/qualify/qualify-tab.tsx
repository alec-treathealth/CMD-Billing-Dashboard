'use client';

/**
 * Qualify tab — the redesigned interactive container (overview-first, autosearch; the approved comp
 * is docs/mockups/qualify-redesign-mockup.html). Owns search/window/lens/reveal/URL state and is the
 * caller of the Qualify Server Actions (the browser's sole data path). It hands plain, already-shaped
 * data to the pure presentational children (BookKpiTiles, HeatingUpCards, FacilityPanel, CasesTable,
 * CohortSheet, VobModal).
 *
 * STRUCTURE (top → bottom): finder (search-type tabs · autosearch input · window control · LOC lens ·
 * global-reveal toggle) → Facilities Heating Up (trend cards + sparklines) → book KPI tiles → the
 * resolved subject band (hero) → FacilityPanel + CasesTable grid.
 *
 * SEARCH TYPES: Member ID/Prefix (server-side sniff — the client never declares the kind) · Client
 * Name (Change C — the exact-name blind-index path; captioned "may match multiple patients") ·
 * Employer (the existing QualifyMarket.employers narrow — a filter, not a resolver, per ruling). The
 * Facility "payer board" tab is DE-SCOPED (later phase). AUTOSEARCH: debounced ~380ms at ≥3 chars +
 * Enter; no "Resolve payer" button. The raw term stays in memory only — never a URL, never a log.
 *
 * CHANGE E (facility drilldown): a search-driven resolve lands payer-wide (full facility list; cases
 * seeded to the Fix-A landing or rank-1). A facility-row click or a Heating-Up card click SCOPES the
 * surface to that facility (the panel pins the selected card + "× All facilities" clears). Heating-Up
 * click = the HYBRID: resolve the card's dominant payer AND scope to the card's facility. A window
 * change RESETS scope to payer-wide (ruling). All case sets are SERVER-scoped via
 * getQualifyFacilityCases (no client-side filtering over a global list). When the resolving search was
 * an IDENTIFIER (prefix / member id / client name), that identifier narrow is carried into the drill as
 * a server-side `filter` — so Recent Claims shows only matching claims, on the seed AND every facility
 * switch (ruling 5). The raw term lives only in an in-memory ref (never state / URL / log).
 *
 * CHANGE B (global persistent reveal): super_admin/admin (derived as canRevealPhi &&
 * viewerHasAmountsCapability — exactly those two roles) get a surface-wide "Reveal identifiers"
 * switch. UI-state-only persistence (in-memory; NEVER localStorage): each scope's newly-loaded rows
 * still fire the SAME audited revealQualifyRows path (chunked to the 50 batch cap) — the toggle
 * changes when we re-reveal, not whether we audit (audit volume rises by design; accepted).
 * admissions_seat keeps the per-patient reveal unchanged and still sees zero dollars.
 *
 * CHANGE D (LOC lens): ONE segmented IP·OP·Both lens on the bar scopes the Heating-Up cards, the
 * facility list, AND the case rows (inclusive semantics via the shared groupClaims helpers) —
 * client-side view filter (ruled v1); the KPI tiles stay book-wide and caption it.
 *
 * CHANGE F (URL state): payer/facility/window/loc survive refresh + are shareable — router.replace on
 * resolved-state change only, via the allowlist-enforcing urlState.ts (PHI never in URLs; a shared
 * link re-resolves by payer label, never a replayed search term).
 *
 * RACE GUARDS (unchanged from the pre-redesign container — they are the correctness core): genRef
 * recency on every resolution, cohortKey identity on standalone cases fetches, atomic
 * snapshot+seed commits (one paint), marketRef for the VOB narrows, per-patient reveal cache keyed by
 * claim id with in-flight tracking.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Eye, EyeOff, Landmark, RotateCcw, Search } from 'lucide-react';
import {
  getQualifySnapshot,
  getQualifySnapshotByPayer,
  getQualifySnapshotByName,
  getQualifyFacilityCases,
  getQualifyPatientCohort,
  getQualifyOverview,
  revealQualifyRows,
} from '@/lib/qualify/actions';
import {
  QUALIFY_CLIENT_NAME_ENABLED,
  QUALIFY_REVEAL_BATCH_CAP,
  qualifyWindowLabel,
  serializeQualifyWindow,
  sniffQualifyKind,
  trailingWindow,
  type QualifyBookKpis,
  type QualifyClaim,
  type QualifyFacilityTrend,
  type QualifyMarket,
  type QualifyPhi,
  type QualifyPatientCohort,
  type QualifySnapshot,
  type QualifyWindow,
} from '@/lib/qualify/contract';
import type { CmdEmployerOption } from '@/lib/actions';
import { loadQualifyEmployers } from '@/lib/qualify/actions';
import { MultiSelectTagPicker, type PickerOption } from '@/components/ui/multi-select-tag-picker';
import { cohortReducer, cohortKey, INITIAL_COHORT, type QualifyCohort } from '@/lib/qualify/qualifyCohort';
import { isIdentifierEmpty, identifierEmptyTerm } from '@/lib/qualify/qualifyGuards';
import { buildQualifySearchParams, parseQualifySearchParams } from '@/lib/qualify/urlState';
import { buildFacilityBucketMap } from '@/components/qualify/colors';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { filterFacilitiesByLoc, filterClaimsByLoc, type QualifyLocFilter } from '@/lib/qualify/groupClaims';
import { CasesTable } from '@/components/qualify/cases-table';
import { CohortSheet } from '@/components/qualify/cohort-sheet';
import { BookKpiTiles, HeatingUpCards, HeatingUpSkeleton } from '@/components/qualify/overview';
import { WindowControl } from '@/components/qualify/window-control';
import { VobModal } from '@/components/qualify/vob-modal';

const MIN_QUERY_LEN = 3;
const AUTOSEARCH_DEBOUNCE_MS = 380;

type SearchType = 'id' | 'client' | 'employer';

const SEARCH_TABS: { key: SearchType; label: string }[] = [
  { key: 'id', label: 'Member ID / Prefix' },
  // Client Name is data-gated (QUALIFY_CLIENT_NAME_ENABLED) — hidden until 0067 + the name backfill land.
  ...(QUALIFY_CLIENT_NAME_ENABLED ? [{ key: 'client' as const, label: 'Client Name' }] : []),
  { key: 'employer', label: 'Employer' },
];

const PLACEHOLDER: Record<Exclude<SearchType, 'employer'>, string> = {
  id: 'Member ID or 3-letter alpha prefix — resolves as you type',
  client: 'Client name (exact) — resolves as you type · audited',
};

/** windowStart (inclusive) .. windowEnd (EXCLUSIVE) → "Jun 18 – Jul 17, 2026" (inclusive last day). */
function formatWindowRange(startIso: string, endExclusiveIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const endIncl = new Date(new Date(`${endExclusiveIso}T00:00:00Z`).getTime() - 86_400_000);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mo(start)} ${start.getUTCDate()} – ${mo(endIncl)} ${endIncl.getUTCDate()}, ${endIncl.getUTCFullYear()}`;
}

/** The whole-window cases set fetched for a facility (seed) — what both resolve paths + a facility
 *  switch write. `capped` = truncated at QUALIFY_CASES_MAX (drives the "narrow the window" nudge). */
type CasesPage = { claims: QualifyClaim[]; capped: boolean };
const EMPTY_PAGE: CasesPage = { claims: [], capped: false };

export function QualifyTab({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const router = useRouter();
  const [searchType, setSearchType] = useState<SearchType>('id');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [isPending, startTransition] = useTransition();
  // Overview strip (book KPIs + trend cards) — window/market-tracked, independent of the subject.
  const [kpis, setKpis] = useState<QualifyBookKpis | null>(null);
  const [trends, setTrends] = useState<QualifyFacilityTrend[]>([]);
  // The cases panel's atomic COHORT (payer/facility/window), reducer-owned (identity guards intact).
  const [cohort, dispatch] = useReducer(cohortReducer, INITIAL_COHORT);
  const cohortRef = useRef(cohort);
  cohortRef.current = cohort;
  const apply = useCallback((action: Parameters<typeof cohortReducer>[1]): QualifyCohort => {
    const next = cohortReducer(cohortRef.current, action);
    // Sync the ref IMMEDIATELY (not just at render): two same-tick applies (e.g. the Change-E hybrid's
    // RESOLVE_PAYER → SWITCH_FACILITY) must each see the prior one's result, or the second computes
    // from a stale cohort and the drill fetches under the WRONG payer.
    cohortRef.current = next;
    dispatch(action);
    return next;
  }, []);
  const [facilityCases, setFacilityCases] = useState<QualifyClaim[]>([]);
  const [capped, setCapped] = useState(false);
  const [isFacilityPending, startFacilityTransition] = useTransition();
  // Change E: facility-SCOPED mode (panel pins the selected card). Payer-wide keeps the full list.
  const [scoped, setScoped] = useState(false);
  // Change D: the ONE LOC lens (bar-level, view-only v1) — scopes trends + facilities + case rows.
  const [locFilter, setLocFilter] = useState<QualifyLocFilter>(null);
  // Phase 3: the patient-cohort slide-over (masked label + fetched context). Null = closed.
  const [cohortSheet, setCohortSheet] = useState<{
    label: string;
    data: QualifyPatientCohort | null;
    loading: boolean;
  } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // Non-null when the CURRENT resolution came from the by-payer path (on-load hybrid, a Heating-Up
  // card, a URL restore) — a window change then re-resolves by payer. A manual search clears it.
  const [byPayer, setByPayer] = useState<string | null>(null);
  // VOB market narrows (employer/funding) — scope the ranking, the drill, the overview strip.
  const [employerSelection, setEmployerSelection] = useState<string[]>([]);
  const [fundingSelection, setFundingSelection] = useState<string[]>([]);
  const [employerOptions, setEmployerOptions] = useState<CmdEmployerOption[]>([]);
  const [employerLoading, setEmployerLoading] = useState(false);
  const [employerQuery, setEmployerQuery] = useState('');
  const [employerDisplay, setEmployerDisplay] = useState<Map<string, string>>(() => new Map());
  const market = useMemo<QualifyMarket | undefined>(() => {
    const m: QualifyMarket = {};
    if (employerSelection.length > 0) m.employers = employerSelection;
    if (fundingSelection.length > 0) m.funding = fundingSelection;
    return m.employers || m.funding ? m : undefined;
  }, [employerSelection, fundingSelection]);
  const marketRef = useRef(market);
  marketRef.current = market;
  const marketKey = `${employerSelection.join('\n')}|${fundingSelection.join('\n')}`;
  const [initializing, setInitializing] = useState(true);
  // PHI reveal cache (per-patient, audited) + the Change-B global toggle. In-memory ONLY.
  const [revealed, setRevealed] = useState<Map<number, QualifyPhi>>(() => new Map());
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;
  const [revealingKeys, setRevealingKeys] = useState<ReadonlySet<number>>(() => new Set());
  const [revealError, setRevealError] = useState<string | null>(null);
  const [globalReveal, setGlobalReveal] = useState(false);
  // Change B eligibility: canRevealPhi && amounts capability ⇔ super_admin/admin exactly
  // (admissions_seat is the one Q-A role without the amounts capability; 'user' lacks canRevealPhi).
  const canGlobalReveal = canRevealPhi && viewerHasAmountsCapability;
  // Resolution recency guard — every fetch entry point bumps-and-captures; every post-await write
  // checks it. A reveal CAPTURES (never bumps) so a stale reveal can't repopulate after a reset.
  const genRef = useRef(0);
  // The RESOLVED manual-search term + path (mirror of mobile's lastSearch). A window/market change
  // re-resolves from THIS, not the live input box — so editing the box after a resolve never leaves
  // a stale subject (review finding). Null on the by-payer / URL-restore path (byPayer drives those).
  const lastResolvedRef = useRef<{ term: string; type: 'id' | 'client' } | null>(null);
  // Fix 1 — the identifier narrow carried from the resolving search into the facility DRILL (ruling 5):
  // Recent Claims shows only claims matching the searched prefix/member/client name, on the seed AND
  // every facility switch. The RAW term lives ONLY here (in-memory ref) — never state, never a URL,
  // never a log; the server mints the blind index from it. Null on every non-identifier resolution
  // (resolve-by-payer, on-load hybrid, URL restore, clear). fetchSeed/fetchCases read it at call time —
  // same trust boundary as the term already sent to getQualifySnapshot.
  const activeFilterRef = useRef<{ prefix?: string } | { memberId?: string } | { clientName?: string } | null>(null);
  // Overview-strip recency guard — independent of genRef so a slow earlier window/market strip
  // response can't overwrite a newer one's KPI tiles + Heating-Up cards.
  const overviewGenRef = useRef(0);

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;
  const facilityBuckets = useMemo(() => buildFacilityBucketMap(snapshot?.facilities ?? []), [snapshot]);

  const resetReveal = useCallback(() => {
    setRevealed(new Map());
    setRevealingKeys(new Set());
    setRevealError(null);
  }, []);

  // ── data fetch helpers (all server-scoped; every commit is atomic) ────────────────────────────

  const fetchSeed = useCallback(
    async (payer: string, facility: string, w: QualifyWindow): Promise<CasesPage> => {
      const res = await getQualifyFacilityCases({
        payer,
        facility,
        window: w,
        market: marketRef.current,
        filter: activeFilterRef.current ?? undefined, // Fix 1: carry the resolving search's identifier narrow
      });
      return { claims: res.claims, capped: res.capped };
    },
    [],
  );

  // Standalone cases fetch for a facility switch (gen + cohortKey double-guarded).
  const fetchCases = useCallback(
    (c: QualifyCohort) => {
      const payer = c.payer;
      const facility = c.facility;
      if (!payer || !facility) return;
      const gen = ++genRef.current;
      const key = cohortKey(c);
      resetReveal();
      startFacilityTransition(async () => {
        try {
          const res = await getQualifyFacilityCases({
            payer,
            facility,
            window: c.window,
            market: marketRef.current,
            filter: activeFilterRef.current ?? undefined, // Fix 1: the identifier narrow persists across facility switches
          });
          if (genRef.current !== gen) return; // superseded (recency)
          if (cohortKey(cohortRef.current) !== key) return; // cohort changed underneath (identity)
          setFacilityCases(res.claims);
          setCapped(res.capped);
        } catch {
          if (genRef.current !== gen) return;
          if (cohortKey(cohortRef.current) !== key) return;
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [resetReveal],
  );

  const commitResolved = useCallback(
    (snap: QualifySnapshot, action: Parameters<typeof cohortReducer>[1], seed: CasesPage) => {
      setSnapshot(snap);
      apply(action);
      setFacilityCases(seed.claims);
      setCapped(seed.capped);
    },
    [apply],
  );

  /** Refresh the overview strip (KPIs + trend cards) for a window/market — resolve:false (strip only).
   *  Recency-guarded (overviewGenRef): an out-of-order earlier response can't overwrite newer tiles. */
  const refreshOverview = useCallback((w: QualifyWindow) => {
    const ogen = ++overviewGenRef.current;
    getQualifyOverview(w, marketRef.current, { resolve: false })
      .then((ov) => {
        if (overviewGenRef.current !== ogen) return; // superseded by a newer window/market strip fetch
        setKpis(ov.kpis);
        setTrends(ov.trends);
      })
      .catch(() => {
        /* strip refresh is non-blocking — stale tiles beat a broken search */
      });
  }, []);

  // Member-id / alpha-prefix search (server-side sniff). Lands payer-wide on the Fix-A landing facility.
  // `explicit` = an Enter/submit (vs a debounced autosearch keystroke): the VOB no-match modal opens
  // ONLY on an explicit submit, so it never pops mid-typing on every debounced intermediate term.
  const runSearch = useCallback(
    (rawQuery: string, w: QualifyWindow, explicit = false) => {
      const trimmed = rawQuery.trim();
      if (trimmed.length < MIN_QUERY_LEN) {
        setHint(`Enter at least a ${MIN_QUERY_LEN}-letter alpha prefix or a full member ID.`);
        return;
      }
      setHint(null);
      resetReveal();
      // Fix 1: carry this identifier into the drill (prefix vs exact member — the server sniffs the kind
      // on resolve, but the drill filter must be explicit). Raw term stays in this ref only.
      activeFilterRef.current = sniffQualifyKind(trimmed) === 'prefix' ? { prefix: trimmed } : { memberId: trimmed };
      const gen = ++genRef.current;
      startTransition(async () => {
        try {
          const snap = await getQualifySnapshot({ query: trimmed, window: w, market: marketRef.current });
          const payerName = snap.resolved?.payerName ?? null;
          const landing = snap.identifierLandingFacility;
          const seed = payerName && landing ? await fetchSeed(payerName, landing, w) : EMPTY_PAGE;
          if (genRef.current !== gen) return;
          commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: landing, window: w }, seed);
          setScoped(false); // a search lands payer-wide (Change E)
          setHasSearched(true);
          setByPayer(null);
          lastResolvedRef.current = { term: trimmed, type: 'id' }; // window/market re-resolve reads THIS
          if (snap.resolved === null) {
            setEcho(trimmed);
            if (explicit) setModalOpen(true); // never pop the full-screen modal on a debounced keystroke
          } else {
            setModalOpen(false);
          }
        } catch {
          if (genRef.current !== gen) return;
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [resetReveal, fetchSeed, commitResolved],
  );

  // Client-name search (Change C) — the exact-name blind-index path. Same landing flow; the raw name
  // never leaves this closure except as the action argument (HMAC'd at the server boundary).
  const runNameSearch = useCallback(
    (rawName: string, w: QualifyWindow, explicit = false) => {
      const trimmed = rawName.trim();
      if (trimmed.length < MIN_QUERY_LEN) {
        setHint('Enter at least 3 characters of the client name.');
        return;
      }
      setHint(null);
      resetReveal();
      activeFilterRef.current = { clientName: trimmed }; // Fix 1: carry the exact-name narrow into the drill
      const gen = ++genRef.current;
      startTransition(async () => {
        try {
          const snap = await getQualifySnapshotByName({ name: trimmed, window: w, market: marketRef.current });
          const payerName = snap.resolved?.payerName ?? null;
          const landing = snap.identifierLandingFacility;
          const seed = payerName && landing ? await fetchSeed(payerName, landing, w) : EMPTY_PAGE;
          if (genRef.current !== gen) return;
          commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: landing, window: w }, seed);
          setScoped(false);
          setHasSearched(true);
          setByPayer(null);
          lastResolvedRef.current = { term: trimmed, type: 'client' };
          if (snap.resolved === null) {
            setEcho(trimmed);
            if (explicit) setModalOpen(true);
          } else {
            setModalOpen(false);
          }
        } catch {
          if (genRef.current !== gen) return;
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [resetReveal, fetchSeed, commitResolved],
  );

  /**
   * Resolve by payer label (Heating-Up hybrid / URL restore / window re-resolve). `focusFacility`
   * (Change E) scopes to that facility WHEN it ranks under the payer this window (else rank-1
   * payer-wide — never a fabricated scope).
   */
  const resolveByPayer = useCallback(
    (payer: string, w: QualifyWindow, focusFacility: string | null = null) => {
      setHint(null);
      resetReveal();
      activeFilterRef.current = null; // Fix 1: by-payer resolutions are payer-wide (ruling 3) — no identifier narrow
      const gen = ++genRef.current;
      startTransition(async () => {
        try {
          const snap = await getQualifySnapshotByPayer({ payer, window: w, market: marketRef.current });
          const payerName = snap.resolved?.payerName ?? null;
          const ranked = focusFacility !== null && snap.facilities.some((f) => f.facilityKey === focusFacility);
          const facility = payerName ? (ranked ? focusFacility : snap.facilities[0]?.facilityKey ?? null) : null;
          const seed = payerName && facility ? await fetchSeed(payerName, facility, w) : EMPTY_PAGE;
          if (genRef.current !== gen) return;
          commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility, window: w }, seed);
          setScoped(ranked); // hybrid: scoped iff the clicked facility actually ranks here
          setHasSearched(true);
          setByPayer(payer);
          lastResolvedRef.current = null; // the by-payer path owns re-resolution now (not a stored term)
          setModalOpen(false);
        } catch {
          if (genRef.current !== gen) return;
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [resetReveal, fetchSeed, commitResolved],
  );

  // Window change: refresh the strip AND re-resolve the subject for the new window. Ruling (Change E):
  // a window change RESETS the facility scope back to payer-wide — cleared in the SAME resolve flow.
  const onWindow = (w: QualifyWindow) => {
    const prev = cohortRef.current;
    apply({ type: 'CHANGE_WINDOW', window: w });
    refreshOverview(w);
    if (!prev.payer) return;
    setScoped(false);
    // Re-resolve the ACTUAL resolved subject (byPayer, or the STORED search term) — never the live
    // input box, which the user may have edited since resolving (review finding).
    if (byPayer) {
      resolveByPayer(byPayer, w);
    } else if (lastResolvedRef.current) {
      const { term, type } = lastResolvedRef.current;
      if (type === 'client') runNameSearch(term, w);
      else runSearch(term, w);
    }
  };

  // Facility row click → server-scoped drill + pin (Change E). No-op on the already-selected row.
  const selectFacility = useCallback(
    (facilityKey: string) => {
      const c = cohortRef.current;
      if (!c.payer) return;
      if (facilityKey === c.facility) {
        setScoped(true); // clicking the selected row in list mode just pins it
        return;
      }
      setScoped(true);
      fetchCases(apply({ type: 'SWITCH_FACILITY', facility: facilityKey }));
    },
    [apply, fetchCases],
  );

  // "× All facilities" (Change E): back to payer-wide — full list + rank-1 seed, one server-scoped fetch.
  const clearFacilityScope = useCallback(() => {
    const c = cohortRef.current;
    setScoped(false);
    const rank1 = snapshot?.facilities[0]?.facilityKey ?? null;
    if (!c.payer || !rank1 || rank1 === c.facility) return;
    fetchCases(apply({ type: 'SWITCH_FACILITY', facility: rank1 }));
  }, [apply, fetchCases, snapshot]);

  // Heating-Up card click — the Change-E HYBRID: resolve the card's dominant payer AND scope to it.
  const openTrendCard = useCallback(
    (t: QualifyFacilityTrend) => {
      if (!t.dominantPayer) return;
      resolveByPayer(t.dominantPayer, cohortRef.current.window, t.facilityKey);
    },
    [resolveByPayer],
  );

  const clearSearch = useCallback(() => {
    genRef.current += 1;
    setQuery('');
    setHint(null);
    setEcho('');
    setModalOpen(false);
    setLocFilter(null);
    resetReveal();
    setSnapshot(null);
    setFacilityCases([]);
    setCapped(false);
    setHasSearched(false);
    setByPayer(null);
    lastResolvedRef.current = null;
    activeFilterRef.current = null; // Fix 1: drop the drill identifier narrow on clear
    setScoped(false);
    apply({ type: 'RESOLVE_PAYER', payer: null, facility: null, window: cohortRef.current.window });
  }, [apply, resetReveal]);

  const viewCohort = useCallback((claimId: number, label: string) => {
    const c = cohortRef.current;
    if (!c.payer || !c.facility) return;
    setCohortSheet({ label, data: null, loading: true });
    void (async () => {
      try {
        const res = await getQualifyPatientCohort({
          payer: c.payer!,
          facility: c.facility!,
          window: c.window,
          claimId,
        });
        setCohortSheet((cur) => (cur && cur.label === label ? { ...cur, data: res, loading: false } : cur));
      } catch {
        setCohortSheet(null);
        setHint('Qualify is unavailable right now. Please try again.');
      }
    })();
  }, []);

  // ── ON LOAD: URL restore (Change F) or the overview HYBRID (Change E) — one decision, one paint ──
  useEffect(() => {
    let alive = true;
    const url = parseQualifySearchParams(new URLSearchParams(globalThis.location?.search ?? ''));
    const w = url.window;
    if (cohortKey(cohortRef.current) !== cohortKey({ ...cohortRef.current, window: w })) {
      apply({ type: 'CHANGE_WINDOW', window: w });
    }
    if (url.loc) setLocFilter(url.loc);
    const gen = ++genRef.current;
    activeFilterRef.current = null; // Fix 1: on-load (URL restore + fresh hybrid) are both by-payer / payer-wide
    (async () => {
      try {
        if (url.payer) {
          // URL restore: strip (no hybrid resolve) + re-resolve via the NON-PHI payer path.
          const [ov, snap] = await Promise.all([
            getQualifyOverview(w, marketRef.current, { resolve: false }),
            getQualifySnapshotByPayer({ payer: url.payer, window: w, market: marketRef.current }),
          ]);
          if (!alive || genRef.current !== gen) return;
          setKpis(ov.kpis);
          setTrends(ov.trends);
          const payerName = snap.resolved?.payerName ?? null;
          const ranked = url.facility !== null && snap.facilities.some((f) => f.facilityKey === url.facility);
          const facility = payerName ? (ranked ? url.facility : snap.facilities[0]?.facilityKey ?? null) : null;
          const seed = payerName && facility ? await fetchSeed(payerName, facility, w) : EMPTY_PAGE;
          if (!alive || genRef.current !== gen) return;
          commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility, window: w }, seed);
          setScoped(ranked);
          setHasSearched(true);
          setByPayer(url.payer);
          lastResolvedRef.current = null; // URL restore is a by-payer resolution, not a stored term
        } else {
          // Fresh load: the overview HYBRID — strip + the top trend facility's payer, scoped to it.
          const ov = await getQualifyOverview(w, marketRef.current);
          if (!alive || genRef.current !== gen) return;
          setKpis(ov.kpis);
          setTrends(ov.trends);
          if (ov.snapshot && ov.topPayer) {
            commitResolved(
              ov.snapshot,
              { type: 'RESOLVE_PAYER', payer: ov.snapshot.resolved?.payerName ?? null, facility: ov.seedFacility, window: w },
              { claims: ov.seedCases, capped: ov.seedCapped },
            );
            setScoped(ov.seedFacility !== null && ov.seedFacility === ov.topFacility);
            setHasSearched(true);
            setByPayer(ov.topPayer);
          }
        }
      } catch {
        // leave the empty prompt — the user can still search
      } finally {
        if (alive) setInitializing(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Change F: write resolved (non-PHI) state to the URL — replace, never push; never a keystroke ──
  const resolvedPayerName = snapshot?.resolved?.payerName ?? null;
  useEffect(() => {
    if (initializing) return;
    const qs = buildQualifySearchParams({
      payer: resolvedPayerName,
      facility: scoped ? cohort.facility : null,
      window: cohort.window,
      loc: locFilter,
    });
    router.replace(qs ? `?${qs}` : globalThis.location?.pathname ?? '/qualify', { scroll: false });
    // serializeQualifyWindow(cohort.window) is covered by cohort.window identity in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializing, resolvedPayerName, scoped, cohort.facility, cohort.window, locFilter, router]);

  // ── AUTOSEARCH: debounced resolve on the id/client tabs (≥3 chars); Enter resolves immediately ──
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchType === 'employer') return;
    const v = query.trim();
    if (v.length < MIN_QUERY_LEN) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      if (searchType === 'client') runNameSearch(v, cohortRef.current.window);
      else runSearch(v, cohortRef.current.window);
    }, AUTOSEARCH_DEBOUNCE_MS);
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchType]);

  // Employer type-ahead (server-side; ≥3 chars).
  useEffect(() => {
    const q = employerQuery.trim();
    if (q.length < 3) {
      setEmployerOptions([]);
      setEmployerLoading(false);
      return;
    }
    let alive = true;
    setEmployerLoading(true);
    const t = setTimeout(() => {
      loadQualifyEmployers(q)
        .then((r) => {
          if (!alive) return;
          const opts = r.ok ? r.employers : [];
          setEmployerOptions(opts);
          if (opts.length > 0) {
            setEmployerDisplay((prev) => {
              const next = new Map(prev);
              for (const o of opts) next.set(o.employer_norm, o.employer_name ?? o.employer_norm);
              return next;
            });
          }
          setEmployerLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setEmployerOptions([]);
          setEmployerLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [employerQuery]);

  // Market change → refresh the strip + re-resolve the active view under the new narrow.
  const marketInitDone = useRef(false);
  useEffect(() => {
    if (!marketInitDone.current) {
      marketInitDone.current = true;
      return;
    }
    const w = cohortRef.current.window;
    refreshOverview(w);
    // Re-resolve the resolved subject (byPayer, or the STORED term) — not the live input box.
    if (byPayer) {
      resolveByPayer(byPayer, w);
    } else if (lastResolvedRef.current) {
      const { term, type } = lastResolvedRef.current;
      if (type === 'client') runNameSearch(term, w);
      else runSearch(term, w);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey]);

  // PER-PATIENT reveal (audited; unchanged for every role).
  const revealPatient = useCallback(
    (patientKey: number, claimIds: number[]) => {
      if (!canRevealPhi || claimIds.length === 0) return;
      const ids = claimIds.slice(0, QUALIFY_REVEAL_BATCH_CAP);
      if (ids.every((id) => revealedRef.current.has(id))) return;
      const gen = genRef.current; // capture (don't bump)
      setRevealingKeys((s) => new Set(s).add(patientKey));
      setRevealError(null);
      const clearKey = () =>
        setRevealingKeys((s) => {
          const n = new Set(s);
          n.delete(patientKey);
          return n;
        });
      void (async () => {
        try {
          const res = await revealQualifyRows(ids);
          if (genRef.current !== gen) return;
          clearKey();
          if (res.ok) {
            setRevealed((m) => {
              const n = new Map(m);
              for (const row of res.rows) {
                const { id, ...phi } = row;
                n.set(id, phi);
              }
              return n;
            });
          } else {
            setRevealError(res.error);
          }
        } catch {
          if (genRef.current !== gen) return;
          clearKey();
          setRevealError('Reveal is unavailable right now.');
        }
      })();
    },
    [canRevealPhi],
  );

  // ── CHANGE B: the GLOBAL persistent reveal. When ON, every scope's newly-loaded rows re-reveal
  // through the SAME audited path, chunked to the 50 batch cap (sequential; gen-guarded). The cache
  // reset on scope change still happens — this effect re-fires after the new rows land, so the audit
  // trail records every scope's reveal (the intended, accepted volume increase). Toggle OFF = re-mask.
  useEffect(() => {
    if (!globalReveal || !canGlobalReveal || facilityCases.length === 0) return;
    const ids = facilityCases.map((c) => c.id).filter((id) => !revealedRef.current.has(id));
    if (ids.length === 0) return;
    const gen = genRef.current; // capture — a newer scope discards these landings
    let alive = true;
    void (async () => {
      for (let i = 0; i < ids.length; i += QUALIFY_REVEAL_BATCH_CAP) {
        const chunk = ids.slice(i, i + QUALIFY_REVEAL_BATCH_CAP);
        try {
          const res = await revealQualifyRows(chunk);
          if (!alive || genRef.current !== gen) return;
          if (res.ok) {
            setRevealed((m) => {
              const n = new Map(m);
              for (const row of res.rows) {
                const { id, ...phi } = row;
                n.set(id, phi);
              }
              return n;
            });
          } else {
            setRevealError(res.error);
            return;
          }
        } catch {
          if (!alive || genRef.current !== gen) return;
          setRevealError('Reveal is unavailable right now.');
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [globalReveal, canGlobalReveal, facilityCases]);

  const toggleGlobalReveal = useCallback(() => {
    setGlobalReveal((on) => {
      if (on) resetReveal(); // OFF re-masks the whole surface
      return !on;
    });
  }, [resetReveal]);

  // Market picker plumbing.
  const toggleEmployer = useCallback((value: string) => {
    setEmployerSelection((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }, []);
  const clearEmployers = useCallback(() => setEmployerSelection([]), []);
  const toggleFunding = useCallback((value: string) => {
    setFundingSelection((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }, []);
  const clearFunding = useCallback(() => setFundingSelection([]), []);
  const employerPickerOptions = useMemo<PickerOption[]>(
    () => employerOptions.map((o) => ({ value: o.employer_norm, display: o.employer_name ?? o.employer_norm })),
    [employerOptions],
  );
  const fundingPickerOptions = useMemo<PickerOption[]>(
    () => [
      { value: 'Self-Funded', display: 'Self-funded' },
      { value: 'Fully Insured', display: 'Fully insured' },
    ],
    [],
  );

  const resolved = snapshot?.resolved ?? null;
  const selectedFacilityLabel = snapshot?.facilities.find((f) => f.facilityKey === cohort.facility)?.name ?? null;
  const emptyIdentifierLabel = isIdentifierEmpty(resolved, snapshot?.identifierLandingFacility ?? null)
    ? identifierEmptyTerm(resolved)
    : null;
  // Fix 1 — when the resolving search was an identifier, the drill is narrowed to it (activeFilterRef),
  // so Recent Claims shows only matching claims. Derive a NON-PHI caption from the resolved match so a
  // payer-wide facility with no matching members reads as intentional, not broken: the ≤3 alpha prefix
  // echoes (matchedValue); an exact member / client name becomes a generic word (never the raw term).
  // Equivalent to "activeFilterRef is set" by construction (identifier resolves set it; payer resolves
  // clear it), and derives from state so render stays reactive.
  const drillFilterCaption =
    resolved === null || resolved.matchedOn === 'payer'
      ? null
      : resolved.matchedOn === 'prefix' && resolved.matchedValue
        ? `prefix ${resolved.matchedValue}`
        : resolved.matchedOn === 'client_name'
          ? 'this client name'
          : 'this member';
  // Change D — ONE lens, everywhere (inclusive semantics; view-only v1).
  const visibleTrends = filterFacilitiesByLoc(trends, locFilter);
  const lensFacilities = filterFacilitiesByLoc(snapshot?.facilities ?? [], locFilter);
  // When SCOPED, the pinned facility is the explicit subject — it must survive the lens even if its
  // careSetting doesn't match (else FacilityPanel pins an empty card + the cases panel empties, a
  // self-contradictory dead-end; review finding). In list mode the lens filters normally.
  const pinnedFacility = scoped ? snapshot?.facilities.find((f) => f.facilityKey === cohort.facility) ?? null : null;
  const visibleFacilities =
    pinnedFacility && !lensFacilities.some((f) => f.facilityKey === pinnedFacility.facilityKey)
      ? [pinnedFacility, ...lensFacilities]
      : lensFacilities;
  // The cases panel is scoped to ONE facility server-side; the LOC lens must NOT empty it when the
  // pinned facility itself is off-lens (its own claims are the subject). Only filter cases by LOC in
  // payer-wide (unscoped) mode — where the lens is a genuine cross-facility view filter.
  const visibleCases = scoped ? facilityCases : filterClaimsByLoc(facilityCases, locFilter);
  // Live branch hint (mirror of the server sniff — display only; the server still decides).
  const branchHint =
    searchType === 'employer' || query.trim().length === 0
      ? null
      : searchType === 'client'
        ? 'resolving as: client name (exact)'
        : query.trim().length < MIN_QUERY_LEN
          ? 'keep typing…'
          : sniffQualifyKind(query.trim()) === 'prefix'
            ? 'resolving as: alpha prefix'
            : 'resolving as: member ID';

  return (
    <main className="mx-auto max-w-[1680px] space-y-4 p-6 sm:p-8">
      {/* page head */}
      <div>
        <h1 className="font-display text-3xl font-medium tracking-tight">Qualify</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Admissions lead qualification · the book at a glance, and the resolved payer below
        </p>
      </div>

      {/* ── OVERVIEW TICKER: Facilities Heating Up — auto-scrolling, ABOVE the finder (stock-ticker
          placement). The skeleton holds the strip's space while the book-wide trend query resolves, so
          the finder below never jumps; LOC-lensed via visibleTrends. ── */}
      {visibleTrends.length > 0 ? (
        <HeatingUpCards
          trends={visibleTrends}
          window={cohort.window}
          activeKey={scoped ? cohort.facility : null}
          onOpen={openTrendCard}
        />
      ) : initializing ? (
        <HeatingUpSkeleton />
      ) : null}

      {/* ── FINDER: search-type tabs · autosearch · window · LOC lens · global reveal ── */}
      <div className="rounded-2xl border border-t-[3px] border-t-teal700 bg-card p-4 shadow-ths-sm">
        <div className="mb-2.5 flex flex-wrap items-center gap-1" role="tablist" aria-label="Search type">
          {SEARCH_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={searchType === t.key}
              onClick={() => {
                setSearchType(t.key);
                setHint(null);
              }}
              className={[
                'rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition-colors',
                searchType === t.key ? 'bg-teal900 text-white shadow-ths-sm' : 'text-ink600 hover:bg-background',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {searchType === 'employer' ? (
            <div className="flex min-w-[300px] flex-1 flex-wrap items-end gap-3.5">
              <MultiSelectTagPicker
                label="Employer"
                placeholder="Type to find employers…"
                icon={<Briefcase className="h-3.5 w-3.5" aria-hidden />}
                options={employerPickerOptions}
                selected={employerSelection}
                onToggle={toggleEmployer}
                onClear={clearEmployers}
                onQueryChange={setEmployerQuery}
                loading={employerLoading}
                minChars={3}
                displayOverride={employerDisplay}
              />
              <MultiSelectTagPicker
                label="Funding"
                placeholder="Self-funded / Fully insured…"
                icon={<Landmark className="h-3.5 w-3.5" aria-hidden />}
                options={fundingPickerOptions}
                selected={fundingSelection}
                onToggle={toggleFunding}
                onClear={clearFunding}
              />
            </div>
          ) : (
            <div className="relative min-w-[300px] max-w-[520px] flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (autoTimer.current) clearTimeout(autoTimer.current);
                    // explicit=true: Enter is the one place the VOB no-match modal may open.
                    if (searchType === 'client') runNameSearch(query, cohort.window, true);
                    else runSearch(query, cohort.window, true);
                  }
                }}
                spellCheck={false}
                autoComplete="off"
                placeholder={PLACEHOLDER[searchType]}
                aria-label={searchType === 'client' ? 'Client name' : 'Member ID or alpha prefix'}
                className="h-12 w-full rounded-xl border-[1.5px] border-line bg-background pl-10 pr-40 text-[15px] text-ink900 outline-none transition-colors focus:border-teal500 focus:bg-card focus:ring-4 focus:ring-teal50"
              />
              {branchHint ? (
                <span className="pointer-events-none absolute right-2.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-teal50 px-2.5 py-1 text-[10.5px] font-bold text-teal700">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                  {branchHint}
                </span>
              ) : null}
            </div>
          )}
          {(query.trim() !== '' || resolved || hasSearched) && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search and return to the overview"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-teal700 px-4 text-[13px] font-bold text-white shadow-ths-sm transition-colors hover:bg-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/50"
            >
              <RotateCcw aria-hidden className="h-4 w-4" />
              Clear Search
            </button>
          )}
          <div className="h-7 w-px bg-line" />
          <WindowControl window={cohort.window} currentYear={new Date().getFullYear()} onChange={onWindow} />
          <div className="h-7 w-px bg-line" />
          {/* Change D: the ONE LOC lens (view-only v1) — scopes trends + facilities + cases. */}
          <div className="inline-flex items-center gap-1.5" role="group" aria-label="Level of care">
            <span className="text-[11.5px] font-semibold text-muted-foreground">LOC</span>
            {(['IP', 'OP', 'BOTH'] as const).map((loc) => (
              <button
                key={loc}
                type="button"
                aria-pressed={locFilter === loc}
                onClick={() => setLocFilter((cur) => (cur === loc ? null : loc))}
                className={[
                  'rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors',
                  locFilter === loc
                    ? 'border-teal500 bg-teal50 text-teal700'
                    : 'border-teal200 bg-card text-muted-foreground hover:bg-teal50',
                ].join(' ')}
              >
                {loc === 'BOTH' ? 'Both' : loc}
              </button>
            ))}
          </div>
          {/* Change B: the GLOBAL persistent reveal switch — super_admin/admin only. Lifted OUT of the
              tab strip and INLINE into the search bar (ml-auto → far right), enlarged for visibility.
              The coral ON-state signals PHI is currently exposed. Behavior + per-scope audit path are
              unchanged (toggleGlobalReveal). */}
          {canGlobalReveal ? (
            <button
              type="button"
              role="switch"
              aria-checked={globalReveal}
              onClick={toggleGlobalReveal}
              title="Reveal PHI identifiers across the whole surface — persists across searches and facility switches; every scope's reveal is audited"
              className={[
                'ml-auto inline-flex h-12 items-center gap-2.5 rounded-xl border px-3.5 text-[13px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
                globalReveal
                  ? 'border-coral400 bg-coral50 text-coral600'
                  : 'border-line bg-background text-ink600 hover:bg-surface hover:text-ink900',
              ].join(' ')}
            >
              {globalReveal ? <Eye aria-hidden className="h-4 w-4" /> : <EyeOff aria-hidden className="h-4 w-4" />}
              <span>Reveal PHI Identifiers</span>
              <span
                className={[
                  'relative h-[22px] w-[38px] rounded-full transition-colors',
                  globalReveal ? 'bg-coral600' : 'bg-line',
                ].join(' ')}
              >
                <span
                  className={[
                    'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-ths transition-all',
                    globalReveal ? 'left-[18px]' : 'left-0.5',
                  ].join(' ')}
                />
              </span>
            </button>
          ) : null}
        </div>
        {searchType === 'client' ? (
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            Exact client name · a name may match multiple patients — resolves their dominant payer. Audited.
          </p>
        ) : null}
      </div>
      {hint ? <p className="px-1 text-xs text-status-warn">{hint}</p> : null}

      {/* ── OVERVIEW: book KPIs (the Facilities Heating Up ticker now sits ABOVE the finder) ── */}
      <BookKpiTiles kpis={kpis} locActive={locFilter !== null} />

      {/* ── RESOLVED SUBJECT + GRID ── */}
      {resolved ? (
        <div className="q-subject animate-ths-reveal relative overflow-hidden rounded-2xl px-6 py-5 text-white shadow-ths">
          <div className="text-[10px] font-extrabold uppercase tracking-widest text-teal200">Resolved payer</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 font-display text-2xl font-medium">
            {resolved.payerName}
            <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold tracking-wide">
              {resolved.matchedOn === 'prefix' ? (
                <>matched on prefix {resolved.matchedValue}</>
              ) : resolved.matchedOn === 'member_id' ? (
                <>matched on member ID</>
              ) : resolved.matchedOn === 'client_name' ? (
                <>matched on client name</>
              ) : (
                <>top facility&rsquo;s payer this window</>
              )}
            </span>
            {scoped && selectedFacilityLabel ? (
              <span className="rounded-full bg-coral600/90 px-2.5 py-1 text-[11px] font-bold tracking-wide">
                scoped · {selectedFacilityLabel}
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-4 text-[13px] text-[#cfe4e0]">
            <span>
              <b className="font-mono text-white">{resolved.totalCharges.toLocaleString('en-US')}</b> claim lines
            </span>
            <span>
              across <b className="font-mono text-white">{resolved.facilityCount}</b> facilities
            </span>
            <span>
              window <b className="font-mono text-white">{formatWindowRange(resolved.windowStart, resolved.windowEnd)}</b>{' '}
              ({qualifyWindowLabel(cohort.window)})
            </span>
            <span className="text-[#9fc7c1]">BXR + Indigo</span>
            {resolved.matchedOn === 'client_name' ? (
              <span className="text-[#9fc7c1]">name may span multiple patients</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {snapshot && snapshot.resolved ? (
        <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[380px_1fr]">
          <FacilityPanel
            facilities={visibleFacilities}
            hasAmounts={hasAmounts}
            heatOn
            selectedKey={cohort.facility}
            onSelect={selectFacility}
            pinned={scoped}
            onClearPin={clearFacilityScope}
          />
          <div aria-busy={isFacilityPending} className={['transition-opacity', isFacilityPending ? 'opacity-60' : ''].join(' ')}>
            <CasesTable
              claims={visibleCases}
              hasAmounts={hasAmounts}
              heatOn
              facilityBuckets={facilityBuckets}
              facilityLabel={selectedFacilityLabel}
              canReveal={canRevealPhi}
              revealed={revealed}
              revealingKeys={revealingKeys}
              revealError={revealError}
              onRevealPatient={revealPatient}
              onHideIdentifiers={resetReveal}
              onViewCohort={viewCohort}
              capped={capped}
              emptyIdentifierLabel={emptyIdentifierLabel}
              filterCaption={drillFilterCaption}
              globalRevealOn={globalReveal && canGlobalReveal}
            />
          </div>
          <CohortSheet
            data={cohortSheet?.data ?? null}
            loading={cohortSheet?.loading ?? false}
            patientLabel={cohortSheet?.label ?? null}
            onClose={() => setCohortSheet(null)}
          />
        </div>
      ) : initializing || isPending ? (
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Resolving…
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          {hasSearched
            ? 'No payer resolved for that search in the selected window.'
            : 'Search a member ID, 3-letter alpha prefix, or client name — or tap a Heating-Up facility above.'}
        </div>
      )}

      <VobModal open={modalOpen} query={echo} onClose={() => setModalOpen(false)} />
    </main>
  );
}
