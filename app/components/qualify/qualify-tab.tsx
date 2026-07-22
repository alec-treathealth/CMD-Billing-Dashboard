'use client';

/**
 * Qualify tab — the interactive container. Owns search/window/toggle/modal state and is the caller of
 * the Qualify Server Actions (the browser's sole data path): getQualifySnapshot (member/prefix search),
 * getQualifySnapshotByPayer (resolve-by-payer), and getQualifyMovers (for the on-load default). It
 * hands plain, already-shaped data to the pure presentational children (facility panel, cases table,
 * VOB modal).
 *
 * COHORT STATE (qualifyCohort.ts): the cases panel's identity — payer / facility / window — and
 * its cursor stack (page + cursors[]) live in ONE atomic object driven by a pure reducer. Every handler
 * DISPATCHES an action; it never hand-resets page/cursors. The reducer owns the invariants:
 *   - any cohort change (payer/facility/window) resets to page 0 with a fresh cursor stack;
 *   - CHANGE_WINDOW keeps the facility — a window change is the same selection re-fetched for the
 *     new window, NOT a teleport back to rank-1.
 *
 * RECENT CLAIMS (ruling Q-4 + Direction B): the "Recent Claims" panel shows the most-recent CLAIMS (claim
 * grain — one row per charge) for the resolved payer FILTERED TO THE SELECTED FACILITY — never the payer-wide
 * set (the mockup's "same list regardless of facility" bug). Selecting a facility row calls getQualifyFacilityCases
 * (same server path the mobile card-tap uses; cross-tenant, masked, amounts stripped server-side). On a NEW payer
 * we auto-select the rank-1 facility so the tab lands populated. A facility switch discards any revealed PHI —
 * the same scope-change rule a new search follows (each drill is its own audited access).
 *
 * IDENTIFIER ENTRY — RULING (settled): the MAIN top-bar search is the ONE place an identifier is ever typed —
 * it resolves the payer, ranks facilities, and LANDS on the searched member's facility (Fix A, untouched).
 * The Recent Claims panel is a PURE DISPLAY of that landed facility (grouped by patient, the searched
 * member present in context) — the former in-panel prefix + group-# re-narrows are REMOVED. The
 * resolve-by-payer path
 * (Heating-up chips / on-load) carries NO identifier → the list stays payer-wide (ruling 3).
 *
 * ON LOAD it auto-resolves the top "Heating up" payer so the tab lands POPULATED (matching the
 * mockup's populated-on-load feel) instead of an empty search prompt. The user can then search or
 * change the window to switch payers; a manual search clears the by-payer default.
 *
 * Amounts capability is server-authoritative: it comes from the snapshot once one exists, and is
 * seeded before the first search by the server-derived prop so an admissions_seat never renders the
 * $ column headers even on the empty state.
 *
 * Window control is 30/60/90/180 (contract QUALIFY_WINDOW_OPTIONS) — the mock's "Month" was
 * dropped (Alec) because it is a different window shape than the contract's trailing-N-days math.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import {
  getQualifySnapshot,
  getQualifySnapshotByPayer,
  getQualifyFacilityCases,
  getQualifyPatientCohort,
  getQualifyMovers,
  revealQualifyRows,
} from '@/lib/qualify/actions';
import {
  QUALIFY_WINDOW_OPTIONS,
  type QualifySnapshot,
  type QualifyWindowDays,
  type QualifyClaim,
  type QualifyCasesCursor,
  type QualifyMover,
  type QualifyPhi,
  type QualifyPatientCohort,
} from '@/lib/qualify/contract';
import { cohortReducer, cohortKey, INITIAL_COHORT, type QualifyCohort } from '@/lib/qualify/qualifyCohort';
import { isIdentifierEmpty, identifierEmptyTerm } from '@/lib/qualify/qualifyGuards';
import { buildFacilityBucketMap } from '@/components/qualify/colors';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { filterFacilitiesByLoc, type QualifyLocFilter } from '@/lib/qualify/groupClaims';
import { CasesTable } from '@/components/qualify/cases-table';
import { CohortSheet } from '@/components/qualify/cohort-sheet';
import { HeatingUpBar } from '@/components/qualify/heating-up-bar';
import { VobModal } from '@/components/qualify/vob-modal';

const MIN_QUERY_LEN = 3;

/** windowStart (inclusive) .. windowEnd (EXCLUSIVE) → "Jun 18 – Jul 17, 2026" (inclusive last day). */
function formatWindowRange(startIso: string, endExclusiveIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const endIncl = new Date(new Date(`${endExclusiveIso}T00:00:00Z`).getTime() - 86_400_000);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mo(start)} ${start.getUTCDate()} – ${mo(endIncl)} ${endIncl.getUTCDate()}, ${endIncl.getUTCFullYear()}`;
}

/** The page-0 slice fetched for a facility (seed) — the shape both the resolve paths and the pager write. */
type CasesPage = { claims: QualifyClaim[]; nextCursor: QualifyCasesCursor | null; hasMore: boolean };
const EMPTY_PAGE: CasesPage = { claims: [], nextCursor: null, hasMore: false };


export function QualifyTab({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [isPending, startTransition] = useTransition();
  // The cases panel's atomic COHORT (payer/facility/window + page/cursors), reducer-owned. Every
  // transition goes through `apply` (dispatch + return the resulting cohort so the fetch can read it). A ref
  // mirrors the latest cohort so an async cases landing can check it changed underneath (the cohort-key guard).
  const [cohort, dispatch] = useReducer(cohortReducer, INITIAL_COHORT);
  const cohortRef = useRef(cohort);
  cohortRef.current = cohort;
  const apply = useCallback((action: Parameters<typeof cohortReducer>[1]): QualifyCohort => {
    const next = cohortReducer(cohortRef.current, action);
    dispatch(action);
    return next;
  }, []);
  // The current facility's page of cases + the last fetch's pagination result. facilityCases is the rendered
  // rows; hasMore gates Next; nextCursor is the cursor a PAGE_NEXT will push. (These are fetch RESULTS, not
  // cohort identity, so they live outside the reducer.) A dedicated transition so a facility/pager fetch
  // doesn't co-mingle with the payer-resolve pending state.
  const [facilityCases, setFacilityCases] = useState<QualifyClaim[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<QualifyCasesCursor | null>(null);
  const [isFacilityPending, startFacilityTransition] = useTransition();
  // LOC filter chips (IP / OP / Both) — pure client-side view filter over the facility panel.
  const [locFilter, setLocFilter] = useState<QualifyLocFilter>(null);
  // Phase 3: the patient-cohort slide-over (masked label + fetched context). Null = closed.
  const [cohortSheet, setCohortSheet] = useState<{
    label: string;
    data: QualifyPatientCohort | null;
    loading: boolean;
  } | null>(null);
  // "Heating up" payer quick-pick (desktop parity with mobile): trending payers for the current window,
  // rendered as a click-to-resolve chip row. Fetched on load + re-fetched on window change.
  const [movers, setMovers] = useState<QualifyMover[]>([]);
  const [heatOn, setHeatOn] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // Non-null when the CURRENT resolution came from the by-payer path (the on-load default or a payer chip),
  // so a window change re-resolves by payer instead of re-running an (empty) search.
  const [byPayer, setByPayer] = useState<string | null>(null);
  // True until the on-load auto-resolve of the top payer settles (so we show "Resolving…", not the
  // empty search prompt, on first paint).
  const [initializing, setInitializing] = useState(true);
  // PHI reveal: a SINGLE parent-owned toggle (`revealAll`) unmasks the whole scoped set at once via one
  // audited revealQualifyRows bulk call — parity with the collections grid + billing-audit work-table.
  // `revealed` caches the fetched PHI for the CURRENT scope; `revealing`/`revealError` drive the toggle.
  // `revealAll` is STICKY across facility switches (Alec's painpoint — don't re-click every drill); the
  // PHI cache resets on every scope change (resetReveal), so each facility re-reveals with its own
  // audited call. Toggling revealAll off/on re-masks DISPLAY only and never re-audits.
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Map<number, QualifyPhi>>(() => new Map());
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  // The facilityCases array identity the auto-reveal has already CLAIMED. The effect claims the current
  // array synchronously before awaiting, so (a) it fires exactly once per scope, and (b) a stale-scope
  // commit — facilityCases still lagging the previous facility for one render right after a switch — is
  // deduped instead of revealing the wrong scope. A new resolution/facility always yields a fresh array.
  const revealedForRef = useRef<QualifyClaim[] | null>(null);
  // Resolution identity (search-is-authority). Every fetch entry point bumps-and-captures this at entry;
  // every post-await write guards `genRef.current === gen` and bails otherwise. So a newer fetch DISCARDS
  // any in-flight older write — the header (snapshot) and the rows (facilityCases) can never be sourced from
  // two different resolutions. This is the RECENCY guard (it also catches pagination races). A reveal
  // CAPTURES the current gen (without bumping) so a stale reveal can't re-populate PHI after a newer scope's
  // resetReveal(). See cohortKey for the complementary IDENTITY guard on standalone cases fetches.
  const genRef = useRef(0);

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;
  const facilityBuckets = useMemo(
    () => buildFacilityBucketMap(snapshot?.facilities ?? []),
    [snapshot],
  );

  // Discard the current scope's revealed PHI — used on every scope change (new search, new payer,
  // facility switch, window change, page). Clears the PHI cache, but NOT `revealAll` (sticky toggle)
  // and NOT `revealedForRef` (resetting it would let the effect re-fire against the still-lagging previous
  // facilityCases); the fresh facilityCases identity from the new fetch is what re-arms the auto-reveal.
  const resetReveal = useCallback(() => {
    setRevealed(new Map());
    setRevealing(false);
    setRevealError(null);
  }, []);

  // Fetch page 0 of ONE facility's cases (the "seed" a resolve/window-change commits atomically with the
  // snapshot, so header + selection + cases land in one paint — no empty-cases flash). `facility` is the
  // landing (Fix A) or rank-1 for a new payer, or the RETAINED facility for a window change. PURE facility
  // display (ruling): no identifier/group narrow — the main-bar search already LANDED us here.
  const fetchSeed = useCallback(
    async (payer: string, facility: string, w: QualifyWindowDays): Promise<CasesPage> => {
      const res = await getQualifyFacilityCases({ payer, facility, windowDays: w });
      return { claims: res.claims, nextCursor: res.nextCursor, hasMore: res.hasMore };
    },
    [],
  );

  // Fetch the cases for a given cohort (a standalone cases fetch — facility switch / pager step; NOT a
  // snapshot re-resolve). Derives the cursor from cohort.cursors[cohort.page]. Guarded twice:
  // genRef (recency — catches pagination races + supersession) AND cohortKey (identity — discards a landing
  // whose cohort changed underneath, belt-and-suspenders over the reducer's structural reset).
  const fetchCases = useCallback(
    (c: QualifyCohort) => {
      const payer = c.payer;
      const facility = c.facility;
      if (!payer || !facility) return;
      const gen = ++genRef.current;
      const key = cohortKey(c);
      resetReveal();
      const cursor = c.cursors[c.page] ?? null;
      startFacilityTransition(async () => {
        try {
          const res = await getQualifyFacilityCases({
            payer,
            facility,
            windowDays: c.window,
            cursor,
          });
          if (genRef.current !== gen) return; // superseded by a newer fetch (recency / pagination guard)
          if (cohortKey(cohortRef.current) !== key) return; // cohort changed underneath — stale landing
          setFacilityCases(res.claims);
          setHasMore(res.hasMore);
          setNextCursor(res.nextCursor);
        } catch {
          if (genRef.current !== gen) return;
          if (cohortKey(cohortRef.current) !== key) return;
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [resetReveal],
  );

  // Commit a fresh snapshot + its seeded page-0 cases atomically (one paint). Shared by runSearch /
  // resolveByPayer / onWindow after they've fetched the snapshot + seed under a captured `gen`.
  const commitResolved = useCallback((snap: QualifySnapshot, action: Parameters<typeof cohortReducer>[1], seed: CasesPage) => {
    setSnapshot(snap);
    apply(action);
    setFacilityCases(seed.claims);
    setHasMore(seed.hasMore);
    setNextCursor(seed.nextCursor);
  }, [apply]);

  // Resolve by member-id / alpha-prefix SEARCH → a brand-new payer cohort landing on the searched
  // member's facility. Seeds page 0 BEFORE committing so snapshot + selection + cases land together.
  const runSearch = useCallback((rawQuery: string, w: QualifyWindowDays) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setHint(`Enter at least a ${MIN_QUERY_LEN}-letter alpha prefix or a full member ID.`);
      return;
    }
    setHint(null);
    resetReveal();
    const gen = ++genRef.current; // this search is now the authoritative resolution
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: trimmed, windowDays: w });
        const payerName = snap.resolved?.payerName ?? null;
        // Fix A: LAND ON the searched identifier's most-recent-claim facility (server-computed, already dropped
        // to null if it isn't a ranked facility), NOT rating rank-1. null → honest-empty (no ranked in-window
        // claims for this identifier).
        const landing = snap.identifierLandingFacility;
        // RULING: the panel is a PURE display of the landed facility — no drill narrow is derived from
        // the search; landing on the right facility (Fix A, above) is the whole identifier story here.
        const seed = payerName && landing ? await fetchSeed(payerName, landing, w) : EMPTY_PAGE;
        if (genRef.current !== gen) return; // a newer resolution superseded this search — discard
        commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: landing, window: w }, seed);
        setHasSearched(true);
        setByPayer(null); // an explicit search supersedes the by-payer default
        if (snap.resolved === null) {
          setEcho(trimmed);
          setModalOpen(true);
        } else {
          setModalOpen(false);
        }
      } catch {
        // The action fails closed (throws) when there is no per-user principal to audit against
        // (e.g. the no-auth staged-rollout fallback) or on a transient error — surface a friendly
        // hint rather than an uncaught rejection. Never echoes the underlying error (could name a
        // field/config).
        if (genRef.current !== gen) return; // don't surface a stale error over a newer resolution
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }, [resetReveal, fetchSeed, commitResolved]);

  // Resolve directly by payer label (the on-load default + the "Heating up" chips). A brand-new payer
  // cohort: rank-1. Sets `byPayer` so a window change re-resolves this payer.
  const resolveByPayer = useCallback((payer: string, w: QualifyWindowDays) => {
    setHint(null);
    resetReveal();
    const gen = ++genRef.current; // this chip resolve is now the authoritative resolution
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshotByPayer({ payer, windowDays: w });
        const payerName = snap.resolved?.payerName ?? null;
        const rank1 = snap.resolved ? snap.facilities[0]?.facilityKey ?? null : null;
        const seed = payerName && rank1 ? await fetchSeed(payerName, rank1, w) : EMPTY_PAGE;
        if (genRef.current !== gen) return; // a newer resolution (e.g. a search) superseded this — discard
        commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: rank1, window: w }, seed);
        setHasSearched(true);
        setByPayer(payer);
        setModalOpen(false);
      } catch {
        if (genRef.current !== gen) return; // don't surface a stale error over a newer resolution
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }, [resetReveal, fetchSeed, commitResolved]);

  // Window change — re-resolve for the new window (ratings + the identifier's landing facility are window-
  // dependent). TWO paths: the PAYER path (Heating-up chip / on-load) keeps the selected facility across the
  // window change (facility-persist, no rank-1 teleport); the SEARCH path RE-LANDS on the identifier's facility
  // for the new window (Fix A — a member's activity, and thus its landing facility, can move between windows),
  // or shows honest-empty when it has no ranked in-window claims.
  const onWindow = (w: QualifyWindowDays) => {
    const prev = cohortRef.current;
    const next = apply({ type: 'CHANGE_WINDOW', window: w }); // window + reset now; keeps facility (optimistic)
    if (!prev.payer) return; // nothing resolved yet — just track the window (the movers effect refreshes chips)
    resetReveal();
    const gen = ++genRef.current;
    startTransition(async () => {
      try {
        if (byPayer) {
          // PAYER path: re-resolve by payer; same payer → keep facility; changed → rank-1.
          const snap = await getQualifySnapshotByPayer({ payer: byPayer, windowDays: w });
          const payerName = snap.resolved?.payerName ?? null;
          if (genRef.current !== gen) return;
          if (payerName && payerName === prev.payer && next.facility) {
            const seed = await fetchSeed(payerName, next.facility, w);
            if (genRef.current !== gen) return;
            setSnapshot(snap);
            setFacilityCases(seed.claims);
            setHasMore(seed.hasMore);
            setNextCursor(seed.nextCursor);
          } else {
            const rank1 = snap.resolved ? snap.facilities[0]?.facilityKey ?? null : null;
            const seed = payerName && rank1 ? await fetchSeed(payerName, rank1, w) : EMPTY_PAGE;
            if (genRef.current !== gen) return;
            commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: rank1, window: w }, seed);
          }
        } else {
          // SEARCH path: re-resolve the identifier and RE-LAND on its facility for the new window (Fix A), or
          // honest-empty (landing null). Pure display — no drill narrow to recompute.
          const snap = await getQualifySnapshot({ query, windowDays: w });
          const payerName = snap.resolved?.payerName ?? null;
          if (genRef.current !== gen) return;
          const landing = snap.identifierLandingFacility;
          const seed = payerName && landing ? await fetchSeed(payerName, landing, w) : EMPTY_PAGE;
          if (genRef.current !== gen) return;
          commitResolved(snap, { type: 'RESOLVE_PAYER', payer: payerName, facility: landing, window: w }, seed);
        }
        setModalOpen(false);
      } catch {
        if (genRef.current !== gen) return;
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  };

  // Facility row click → SWITCH_FACILITY (keeps payer+window, resets the cursor stack). No-ops on the
  // already-selected row, then fetches page 0.
  const selectFacility = useCallback(
    (facilityKey: string) => {
      const c = cohortRef.current;
      if (!c.payer || facilityKey === c.facility) return;
      fetchCases(apply({ type: 'SWITCH_FACILITY', facility: facilityKey }));
    },
    [apply, fetchCases],
  );

  // Phase 3: open the cohort slide-over for one patient group. The claim id is the non-PHI synthetic
  // rollup id; the server re-derives the cohort token, audits, floor-gates, and strips dollars.
  const viewCohort = useCallback((claimId: number, label: string) => {
    const c = cohortRef.current;
    if (!c.payer || !c.facility) return;
    setCohortSheet({ label, data: null, loading: true });
    void (async () => {
      try {
        const res = await getQualifyPatientCohort({
          payer: c.payer!,
          facility: c.facility!,
          windowDays: c.window,
          claimId,
        });
        setCohortSheet((cur) => (cur && cur.label === label ? { ...cur, data: res, loading: false } : cur));
      } catch {
        setCohortSheet(null);
        setHint('Qualify is unavailable right now. Please try again.');
      }
    })();
  }, []);

  // Pager steps — walk the SAME cohort's cursor stack. PAGE_PREV steps back to the stored cursor; PAGE_NEXT
  // advances, pushing the last fetch's nextCursor. Guarded by hasPrev/hasMore at the call.
  const goPrevPage = useCallback(() => {
    const c = cohortRef.current;
    if (c.page > 0 && c.facility) fetchCases(apply({ type: 'PAGE_PREV' }));
  }, [apply, fetchCases]);
  const goNextPage = useCallback(() => {
    const c = cohortRef.current;
    if (hasMore && c.facility) fetchCases(apply({ type: 'PAGE_NEXT', nextCursor }));
  }, [apply, fetchCases, hasMore, nextCursor]);

  // On load, land POPULATED: fetch the "Heating up" movers (for the quick-pick chip row) and resolve
  // the top one (highest distinct-patient mover). If there are no movers or the fetch fails, fall
  // through to the empty search prompt. Runs once.
  useEffect(() => {
    let alive = true;
    const w = cohortRef.current.window;
    (async () => {
      try {
        const m = await getQualifyMovers(w);
        if (!alive) return;
        setMovers(m.movers);
        const top = m.movers[0]?.label;
        if (top) resolveByPayer(top, w);
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

  // Keep the "Heating up" chip row tracking the window: re-fetch movers whenever the window changes
  // (the initial window is covered by the on-load effect above; skip the mount run to avoid a double
  // fetch). Chip-row only — does NOT re-resolve; onWindow already re-resolves the active payer/search.
  const moversInitDone = useRef(false);
  useEffect(() => {
    if (!moversInitDone.current) {
      moversInitDone.current = true;
      return;
    }
    let alive = true;
    getQualifyMovers(cohort.window)
      .then((m) => {
        if (alive) setMovers(m.movers);
      })
      .catch(() => {
        /* stale/failed movers just leave the prior chips — never blocks search */
      });
    return () => {
      alive = false;
    };
  }, [cohort.window]);

  // Auto-reveal the current scope in ONE audited bulk call while "Reveal all" is on — parity with the
  // collections grid + billing-audit work-table. It re-fires whenever facilityCases changes (a new
  // resolution/facility yields a fresh array), revealing each facility exactly once with its own audit.
  // Gated on canRevealPhi so a non-entitled role can never trigger a reveal. `revealedForRef` is claimed
  // SYNCHRONOUSLY before the await, which (a) dedupes a given scope to one fetch and (b) makes a
  // stale-scope commit — facilityCases still lagging the previous facility for one render after a switch
  // — a no-op instead of revealing the wrong facility. The write also CAPTURES the resolution identity
  // (genRef) WITHOUT bumping it and bails if a newer resolution superseded, so a stale reveal can't
  // repopulate PHI after a newer scope's resetReveal().
  useEffect(() => {
    if (!canRevealPhi || !revealAll) return;
    if (facilityCases.length === 0) return;
    if (revealedForRef.current === facilityCases) return; // this exact scope is already claimed
    revealedForRef.current = facilityCases; // claim BEFORE awaiting (see note above)
    const gen = genRef.current; // capture (don't bump) — same discipline as a per-scope resolve
    const ids = facilityCases.map((c) => c.id);
    setRevealing(true);
    setRevealError(null);
    void (async () => {
      try {
        const res = await revealQualifyRows(ids);
        if (genRef.current !== gen) return; // stale reveal — a newer resolution superseded it
        setRevealing(false);
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
        if (genRef.current !== gen) return; // stale reveal — a newer resolution superseded it
        setRevealing(false);
        setRevealError('Reveal is unavailable right now.');
      }
    })();
  }, [canRevealPhi, revealAll, facilityCases]);

  const resolved = snapshot?.resolved ?? null;
  // Human name of the selected facility, for the cases-panel scope label (display only, never PHI). Null when
  // the kept facility has no row in the current window's snapshot (e.g. zero volume after a window change).
  const selectedFacilityLabel =
    snapshot?.facilities.find((f) => f.facilityKey === cohort.facility)?.name ?? null;
  // Fix A honest-empty: an identifier search resolved but has no claim at any ranked in-window facility. The
  // claims panel reads "No in-window claims for <term> — try a wider window" (term = the ≤3 echo, or the
  // generic 'this member' for an exact search). null on the payer path / when the identifier DID land.
  const emptyIdentifierLabel = isIdentifierEmpty(resolved, snapshot?.identifierLandingFacility ?? null)
    ? identifierEmptyTerm(resolved)
    : null;

  return (
    <main className="mx-auto max-w-[1560px] space-y-4 p-6 sm:p-8">
      {/* page head + color-layer toggle */}
      <div className="flex items-end justify-between gap-5">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Qualify</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Admissions lead qualification · resolve a payer, read facility performance and recent cases
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={heatOn}
          onClick={() => setHeatOn((v) => !v)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"
        >
          <span>Color layer</span>
          <span className={['relative h-[22px] w-[38px] rounded-full transition-colors', heatOn ? 'bg-teal700' : 'bg-line'].join(' ')}>
            <span
              className={['absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-ths transition-all', heatOn ? 'left-[18px]' : 'left-0.5'].join(' ')}
            />
          </span>
        </button>
      </div>

      {/* filter / search bar */}
      <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-t-2 border-t-teal700 bg-card p-3.5 shadow-sm">
        <div className="relative min-w-[280px] max-w-[460px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(query, cohort.window);
            }}
            spellCheck={false}
            placeholder="3-letter alpha prefix or member ID"
            aria-label="Member ID or alpha prefix"
            className="h-10 w-full rounded-xl border bg-background pl-9 pr-3 text-sm text-ink900 outline-none focus:border-teal500 focus:bg-white focus:ring-4 focus:ring-teal50"
          />
        </div>
        <button
          type="button"
          onClick={() => runSearch(query, cohort.window)}
          disabled={isPending}
          className="rounded-xl border border-teal200 bg-teal50 px-4 py-2 text-[13px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-60"
        >
          {isPending ? 'Resolving…' : 'Resolve payer'}
        </button>
        <div className="h-6 w-px bg-line" />
        <div className="inline-flex rounded-full border bg-background p-0.5" role="group" aria-label="Time window">
          {QUALIFY_WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindow(w)}
              aria-pressed={cohort.window === w}
              className={['rounded-full px-3 py-1.5 text-xs font-semibold transition-colors', cohort.window === w ? 'bg-teal700 text-white' : 'text-muted-foreground hover:text-ink900'].join(' ')}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      {hint ? <p className="px-1 text-xs text-status-warn">{hint}</p> : null}

      {/* "Heating up" payer quick-pick — click a chip to resolve that payer (parity with mobile) */}
      <HeatingUpBar
        movers={movers}
        windowDays={cohort.window}
        activeLabel={byPayer}
        onOpen={(label) => resolveByPayer(label, cohort.window)}
      />

      {/* resolved context */}
      {resolved ? (
        <div className="flex flex-wrap items-center gap-3 px-0.5">
          <span className="inline-flex items-center gap-2 rounded-full bg-teal900 py-1.5 pl-3 pr-3.5 text-[13.5px] font-semibold text-white">
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal200">Resolved payer</span>
            {resolved.payerName}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {resolved.matchedOn === 'prefix' ? (
              <>
                matched on prefix <span className="font-mono text-ink900">{resolved.matchedValue}</span>
              </>
            ) : resolved.matchedOn === 'payer' ? (
              <>top payer this window</>
            ) : (
              <>matched on member ID</>
            )}{' '}
            · <span className="font-mono text-ink900">{resolved.totalCharges.toLocaleString('en-US')}</span> charges across{' '}
            <span className="font-mono text-ink900">{resolved.facilityCount}</span> facilities · window{' '}
            <span className="font-mono text-ink900">{formatWindowRange(resolved.windowStart, resolved.windowEnd)}</span>
          </span>
        </div>
      ) : null}

      {/* grid or empty prompt */}
      {snapshot && snapshot.resolved ? (
        <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[340px_1fr]">
          <div className="min-[960px]:col-span-2 -mb-2 flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-muted-foreground">Level of care</span>
            {(['IP', 'OP', 'BOTH'] as const).map((loc) => (
              <button
                key={loc}
                type="button"
                aria-pressed={locFilter === loc}
                onClick={() => setLocFilter((cur) => (cur === loc ? null : loc))}
                className={[
                  'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
                  locFilter === loc
                    ? 'border-teal500 bg-teal50 text-teal700'
                    : 'border-teal200 bg-card text-muted-foreground hover:bg-teal50',
                ].join(' ')}
              >
                {loc === 'BOTH' ? 'Both' : loc}
              </button>
            ))}
          </div>
          <FacilityPanel
            facilities={filterFacilitiesByLoc(snapshot.facilities, locFilter)}
            hasAmounts={hasAmounts}
            heatOn={heatOn}
            selectedKey={cohort.facility}
            onSelect={selectFacility}
          />
          <div
            aria-busy={isFacilityPending}
            className={['transition-opacity', isFacilityPending ? 'opacity-60' : ''].join(' ')}
          >
            <CasesTable
              claims={facilityCases}
              hasAmounts={hasAmounts}
              heatOn={heatOn}
              facilityBuckets={facilityBuckets}
              facilityLabel={selectedFacilityLabel}
              canReveal={canRevealPhi}
              revealed={revealed}
              revealAll={revealAll}
              revealing={revealing}
              revealError={revealError}
              onToggleRevealAll={() => setRevealAll((v) => !v)}
              onViewCohort={viewCohort}
              page={cohort.page + 1}
              hasPrev={cohort.page > 0}
              hasNext={hasMore}
              paging={isFacilityPending}
              onPrevPage={goPrevPage}
              onNextPage={goNextPage}
              emptyIdentifierLabel={emptyIdentifierLabel}
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
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Resolving…
        </div>
      ) : (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          {hasSearched
            ? 'No payer resolved for that identifier in the selected window.'
            : 'Search a member ID or 3-letter alpha prefix to resolve a payer and see facility performance and recent cases.'}
        </div>
      )}

      <VobModal open={modalOpen} query={echo} onClose={() => setModalOpen(false)} />
    </main>
  );
}
