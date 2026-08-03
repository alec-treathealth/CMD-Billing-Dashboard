'use client';

/**
 * Qualify mobile PWA — the redesigned interactive shell (overview-first, autosearch; the approved
 * comp is docs/mockups/qualify-redesign-mockup.html, mobile toggle). Owns the search, the compact
 * KPI strip + "Facilities Heating Up" chips, and the 5-row sliding-window swipe list; the only
 * caller of the Qualify Server Actions on this surface. Facilities render in the contract's
 * rating-desc order (never re-sorted here).
 *
 * REDESIGN (mirrors desktop Phase 1):
 *  - AUTOSEARCH: debounced ~650ms at ≥3 chars + Enter (no resolve button). Member-id/prefix only on
 *    mobile (the comp's mobile surface); the raw term lives in memory only.
 *  - WINDOW: 30d/60d/90d + M/Y (the calendar QualifyWindow shape; Month/Year selects reveal).
 *  - OVERVIEW: getQualifyOverview lands the surface populated in ONE round-trip — KPI strip + trend
 *    chips + the HYBRID subject (top trend facility's dominant payer, Change E). The old hardcoded
 *    top-mover auto-resolve is gone.
 *  - HEATING-UP CHIPS: facility-shaped (rating + Δpts + defined n). Tap = the hybrid: resolve the
 *    chip's dominant payer AND open that facility's detail sheet.
 *  - CHANGE G: a persistent BREADCRUMB strip (Payer › Facility › Claim) pinned above the deck/sheets,
 *    each crumb tappable to jump straight to that level (not one-back-at-a-time).
 *  - CHANGE B: super_admin/admin (canRevealPhi && amounts capability) get the surface-wide "Reveal
 *    identifiers" switch — in-memory only; every scope still fires the SAME audited reveal path
 *    (chunked to the 50 cap). admissions_seat keeps the per-patient reveal + zero dollars.
 *  - CHANGE D: the LOC lens row scopes the deck AND the detail sheet's claims (inclusive semantics,
 *    shared helpers — one lens, everywhere).
 *
 * INTERACTION CONTRACT (unchanged): an IDENTIFIER search SCOPES the list to the landing facility;
 * a browse (chip/hybrid) keeps the FULL ranked list. The horizontal gesture lives on the LIST
 * CONTAINER; paging is a browse affordance. All async landings ride the resolveSeq/facilitySeq +
 * cohortKey guards — the race-safety core is untouched.
 */
import { useCallback, useEffect, useReducer, useRef, useState, useTransition, type ReactNode } from 'react';
import { getQualifySnapshot, getQualifySnapshotByPayer, getQualifyFacilityCases, getQualifyOverview, getQualifyBookKpis, revealQualifyRows } from '@/lib/qualify/actions';
import { QUALIFY_WINDOW_OPTIONS, QUALIFY_ROLLING_OPTIONS, QUALIFY_CAL_YEAR_MIN, QUALIFY_REVEAL_BATCH_CAP, qualifyRollingLabel, qualifyWindowLabel, sniffQualifyKind, trailingWindow } from '@/lib/qualify/contract';
import type { QualifySnapshot, QualifyFacility, QualifyFacilityTrend, QualifyBookKpis, QualifyClaim, QualifyWindow, QualifyPhi, QualifyMarket } from '@/lib/qualify/contract';
import { cohortReducer, cohortKey, INITIAL_COHORT, type QualifyCohort } from '@/lib/qualify/qualifyCohort';
import { resolveLandingWins, drillLandingWins, isPayerChange, scopeFacilitiesForList, isIdentifierResolution, isIdentifierEmpty, identifierEmptyTerm } from '@/lib/qualify/qualifyGuards';
import { filterFacilitiesByLoc, filterClaimsByLoc, type QualifyLocFilter } from '@/lib/qualify/groupClaims';
import { nextPage, prevPage } from '@/lib/qualify/pagination';
import { MobileFacilityList } from '@/components/qualify/m/facility-list';
import { MobilePolicyLine } from '@/components/qualify/m/policy-line';
import { TrendSheet } from '@/components/qualify/m/trend-sheet';
import { DetailSheet } from '@/components/qualify/m/detail-sheet';
import { ClaimDetailSheet } from '@/components/qualify/m/claim-detail-sheet';
import { AreaChips, deriveAreaChips, facilitiesInArea, AREA_ALL } from '@/components/qualify/m/area-chips';
import { HeatingUp } from '@/components/qualify/m/heating-up';
import { MobileMarketFilter } from '@/components/qualify/m/market-filter';
import { ratingSampleTier } from '@/lib/qualify/sampleGate';
import { SwRegister } from '@/components/qualify/m/sw-register';
import { SearchIcon, RefreshIcon } from '@/components/qualify/m/icons';
import { QUALIFY_PALETTE, RATING_HEX } from '@/components/qualify/tokens';

const TEAL900 = QUALIFY_PALETTE.teal900;
const GROUND = QUALIFY_PALETTE.ground;
const INK900 = QUALIFY_PALETTE.ink900;
const INK400 = QUALIFY_PALETTE.ink400;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AUTOSEARCH_DEBOUNCE_MS = 650;

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '40px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: INK400, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

export function QualifyMobileApp({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const [query, setQuery] = useState('');
  const [win, setWin] = useState<QualifyWindow>(trailingWindow(30));
  const [rangeOpen, setRangeOpen] = useState(false); // the Range ▾ panel (rolling months + calendar)
  const winRef = useRef(win);
  winRef.current = win;
  // Area (state) filter over the resolved deck. Resets on any new resolution / window change.
  const [areaFilter, setAreaFilter] = useState<string>(AREA_ALL);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  // Overview strip: the book KPI percentages + the facility trend chips (window/market-tracked).
  const [kpis, setKpis] = useState<QualifyBookKpis | null>(null);
  const [trends, setTrends] = useState<QualifyFacilityTrend[]>([]);
  // KPI tiles narrowed to the resolved payer (null = book-wide). Mirrors desktop's scoped tiles.
  const [scopedKpis, setScopedKpis] = useState<QualifyBookKpis | null>(null);
  // The FULL ranked list (post-lead) + the current 5-up page. Filters (area + LOC) apply at render.
  const [list, setList] = useState<QualifyFacility[]>([]);
  const [page, setPage] = useState(0);
  const [locFilter, setLocFilter] = useState<QualifyLocFilter>(null);
  const [trendSheet, setTrendSheet] = useState<QualifyFacility | null>(null);
  const [detail, setDetail] = useState<QualifyFacility | null>(null);
  // Facility-scoped claim lines for the open detail sheet: null === loading, [] === none.
  const [facilityCases, setFacilityCases] = useState<QualifyClaim[] | null>(null);
  const [casesCapped, setCasesCapped] = useState(false);
  const [claim, setClaim] = useState<QualifyClaim | null>(null);
  // PHI reveal (facility-scoped, audited) — per-patient cache keyed by case id; the Change-B global
  // toggle auto-fires the SAME audited path per scope. In-memory only, never storage.
  const [revealedPhi, setRevealedPhi] = useState<Map<number, QualifyPhi>>(() => new Map());
  const revealedRef = useRef(revealedPhi);
  revealedRef.current = revealedPhi;
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [globalReveal, setGlobalReveal] = useState(false);
  const canGlobalReveal = canRevealPhi && viewerHasAmountsCapability; // ⇔ super_admin/admin exactly
  const [searched, setSearched] = useState(false);
  // How the CURRENT snapshot was resolved (window changes re-rank via the same path).
  const [byPayer, setByPayer] = useState<string | null>(null);
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  const lastSearchRef = useRef<string | null>(null);
  // VOB market narrows.
  const [employerSelection, setEmployerSelection] = useState<string[]>([]);
  const [fundingSelection, setFundingSelection] = useState<string[]>([]);
  const market = ((): QualifyMarket | undefined => {
    const m: QualifyMarket = {};
    if (employerSelection.length > 0) m.employers = employerSelection;
    if (fundingSelection.length > 0) m.funding = fundingSelection;
    return m.employers || m.funding ? m : undefined;
  })();
  const marketRef = useRef(market);
  marketRef.current = market;
  const marketKey = `${employerSelection.join('\n')}|${fundingSelection.join('\n')}`;
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const initialResolveDone = useRef(false);
  // Monotonic request tokens (the race-safety core): deck resolution + the facility-drill fetch.
  const resolveSeq = useRef(0);
  const facilitySeq = useRef(0);
  // Overview-strip recency: an out-of-order window/market strip response can't overwrite newer tiles.
  const overviewSeq = useRef(0);
  // Scoped-KPI recency: a slow earlier payer/window response can't overwrite newer scoped tiles.
  const scopedKpiSeq = useRef(0);
  // Drill cases COHORT (shared, root-tested reducer).
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
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;

  /** Refresh the overview strip's TRENDS (Heating-Up chips) + the book-wide KPI fallback — non-blocking,
   *  resolve:false. Design B (Phase 2): NO market — employer/funding never scope the strip; the tiles are
   *  re-scoped to the resolved PAYER by refreshScopedKpis (gated). Recency-guarded (overviewSeq). */
  function refreshOverview(w: QualifyWindow) {
    const oseq = ++overviewSeq.current;
    getQualifyOverview(w, undefined, { resolve: false })
      .then((ov) => {
        if (oseq !== overviewSeq.current) return; // superseded by a newer strip fetch
        setKpis(ov.kpis);
        setTrends(ov.trends);
      })
      .catch(() => {});
  }

  /** Fetch the three KPI ratios narrowed to the RESOLVED payer (the scoped tiles). Recency-guarded
   *  (scopedKpiSeq): a slow earlier payer/window response can't overwrite newer tiles. A null/blank
   *  payer clears the scope (back to book-wide). Non-blocking — a failed fetch leaves the prior tiles. */
  function refreshScopedKpis(payer: string | null, w: QualifyWindow) {
    const sseq = ++scopedKpiSeq.current;
    if (!payer) {
      setScopedKpis(null);
      return;
    }
    // Design B (Phase 2): tiles scope on payer (+ facility) ONLY — no market. Full mobile
    // reconciliation lands in Phase 2 Commit B; this keeps the signature correct meanwhile.
    getQualifyBookKpis(w, { payers: [payer] })
      .then((k) => {
        if (sseq !== scopedKpiSeq.current) return; // superseded by a newer scoped fetch
        setScopedKpis(k);
      })
      .catch(() => {});
  }

  // Effect B — mount: load the OVERVIEW STRIP ONLY (book KPI tiles + Heating-Up chips), resolve:false.
  // NO auto-resolve / auto-open sheet: the deck shows the clean search prompt until the user searches
  // or taps a Heating-Up chip (mirrors desktop's clean landing, 2f81846/046336e). This also skips the
  // ~2.5–5s hybrid aggregate on first paint. overviewSeq-guarded like every other strip fetch.
  useEffect(() => {
    refreshOverview(winRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect C — market change → re-resolve the ACTIVE view only (skip mount). Design B (Phase 2): market
  // (employer/funding) scopes the CASES/count, NOT the strip — so the strip is NOT refreshed here; only
  // the resolved snapshot (facility cards + claims) re-runs under the new market narrow.
  const marketInitDone = useRef(false);
  useEffect(() => {
    if (!marketInitDone.current) {
      marketInitDone.current = true;
      return;
    }
    if (byPayer) resolveByPayer(byPayer, winRef.current);
    else if (lastSearch) runSearch(lastSearch, winRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey]);

  // AUTOSEARCH — debounced resolve at ≥3 chars (Enter fires immediately via onKeyDown).
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const v = query.trim();
    if (v.length < 3) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => runSearch(v, winRef.current), AUTOSEARCH_DEBOUNCE_MS);
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function runSearch(raw: string, w: QualifyWindow) {
    const t = raw.trim();
    if (t.length < 3) {
      setHint('Enter at least a 3-letter prefix or a member ID.');
      return;
    }
    setHint(null);
    initialResolveDone.current = true;
    const seq = ++resolveSeq.current;
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: t, window: w, market: marketRef.current });
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setSnapshot(snap);
        setSearched(true);
        setByPayer(null);
        lastSearchRef.current = t;
        setLastSearch(t);
        setAreaFilter(AREA_ALL);
        if (snap.resolved === null) {
          setEcho(t);
          // v2: the COMPARABLE path rides resolved:null with a ranked peer cohort — keep it.
          // A true no-match ships facilities: [] anyway, so this stays the empty state there.
          setList(snap.facilities);
          setPage(0);
          setLocFilter(null);
        } else {
          setEcho('');
          setList(snap.facilities);
          setPage(0);
          setLocFilter(null);
        }
        refreshScopedKpis(snap.resolved?.payerName ?? null, w); // scope the KPI tiles to the resolved payer
        syncCohortForResolution(snap.resolved?.payerName ?? null, w);
      } catch {
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }

  /** Resolve by payer label (chips = the Change-E HYBRID via focusKey; window changes re-rank). */
  function resolveByPayer(label: string, w: QualifyWindow, focusKey: string | null = null) {
    setHint(null);
    initialResolveDone.current = true;
    const seq = ++resolveSeq.current;
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshotByPayer({ payer: label, window: w, market: marketRef.current });
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setSnapshot(snap);
        setSearched(true);
        setByPayer(label);
        lastSearchRef.current = null;
        setLastSearch(null);
        setAreaFilter(AREA_ALL);
        setEcho('');
        setList(snap.facilities);
        setPage(0);
        setLocFilter(null);
        refreshScopedKpis(snap.resolved?.payerName ?? null, w); // scope the KPI tiles to the resolved payer
        // HYBRID (Change E): when the tapped chip's facility ranks under its payer, open it directly.
        const focus = focusKey ? snap.facilities.find((f) => f.facilityKey === focusKey) : undefined;
        // Skip syncCohort's own drill when a focus open follows — openFacility issues the single
        // authoritative (audited) drill; without this the same-payer path double-fetches the OLD
        // facility's cases for a sheet we're about to replace (review finding).
        syncCohortForResolution(snap.resolved?.payerName ?? null, w, !!focus);
        if (focus) openFacility(focus);
      } catch {
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }

  // Window is orthogonal to resolution: refresh the strip + re-rank whatever is CURRENTLY resolved.
  function onWindow(w: QualifyWindow) {
    setWin(w);
    refreshOverview(w);
    if (byPayer) resolveByPayer(byPayer, w);
    else if (lastSearch) runSearch(lastSearch, w);
  }

  function resetDeck() {
    setPage(0);
  }

  function clearSearch() {
    resolveSeq.current += 1;
    setQuery('');
    setHint(null);
    setEcho('');
    setSnapshot(null);
    setSearched(false);
    setByPayer(null);
    setLastSearch(null);
    lastSearchRef.current = null;
    refreshScopedKpis(null, winRef.current); // back to book-wide tiles
    setList([]);
    setPage(0);
    setAreaFilter(AREA_ALL);
    setLocFilter(null);
    setDetail(null);
    setClaim(null);
    clearReveal();
    apply({ type: 'RESOLVE_PAYER', payer: null, facility: null, window: winRef.current });
  }

  function onSelectArea(key: string) {
    if (!snapshot?.resolved) return;
    setAreaFilter(key);
    setPage(0);
  }

  function onSelectLoc(loc: QualifyLocFilter) {
    setLocFilter((cur) => (cur === loc ? null : loc));
    setPage(0);
  }

  function clearReveal() {
    setRevealedPhi(new Map());
    setRevealPending(false);
    setRevealError(null);
  }

  // The DRILL stream (facilitySeq recency + cohortKey identity) — untouched race core.
  function fetchDrill(c: QualifyCohort) {
    const seq = ++facilitySeq.current;
    const key = cohortKey(c);
    if (!c.payer || !c.facility) { setFacilityCases([]); setCasesCapped(false); return; }
    const term = lastSearchRef.current;
    const filter = term ? (sniffQualifyKind(term) === 'member_id' ? { memberId: term } : { prefix: term }) : undefined;
    getQualifyFacilityCases({ payer: c.payer, facility: c.facility, window: c.window, allPayers: true, market: marketRef.current, ...(filter ? { filter } : {}) })
      .then((r) => {
        if (!drillLandingWins(seq, facilitySeq.current, key, cohortKey(cohortRef.current))) return;
        setFacilityCases(r.claims);
        setCasesCapped(r.capped);
      })
      .catch(() => {
        if (!drillLandingWins(seq, facilitySeq.current, key, cohortKey(cohortRef.current))) return;
        setFacilityCases([]);
        setCasesCapped(false);
      });
  }

  function syncCohortForResolution(nextPayer: string | null, w: QualifyWindow, skipDrill = false) {
    if (isPayerChange(cohortRef.current.payer, nextPayer)) {
      if (detailRef.current) closeFacility();
      apply({ type: 'RESOLVE_PAYER', payer: nextPayer, facility: null, window: w });
    } else {
      const next = apply({ type: 'CHANGE_WINDOW', window: w });
      // skipDrill: a focus openFacility() will fire the authoritative drill right after — don't
      // double-fetch the currently-open (old) facility's cases here.
      if (detailRef.current && !skipDrill) fetchDrill(next);
    }
  }

  function openFacility(f: QualifyFacility) {
    setClaim(null);
    setFacilityCases(null); // loading
    setDetail(f);
    clearReveal();
    fetchDrill(apply({ type: 'SWITCH_FACILITY', facility: f.facilityKey }));
  }

  function closeFacility() {
    facilitySeq.current++;
    setDetail(null);
    setFacilityCases(null);
    setClaim(null);
    setCasesCapped(false);
    clearReveal();
  }

  // PER-PATIENT reveal (audited) — unchanged for every role.
  function revealPatient(patientKey: number) {
    if (!canRevealPhi) return;
    const rows = facilityCases ?? [];
    const ids = rows.filter((c) => c.patientKey === patientKey).map((c) => c.id).slice(0, QUALIFY_REVEAL_BATCH_CAP);
    if (ids.length === 0) return;
    if (ids.every((id) => revealedPhi.has(id))) return;
    if (revealPending) return;
    const seq = facilitySeq.current;
    setRevealPending(true);
    setRevealError(null);
    revealQualifyRows(ids)
      .then((res) => {
        if (seq !== facilitySeq.current) return;
        setRevealPending(false);
        if (res.ok) {
          setRevealedPhi((prev) => {
            const m = new Map(prev);
            for (const r of res.rows) {
              m.set(r.id, { patient_name: r.patient_name, member_id_raw: r.member_id_raw, group_number: r.group_number });
            }
            return m;
          });
        } else {
          setRevealError(res.error);
        }
      })
      .catch(() => {
        if (seq !== facilitySeq.current) return;
        setRevealPending(false);
        setRevealError('Reveal is unavailable right now.');
      });
  }

  // CHANGE B — the global persistent reveal: when ON, every loaded drill scope re-reveals through the
  // SAME audited path, chunked to the 50 cap (facilitySeq-guarded so a close/reopen drops landings).
  useEffect(() => {
    if (!globalReveal || !canGlobalReveal || !facilityCases || facilityCases.length === 0) return;
    const ids = facilityCases.map((c) => c.id).filter((id) => !revealedRef.current.has(id));
    if (ids.length === 0) return;
    const seq = facilitySeq.current;
    let alive = true;
    void (async () => {
      for (let i = 0; i < ids.length; i += QUALIFY_REVEAL_BATCH_CAP) {
        const chunk = ids.slice(i, i + QUALIFY_REVEAL_BATCH_CAP);
        try {
          const res = await revealQualifyRows(chunk);
          if (!alive || seq !== facilitySeq.current) return;
          if (res.ok) {
            setRevealedPhi((prev) => {
              const m = new Map(prev);
              for (const r of res.rows) {
                m.set(r.id, { patient_name: r.patient_name, member_id_raw: r.member_id_raw, group_number: r.group_number });
              }
              return m;
            });
          } else {
            setRevealError(res.error);
            return;
          }
        } catch {
          if (!alive || seq !== facilitySeq.current) return;
          setRevealError('Reveal is unavailable right now.');
          return;
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalReveal, canGlobalReveal, facilityCases]);

  function toggleGlobalReveal() {
    setGlobalReveal((on) => {
      if (on) clearReveal(); // OFF re-masks
      return !on;
    });
  }

  // Resolution-derived view state (identifier scoping — unchanged).
  const resolvedSnap = snapshot?.resolved ?? null;
  const landingKey = snapshot?.identifierLandingFacility ?? null;
  const isIdentifierPath = isIdentifierResolution(resolvedSnap);
  const identifierEmpty = isIdentifierEmpty(resolvedSnap, landingKey);
  const isIdentifierScoped = isIdentifierPath && landingKey !== null;
  const scopedList = scopeFacilitiesForList(list, resolvedSnap, landingKey);
  const filteredList = isIdentifierScoped ? scopedList : filterFacilitiesByLoc(facilitiesInArea(scopedList, areaFilter), locFilter);

  const goNext = () => setPage((p) => nextPage(p, filteredList.length));
  const goPrev = () => setPage((p) => prevPage(p, filteredList.length));

  // Change D on the drill: the LOC lens filters the open sheet's claims too (one lens, everywhere).
  const sheetClaims = facilityCases === null ? null : filterClaimsByLoc(facilityCases, locFilter);

  // KPI tiles: scoped to the resolved PAYER once a subject resolves; book-wide on the clean landing.
  // Phase 2 (Design B): the hotfix's fail-safe is LIFTED — scoped tiles are restored, now that the KPI
  // builder returns a distinct-patient count, and the tile display is SAMPLE-GATED below (a <3-patient
  // slice renders no confident %, matching the ranking + desktop). Employer/funding still never scope
  // these tiles (that's why refreshScopedKpis passes { payers } only, no market).
  const kpiScopePayer = snapshot?.resolved?.payerName ?? null;
  const tilesScoped = searched && kpiScopePayer !== null && scopedKpis !== null;
  const shownKpis = tilesScoped ? scopedKpis : kpis;
  // SAMPLE GATE (Design B parity with desktop): tier the tiles by the slice's distinct-patient count.
  // Only once shownKpis has loaded (null → keep the '—' skeleton, never a false "insufficient").
  const tileTier = shownKpis ? ratingSampleTier(shownKpis.distinctPatients) : 'full';
  const tileInsufficient = tileTier === 'insufficient';
  const tilePatients = shownKpis?.distinctPatients ?? 0;
  const tileTierNote =
    tileTier === 'insufficient'
      ? ` · insufficient data (${tilePatients} patient${tilePatients === 1 ? '' : 's'})`
      : tileTier === 'thin'
        ? ` · thin sample (${tilePatients} patient${tilePatients === 1 ? '' : 's'})`
        : '';

  function renderBody(): ReactNode {
    if (!searched) {
      return <EmptyState>Search a member ID or 3-letter prefix — or tap a heating-up facility.</EmptyState>;
    }
    if (snapshot && snapshot.resolved === null) {
      const estimated = snapshot.provenance === 'comparable_employer' || snapshot.provenance === 'comparable_funding';
      if (!estimated || filteredList.length === 0) {
        if (snapshot.policy?.found) {
          return (
            <EmptyState>
              VOB on file{snapshot.policy.carrier ? ` (${snapshot.policy.carrier})` : ''} — no paid history yet for this
              plan or its peer group.
            </EmptyState>
          );
        }
        return (
          <EmptyState>
            No match for <span className="ths-num" style={{ color: INK900, fontWeight: 600 }}>{echo}</span>
          </EmptyState>
        );
      }
      // estimated cohort → fall through to the ranked list; MobilePolicyLine above carries the banner
    }
    if (snapshot && snapshot.facilities.length === 0) {
      return <EmptyState>No facilities for this payer in this window.</EmptyState>;
    }
    if (identifierEmpty) {
      return (
        <EmptyState>
          No in-window claims for{' '}
          <span className="ths-num" style={{ color: INK900, fontWeight: 600 }}>{identifierEmptyTerm(resolvedSnap)}</span>
          {' '}— try a wider window.
        </EmptyState>
      );
    }
    if (!isIdentifierScoped && filteredList.length === 0) {
      return (
        <div style={{ padding: '40px 16px', textAlign: 'center' }}>
          <div className="ths-h" style={{ fontSize: 14, fontWeight: 600, color: INK900 }}>No facilities match these filters</div>
          <div style={{ marginTop: 4, fontSize: 12, color: INK400 }}>Clear a chip or tap Top</div>
        </div>
      );
    }
    return (
      <MobileFacilityList
        facilities={filteredList}
        page={page}
        scoped={isIdentifierScoped}
        dimmed={isPending}
        onPageNext={goNext}
        onPagePrev={goPrev}
        onWhy={(x) => setTrendSheet(x)}
        onOpen={openFacility}
      />
    );
  }

  const resolvedForSheet = snapshot?.resolved ?? null;
  const searchContext =
    resolvedForSheet && resolvedForSheet.matchedOn === 'prefix' && resolvedForSheet.matchedValue
      ? { term: resolvedForSheet.matchedValue, payer: resolvedForSheet.payerName }
      : null;

  const areaChips = snapshot?.resolved ? deriveAreaChips(snapshot.facilities) : [];
  const showAreaChips = areaChips.length > 2 && !isIdentifierPath;

  // Window control state (M/Y selects).
  const rangeActive = !(win.kind === 'trailing' && (QUALIFY_WINDOW_OPTIONS as readonly number[]).includes(win.days));
  const nowYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = nowYear; y >= QUALIFY_CAL_YEAR_MIN; y--) years.push(y);
  const selYear = win.kind === 'trailing' ? nowYear : win.year;
  const selMonth = win.kind === 'month' ? win.month : 0;

  // CHANGE G — the breadcrumb levels currently live (payer › facility › claim).
  const crumbPayer = snapshot?.resolved?.payerName ?? null;
  const crumbs: { key: string; label: string; onTap: (() => void) | null }[] = [];
  if (crumbPayer) {
    crumbs.push({ key: 'payer', label: crumbPayer, onTap: detail || claim ? () => { setClaim(null); closeFacility(); } : null });
    if (detail) crumbs.push({ key: 'facility', label: detail.name, onTap: claim ? () => setClaim(null) : null });
    if (claim) crumbs.push({ key: 'claim', label: 'Claim', onTap: null });
  }

  return (
    <div style={{ minHeight: '100vh', background: GROUND }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, padding: '16px 16px 12px', background: TEAL900 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)' }}>Qualify</div>
            <div className="ths-h" style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>Lead lookup</div>
          </div>
          {canGlobalReveal ? (
            <button
              type="button"
              role="switch"
              aria-checked={globalReveal}
              onClick={toggleGlobalReveal}
              title="Reveal identifiers across the whole surface (audited per scope)"
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '0 12px', borderRadius: 999, background: globalReveal ? '#fff' : 'rgba(255,255,255,0.1)', border: 'none', color: globalReveal ? TEAL900 : '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              <span>{globalReveal ? 'IDs shown' : 'Reveal IDs'}</span>
            </button>
          ) : null}
          {(searched || query.trim() !== '') && (
            <button
              type="button"
              onClick={clearSearch}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '0 12px', borderRadius: 999, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
            >
              <span>Clear</span>
            </button>
          )}
          <button
            type="button"
            onClick={resetDeck}
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, padding: '0 12px', borderRadius: 999, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
          >
            <RefreshIcon size={14} color="#fff" />
            <span>Top</span>
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)' }}>
            <SearchIcon size={16} color="rgba(255,255,255,0.4)" />
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (autoTimer.current) clearTimeout(autoTimer.current);
                runSearch(query, win);
              }
            }}
            enterKeyHint="search"
            spellCheck={false}
            placeholder="Member ID or 3-letter prefix · auto-resolves"
            aria-label="Member ID or alpha prefix"
            style={{ width: '100%', height: 40, padding: '0 14px 0 36px', borderRadius: 12, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 14, outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }} role="group" aria-label="Time window">
          {QUALIFY_WINDOW_OPTIONS.map((d) => {
            const active = win.kind === 'trailing' && win.days === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => onWindow(trailingWindow(d))}
                aria-pressed={active}
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: 999,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  background: active ? '#fff' : 'rgba(255,255,255,0.1)',
                  color: active ? TEAL900 : 'rgba(255,255,255,0.7)',
                }}
              >
                {d}d
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setRangeOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={rangeOpen}
            aria-pressed={rangeActive}
            style={{
              flex: 1.4,
              height: 44,
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              whiteSpace: 'nowrap',
              background: rangeActive ? '#fff' : 'rgba(255,255,255,0.1)',
              color: rangeActive ? TEAL900 : 'rgba(255,255,255,0.7)',
            }}
          >
            {rangeActive ? qualifyWindowLabel(win) : 'Range'} ▾
          </button>
        </div>
        {rangeOpen ? (
          <div style={{ marginTop: 8, borderRadius: 12, background: 'rgba(255,255,255,0.08)', padding: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', padding: '2px 4px 6px' }}>
              Rolling (from today)
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {QUALIFY_ROLLING_OPTIONS.map((d) => {
                const active = win.kind === 'trailing' && win.days === d;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => { onWindow(trailingWindow(d)); setRangeOpen(false); }}
                    aria-pressed={active}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      borderRadius: 10,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      background: active ? '#fff' : 'rgba(255,255,255,0.12)',
                      color: active ? TEAL900 : '#fff',
                    }}
                  >
                    {qualifyRollingLabel(d).replace('Last ', '')}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', padding: '10px 4px 6px' }}>
              Specific period
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={selMonth}
                aria-label="Month"
                onChange={(e) => {
                  const m = Number(e.target.value);
                  onWindow(m === 0 ? { kind: 'year', year: selYear } : { kind: 'month', year: selYear, month: m });
                }}
                style={{ flex: 1, height: 44, borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 13, padding: '0 8px' }}
              >
                <option value={0}>All months</option>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
              <select
                value={selYear}
                aria-label="Year"
                onChange={(e) => {
                  const y = Number(e.target.value);
                  onWindow(selMonth === 0 ? { kind: 'year', year: y } : { kind: 'month', year: y, month: selMonth });
                }}
                style={{ flex: 1, height: 44, borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 13, padding: '0 8px' }}
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {/* CHANGE G — the breadcrumb strip: Payer › Facility › Claim, each live level tappable. */}
        {crumbs.length > 0 ? (
          <nav aria-label="Drilldown breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, overflowX: 'auto' }}>
            {crumbs.map((c, i) => (
              <span key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {i > 0 ? <span aria-hidden style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>›</span> : null}
                {c.onTap ? (
                  <button
                    type="button"
                    onClick={c.onTap}
                    style={{ border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {c.label}
                  </button>
                ) : (
                  <span style={{ color: '#fff', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.24)', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
      </div>

      <MobileMarketFilter
        employers={employerSelection}
        funding={fundingSelection}
        onEmployersChange={setEmployerSelection}
        onFundingChange={setFundingSelection}
      />

      {/* Compact KPI strip — book-wide on the clean landing, re-scoped to the resolved payer once a
          subject resolves (mirrors desktop). SAMPLE-GATED (Design B): a <3-patient slice renders no
          confident % ("insufficient data"); 3-9 shows the % with a thin-sample caption. The LOC lens
          never re-scopes these. */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px 2px' }}>
        {(
          [
            { key: 'allowed', label: 'allowed / billed', v: shownKpis?.pctAllowedOfBilled ?? null, color: RATING_HEX.ok, bg: '#E6F2EC' },
            { key: 'paidAllowed', label: 'paid / allowed', v: shownKpis?.pctPaidOfAllowed ?? null, color: RATING_HEX.warn, bg: '#FBF1DE' },
            { key: 'paidBilled', label: 'paid / billed', v: shownKpis?.pctPaidOfBilled ?? null, color: RATING_HEX.warn, bg: '#FBF1DE' },
          ] as const
        ).map((t) => (
          <div key={t.key} style={{ flex: 1, borderRadius: 12, border: `1px solid ${QUALIFY_PALETTE.line}`, padding: '9px 11px', background: tileInsufficient ? '#F1F3F2' : t.bg }}>
            <div className="ths-num" style={{ fontSize: 20, fontWeight: 600, color: tileInsufficient ? INK400 : t.color }}>
              {tileInsufficient || t.v === null ? '—' : `${Math.round(t.v)}%`}
            </div>
            <div style={{ fontSize: 9.5, color: QUALIFY_PALETTE.ink600, fontWeight: 600, marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: '4px 16px 0', fontSize: 10, fontWeight: 600, color: INK400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tilesScoped ? kpiScopePayer : 'book-wide'}
        {tileTierNote}
        {locFilter !== null ? ' · not LOC-scoped' : ''}
      </div>

      <HeatingUp trends={trends} window={win} onOpen={(t) => { if (t.dominantPayer) resolveByPayer(t.dominantPayer, winRef.current, t.facilityKey); }} />
      <SwRegister />

      {hint ? <div style={{ padding: '0 16px', fontSize: 12, color: '#C9881E' }}>{hint}</div> : null}

      {showAreaChips ? <AreaChips chips={areaChips} active={areaFilter} onSelect={onSelectArea} /> : null}
      {snapshot?.resolved && !isIdentifierPath ? (
        <div style={{ display: 'flex', gap: 6, padding: '8px 16px 0' }} role="group" aria-label="Level of care">
          {(['IP', 'OP', 'BOTH'] as const).map((locOpt) => {
            const active = locFilter === locOpt;
            return (
              <button
                key={locOpt}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectLoc(locOpt)}
                style={{
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 16px',
                  borderRadius: 999,
                  border: 'none',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: active ? TEAL900 : '#EEF2F0',
                  color: active ? '#fff' : INK400,
                }}
              >
                {locOpt === 'BOTH' ? 'Both' : locOpt}
              </button>
            );
          })}
        </div>
      ) : null}

      {searched && snapshot ? <MobilePolicyLine policy={snapshot.policy} provenance={snapshot.provenance} /> : null}

      {renderBody()}

      {trendSheet ? <TrendSheet facility={trendSheet} onClose={() => setTrendSheet(null)} sampleGated={!isIdentifierScoped} /> : null}
      {detail ? (
        <DetailSheet
          key={detail.facilityKey}
          facility={detail}
          claims={sheetClaims ?? []}
          loading={sheetClaims === null}
          hasAmounts={hasAmounts}
          capped={casesCapped}
          canReveal={canRevealPhi}
          revealed={revealedPhi}
          revealError={revealError}
          onHideIdentifiers={clearReveal}
          onOpenClaim={(c) => setClaim(c)}
          onClose={closeFacility}
          searchContext={searchContext}
        />
      ) : null}
      {claim ? (
        <ClaimDetailSheet
          claim={claim}
          hasAmounts={hasAmounts}
          phi={revealedPhi.get(claim.id) ?? null}
          canReveal={canRevealPhi}
          revealing={revealPending}
          revealError={revealError}
          onReveal={() => revealPatient(claim.patientKey)}
          onClose={() => setClaim(null)}
        />
      ) : null}
    </div>
  );
}
