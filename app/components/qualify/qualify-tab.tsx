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
import { Briefcase, Building2, ChevronRight, Eye, EyeOff, Landmark, Lock, Search, ShieldCheck } from 'lucide-react';
import {
  getQualifyMatchSummary,
  getQualifyComposedCases,
  getQualifySnapshot,
  getQualifySnapshotByPayer,
  getQualifyPayerEverBilled,
  getQualifyResolvePayer,
  getQualifyPatientCohort,
  getQualifyBookKpis,
  getQualifyFacilityTrends,
  getQualifyOverview,
  loadQualifyFacilityOptions,
  loadQualifyPayerOptions,
  loadQualifyEmployers,
  revealQualifyRows,
} from '@/lib/qualify/actions';
import {
  classifyQualifyIdentifier,
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
import { deriveScopeNotice, deriveFacilitySpread, deriveOnFileTags } from '@/lib/qualify/scopeNotice';
import { derivePolicyRating } from '@/lib/qualify/policyRating';
import { ScopeNotice } from '@/components/qualify/scope-notice';

/** Band → the ON-DARK hue for the policy numeral (the light-surface RATING_HEX is unreadable on
 *  teal900). Brighter, higher-contrast variants of the same five bands. */
const POLICY_BAND_HEX: Record<'65' | '50' | '30' | '15' | '0', string> = {
  '65': '#5FC9BE',
  '50': '#5FC9BE',
  '30': '#E9B44C',
  '15': '#F0917C',
  '0': '#F0917C',
};
import { filterFacilitiesByLoc, filterClaimsByLoc, type QualifyLocFilter } from '@/lib/qualify/groupClaims';
import type { RatingBucket } from '@/lib/qualify/rating';
import { CasesTable } from '@/components/qualify/cases-table';
import { CohortSheet } from '@/components/qualify/cohort-sheet';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { PolicyStrip } from '@/components/qualify/policy-strip';
import { WindowLadder } from '@/components/qualify/window-ladder';
import { QualifyAiPanel } from '@/components/qualify/qualify-ai-panel';
import { BookKpiTiles, EvidenceGauge, HeatingUpCards, HeatingUpSkeleton } from '@/components/qualify/overview';
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

  // ── CHIP PROVENANCE — the facility + payer values a ticker-card click PUT into the filter set, so
  //    their chips render dashed + ↳ (distinct from hand-typed picks). Set ONLY by a card click, cleared
  //    by the clear actions; a value stops reading derived the moment it leaves the selection (the
  //    pickers intersect this with `selected`). Purely visual — behaviour is identical to a typed chip. ─
  const [derivedValues, setDerivedValues] = useState<ReadonlySet<string>>(() => new Set());

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
  // ── v2 LEAD snapshot (Phases 0/B/D/E): the identifier-driven policy card + auto-window ladder +
  //    comparable ranking, from the PHI snapshot core. Fetched alongside the derived-payer resolve;
  //    gen-guarded like every other stream. `auto` fires once per NEW identifier (the ladder decides
  //    the window); later manual window changes refetch with the user's explicit choice respected.
  const [leadSnapshot, setLeadSnapshot] = useState<QualifySnapshot | null>(null);
  const leadGenRef = useRef(0);
  const lastAutoIdentifierRef = useRef<string | null>(null);
  const [expandedFacilities, setExpandedFacilities] = useState<ReadonlySet<string>>(new Set());
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

  // ── MOUNT PERF (Step 2): on a clean mount (no restored payer/facility) the book-wide KPI tiles +
  //    Heating-Up trends are fetched in ONE getQualifyOverview action (it Promise.alls both queries
  //    server-side) — saving a Server-Action round-trip (~100–200 ms invocation+network) and running
  //    the two rollup reads concurrently (max(~298,~52) ms) instead of the two SEPARATE, SERIALIZED
  //    actions the dedicated effects would otherwise fire. `combinedOwnedInitialRef` marks that the
  //    combined fetch owns the initial strip; the dedicated KPI + ticker effects skip their auto-run
  //    while it does, and resume the instant the user interacts (`userDrivenRef`). A URL that restored a
  //    payer/facility scope leaves the initial fetch to the dedicated (scoped) effects, exactly as before.
  const userDrivenRef = useRef(false);
  const combinedOwnedInitialRef = useRef(false);

  // ── v2 IDENTIFIED-FIRST COMPOSE (the Qualify v2 prototype's hierarchy): one smart identifier
  //    field + facility is the whole primary search; the aggregate pickers fold behind "Browse
  //    filters". The single input CLASSIFIES instead of splitting into two boxes — ≤3 letters is the
  //    alpha-prefix STARTS-WITH narrow (member_id_prefix_bidx), anything else the exact member-id
  //    narrow (member_id_bidx). It writes the SAME two states the old separate inputs wrote, so every
  //    downstream contract (compose filter, ladder, lead snapshot, audits) is unchanged — and the old
  //    both-identifiers dead-end is unrepresentable from the UI.
  const identifierValue = memberId || alphaPrefix;
  const onIdentifierChange = useCallback((raw: string) => {
    const c = classifyQualifyIdentifier(raw);
    setMemberId(c.memberId);
    setAlphaPrefix(c.alphaPrefix);
  }, []);
  const [browseOpen, setBrowseOpen] = useState(false);
  const scrollToResults = useCallback(() => {
    document.getElementById('qualify-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
    // MOUNT PERF (Step 2): when NOTHING scopes the strip (no restored payer/facility), fetch the
    // book-wide KPI tiles + Heating-Up trends in ONE getQualifyOverview action (resolve:false →
    // strip only, no hybrid resolve, no seed cases, no extra audit — identical to today's mount) that
    // Promise.alls both queries server-side. This REPLACES the two separate, serialized actions the
    // dedicated effects below would otherwise fire on mount; they skip their initial auto-run while
    // this owns it (combinedOwnedInitialRef) and resume on first user interaction (userDrivenRef). It
    // participates in kpiGenRef/overviewGenRef so a fast user action supersedes it. When the URL DID
    // restore a payer/facility, this is skipped and the dedicated (scoped) effects own the initial
    // load exactly as before — so a facility-only restore still gets book-wide trends via the ticker.
    if (url.payers.length === 0 && url.facilities.length === 0) {
      combinedOwnedInitialRef.current = true;
      const kgen = ++kpiGenRef.current;
      const ogen = ++overviewGenRef.current;
      getQualifyOverview(url.window, undefined, { resolve: false })
        .then((ov) => {
          if (!alive) return;
          if (kpiGenRef.current === kgen) setKpis(ov.kpis);
          if (overviewGenRef.current === ogen) {
            setTrends(ov.trends);
            setOverviewError(false);
          }
        })
        .catch(() => {
          if (alive && overviewGenRef.current === ogen) setOverviewError(true);
        })
        .finally(() => {
          if (alive && overviewGenRef.current === ogen) setInitializing(false);
        });
    }
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
    // Step 2: the combined mount fetch owns the initial book-wide tiles until the user first interacts;
    // skip the auto-run so mount's own URL-restore/window setState re-renders don't double-fetch.
    if (combinedOwnedInitialRef.current && !userDrivenRef.current) return;
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
    // Step 2: skip the initial auto-run while the combined mount fetch owns the strip (resumes on first
    // user interaction). facilitySelection is deliberately NOT read here or added to deps — the ticker
    // must never refetch/remount on a facility change (Phase 2 marquee invariant, unchanged).
    if (combinedOwnedInitialRef.current && !userDrivenRef.current) return;
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

  // ── v2 LEAD snapshot fetch: policy strip + ladder + (comparable) ranking for the searched
  //    identifier. AUTO only when the identifier CHANGED — a manual window change after a search
  //    refetches under the user's window (respect the override; the Range menu stays the biller path).
  useEffect(() => {
    if (!singleIdentifier) {
      setLeadSnapshot(null);
      lastAutoIdentifierRef.current = null;
      return;
    }
    const lgen = ++leadGenRef.current;
    const auto = lastAutoIdentifierRef.current !== singleIdentifier;
    // Consume the auto flag SYNCHRONOUSLY: a window change mid-flight must re-enter as auto=false
    // (never override the user's pick), and a rejected auto fetch must not re-auto on the next
    // manual window change.
    lastAutoIdentifierRef.current = singleIdentifier;
    getQualifySnapshot({ query: singleIdentifier, window: windowSel, auto })
      .then((snap) => {
        if (leadGenRef.current !== lgen) return;
        // The manual-window echo refetch (auto=false) carries ladder:null by design — PRESERVE the
        // ladder from the auto fetch so the disclosure card doesn't flash and vanish exactly when
        // it re-windowed (same identifier, so the rung counts still describe this search).
        setLeadSnapshot((prev) => (!auto && snap.ladder === null && prev !== null ? { ...snap, ladder: prev.ladder } : snap));
        // Follow the ladder's decision ONCE per search: the whole surface (panel, cases, KPIs)
        // re-windows to the chosen span so every number on screen describes ONE window.
        if (auto && snap.ladder && (windowSel.kind !== 'trailing' || windowSel.days !== snap.ladder.chosenDays)) {
          setWindowSel({ kind: 'trailing', days: snap.ladder.chosenDays });
        }
      })
      .catch(() => {
        if (leadGenRef.current !== lgen) return;
        setLeadSnapshot(null);
      });
    // windowSel is deliberately IN deps: a post-search window change refetches the lead under the
    // manual window (auto=false), keeping the policy/estimate read on the same span as the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleIdentifier, windowSel]);

  const toggleFacilityExpansion = useCallback((key: string) => {
    setExpandedFacilities((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
    if (!hasAnyFilter) {
      if (tickerPinned) setTickerPinned(false);
      if (derivedValues.size > 0) setDerivedValues(new Set());
    }
  }, [hasAnyFilter, tickerPinned, derivedValues]);

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
    userDrivenRef.current = true; // Step 2: hand strip ownership back to the dedicated effects
    setWindowSel(w);
  }, []);

  // ── Ticker-card click — REPLACE the whole filter set with exactly {that facility, its dominant payer}
  //    (never append: a second click must not push the payer count to 2+) and PIN the marquee. The
  //    auto-added payer chip is behaviorally/visually identical to a hand-picked one (same picker state). ─
  const openTrendCard = useCallback((t: QualifyFacilityTrend) => {
    if (!t.dominantPayer) return;
    userDrivenRef.current = true; // Step 2: a ticker-card click is a user interaction
    setTickerPinned(true);
    setFacilitySelection([t.facilityKey]);
    setPayerSelection([t.dominantPayer]);
    // Mark exactly these two as ticker-DERIVED so their chips read dashed + ↳ (a hand-picked chip stays
    // solid). Namespaces don't collide, so one set feeds both the facility and payer pickers.
    setDerivedValues(new Set([t.facilityKey, t.dominantPayer]));
    setEmployerSelection([]);
    setFundingSelection([]);
    setMemberId('');
    setAlphaPrefix('');
    setGroupNumber('');
    setClientName('');
  }, []);

  // ── Picker plumbing ───────────────────────────────────────────────────────────────────────────────
  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (value: string) => {
    userDrivenRef.current = true; // Step 2: any picker toggle hands strip ownership to the dedicated effects
    setter((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };
  const toggleFacility = useCallback(toggleIn(setFacilitySelection), []);
  const togglePayer = useCallback(toggleIn(setPayerSelection), []);
  const toggleEmployer = useCallback(toggleIn(setEmployerSelection), []);
  const toggleFunding = useCallback(toggleIn(setFundingSelection), []);
  const clearFacilities = useCallback(() => {
    userDrivenRef.current = true; // Step 2
    setFacilitySelection([]);
  }, []);
  const clearPayers = useCallback(() => {
    userDrivenRef.current = true; // Step 2
    setPayerSelection([]);
  }, []);
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
    userDrivenRef.current = true; // Step 2: clearing filters resumes the dedicated (book-wide) strip effects
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
    setDerivedValues(new Set());
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
  // Ticker scope (Design B): payer-scoped at exactly one payer, book-wide otherwise.
  const tickerScopePayer = payerSelection.length === 1 ? payerSelection[0]! : null;
  const billedText =
    summaryHasAmounts && summary?.totalCharge != null
      ? summary.totalCharge.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      : null;

  // ── SCOPE HONESTY + KPI FLANKS (2026-08-04) — both derived from the SAME facility set the ranking
  //    renders, so the tiles bracket what they average and the notice describes what is on screen.
  //    `panelFacilities` is the LOC-lensed ranking; the identifier flag is what makes the ranking's
  //    population (payer-wide) and the grid's population (this client) diverge. ──────────────────────
  const rankedForScopeLoading = Boolean(panelPayer && !panelSnapshot);
  const rankedForScope = rankedForScopeLoading ? [] : panelPayer ? panelFacilities : leadSnapshot?.facilities ?? [];
  const facilitySpread = useMemo(() => deriveFacilitySpread(rankedForScope), [rankedForScope]);
  const scopeNotice = useMemo(
    () =>
      deriveScopeNotice({
        rankedCount: rankedForScope.length,
        composedCount: summaryLoading ? null : summary?.count ?? null,
        // singleIdentifier is the TERM (string | null) — never render it, only its presence.
        identifierSearched: singleIdentifier !== null,
        rankingPayerLabel: panelPayer ?? leadSnapshot?.policy?.carrier ?? null,
        windowLabel: qualifyWindowLabel(windowSel),
      }),
    [rankedForScope.length, summaryLoading, summary?.count, singleIdentifier, panelPayer, leadSnapshot?.policy?.carrier, windowSel],
  );

  // The policy-level rating shown on the dark bar — the patient-weighted mean of the SAME cards the
  // ranking renders, so the two can never contradict each other.
  const policyRating = useMemo(() => derivePolicyRating(rankedForScope), [rankedForScope]);

  // "On file" tags for the readout bar — only once the VOB actually matched the prefix. An unmatched
  // policy contributes nothing rather than a row of five "not on file" chips.
  const onFileTags = useMemo(
    () => deriveOnFileTags(leadSnapshot?.policy?.found ? leadSnapshot.policy : null),
    [leadSnapshot?.policy],
  );

  // The snapshot the AI explainer reads: the identifier lead when it resolved to anything, else the
  // by-payer panel. Hoisted out of the JSX so the panel can move above the ranking.
  const aiSnapshot =
    leadSnapshot && (leadSnapshot.resolved || leadSnapshot.facilities.length > 0 || leadSnapshot.policy?.found)
      ? leadSnapshot
      : panelSnapshot;

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

      {/* ── COMPOSE CONSOLE (v2 prototype hierarchy): the IDENTIFIED search leads — one smart
          identifier field + facility + Search over the hatched PHI treatment — with the aggregate
          pickers folded behind "Browse filters" and the dark readout bar anchoring the card. Design
          B's rule survives as the hint line (payer/facility score; employer/funding/group # narrow).
          Interaction model unchanged: AND-composed filter, drill-not-filter, tickerPinned distinct
          from selection, canRevealPhi gating, amounts choke-point — visual only. ── */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-ths-sm">
        {/* teal cap — the finder-card chrome, kept */}
        <div aria-hidden className="h-[3px] bg-gradient-to-r from-teal700 via-teal500 to-teal200" />

        {/* ── IDENTIFIED SEARCH (v2 primary — the prototype's hierarchy: the prefix IS the policy, so
            the person-level search leads the card). Two fields is the whole search: the single smart
            identifier input (auto-classifies prefix vs member ID) + the facility picker. canRevealPhi-
            gated exactly like the old PHI row; raw terms remain state-only (never URL/log). ── */}
        {canRevealPhi ? (
          <div className="q-phi-hatch px-4 py-4 sm:px-5">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-teal900 px-2.5 py-1 text-[10.5px] font-semibold tracking-wide text-white">
                <Lock className="h-2.5 w-2.5" aria-hidden />
                Identified
              </span>
              <span className="font-head text-[10.5px] font-bold uppercase tracking-[0.1em] text-teal900">
                Two fields is the whole search
              </span>
              <span className="text-[11.5px] text-ink600 min-[560px]:ml-auto">Audited on use. Never written to the URL.</span>
              {canGlobalReveal ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={globalReveal}
                  onClick={toggleGlobalReveal}
                  title="Reveal PHI identifiers across the results — every reveal is audited"
                  className={[
                    'inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-[12px] font-semibold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40',
                    globalReveal
                      ? 'border-coral400 bg-coral50 text-coral600'
                      : 'border-line bg-surface text-ink600 hover:text-ink900',
                  ].join(' ')}
                >
                  {globalReveal ? <Eye aria-hidden className="h-3.5 w-3.5" /> : <EyeOff aria-hidden className="h-3.5 w-3.5" />}
                  Reveal PHI identifiers
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 items-end gap-3 min-[720px]:grid-cols-[minmax(200px,250px)_minmax(220px,1fr)_auto]">
              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal900">
                  <ShieldCheck className="h-3.5 w-3.5 text-teal700" aria-hidden />
                  Member ID or prefix
                </span>
                <input
                  value={identifierValue}
                  onChange={(e) => onIdentifierChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') scrollToResults();
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="XQH · or a full member ID"
                  aria-label="Member ID or alpha prefix"
                  className="h-10 rounded-lg border border-teal200 bg-surface px-3 font-mono text-[15px] font-medium uppercase tracking-[0.08em] text-ink900 outline-none transition-colors placeholder:normal-case placeholder:tracking-normal placeholder:text-ink400 focus:border-teal500 focus:ring-2 focus:ring-teal500/25"
                />
              </label>
              <MultiSelectTagPicker
                label="Facility"
                placeholder="Search and select a facility…"
                icon={<Building2 className="h-3.5 w-3.5" aria-hidden />}
                options={facilityOptions}
                selected={facilitySelection}
                onToggle={toggleFacility}
                onClear={clearFacilities}
                tone="score"
                derivedValues={derivedValues}
              />
              <button
                type="button"
                onClick={scrollToResults}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-teal700 px-5 text-sm font-semibold text-white transition-colors hover:bg-teal900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40"
              >
                <Search className="h-4 w-4" aria-hidden />
                Search
              </button>
            </div>
          </div>
        ) : null}

        {/* ── BROWSE FILTERS (Design B, folded behind the identified search): payer still SCORES the
            book; employer/funding/group # narrow the LIST only — the seam rule survives as the hint
            line. Collapsed by default; FORCED open while any browse filter is active (active filters
            are never hidden) and always open for viewers without the identified search. Interaction
            model unchanged: AND-composed, drill-not-filter, tickerPinned distinct from selection. ── */}
        {(() => {
          const browseActive =
            payerSelection.length > 0 ||
            employerSelection.length > 0 ||
            fundingSelection.length > 0 ||
            groupNumber.trim() !== '' ||
            (QUALIFY_CLIENT_NAME_ENABLED && clientName.trim() !== '');
          const browseExpanded = browseOpen || browseActive || !canRevealPhi;
          return (
            <div className={canRevealPhi ? 'border-t border-dashed border-teal200' : ''}>
              {canRevealPhi ? (
                <button
                  type="button"
                  aria-expanded={browseExpanded}
                  onClick={() => setBrowseOpen((o) => !o)}
                  disabled={browseActive}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors enabled:hover:bg-teal50/40 sm:px-5"
                >
                  <ChevronRight
                    aria-hidden
                    className={['h-3.5 w-3.5 text-ink400 transition-transform', browseExpanded ? 'rotate-90' : ''].join(' ')}
                  />
                  <span className="font-head text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink600">Browse filters</span>
                  <span className="text-[11px] text-ink400">payer · employer · funding · group #</span>
                  {browseActive ? (
                    <span className="ml-auto rounded-full bg-teal50 px-2 py-0.5 text-[10px] font-bold text-teal700">active</span>
                  ) : null}
                </button>
              ) : null}
              {browseExpanded ? (
                <div className={['px-4 pb-4 sm:px-5', canRevealPhi ? '' : 'pt-4'].join(' ')}>
                  <p className="mb-3 text-[11.5px] text-ink600">
                    <b className="font-semibold text-teal700">Payer and facility move the scores.</b> Employer, funding and
                    group # only narrow the matching claims.
                  </p>
                  <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[1100px]:grid-cols-4">
                    <MultiSelectTagPicker
                      label="Payer"
                      placeholder="Filter by payer…"
                      icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
                      options={payerOptions}
                      selected={payerSelection}
                      onToggle={togglePayer}
                      onClear={clearPayers}
                      tone="score"
                      derivedValues={derivedValues}
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
                      tone="list"
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
                      tone="list"
                    />
                    {canRevealPhi ? <PhiInput label="Group #" value={groupNumber} onChange={setGroupNumber} placeholder="Group" /> : null}
                    {/* Client name stays DATA-GATED behind QUALIFY_CLIENT_NAME_ENABLED (needs the 0067
                        matview rebuild + owner-run backfill first — see contract.ts). Not an oversight. */}
                    {canRevealPhi && QUALIFY_CLIENT_NAME_ENABLED ? (
                      <PhiInput label="Client name" value={clientName} onChange={setClientName} placeholder="Last, First" />
                    ) : null}
                  </div>
                  {canRevealPhi && QUALIFY_CLIENT_NAME_ENABLED ? (
                    <p className="mt-2 text-[10.5px] text-ink400">Qualify only — Collections has no name lookup.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })()}

        {/* READOUT BAR — anchors the console on the dark teal bar: the live match count, then [evidence
            gauge — wired in Part 1b], then the window + LOC segmented controls + Clear all. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line bg-teal900 px-4 py-3 sm:px-5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[26px] font-semibold leading-none tracking-tight text-white tabular-nums">
              {!hasAnyFilter ? '—' : summaryLoading && !summary ? '…' : (summary?.count ?? 0).toLocaleString('en-US')}
            </span>
            <span className="text-[12px] text-white/70">charge lines match</span>
            {hasAnyFilter && summaryLoading ? (
              <span className="text-[10.5px] uppercase tracking-wide text-teal200">updating…</span>
            ) : null}
          </div>

          {/* EVIDENCE GAUGE — distinct clients behind the composed match (same population as the count),
              fill-state only. Shown once a match exists; the count block already carries "—" at landing. */}
          {hasAnyFilter && summary ? <EvidenceGauge distinctPatients={summary.distinctPatients} /> : null}

          <div className="flex flex-wrap items-center gap-2.5 min-[560px]:ml-auto">
            <WindowControl window={windowSel} currentYear={new Date().getFullYear()} onChange={onWindow} tone="dark" />
            <div className="inline-flex rounded-lg bg-white/10 p-0.5" role="group" aria-label="Level of care">
              {(['IP', 'OP', 'BOTH'] as const).map((loc) => (
                <button
                  key={loc}
                  type="button"
                  aria-pressed={locFilter === loc}
                  onClick={() => setLocFilter((cur) => (cur === loc ? null : loc))}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                    locFilter === loc ? 'bg-white text-teal900' : 'text-white/70 hover:text-white',
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
                className="rounded-lg border border-white/25 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {/* ── POLICY RATING (prototype's showPolicyScore): the one number for "does this payer pay
              us". RECONCILED BY CONSTRUCTION — it is the patient-weighted mean of exactly the ratings
              on the cards below, so the bar and the ranking can never disagree. Null (no facility
              clears the floor) renders "—" + "Not rated", never a 0. ── */}
          {policyRating.ratedCount > 0 || rankedForScope.length > 0 ? (
            <div className="flex items-center gap-3 border-l border-white/15 pl-4 min-[560px]:order-2">
              <div className="text-right">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.11em] text-white/55">Policy rating</div>
                <div className="mt-px text-[11px] text-white/60">{policyRating.basis}</div>
              </div>
              <div
                className="font-display text-[36px] font-semibold leading-[0.85] tracking-tight tabular-nums"
                style={{ color: policyRating.band ? POLICY_BAND_HEX[policyRating.band] : 'rgba(255,255,255,.72)' }}
              >
                {policyRating.rating ?? '—'}
              </div>
              <span
                className="rounded-full px-2.5 py-[3px] text-[11.5px] font-bold"
                style={{
                  background: policyRating.band ? `${POLICY_BAND_HEX[policyRating.band]}29` : 'rgba(255,255,255,.1)',
                  color: policyRating.band ? POLICY_BAND_HEX[policyRating.band] : 'rgba(255,255,255,.72)',
                }}
              >
                {policyRating.verdict}
              </span>
            </div>
          ) : null}

          {/* ── "ON FILE" (prototype's policy tag row): what the plan behind this prefix ACTUALLY is —
              carrier · funding · policy type · plan · network. The rep never types any of it, and a
              missing field says "not on file" rather than being silently dropped, because "we don't
              know the network" and "in network" are different answers. Plan-level, non-PHI: no
              employer, no group number (presence-only by contract), no benefit dollars. ── */}
          {onFileTags.length > 0 ? (
            <div className="flex basis-full flex-wrap items-center gap-1.5 border-t border-white/15 pt-2.5">
              <span className="mr-1 text-[10px] font-extrabold uppercase tracking-[0.11em] text-white/50">On file</span>
              {onFileTags.map((t) => (
                <span
                  key={t.label}
                  title={`${t.label} · ${t.value}`}
                  className={[
                    'inline-flex max-w-full items-baseline gap-1.5 rounded-full border border-dashed px-2.5 py-[3px]',
                    t.missing ? 'border-white/20' : 'border-teal200/45 bg-white/[0.06]',
                  ].join(' ')}
                >
                  <span className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.07em] text-white/50">{t.label}</span>
                  <span
                    className={[
                      'min-w-0 truncate text-[11.5px] font-semibold leading-snug',
                      t.mono ? 'font-mono tabular-nums' : '',
                      t.missing ? 'text-white/50' : 'text-white',
                    ].join(' ')}
                  >
                    {t.value}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── KPI TILES (Phase 2: scoped to payer + facility; sample-gated) ── */}
      <BookKpiTiles kpis={kpis} locActive={locFilter !== null} scopeLabel={kpiScopeLabel} spread={facilitySpread} />

      {/* ── CONTEXT LINE + LIVE MATCH COUNT + FACILITY RANKING + COMPOSED CASES ── */}
      {hasAnyFilter ? (
        <>
          {/* ── v2 POLICY STRIP + AUTO-WINDOW LADDER (Phases 0/B/D/E): identifier searches only —
              the prefix IS the policy; the ladder shows the window decision instead of hiding it. */}
          {singleIdentifier && leadSnapshot?.policy ? (
            <PolicyStrip
              policy={leadSnapshot.policy}
              provenance={leadSnapshot.provenance}
              hasAmounts={hasAmounts}
              prefixEcho={leadSnapshot.resolved?.matchedValue ?? ''}
            />
          ) : null}
          {singleIdentifier && leadSnapshot?.ladder ? <WindowLadder ladder={leadSnapshot.ladder} /> : null}
          {/* Lighter context line (the old resolved-payer hero band is gone). Non-dollar for admissions_seat. */}
          <div
            id="qualify-results"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-surface px-4 py-2.5 text-[12px] text-ink600"
          >
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
            {/* Composed-match realization (non-dollar; relocated here from the old readout card — the dark
                readout bar now carries only the count + gauge + controls). "—" for a collapsed denominator. */}
            {summary ? (
              <>
                <span aria-hidden className="text-ink300">·</span>
                <span>
                  allowed{' '}
                  <b className="font-mono font-semibold text-ink900">
                    {summary.pctAllowedOfBilled === null ? '—' : `${Math.round(summary.pctAllowedOfBilled)}%`}
                  </b>{' '}
                  of billed
                </span>
                <span aria-hidden className="text-ink300">·</span>
                <span>
                  paid{' '}
                  <b className="font-mono font-semibold text-ink900">
                    {summary.pctPaidOfBilled === null ? '—' : `${Math.round(summary.pctPaidOfBilled)}%`}
                  </b>{' '}
                  of billed
                </span>
              </>
            ) : null}
            <span aria-hidden className="text-ink300">·</span>
            <span className="text-[#7fae9f]">BXR + Indigo</span>
          </div>

          {/* ── SCOPE HONESTY (2026-08-04): the ranking is payer-WIDE while the grid is fully composed,
              so when those two populations disagree the screen says so — ABOVE the ranking, where it
              is read, not below a 27-card list. Pure decision in lib/qualify/scopeNotice.ts. ── */}
          {!rankedForScopeLoading ? <ScopeNotice notice={scopeNotice} /> : null}

          {/* ── AI EXPLAINER — moved ABOVE the ranking (2026-08-04). It used to render after the
              two-column grid, which on a 27-facility payer put it a full screen below the fold: the
              answer to "does this payer pay us" was the least visible thing on the page. Lead
              (identifier) snapshot preferred; by-payer panel otherwise. ── */}
          {aiSnapshot ? <QualifyAiPanel snapshot={aiSnapshot} blind={!hasAmounts} /> : null}

          <div className="grid grid-cols-1 items-start gap-4 min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* LEFT: the payer-wide facility ranking — for the ONE selected payer, or the payer DERIVED
                from a single-identifier search (so an alpha/member search never forces a payer pick).
                0/2+ payers with no resolvable identifier → a one-line note. Widened from a fixed 380px
                column (2026-08-04): the scorecard carries a hero numeral, a verdict pill, evidence pips,
                a weight bar and a 6-factor expansion, and none of that is legible at 380px. */}
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
                    expandedKeys={expandedFacilities}
                    onExpandToggle={toggleFacilityExpansion}
                  />
                ) : derivedLoading || (panelPayer && !panelSnapshot) ? (
                  <div className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground shadow-ths-sm">
                    {derivedLoading ? 'Resolving payer…' : 'Loading facility ranking…'}
                  </div>
                ) : leadSnapshot && !leadSnapshot.resolved && leadSnapshot.facilities.length > 0 ? (
                  // ESTIMATED (Phase B): no claims of its own, but the VOB names its cohort — rank the
                  // policy's behavioral peer group, clearly labeled, never dressed as direct evidence.
                  <FacilityPanel
                    facilities={leadSnapshot.facilities}
                    hasAmounts={hasAmounts}
                    heatOn
                    selectedKeys={activeFacilityKeys}
                    onToggle={toggleFacility}
                    payerLabel={leadSnapshot.policy?.employerName ?? leadSnapshot.policy?.carrier ?? null}
                    expandedKeys={expandedFacilities}
                    onExpandToggle={toggleFacilityExpansion}
                    provenance={leadSnapshot.provenance}
                  />
                ) : (
                  // An identifier was searched but resolved to no payer (never seen / misspelled).
                  <div className="rounded-2xl border border-dashed bg-card p-6 text-center text-[13px] text-muted-foreground">
                    {leadSnapshot?.policy?.found
                      ? 'This plan has no claims history anywhere yet — the policy card above is everything on file. Ask a biller before quoting.'
                      : 'No payer on file for that identifier — it may be new or misspelled.'}
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

