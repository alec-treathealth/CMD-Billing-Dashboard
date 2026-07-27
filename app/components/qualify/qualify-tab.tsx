'use client';

/**
 * Qualify tab — the COMPOSE-BAR container (Phase 1 of the compose-bar rework). Replaces the old
 * tab-based single-mode resolver with a Collections-style AND-composed multi-filter bar, while KEEPING
 * Qualify's own outputs (the Heating-Up ticker, the live match count, the recent-claims panel). The
 * browser's sole data path is the Qualify Server Actions (this component is the only caller).
 *
 * INPUT MODEL (the swap): four MultiSelectTagPickers — Facility · Payer · Employer · Funding — plus a
 * PHI row (Member ID · Alpha prefix · Group # · Client Name) all AND-compose into ONE CmdExplorer-shaped
 * filter (the Qualify-side QualifyComposeInput). An empty field = NO restriction (never match-nothing).
 * The derived filter drives TWO reads: getQualifyMatchSummary (the live "N charge lines match" count +
 * non-dollar percentages) and getQualifyComposedCases (the claim rows for the panel). Both run through
 * Qualify's amounts choke point server-side, so an admissions_seat sees the count + percentages with
 * ZERO dollars. Debounced + recency-guarded (genRef) so a slow earlier response can't overwrite a newer.
 *
 * PHI ROW (Change C divergence — do NOT "fix" to Collections parity): Qualify is the admissions-facing
 * surface where person-first lookup is the natural entry, so it carries a FOURTH PHI input — Client Name —
 * that Collections deliberately has no equivalent for. All four PHI inputs are canRevealPhi-gated; Client
 * Name is ADDITIONALLY behind QUALIFY_CLIENT_NAME_ENABLED (contract.ts) and stays hidden until migration
 * 0067 + the owner-run name backfill land. The raw PHI terms live in component state only — never a URL,
 * never a log; the server mints the blind indexes from them. See docs/veris-data-notes.md ("Qualify
 * Client-Name (Change C) activation") — flipping the flag ALSO requires making the live count name-aware.
 *
 * TICKER (Facilities Heating Up): stays BOOK-WIDE in Phase 1 — only the window control refetches it (the
 * compose pickers do NOT re-scope the ticker or the KPI tiles; employer/funding are pure filter
 * dimensions now, a deliberate behavior change from the pre-compose tab). A ticker-card click REPLACES
 * the whole filter set with exactly {that facility, its dominant payer} and PINS the marquee
 * (tickerPinned — a flag set ONLY by a card click and cleared only by the clear actions, NEVER derived
 * from the facility selection). Cards whose facility is currently selected read pressed (activeFacilityKeys).
 *
 * URL STATE: the NON-PHI selection arrays (facilities/payers/employers/funding) + window + LOC survive
 * refresh and are shareable (router.replace, never push). PHI terms NEVER touch the URL — enforced
 * structurally in urlState.ts (no field exists for them).
 *
 * OUT OF SCOPE (Phase 2, frozen): the FacilityPanel single-payer ranking + the lighter context line +
 * the VOB single-payer probe land in the NEXT commit. The book KPI tiles + ticker keep their current
 * book-wide behavior — buildBookKpisQuery / buildFacilityTrendQuery are untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Building2, Eye, EyeOff, Landmark, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  getQualifyMatchSummary,
  getQualifyComposedCases,
  getQualifySnapshotByPayer,
  getQualifyPayerEverBilled,
  getQualifyResolvePayer,
  getQualifyPatientCohort,
  getQualifyBookKpis,
  getQualifyFacilityTrends,
  loadQualifyFacilityOptions,
  loadQualifyPayerOptions,
  loadQualifyEmployers,
  revealQualifyRows,
} from '@/lib/qualify/actions';
import {
  QUALIFY_CLIENT_NAME_ENABLED,
  QUALIFY_REVEAL_BATCH_CAP,
  qualifyWindowLabel,
  trailingWindow,
  type QualifyBookKpis,
  type QualifyClaim,
  type QualifyComposeInput,
  type QualifyFacilityTrend,
  type QualifyMatchSummary,
  type QualifyPhi,
  type QualifyPatientCohort,
  type QualifySnapshot,
  type QualifyWindow,
} from '@/lib/qualify/contract';
import type { CmdEmployerOption } from '@/lib/actions';
import { MultiSelectTagPicker, type PickerOption } from '@/components/ui/multi-select-tag-picker';
import { buildQualifySearchParams, parseQualifySearchParams } from '@/lib/qualify/urlState';
import { filterFacilitiesByLoc, filterClaimsByLoc, type QualifyLocFilter } from '@/lib/qualify/groupClaims';
import type { RatingBucket } from '@/lib/qualify/rating';
import { CasesTable } from '@/components/qualify/cases-table';
import { CohortSheet } from '@/components/qualify/cohort-sheet';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { BookKpiTiles, HeatingUpCards, HeatingUpSkeleton, MatchCountReadout } from '@/components/qualify/overview';
import { WindowControl } from '@/components/qualify/window-control';
import { VobModal } from '@/components/qualify/vob-modal';
import { QualifyLandingHero } from '@/components/qualify/landing-hero';

/** Debounce for the composed count + cases fetch (covers PHI-input keystrokes; picker clicks too). */
const COMPOSE_DEBOUNCE_MS = 350;
/** Employer type-ahead: min chars + debounce (server-driven, mirrors Collections). */
const EMPLOYER_MIN_CHARS = 3;

/** An empty facility-bucket map — CasesTable retains the prop but no longer colors from it. */
const NO_FACILITY_BUCKETS: Map<string, RatingBucket> = new Map();

export function QualifyTab({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const router = useRouter();

  // ── COMPOSE SELECTIONS (non-PHI, set-membership; the URL persists these) ──────────────────────────
  const [facilitySelection, setFacilitySelection] = useState<string[]>([]);
  const [payerSelection, setPayerSelection] = useState<string[]>([]);
  const [employerSelection, setEmployerSelection] = useState<string[]>([]);
  const [fundingSelection, setFundingSelection] = useState<string[]>([]);
  // ── PHI TERMS (raw; state-only, NEVER a URL/log — the server HMACs them to blind indexes) ─────────
  const [memberId, setMemberId] = useState('');
  const [alphaPrefix, setAlphaPrefix] = useState('');
  const [groupNumber, setGroupNumber] = useState('');
  const [clientName, setClientName] = useState(''); // Change C — dormant until QUALIFY_CLIENT_NAME_ENABLED

  const [windowSel, setWindowSel] = useState<QualifyWindow>(() => trailingWindow(30));
  const [locFilter, setLocFilter] = useState<QualifyLocFilter>(null);

  // ── OVERVIEW STRIP (book KPIs + Heating-Up trends) — window-tracked, book-wide (NOT compose-scoped) ─
  const [kpis, setKpis] = useState<QualifyBookKpis | null>(null);
  const [trends, setTrends] = useState<QualifyFacilityTrend[]>([]);
  const [overviewError, setOverviewError] = useState(false);
  const [initializing, setInitializing] = useState(true);

  // ── COMPOSED READS (live count + claim rows) ───────────────────────────────────────────────────
  const [summary, setSummary] = useState<QualifyMatchSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [composedCases, setComposedCases] = useState<QualifyClaim[]>([]);
  const [capped, setCapped] = useState(false);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState(false);

  // ── TICKER PIN — a DISTINCT flag, set ONLY by a card click, cleared ONLY by the clear actions. NEVER
  //    derived from the facility selection (deriving it would freeze the marquee whenever someone picks a
  //    facility in the picker or restores a filtered URL — a pause with no visible cause). ─────────────
  const [tickerPinned, setTickerPinned] = useState(false);

  // ── FACILITY PANEL — the payer-wide ranking, fetched ONLY when EXACTLY ONE payer is selected (decision
  //    4). Market is deliberately NOT passed ({} ) so employer/funding never narrow the ranking: the
  //    value-first rating (rating.ts) is the raw allowed% with no volume term, so a thin employer/funding
  //    slice — median ~2 distinct patients — would render a confident color off sampling noise (the
  //    ranking's own distinct-patient sample gate, sampleGate.ts, is the guard). Highlights the selected
  //    facilities; never intersects. ────────────────────────────────────────────────────────────────
  const [panelSnapshot, setPanelSnapshot] = useState<QualifySnapshot | null>(null);
  const panelGenRef = useRef(0);
  // When the user searches a single PHI identifier (alpha prefix / member id) with NO payer chip, we
  // resolve its dominant payer server-side and rank against THAT — so an identifier search doesn't force a
  // manual payer pick. `derivedPayer` null = not applicable OR the identifier was never seen.
  const [derivedPayer, setDerivedPayer] = useState<string | null>(null);
  const [derivedLoading, setDerivedLoading] = useState(false);
  const resolveGenRef = useRef(0);

  // ── VOB PATH — the payer we've PROVEN is never-billed (unwindowed probe); null = no VOB. `vobDismissed`
  //    remembers the payer the user closed the modal for, so it doesn't re-pop until the payer changes. ─
  const [vobPayer, setVobPayer] = useState<string | null>(null);
  const vobDismissedRef = useRef<string | null>(null);

  // ── PICKER OPTION VOCABULARIES ────────────────────────────────────────────────────────────────────
  const [facilityOptions, setFacilityOptions] = useState<PickerOption[]>([]);
  const [payerOptions, setPayerOptions] = useState<PickerOption[]>([]);
  // Employer is a SERVER type-ahead (the ~11.6k vocabulary is too large to load whole).
  const [employerOptions, setEmployerOptions] = useState<CmdEmployerOption[]>([]);
  const [employerLoading, setEmployerLoading] = useState(false);
  const [employerQuery, setEmployerQuery] = useState('');
  const [employerDisplay, setEmployerDisplay] = useState<Map<string, string>>(() => new Map());

  // ── PHI reveal (per-patient, audited) + the Change-B global toggle. In-memory ONLY (never localStorage). ─
  const [revealed, setRevealed] = useState<Map<number, QualifyPhi>>(() => new Map());
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;
  const [revealingKeys, setRevealingKeys] = useState<ReadonlySet<number>>(() => new Set());
  const [revealError, setRevealError] = useState<string | null>(null);
  const [globalReveal, setGlobalReveal] = useState(false);
  // Change B eligibility: canRevealPhi && amounts ⇔ super_admin/admin exactly (admissions_seat lacks amounts).
  const canGlobalReveal = canRevealPhi && viewerHasAmountsCapability;

  // Phase 3 patient-cohort slide-over (masked label + fetched context). Null = closed.
  const [cohortSheet, setCohortSheet] = useState<{ label: string; data: QualifyPatientCohort | null; loading: boolean } | null>(
    null,
  );

  // Recency guards — one for the compose fetch (count + cases + reveal), one for the overview ticker,
  // one for the payer+facility-scoped KPI tiles (Phase 2).
  const composeGenRef = useRef(0);
  const overviewGenRef = useRef(0);
  const kpiGenRef = useRef(0);

  const resetReveal = useCallback(() => {
    setRevealed(new Map());
    setRevealingKeys(new Set());
    setRevealError(null);
  }, []);

  // ── DERIVED: the compose filter + whether any restriction is active (client mirror of composeHasAny) ─
  const composeInput = useMemo<QualifyComposeInput>(
    () => ({
      facilities: facilitySelection.length > 0 ? facilitySelection : undefined,
      payers: payerSelection.length > 0 ? payerSelection : undefined,
      employers: employerSelection.length > 0 ? employerSelection : undefined,
      funding: fundingSelection.length > 0 ? fundingSelection : undefined,
      memberId: memberId.trim() || undefined,
      alphaPrefix: alphaPrefix.trim() || undefined,
      group: groupNumber.trim() || undefined,
      clientName: clientName.trim() || undefined,
      window: windowSel,
    }),
    [facilitySelection, payerSelection, employerSelection, fundingSelection, memberId, alphaPrefix, groupNumber, clientName, windowSel],
  );
  const hasAnyFilter =
    facilitySelection.length > 0 ||
    payerSelection.length > 0 ||
    employerSelection.length > 0 ||
    fundingSelection.length > 0 ||
    memberId.trim() !== '' ||
    alphaPrefix.trim() !== '' ||
    groupNumber.trim() !== '' ||
    (QUALIFY_CLIENT_NAME_ENABLED && clientName.trim() !== '');

  // Cards whose facility is currently selected read pressed. STABLE identity while the selection is
  // unchanged (so the memoized ticker subtree below doesn't re-render on unrelated count updates).
  const facilityKey = facilitySelection.join('');
  const activeFacilityKeys = useMemo(() => new Set(facilitySelection), [facilityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasAmounts = viewerHasAmountsCapability;

  // A single PHI identifier (alpha prefix / member id) with NO payer chip → we resolve its dominant payer
  // for the ranking (so an identifier search doesn't force a manual payer pick). Exactly one of the two,
  // and only when no payer is selected; group/client-name don't drive this derive.
  const identifierTerm = alphaPrefix.trim() || memberId.trim();
  const bothIdentifiers = alphaPrefix.trim() !== '' && memberId.trim() !== '';
  const singleIdentifier = payerSelection.length === 0 && identifierTerm !== '' && !bothIdentifiers ? identifierTerm : null;

  // ── OVERVIEW TICKER: Heating-Up trends. Phase 2 (Design B): BOOK-WIDE-WITHIN-PAYER — payer-scoped when
  //    EXACTLY ONE payer is selected, book-wide at 0 or 2+. Facility/employer/funding NEVER scope it
  //    (only payer + window are inputs). Owns TRENDS only; the KPI tiles are owned by their own effect.
  //    Also clears `initializing` on first settle (the mount effect no longer fetches the strip). ────────
  const refreshOverview = useCallback((w: QualifyWindow, payer: string | null) => {
    const ogen = ++overviewGenRef.current;
    getQualifyFacilityTrends(w, { payer })
      .then((tr) => {
        if (overviewGenRef.current !== ogen) return;
        setTrends(tr);
        setOverviewError(false);
      })
      .catch(() => {
        if (overviewGenRef.current !== ogen) return;
        setOverviewError(true);
      })
      .finally(() => {
        if (overviewGenRef.current === ogen) setInitializing(false);
      });
  }, []);

  // ── ON LOAD: restore non-PHI selections + window + LOC from the URL, load the option vocabularies, and
  //    fetch the book-wide overview strip. One paint. The compose fetch effect below fires naturally once
  //    the restored selections land (no separate restore fetch). ────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const url = parseQualifySearchParams(new URLSearchParams(globalThis.location?.search ?? ''));
    if (url.facilities.length) setFacilitySelection(url.facilities);
    if (url.payers.length) setPayerSelection(url.payers);
    if (url.employers.length) setEmployerSelection(url.employers);
    if (url.funding.length) setFundingSelection(url.funding);
    setWindowSel(url.window);
    if (url.loc) setLocFilter(url.loc);

    void loadQualifyFacilityOptions().then((r) => {
      if (!alive || !r.ok) return;
      setFacilityOptions(r.facilities.map((f) => ({ value: f.facility, display: f.facility_name ?? f.facility, badge: f.care_setting })));
    });
    void loadQualifyPayerOptions().then((r) => {
      if (!alive || !r.ok) return;
      setPayerOptions(r.payers.map((p) => ({ value: p, display: p })));
    });
    // The overview strip (ticker + KPI tiles) is fetched by the dedicated effects below, which fire on
    // mount with the restored selections — no strip fetch here, and `initializing` clears when the
    // ticker fetch (refreshOverview) first settles.
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── KPI TILES (Phase 2, Design B): re-scoped on PAYER + FACILITY selection (+ window) ONLY. Employer/
  //    funding are deliberately EXCLUDED — they'd shred the slice to ~1 patient; they narrow the count +
  //    cases list, never the tiles. Debounced + gen-guarded like the compose fetch; this effect is the
  //    SOLE owner of `kpis` (the ticker fetch above no longer sets it). Empty selections → book-wide.
  //    Refetch frequency: one fetch per payer/facility tag toggle or window change; ZERO on
  //    employer/funding/PHI/typing (those aren't deps). ────────────────────────────────────────────────
  useEffect(() => {
    const kgen = ++kpiGenRef.current;
    const t = setTimeout(() => {
      getQualifyBookKpis(windowSel, {
        payers: payerSelection.length > 0 ? payerSelection : undefined,
        facilities: facilitySelection.length > 0 ? facilitySelection : undefined,
      })
        .then((k) => {
          if (kpiGenRef.current !== kgen) return;
          setKpis(k);
        })
        .catch(() => {
          // leave the prior tiles in place; the strip-level error is surfaced by the ticker fetch.
        });
    }, COMPOSE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [payerSelection, facilitySelection, windowSel]);

  // ── HEATING-UP TICKER (Phase 2, Design B): refetch trends on PAYER + WINDOW only. FACILITY, employer,
  //    and funding are NOT deps — they never scope the ticker (facility especially: keeping it out means
  //    a facility toggle can't refetch/remount the marquee mid-scroll). Payer-scoped at exactly one payer,
  //    book-wide at 0 or 2+. Debounced + gen-guarded (refreshOverview bumps overviewGenRef); fires on mount. ─
  useEffect(() => {
    const payer = payerSelection.length === 1 ? payerSelection[0]! : null;
    const t = setTimeout(() => refreshOverview(windowSel, payer), COMPOSE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [payerSelection, windowSel, refreshOverview]);

  // ── COMPOSE FETCH: the live match count + the composed claim rows, debounced + recency-guarded. No
  //    filter ⇒ clear + no fetch (the landing hero shows). ──────────────────────────────────────────────
  useEffect(() => {
    if (!hasAnyFilter) {
      setSummary(null);
      setComposedCases([]);
      setCapped(false);
      setCasesError(false);
      setSummaryLoading(false);
      setCasesLoading(false);
      return;
    }
    setSummaryLoading(true);
    setCasesLoading(true);
    const gen = ++composeGenRef.current;
    const t = setTimeout(() => {
      getQualifyMatchSummary(composeInput)
        .then((s) => {
          if (composeGenRef.current !== gen) return;
          setSummary(s);
          setSummaryLoading(false);
          // ── VOB PATH — fire the "never billed, ever" probe ONLY when the composed count is 0 AND
          //    exactly one payer is selected AND NO PHI narrow is active. A name/member/prefix/group
          //    zero must read as "no match", never "never billed" — so PHI presence hard-blocks the
          //    probe. Every other empty (multi-payer, over-narrow combo, wrong window) falls through to
          //    the plain empty state. The probe itself is unwindowed + cross-tenant (server-side). ─────
          const onePayer = payerSelection.length === 1;
          const noPhi =
            memberId.trim() === '' && alphaPrefix.trim() === '' && groupNumber.trim() === '' && clientName.trim() === '';
          const payer = payerSelection[0];
          if (s.count === 0 && onePayer && noPhi && payer && vobDismissedRef.current !== payer) {
            void getQualifyPayerEverBilled(payer).then((r) => {
              if (composeGenRef.current !== gen) return;
              setVobPayer(r.ok && r.count === 0 ? payer : null);
            });
          } else {
            setVobPayer(null);
          }
        })
        .catch(() => {
          if (composeGenRef.current !== gen) return;
          setSummary(null);
          setSummaryLoading(false);
          setVobPayer(null);
        });
      getQualifyComposedCases(composeInput)
        .then((r) => {
          if (composeGenRef.current !== gen) return;
          resetReveal(); // new result set → drop the prior scope's reveal cache (globalReveal re-reveals below)
          setComposedCases(r.claims);
          setCapped(r.capped);
          setCasesError(false);
          setCasesLoading(false);
        })
        .catch(() => {
          if (composeGenRef.current !== gen) return;
          setComposedCases([]);
          setCapped(false);
          setCasesError(true);
          setCasesLoading(false);
        });
    }, COMPOSE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // composeInput is recomposed each render; depend on its inputs (stable state identities) instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilitySelection, payerSelection, employerSelection, fundingSelection, memberId, alphaPrefix, groupNumber, clientName, windowSel, hasAnyFilter, resetReveal]);

  // ── IDENTIFIER → PAYER resolve: when the user searched a single PHI identifier with no payer chip,
  //    resolve its dominant payer so the ranking can render without forcing a manual payer pick. ────────
  useEffect(() => {
    if (!singleIdentifier) {
      setDerivedPayer(null);
      setDerivedLoading(false);
      return;
    }
    const rgen = ++resolveGenRef.current;
    setDerivedLoading(true);
    getQualifyResolvePayer(singleIdentifier)
      .then((r) => {
        if (resolveGenRef.current !== rgen) return;
        setDerivedPayer(r.ok ? r.payer : null);
        setDerivedLoading(false);
      })
      .catch(() => {
        if (resolveGenRef.current !== rgen) return;
        setDerivedPayer(null);
        setDerivedLoading(false);
      });
  }, [singleIdentifier]);

  // ── FACILITY PANEL fetch: the payer-wide ranking for the panel's payer — either the ONE selected payer
  //    OR the payer derived from a single-identifier search. 0/2+ payers with no resolvable identifier ⇒
  //    no fetch (panel hidden behind a note). Market is NOT passed — the ranking stays market-blind so a
  //    thin employer/funding slice can't drive the value-first rating below a reliable sample (the raw
  //    allowed% has no volume term; the distinct-patient sample gate handles thinness — decision 4 + B2). ─
  const panelPayer = payerSelection.length === 1 ? payerSelection[0]! : singleIdentifier ? derivedPayer : null;
  useEffect(() => {
    if (!panelPayer) {
      setPanelSnapshot(null);
      return;
    }
    const pgen = ++panelGenRef.current;
    getQualifySnapshotByPayer({ payer: panelPayer, window: windowSel })
      .then((snap) => {
        if (panelGenRef.current !== pgen) return;
        setPanelSnapshot(snap);
      })
      .catch(() => {
        if (panelGenRef.current !== pgen) return;
        setPanelSnapshot(null);
      });
  }, [panelPayer, windowSel]);

  // ── URL STATE: persist the NON-PHI selection arrays + window + LOC (replace, never push). PHI is
  //    excluded by construction — buildQualifySearchParams has no field for it. ─────────────────────────
  useEffect(() => {
    if (initializing) return;
    const qs = buildQualifySearchParams({
      facilities: facilitySelection,
      payers: payerSelection,
      employers: employerSelection,
      funding: fundingSelection,
      window: windowSel,
      loc: locFilter,
    });
    router.replace(qs ? `?${qs}` : globalThis.location?.pathname ?? '/qualify', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializing, facilitySelection, payerSelection, employerSelection, fundingSelection, windowSel, locFilter]);

  // Safety: if every filter is cleared (incl. a manual chip removal down to empty), drop the pin so the
  // marquee doesn't stay paused with nothing selected. The explicit clear actions also drop it directly.
  useEffect(() => {
    if (!hasAnyFilter && tickerPinned) setTickerPinned(false);
  }, [hasAnyFilter, tickerPinned]);

  // ── EMPLOYER type-ahead (server-side; ≥3 chars, debounced). ──────────────────────────────────────
  useEffect(() => {
    const q = employerQuery.trim();
    if (q.length < EMPLOYER_MIN_CHARS) {
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

  // ── PER-PATIENT reveal (audited; unchanged for every role). ───────────────────────────────────────
  const revealPatient = useCallback(
    (patientKey: number, claimIds: number[]) => {
      if (!canRevealPhi || claimIds.length === 0) return;
      const ids = claimIds.slice(0, QUALIFY_REVEAL_BATCH_CAP);
      if (ids.every((id) => revealedRef.current.has(id))) return;
      const gen = composeGenRef.current; // capture (don't bump) — a newer compose fetch discards this
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
          if (composeGenRef.current !== gen) return;
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
          if (composeGenRef.current !== gen) return;
          clearKey();
          setRevealError('Reveal is unavailable right now.');
        }
      })();
    },
    [canRevealPhi],
  );

  // ── CHANGE B: the GLOBAL persistent reveal. When ON, each new result set's rows re-reveal through the
  //    SAME audited path, chunked to the 50 batch cap (gen-guarded). ──────────────────────────────────
  useEffect(() => {
    if (!globalReveal || !canGlobalReveal || composedCases.length === 0) return;
    const ids = composedCases.map((c) => c.id).filter((id) => !revealedRef.current.has(id));
    if (ids.length === 0) return;
    const gen = composeGenRef.current; // capture — a newer result set discards these landings
    let alive = true;
    void (async () => {
      for (let i = 0; i < ids.length; i += QUALIFY_REVEAL_BATCH_CAP) {
        const chunk = ids.slice(i, i + QUALIFY_REVEAL_BATCH_CAP);
        try {
          const res = await revealQualifyRows(chunk);
          if (!alive || composeGenRef.current !== gen) return;
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
          if (!alive || composeGenRef.current !== gen) return;
          setRevealError('Reveal is unavailable right now.');
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [globalReveal, canGlobalReveal, composedCases]);

  const toggleGlobalReveal = useCallback(() => {
    setGlobalReveal((on) => {
      if (on) resetReveal(); // OFF re-masks the whole surface
      return !on;
    });
  }, [resetReveal]);

  // ── Phase 3 cohort slide-over — derive the payer/facility AUDIT CONTEXT from the clicked claim (the
  //    cohort itself is re-derived server-side from claimId; payer/facility are context only). ───────────
  const viewCohort = useCallback(
    (claimId: number, label: string) => {
      const claim = composedCases.find((c) => c.id === claimId);
      setCohortSheet({ label, data: null, loading: true });
      void (async () => {
        try {
          const res = await getQualifyPatientCohort({
            payer: claim?.payerName ?? '',
            facility: claim?.facilityName ?? '',
            window: windowSel,
            claimId,
          });
          setCohortSheet((cur) => (cur && cur.label === label ? { ...cur, data: res, loading: false } : cur));
        } catch {
          setCohortSheet(null);
        }
      })();
    },
    [composedCases, windowSel],
  );

  // ── Window change: just set the window — the KPI-tiles, ticker, and compose effects all key on
  //    windowSel and refetch themselves (no imperative strip refresh needed). ─────────────────────────
  const onWindow = useCallback((w: QualifyWindow) => {
    setWindowSel(w);
  }, []);

  // ── Ticker-card click — REPLACE the whole filter set with exactly {that facility, its dominant payer}
  //    (never append: a second click must not push the payer count to 2+) and PIN the marquee. The
  //    auto-added payer chip is behaviorally/visually identical to a hand-picked one (same picker state). ─
  const openTrendCard = useCallback((t: QualifyFacilityTrend) => {
    if (!t.dominantPayer) return;
    setTickerPinned(true);
    setFacilitySelection([t.facilityKey]);
    setPayerSelection([t.dominantPayer]);
    setEmployerSelection([]);
    setFundingSelection([]);
    setMemberId('');
    setAlphaPrefix('');
    setGroupNumber('');
    setClientName('');
  }, []);

  // ── Picker plumbing ───────────────────────────────────────────────────────────────────────────────
  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (value: string) =>
    setter((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  const toggleFacility = useCallback(toggleIn(setFacilitySelection), []);
  const togglePayer = useCallback(toggleIn(setPayerSelection), []);
  const toggleEmployer = useCallback(toggleIn(setEmployerSelection), []);
  const toggleFunding = useCallback(toggleIn(setFundingSelection), []);
  const clearFacilities = useCallback(() => setFacilitySelection([]), []);
  const clearPayers = useCallback(() => setPayerSelection([]), []);
  const clearEmployers = useCallback(() => setEmployerSelection([]), []);
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

  const clearAll = useCallback(() => {
    composeGenRef.current += 1;
    setFacilitySelection([]);
    setPayerSelection([]);
    setEmployerSelection([]);
    setFundingSelection([]);
    setMemberId('');
    setAlphaPrefix('');
    setGroupNumber('');
    setClientName('');
    setTickerPinned(false);
    setSummary(null);
    setComposedCases([]);
    setCapped(false);
    setCasesError(false);
    setPanelSnapshot(null);
    setVobPayer(null);
    vobDismissedRef.current = null;
    resetReveal();
  }, [resetReveal]);

  // ── Change D: the ONE LOC lens (client-side view filter) — scopes the ticker, the facility ranking,
  //    and the case rows. ─────────────────────────────────────────────────────────────────────────────
  const visibleTrends = useMemo(() => filterFacilitiesByLoc(trends, locFilter), [trends, locFilter]);
  const visibleCases = useMemo(() => filterClaimsByLoc(composedCases, locFilter), [composedCases, locFilter]);
  const panelFacilities = useMemo(
    () => filterFacilitiesByLoc(panelSnapshot?.facilities ?? [], locFilter),
    [panelSnapshot, locFilter],
  );

  const summaryHasAmounts = summary?.viewerHasAmountsCapability ?? hasAmounts;
  // ── Lighter CONTEXT LINE (replaces the removed hero band): window · payer(s) · facility count · total
  //    charges. Total charges is null for admissions_seat (server-stripped) so it's simply omitted. When
  //    the payer was DERIVED from an identifier search, name it as such rather than "all payers". ────────
  const payerSummary =
    payerSelection.length === 1
      ? payerSelection[0]!
      : payerSelection.length > 1
        ? `${payerSelection.length} payers`
        : panelPayer
          ? `${panelPayer} · from your search`
          : 'all payers';
  const contextFacilityCount = panelPayer ? panelSnapshot?.facilities.length ?? null : null;
  // KPI-tile scope caption (Design B: payer + facility only). Null = book-wide.
  const kpiScopeLabel =
    payerSelection.length === 0 && facilitySelection.length === 0
      ? null
      : [
          payerSelection.length === 1
            ? payerSelection[0]!
            : payerSelection.length > 1
              ? `${payerSelection.length} payers`
              : null,
          facilitySelection.length === 1
            ? '1 facility'
            : facilitySelection.length > 1
              ? `${facilitySelection.length} facilities`
              : null,
        ]
          .filter(Boolean)
          .join(' · ') || null;
  // Design B affordance: employer/funding narrow the list, NOT the tiles — say so when they're active,
  // so a non-moving tile reads as intentional, not a bug.
  const marketNarrowActive = employerSelection.length > 0 || fundingSelection.length > 0;
  // Ticker scope (Design B): payer-scoped at exactly one payer, book-wide otherwise.
  const tickerScopePayer = payerSelection.length === 1 ? payerSelection[0]! : null;
  const billedText =
    summaryHasAmounts && summary?.totalCharge != null
      ? summary.totalCharge.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      : null;

  // SR-only announcement (the compose count updates silently otherwise).
  const liveMessage = !hasAnyFilter
    ? ''
    : summaryLoading
      ? 'Matching…'
      : summary
        ? `${summary.count.toLocaleString('en-US')} charge lines match`
        : 'Match count unavailable';

  return (
    <main className="mx-auto max-w-[1680px] space-y-4 p-6 sm:p-8">
      <div>
        <h1 className="font-display text-3xl font-medium tracking-tight">Qualify</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Admissions lead qualification · compose filters below · the book at a glance above
        </p>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {overviewError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card px-4 py-3 text-sm"
        >
          <span className="text-status-danger">Couldn’t load the book overview — your filters still work.</span>
          <button
            type="button"
            onClick={() => refreshOverview(windowSel, tickerScopePayer)}
            className="rounded-lg border border-line px-3 py-1 text-[13px] font-semibold text-ink900 transition-colors hover:bg-background"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* ── OVERVIEW TICKER: Facilities Heating Up — auto-scrolling, ABOVE the compose bar. Phase 2
          (Design B): book-wide-within-payer — payer-scoped at exactly one payer, book-wide otherwise;
          facility/employer/funding never rescope it. A card click REPLACES the filter set + pins. ── */}
      {visibleTrends.length > 0 ? (
        <HeatingUpCards
          trends={visibleTrends}
          window={windowSel}
          scopePayer={tickerScopePayer}
          activeFacilityKeys={activeFacilityKeys}
          pinned={tickerPinned}
          onOpen={openTrendCard}
        />
      ) : initializing ? (
        <HeatingUpSkeleton />
      ) : null}

      {/* ── COMPOSE BAR: four pickers + PHI row + window + LOC + reveal, in the teal finder card ── */}
      <div className="rounded-2xl border border-t-[3px] border-t-teal700 bg-card p-4 shadow-ths-sm">
        <div className="flex flex-wrap items-start gap-3.5">
          <MultiSelectTagPicker
            label="Facility"
            placeholder="Filter by facility…"
            icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
            options={facilityOptions}
            selected={facilitySelection}
            onToggle={toggleFacility}
            onClear={clearFacilities}
          />
          <MultiSelectTagPicker
            label="Payer"
            placeholder="Filter by payer…"
            icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
            options={payerOptions}
            selected={payerSelection}
            onToggle={togglePayer}
            onClear={clearPayers}
          />
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
            minChars={EMPLOYER_MIN_CHARS}
            displayOverride={employerDisplay}
          />
          {/* Funding stays a PICKER (Collections parity) — the earlier two-toggle-pill plan is dropped. */}
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

        {/* PHI ROW — canRevealPhi-gated. Qualify carries a FOURTH input (Client Name) that Collections
            deliberately does NOT — the admissions-first person lookup (Change C). Do NOT "fix" this into
            Collections parity. Client Name is additionally behind QUALIFY_CLIENT_NAME_ENABLED (dormant
            until migration 0067 + the name backfill); raw terms are state-only (never URL/log). */}
        {canRevealPhi ? (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-dashed border-line pt-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Eye className="h-3.5 w-3.5" aria-hidden />
              PHI narrows
            </div>
            <PhiInput label="Member ID" value={memberId} onChange={setMemberId} placeholder="Exact member ID" />
            <PhiInput label="Alpha prefix" value={alphaPrefix} onChange={setAlphaPrefix} placeholder="3-letter prefix" />
            <PhiInput label="Group #" value={groupNumber} onChange={setGroupNumber} placeholder="Group number" />
            {QUALIFY_CLIENT_NAME_ENABLED ? (
              <PhiInput label="Client name" value={clientName} onChange={setClientName} placeholder="Exact client name · audited" />
            ) : null}
          </div>
        ) : null}

        {/* Controls row: window · LOC lens · clear · global reveal */}
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <WindowControl window={windowSel} currentYear={new Date().getFullYear()} onChange={onWindow} />
          <div className="h-7 w-px bg-line" />
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
          {hasAnyFilter ? (
            <button
              type="button"
              onClick={clearAll}
              aria-label="Clear all filters"
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-teal700 px-3.5 text-[13px] font-bold text-white shadow-ths-sm transition-colors hover:bg-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/50"
            >
              <RotateCcw aria-hidden className="h-4 w-4" />
              Clear filters
            </button>
          ) : null}
          {canGlobalReveal ? (
            <button
              type="button"
              role="switch"
              aria-checked={globalReveal}
              onClick={toggleGlobalReveal}
              title="Reveal PHI identifiers across the results — every reveal is audited"
              className={[
                'ml-auto inline-flex h-9 items-center gap-2.5 rounded-xl border px-3.5 text-[13px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
                globalReveal
                  ? 'border-coral400 bg-coral50 text-coral600'
                  : 'border-line bg-background text-ink600 hover:bg-surface hover:text-ink900',
              ].join(' ')}
            >
              {globalReveal ? <Eye aria-hidden className="h-4 w-4" /> : <EyeOff aria-hidden className="h-4 w-4" />}
              <span>Reveal PHI Identifiers</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* ── KPI TILES (Phase 2: scoped to payer + facility; sample-gated) ── */}
      <BookKpiTiles kpis={kpis} locActive={locFilter !== null} scopeLabel={kpiScopeLabel} />
      {marketNarrowActive ? (
        <p className="mt-2 text-[11px] text-ink400">
          Tiles &amp; ratings reflect <b className="font-semibold text-ink600">payer + facility</b>. Employer &amp;
          funding filter the matching claims below — they don’t re-scope these tiles.
        </p>
      ) : null}

      {/* ── CONTEXT LINE + LIVE MATCH COUNT + FACILITY RANKING + COMPOSED CASES ── */}
      {hasAnyFilter ? (
        <>
          {/* Lighter context line (the old resolved-payer hero band is gone). Non-dollar for admissions_seat. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-surface px-4 py-2.5 text-[12px] text-ink600">
            <span className="font-semibold text-ink900">{qualifyWindowLabel(windowSel)}</span>
            <span aria-hidden className="text-ink300">·</span>
            <span>{payerSummary}</span>
            {contextFacilityCount !== null ? (
              <>
                <span aria-hidden className="text-ink300">·</span>
                <span>
                  {contextFacilityCount.toLocaleString('en-US')} {contextFacilityCount === 1 ? 'facility' : 'facilities'}
                </span>
              </>
            ) : null}
            {billedText ? (
              <>
                <span aria-hidden className="text-ink300">·</span>
                <span>{billedText} billed</span>
              </>
            ) : null}
            <span aria-hidden className="text-ink300">·</span>
            <span className="text-[#7fae9f]">BXR + Indigo</span>
          </div>

          <MatchCountReadout summary={summary} loading={summaryLoading} hasAmounts={summaryHasAmounts} />

          <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[380px_1fr]">
            {/* LEFT: the payer-wide facility ranking — for the ONE selected payer, or the payer DERIVED
                from a single-identifier search (so an alpha/member search never forces a payer pick).
                0/2+ payers with no resolvable identifier → a one-line note. */}
            <div>
              {payerSelection.length === 1 || singleIdentifier ? (
                panelPayer && panelSnapshot ? (
                  <FacilityPanel
                    facilities={panelFacilities}
                    hasAmounts={hasAmounts}
                    heatOn
                    selectedKeys={activeFacilityKeys}
                    onToggle={toggleFacility}
                    payerLabel={panelPayer}
                  />
                ) : derivedLoading || (panelPayer && !panelSnapshot) ? (
                  <div className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground shadow-ths-sm">
                    {derivedLoading ? 'Resolving payer…' : 'Loading facility ranking…'}
                  </div>
                ) : (
                  // An identifier was searched but resolved to no payer (never seen / misspelled).
                  <div className="rounded-2xl border border-dashed bg-card p-6 text-center text-[13px] text-muted-foreground">
                    No payer on file for that identifier — it may be new or misspelled.
                  </div>
                )
              ) : (
                <div className="rounded-2xl border border-dashed bg-card p-6 text-center text-[13px] text-muted-foreground">
                  Select a single payer — or search a member ID / alpha prefix — to see the facility ranking.
                </div>
              )}
            </div>

            {/* RIGHT: the composed claim rows (or the plain empty state). */}
            <div>
              {casesError ? (
                <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-status-danger">
                  Qualify is unavailable right now. Please try again.
                </div>
              ) : summary && summary.count === 0 && !casesLoading ? (
                // Plain empty state. When the single-payer "never billed" probe confirms, the VobModal
                // overlays this; otherwise this widen-your-filters nudge (window-widen hinted) stands.
                <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
                  No charge lines match these filters.
                  <div className="mt-1 text-[13px] text-ink400">Try removing a filter, or choose a longer window.</div>
                </div>
              ) : (
                <div aria-busy={casesLoading} className={['transition-opacity', casesLoading ? 'opacity-60' : ''].join(' ')}>
                  <CasesTable
                    claims={visibleCases}
                    hasAmounts={hasAmounts}
                    heatOn
                    facilityBuckets={NO_FACILITY_BUCKETS}
                    facilityLabel={null}
                    canReveal={canRevealPhi}
                    revealed={revealed}
                    revealingKeys={revealingKeys}
                    revealError={revealError}
                    onRevealPatient={revealPatient}
                    onHideIdentifiers={resetReveal}
                    onViewCohort={viewCohort}
                    capped={capped}
                    globalRevealOn={globalReveal && canGlobalReveal}
                  />
                </div>
              )}
            </div>
          </div>

          <CohortSheet
            data={cohortSheet?.data ?? null}
            loading={cohortSheet?.loading ?? false}
            patientLabel={cohortSheet?.label ?? null}
            onClose={() => setCohortSheet(null)}
          />
        </>
      ) : (
        // No filter yet: the animated brand hero fills the space until a filter (or a Heating-Up tap)
        // composes a query. Purely decorative + guidance — no data, no PHI.
        <QualifyLandingHero />
      )}

      {/* VOB — opens ONLY when the single-payer unwindowed probe proved the payer is never-billed. */}
      <VobModal
        open={vobPayer !== null}
        query={vobPayer ?? ''}
        onClose={() => {
          vobDismissedRef.current = vobPayer;
          setVobPayer(null);
        }}
      />
    </main>
  );
}

/** One PHI narrow input — a plain equality filter on a blind index (results stay masked regardless). */
function PhiInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={label}
        className="h-10 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink900 outline-none transition-colors focus:border-teal500 focus:ring-2 focus:ring-teal500/25"
      />
    </label>
  );
}

