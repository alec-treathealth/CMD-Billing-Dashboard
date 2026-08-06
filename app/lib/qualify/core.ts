/**
 * Qualify orchestration CORE — the action logic (sniff → audit → resolve → load → assemble → strip),
 * dependency-INJECTED so it is unit-testable with fakes (no live session, DB, or blind-index key).
 * The 'use server' actions.ts wires the REAL deps and exports thin Server Actions over these cores.
 *
 * This module has NO server-only runtime import (only pure app modules + type-only imports), so tests
 * can load it hermetically. All PHI/DB/crypto reach it only through the injected QualifyDeps.
 */
import { qualifyRating, QUALIFY_MIN_LINES } from './rating';
import { computeRatingV2, QUALIFY_AUTH_FIT_MIN_SAMPLE, type QualifyProvenance } from './ratingV2';
import { QUALIFY_RATING_CONFIDENT_PATIENTS } from './sampleGate';
import { confidenceOf } from './confidence';
import { facilityLocation } from './facilityLocations';
import {
  lookupCodingDecision,
  codingCodesLabel,
  type CodingDecisionRow,
} from '../../../src/collections/codingRegistryQuery';
import type {
  QualifyPolicyRow,
  QualifyPolicySpreadRow,
  QualifyWindowRungsRow,
} from '../../../src/collections/qualifyPolicyQuery';
import type { QualifyPayerSpreadRow } from '../../../src/collections/qualifyQuery';
import {
  isQualifyWindow,
  sniffQualifyKind,
  serializeQualifyWindow,
  qualifyWindowBounds,
  QUALIFY_TENANT_SCOPE,
  QUALIFY_MEMBER_ID_MASK,
  QUALIFY_REVEAL_BATCH_CAP,
  type QualifyInput,
  type QualifyPayerInput,
  type QualifyNameInput,
  type QualifyFacilityCasesInput,
  type QualifyFacilityCases,
  type QualifyPatientCohortInput,
  type QualifyPatientCohort,
  type QualifyMatchKind,
  type QualifySnapshot,
  type QualifyResolved,
  type QualifyFacility,
  type QualifyClaim,
  type QualifyMovers,
  type QualifyMover,
  type QualifyInitial,
  type QualifyMarket,
  type QualifyWindow,
  type QualifyPhi,
  type QualifyRevealedRow,
  type RevealQualifyRowResult,
  type RevealQualifyRowsResult,
  type QualifyBookKpis,
  type QualifyFacilityTrend,
  type QualifyOverview,
  type QualifyComposeInput,
  type QualifyMatchSummary,
  type QualifyPolicyCard,
  type QualifyPayerOption,
  type QualifyWindowLadder,
  type QualifyWindowRung,
  type QualifyTrailingDays,
  QUALIFY_VOB_STALE_HOURS,
} from './contract';
import type { QualifyPrincipal } from './principal';
import {
  QUALIFY_CASES_MAX,
  type QualifyTokenKind,
  type QualifyFacilityRow,
  type QualifyClaimRow,
  type QualifyMoverRow,
  type QualifyBookKpisRow,
  type QualifyOrientationScope,
  type QualifyFacilityTrendRow,
  type QualifyMatchSummaryRow,
} from '../../../src/collections/qualifyQuery';
import {
  COHORT_MIN_PATIENTS,
  type CmdExplorerFilter,
  type VobMarketFilter,
} from '../../../src/collections/cmdExplorerQuery';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../../../src/tenants';

/** Distinct audit action labels (post reveal-audit-action fix) — Qualify surfaces are attributable. */
export const SEARCH_QUALIFY_PHI = 'search_qualify_phi';
/** Client-name search audit (Change C) — a name term was HMAC-resolved. Field NAME only; the raw
 *  name never reaches the audit detail, a log line, or a URL. */
export const SEARCH_QUALIFY_NAME = 'search_qualify_name';
/** Resolve-by-payer audit — a payer LABEL was looked up (non-PHI, distinct from the PHI-term search). */
export const SEARCH_QUALIFY_PAYER = 'search_qualify_payer';
/** Facility drill audit — a payer's cases were narrowed to ONE facility (distinct, more-granular access). */
export const SEARCH_QUALIFY_FACILITY = 'search_qualify_facility';
/** Phase 3: a patient-group's lifetime prefix-cohort context was opened (distinct granular access). */
export const SEARCH_QUALIFY_COHORT = 'search_qualify_cohort';
export const REVEAL_QUALIFY_ROW = 'reveal_qualify_row';
export const REVEAL_QUALIFY_ROWS = 'reveal_qualify_rows';

const REVEAL_BATCH_CAP = QUALIFY_REVEAL_BATCH_CAP;

/** Everything the cores touch that isn't pure — injected so tests can fake it. */
export interface QualifyDeps {
  requirePrincipal: () => Promise<QualifyPrincipal>;
  /** Mint the opaque blind-index token (may throw if the key is unavailable → caught as "unavailable"). */
  mintToken: (query: string, kind: QualifyMatchKind) => string | null;
  /** Mint the EXACT group-number blind index (the employer proxy, Phase 2). Same key discipline as
   *  mintToken; null when the term normalizes to nothing. */
  mintGroupToken: (raw: string) => string | null;
  /** Mint the EXACT normalized-name blind index (Change C). Same key discipline; null when the
   *  term normalizes to nothing. The raw name never leaves this call's argument. */
  mintNameToken: (raw: string) => string | null;
  resolvePayer: (token: string, kind: QualifyTokenKind, entityIds: string[]) => Promise<string | null>;
  /** EVERY payer behind the token, ranked — the widened resolvePayer (buildResolvePayerSpreadQuery).
   *  Row [0] agrees with resolvePayer exactly by construction; this exists so the surface can offer
   *  the other 80.6% of searches their real alternatives instead of discarding them. Optional so
   *  pre-existing dep fixtures stay valid, and fail-soft at the call site: losing the spread must
   *  degrade to today's single-payer behaviour, never take the search down. */
  loadPayerSpread?: (
    token: string,
    kind: QualifyTokenKind,
    entityIds: string[],
  ) => Promise<QualifyPayerSpreadRow[]>;
  /** The employer + carrier spread behind the token (buildQualifyPolicySpreadQuery). ⚠ The employer
   *  rows are SERVER-SIDE ONLY — see the forwarding boundary in getQualifySnapshotCore. Optional and
   *  fail-soft for the same reason as loadPayerSpread. */
  loadPolicySpread?: (
    token: string,
    kind: Exclude<QualifyTokenKind, 'client_name'>,
  ) => Promise<QualifyPolicySpreadRow[]>;
  loadFacilities: (
    /** The resolved payer, or NULL for the v2 comparable-cohort ranking (Phase B) — the builder
     *  omits the payer clause; the market semi-join MUST carry the scope (core enforces it). */
    payer: string | null,
    from: string,
    to: string,
    entityIds: string[],
    market?: VobMarketFilter,
    /** Optional identifier narrow (prefix/member/client-name blind-index token + its kind): scopes the
     *  ranking to that identifier's footprint. Null (the by-payer path) = the payer-wide book. */
    token?: string | null,
    kind?: QualifyTokenKind | null,
  ) => Promise<QualifyFacilityRow[]>;
  /** Fix A: raw facility of the searched identifier's most-recent in-window claim under the payer (or null). */
  loadIdentifierLandingFacility: (
    token: string,
    kind: QualifyTokenKind,
    payer: string,
    from: string,
    to: string,
    entityIds: string[],
  ) => Promise<string | null>;
  /** Composed claims for a filter SET (compose bar; the single-facility/single-payer drill is a
   *  one-element array). WHERE = Collections' shared cmdExplorerBaseConds (built in buildFacilityCasesQuery);
   *  `nameToken` is Qualify's own patient_name_bidx extra AND (Change C, dormant). */
  loadFacilityCases: (
    filter: CmdExplorerFilter,
    entityIds: string[],
    opts: { nameToken?: string | null; allPayers?: boolean; limit?: number },
  ) => Promise<QualifyClaimRow[]>;
  /** Compose-bar live match count: the `totals` row of Collections' buildCmdSearchSummaryQueries over the
   *  SAME cmdExplorerBaseConds predicate. One row (or null on empty). Dollars are stripped in the CORE. */
  loadMatchSummary: (filter: CmdExplorerFilter, entityIds: string[]) => Promise<QualifyMatchSummaryRow | null>;
  /** Compose-bar EVIDENCE count: distinct clients (count(distinct member_id_bidx)) over the SAME composed
   *  predicate as the match count. Qualify-OWNED (does NOT touch Collections' buildCmdSearchSummaryQueries,
   *  which is patient-count-blind) — reuses the shared cmdExplorerBaseConds predicate like the cases drill.
   *  member_id_bidx is COUNTED, never projected. Drives the readout evidence gauge (sampleGate tiers). */
  loadMatchClientCount: (filter: CmdExplorerFilter, entityIds: string[]) => Promise<number>;
  /** Phase 3: tenant-scoped lookup of ONE claim's alpha-prefix cohort token. Null = unknown/foreign
   *  claim id (fails closed to suppressed). The token never reaches the client. */
  loadClaimPrefixToken: (claimId: number, entityIds: string[]) => Promise<string | null>;
  /** Phase 3: the LIFETIME prefix-cohort context, already gated by the collections cohort floor —
   *  null = below COHORT_MIN_PATIENTS (the caller renders "not enough data"). */
  loadPatientCohort: (prefixBidx: string, entityIds: string[]) => Promise<QualifyPatientCohortRaw | null>;
  loadMovers: (
    thisFrom: string,
    thisTo: string,
    priorFrom: string,
    priorTo: string,
    entityIds: string[],
    market?: VobMarketFilter,
  ) => Promise<QualifyMoverRow[]>;
  /** Phase 2 overview: KPI percentages + distinct-patient count (dollars summed + dropped in SQL). One
   *  row. Scope is payer + facility + window (QualifyOrientationScope) — NO employer/funding (Design B). */
  loadBookKpis: (scope: QualifyOrientationScope, entityIds: string[]) => Promise<QualifyBookKpisRow | null>;
  /** Phase 2 overview: per-facility rating trend rows (ratings only). payer null = book-wide; a single
   *  payer = the payer-scoped ticker (Design B — NO market). The builder enforces the delta gate. */
  loadFacilityTrends: (
    from: string,
    to: string,
    priorFrom: string,
    entityIds: string[],
    opts?: { payer?: string | null },
  ) => Promise<QualifyFacilityTrendRow[]>;
  recordAccess: (entry: {
    actorEmail: string;
    actorUserId: string;
    action: string;
    detail: Record<string, unknown>;
  }) => Promise<unknown>;
  revealRow: (
    id: number,
    actor: { email: string; userId: string },
    entityIds: string[],
    action: string,
  ) => Promise<QualifyPhi | null>;
  revealRows: (
    ids: number[],
    actor: { email: string; userId: string },
    entityIds: string[],
    action: string,
  ) => Promise<QualifyRevealedRow[]>;
  now: () => Date;

  // ── v2 seams (Phases 0/A/B/E/G) — ALL OPTIONAL, all fail-soft ─────────────────────────────────
  // Optional so (a) the pre-v2 fake-deps test corpus keeps compiling untouched and (b) every core
  // degrades honestly when a seam is absent: no policy card, coding factor "unseeded", census
  // factors unavailable — never a throw, never a fabricated value.
  /** Phase B: the policy on file behind a member/prefix token (vob.member_benefits_latest aggregate). */
  loadPolicy?: (token: string, kind: QualifyMatchKind) => Promise<QualifyPolicyRow>;
  /** Phase 0: the GLOBAL VOB feed high-water mark (max vob_created_at) — the staleness alarm input. */
  loadVobFreshness?: () => Promise<string | null>;
  /** Phase E: the five-rung distinct-patient ladder in ONE scan. */
  loadWindowRungs?: (
    token: string,
    kind: QualifyMatchKind,
    entityIds: string[],
    froms: { d30: string; d60: string; d90: string; d180: string; d365: string },
    to: string,
  ) => Promise<QualifyWindowRungsRow>;
  /** Phase A: all CURRENT coding decisions (seeded:false while 0077 is unapplied/empty). */
  loadCodingDecisions?: () => Promise<{ seeded: boolean; rows: CodingDecisionRow[] }>;
  /** Phase G: per-facility census aggregates (auth days, LOS, next UR, open beds). Empty = none. */
  /** Completed-stay aggregates (0091). Optional + fail-soft: absent means the auth-fit factor keeps
   *  using the in-progress census snapshot, which is the pre-0091 behaviour. */
  loadFacilityOutcomes?: () => Promise<QualifyOutcomesRow[]>;
  loadCensusAuth?: () => Promise<QualifyCensusAggRow[]>;
}

/** Per-facility monday-census AGGREGATE row (Phase G) — facility-level only, deliberately no
 *  patient-level census data crosses this seam (no new PHI at rest for the auth-fit factor). */
export interface QualifyCensusAggRow {
  facility_code: string;
  /** 'residential' | 'outpatient' — the rating suppresses auth/LOS outright for outpatient. */
  board_family?: string | null;
  avg_auth_days: number | null;
  avg_los_days: number | null;
  /** Clients behind each average (0078 / 0088). The rating gates on the SMALLER of the two, because
   *  auth-fit is their ratio. Optional so a pre-0088 read still typechecks and does not suppress. */
  auth_sample?: number | null;
  los_sample?: number | null;
  next_ur_date: string | null; // soonest upcoming UR date on the board, ISO
  open_beds: number | null;
  bed_capacity: number | null;
}

/** One facility's COMPLETED-stay aggregate (0091) — finished admissions with a real discharge date,
 *  over a trailing window. Distinct from QualifyCensusAggRow, which is a live snapshot of clients
 *  still admitted; see the basis decision in assembleFacilities. */
export interface QualifyOutcomesRow {
  facility_code: string;
  stays_sample: number;
  auth_sample: number;
  avg_los_days: number | null;
  avg_auth_days: number | null;
  window_days: number;
}

/** Raw, un-stripped lifetime cohort context the server loader returns (dollar sums intact — the
 *  CORE strips them for non-amounts viewers; the one choke-point pattern). */
export interface QualifyPatientCohortRaw {
  patients: number;
  billed: number | null;
  allowed: number | null;
  paid: number | null;
  byPayer: { label: string | null; count: number; charge: number }[];
  byCpt: { label: string | null; count: number; charge: number }[];
}

// ── pure assembly helpers ────────────────────────────────────────────────────

/** The ONE amounts choke point (R-AMOUNTS): null every dollar field. Runs LAST, in one place.
 *  v2 extends it to the policy card's raw benefit strings (deductible/OOP text is dollar-bearing);
 *  factors + ratingV2 are dollar-free BY CONSTRUCTION (ratingV2.ts has no dollar input) and pass
 *  through untouched — that is the blind-parity invariant. */
function stripSnapshotAmounts(snap: QualifySnapshot): QualifySnapshot {
  return {
    ...snap,
    facilities: snap.facilities.map((f) => ({ ...f, billedAmount: null, allowedAmount: null })),
    policy: snap.policy
      ? { ...snap.policy, deductible: null, deductibleMet: null, oopMax: null, oopMet: null }
      : null,
  };
}

/** The claims analog of stripSnapshotAmounts — the facility-drill choke point (R-AMOUNTS). Runs LAST. */
function stripClaimsAmounts(claims: QualifyClaim[]): QualifyClaim[] {
  return claims.map((c) => ({ ...c, billedAmount: null, allowedAmount: null }));
}

function emptySnapshot(hasAmounts: boolean): QualifySnapshot {
  return {
    resolved: null,
    facilities: [],
    identifierLandingFacility: null,
    viewerHasAmountsCapability: hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    policy: null,
    ladder: null,
    provenance: 'none',
    // Empty = "not loaded", which is exactly right here: an empty snapshot resolved no identifier,
    // so there is no payer set to disambiguate. Never conflate with "exactly one payer".
    payerOptions: [],
    payerOverridden: false,
  };
}

// ── v2 factor context — everything assembleFacilities needs beyond the rows ─────────────────────

interface QualifyFactorContext {
  windowDays: number;
  provenance: QualifyProvenance;
  coding: { seeded: boolean; rows: CodingDecisionRow[] };
  census: Map<string, QualifyCensusAggRow>;
  outcomes: Map<string, QualifyOutcomesRow>;
  /** The resolved payer LABEL the coding lookup keys on. Null on the comparable path (no payer —
   *  registry decisions are payer-scoped, so the factor honestly reads "no decision on file"). */
  payer: string | null;
  now: Date;
}

const NO_CODING = { seeded: false, rows: [] as CodingDecisionRow[] };

/** Comparable-cohort rankings are POPULATION estimates — recency beats reach. Unclamped, the
 *  funding-cohort shape at 365d measured 17.3s on prod (EXPLAIN ANALYZE 2026-08-03: 152k-row scan +
 *  12.8MB external sort); at 90d the same shape measures ~0.32s (44k rows, 3.5MB sort). The clamp is
 *  DISCLOSED, not hidden: windowAgeMultiplier(90)=0.9 prices it into data confidence, and every
 *  factor detail names the 90d reach (review finding #6). */
const QUALIFY_COMPARABLE_WINDOW_DAYS = 90 as const;

/** Days spanned by [from, to) — the data-confidence age input for ANY window shape. */
function windowDaysOf(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86_400_000) : 0;
}

/** Assemble the shared factor context for one snapshot: load coding + census ONCE (both optional
 *  seams, both fail-soft), never per facility. */
async function factorContext(
  deps: QualifyDeps,
  payer: string | null,
  from: string,
  to: string,
  provenance: QualifyProvenance,
): Promise<QualifyFactorContext> {
  const [coding, censusRows, outcomeRows] = await Promise.all([
    deps.loadCodingDecisions ? deps.loadCodingDecisions().catch(() => NO_CODING) : Promise.resolve(NO_CODING),
    deps.loadCensusAuth ? deps.loadCensusAuth().catch(() => [] as QualifyCensusAggRow[]) : Promise.resolve([] as QualifyCensusAggRow[]),
    // Fail-soft to []: losing the completed-stay aggregates degrades auth-fit to the in-progress
    // snapshot (the pre-0091 behaviour), never takes the ranking down.
    deps.loadFacilityOutcomes ? deps.loadFacilityOutcomes().catch(() => [] as QualifyOutcomesRow[]) : Promise.resolve([] as QualifyOutcomesRow[]),
  ]);
  const census = new Map<string, QualifyCensusAggRow>();
  const outcomes = new Map<string, QualifyOutcomesRow>();
  for (const r of censusRows) if (r.facility_code) census.set(r.facility_code, r);
  for (const r of outcomeRows) if (r.facility_code) outcomes.set(r.facility_code, r);
  return { windowDays: windowDaysOf(from, to), provenance, coding, census, outcomes, payer, now: deps.now() };
}


/** Non-PHI alpha-prefix echo (≤3 chars) — never the raw member id. */
function alphaEcho(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

/**
 * Map a facility's distinct tenant uuid(s) to a small NON-PHI label. Both tenants present → 'Mixed'
 * (a raw facility text served under both books — cross-tenant interleave is intended; the label never
 * groups or splits). An unrecognized/empty set → null (never fabricate a label). The canonical uuids
 * are the SAME two the cross-tenant scope pins.
 */
function entityLabel(entityIds: string[] | null | undefined): 'BXR' | 'Indigo' | 'Mixed' | null {
  if (!entityIds || entityIds.length === 0) return null;
  const hasBxr = entityIds.includes(BXR_ENTITY_ID);
  const hasIndigo = entityIds.includes(INDIGO_ENTITY_ID);
  if (hasBxr && hasIndigo) return 'Mixed';
  if (hasBxr) return 'BXR';
  if (hasIndigo) return 'Indigo';
  return null;
}

/**
 * Shape + rate + sort the facility rows. v2 (qualify-v2-build-plan §5): every card carries the
 * five-factor reading (computed HERE, server-side, from NON-DOLLAR inputs only — the wire ships the
 * work, the client never re-derives it), and the RANK is by ratingV2 desc — the factor model is the
 * sort key. Fallbacks keep it total: ratingV2 null (suppressed) sorts after rated cards, then the
 * value-first v1 pct, then name — deterministic under every data shape. FLOOR unchanged: drop
 * < QUALIFY_MIN_LINES flukes on payer-wide paths only.
 */
function assembleFacilities(
  rows: QualifyFacilityRow[],
  ctx: QualifyFactorContext,
  applyFloor = true,
): QualifyFacility[] {
  return rows
    // FLOOR (payer-wide only): drop < QUALIFY_MIN_LINES flukes. An IDENTIFIER-scoped ranking passes
    // applyFloor=false — every facility the searched id billed is relevant (even a single claim), and the
    // "thin sample" flag (lineCount) communicates the small n instead of hiding the facility.
    .filter((r) => !applyFloor || r.line_count >= QUALIFY_MIN_LINES)
    .map((r) => {
      const facilityCode = r.facility_code ?? null;
      const census = facilityCode ? ctx.census.get(facilityCode) ?? null : null;
      /* WHICH LENGTH-OF-STAY MEASUREMENT SCORES THIS FACILITY — decided here, explicitly, once.
       *
       * The census snapshot measures clients CURRENTLY ADMITTED, so its LOS is today-minus-admit: a
       * stay still running. Completed stays (0091) measure finished admissions with a real discharge
       * date. They disagree materially — measured 2026-08-06, the in-progress read put ALL twelve
       * residential facilities below their authorization (0.69-0.96), so the overrun penalty could
       * never fire for anyone; on completed stays four are at or over it. It also carries 47-165
       * authorized-day values per facility against the snapshot's 4-15.
       *
       * Completed stays WIN when present with a usable sample, because they are the quantity the
       * factor claims to compare. Otherwise fall back to the snapshot unchanged — outpatient
       * facilities have no outcomes row at all, and the factor suppresses there for its own reasons.
       * The chosen basis rides into the rating so the card can SAY which one it used; two facilities
       * scored on different measurements are not comparable and the operator must be told. */
      const outcome = facilityCode ? ctx.outcomes.get(facilityCode) ?? null : null;
      const useOutcomes =
        outcome !== null &&
        outcome.avg_los_days !== null &&
        outcome.avg_auth_days !== null &&
        outcome.auth_sample >= QUALIFY_AUTH_FIT_MIN_SAMPLE &&
        outcome.stays_sample >= QUALIFY_AUTH_FIT_MIN_SAMPLE;
      // Coding lookup: payer-scoped (registry decisions are per payer family). The comparable path
      // carries payer=null → no row → the factor reads "no decision on file", which is the truth.
      const decision = ctx.coding.seeded
        ? lookupCodingDecision(ctx.coding.rows, ctx.payer, facilityCode, r.care_setting)
        : null;
      const v2 = computeRatingV2({
        pctAllowed: r.pct_allowed,
        lineCount: r.line_count,
        confirmedClaims: r.confirmed_claims,
        distinctPatients: r.distinct_patients,
        windowDays: ctx.windowDays,
        provenance: ctx.provenance,
        registrySeeded: ctx.coding.seeded,
        payerKnown: ctx.payer !== null,
        codingLifecycle: decision ? (decision.lifecycle as import('./ratingV2').CodingLifecycle) : null,
        codingDecidedOn: decision?.decided_on ?? null,
        codingCodesLabel: decision ? codingCodesLabel(decision) : null,
        medianDaysToPayment: r.median_days_to_payment ?? null,
        avgAuthDays: useOutcomes ? outcome!.avg_auth_days : (census?.avg_auth_days ?? null),
        avgLosDays: useOutcomes ? outcome!.avg_los_days : (census?.avg_los_days ?? null),
        censusFamily: census?.board_family === 'outpatient' || census?.board_family === 'residential' ? census.board_family : null,
        authSample: useOutcomes ? outcome!.auth_sample : (census?.auth_sample ?? null),
        losSample: useOutcomes ? outcome!.stays_sample : (census?.los_sample ?? null),
        losBasis: useOutcomes ? 'completed' : census?.avg_los_days != null ? 'in_progress' : null,
        losWindowDays: useOutcomes ? outcome!.window_days : null,
        now: ctx.now,
      });
      return {
        rank: 0,
        name: r.facility_name ?? r.facility,
        facilityKey: r.facility, // raw rollup text — the join key for the facility-scoped cases drill
        city: facilityLocation(r.facility_code)?.city ?? null,
        state: facilityLocation(r.facility_code)?.state ?? null,
        pctAllowedOfBilled: r.pct_allowed,
        // The other two tile metrics, per facility — the flanks the KPI tiles bracket their headline
        // with. Percentages, so they are NOT in stripSnapshotAmounts' remit and blind/sighted match.
        pctPaidOfAllowed: r.pct_paid_of_allowed ?? null,
        pctPaidOfBilled: r.pct_paid_of_billed ?? null,
        rating: qualifyRating(r.pct_allowed),
        streakSignal: null, // Q-E: always null in v1
        billedAmount: r.billed,
        allowedAmount: r.allowed,
        lineCount: r.line_count,
        distinctPatients: r.distinct_patients, // rating sample-gate unit (sampleGate.ts) — non-dollar, non-PHI count
        // 0059 trust signal (non-dollar — survives the amounts strip for admissions_seat).
        confirmedClaims: r.confirmed_claims,
        estimateClaims: r.estimate_claims,
        unknownClaims: r.unknown_claims,
        careSetting: r.care_setting,
        entity: entityLabel(r.entity_ids),
        // v2 — all non-dollar; survive the amounts strip unchanged.
        medianDaysToPayment: r.median_days_to_payment ?? null,
        avgAuthDays: census?.avg_auth_days ?? null,
        avgLosDays: census?.avg_los_days ?? null,
        // NO censusFamily HERE. It is a rating INPUT (see the computeRatingV2 call above), not part
        // of the client contract — `QualifyFacility` in contract.ts declares no such field, and
        // contract.ts is the frozen single source of truth for what crosses the wire. A mechanical
        // edit put it on both objects; on this one it was undeclared payload that nothing read.
        nextUrDate: census?.next_ur_date ?? null,
        openBeds: census?.open_beds ?? null,
        // Licensed beds (curated FACILITY_BED_CAPACITY). Null for outpatient — they have no beds,
        // which is correct rather than missing — and for any residential facility not yet curated.
        bedCapacity: census?.bed_capacity ?? null,
        ratingV2: v2.rating,
        iqBand: v2.band,
        factors: v2.factors,
        availableWeight: v2.availableWeight,
      };
    })
    .sort((a, b) => {
      // v2 rank: factor rating desc, nulls (suppressed) last …
      if (a.ratingV2 === null && b.ratingV2 !== null) return 1;
      if (b.ratingV2 === null && a.ratingV2 !== null) return -1;
      if (a.ratingV2 !== null && b.ratingV2 !== null && b.ratingV2 !== a.ratingV2) return b.ratingV2 - a.ratingV2;
      // … then the value-first v1 rating, then pct, then name — deterministic everywhere.
      const br = b.rating ?? -1;
      const ar = a.rating ?? -1;
      if (br !== ar) return br - ar;
      const bp = b.pctAllowedOfBilled ?? -1;
      const ap = a.pctAllowedOfBilled ?? -1;
      if (bp !== ap) return bp - ap;
      return a.name.localeCompare(b.name);
    })
    .map((f, i) => ({ ...f, rank: i + 1 }));
}

function assembleClaims(rows: QualifyClaimRow[]): QualifyClaim[] {
  // PER-RESPONSE patient aliasing: first-seen ordinal per member_id_bidx. The opaque token itself
  // NEVER leaves this function (wire-tested); a null/absent bidx gets its own singleton key so no
  // two unknown-member claims ever merge into a fake patient.
  const aliasByToken = new Map<string, number>();
  let nextAlias = 0;
  const aliasOf = (bidx: string | null): number => {
    if (bidx === null) return ++nextAlias; // singleton — never grouped
    const existing = aliasByToken.get(bidx);
    if (existing !== undefined) return existing;
    nextAlias += 1;
    aliasByToken.set(bidx, nextAlias);
    return nextAlias;
  };
  return rows.map((r) => ({
    id: r.id,
    patientKey: aliasOf(r.member_id_bidx),
    memberIdMasked: QUALIFY_MEMBER_ID_MASK,
    payerName: r.primary_payer, // non-PHI; the SAME rollup column the payer card resolves on (no re-lookup)
    facilityName: r.facility_name ?? r.facility,
    program: r.program,
    dos: r.dos,
    paymentDate: r.payment_date,
    pctAllowedOfBilled: r.pct_allowed,
    billedAmount: r.billed,
    allowedAmount: r.allowed,
    // The six-value tier collapses HERE (confidence.ts) — the client only ever sees the 3 states.
    confidence: confidenceOf(r.allowed_tier),
  }));
}

// ── cores ────────────────────────────────────────────────────────────────────

export async function getQualifySnapshotCore(deps: QualifyDeps, input: QualifyInput): Promise<QualifySnapshot> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');

  const raw = (input.query ?? '').trim();
  if (raw === '' || raw.length > 120) return emptySnapshot(gate.hasAmounts);

  const kind = sniffQualifyKind(raw);
  let token: string | null;
  try {
    token = deps.mintToken(raw, kind);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  if (!token) return emptySnapshot(gate.hasAmounts); // e.g. a <3-char prefix → nothing searched → no audit

  // A real PHI search executed → audit BEFORE any data (field NAME only; never term/token).
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_PHI,
    detail: { field: kind, window: serializeQualifyWindow(window) },
  });

  // ── Phase E: the AUTO-WINDOW sufficiency ladder (one bucketed query, never five probes). Runs
  // BEFORE the payer resolve so the chosen window scopes everything downstream. Manual windows
  // (input.auto falsy) skip it entirely — the Range menu stays the biller's override.
  let window2: QualifyWindow = window;
  let ladder: QualifyWindowLadder | null = null;
  if (input.auto === true && kind === 'prefix' && deps.loadWindowRungs) {
    const rungDays: QualifyTrailingDays[] = [30, 60, 90, 180, 365];
    const now = deps.now();
    const boundsOf = (d: QualifyTrailingDays) => qualifyWindowBounds({ kind: 'trailing', days: d }, now);
    const to = boundsOf(30).to; // all trailing windows share the exclusive upper bound
    const froms = {
      d30: boundsOf(30).from,
      d60: boundsOf(60).from,
      d90: boundsOf(90).from,
      d180: boundsOf(180).from,
      d365: boundsOf(365).from,
    };
    try {
      const counts = await deps.loadWindowRungs(token, kind, gate.entityIds, froms, to);
      const byDay: Record<QualifyTrailingDays, number> = {
        30: counts.p30,
        60: counts.p60,
        90: counts.p90,
        180: counts.p180,
        270: counts.p180, // 270 is not a ladder rung; mapped for type-totality only (never rendered)
        365: counts.p365,
      };
      const rungs: QualifyWindowRung[] = rungDays.map((d) => ({
        days: d,
        distinctPatients: byDay[d],
        sufficient: byDay[d] >= QUALIFY_RATING_CONFIDENT_PATIENTS,
      }));
      const chosen = rungs.find((r) => r.sufficient) ?? rungs[rungs.length - 1]!;
      ladder = { rungs, chosenDays: chosen.days, sufficient: chosen.sufficient };
      window2 = { kind: 'trailing', days: chosen.days };
    } catch {
      ladder = null; // ladder failure degrades to the caller's window — never blocks the search
    }
  }

  // ── Phase B/0: the policy on file behind the token + the global VOB feed freshness — parallel
  // with the payer resolve. All three fail-soft; a VOB hiccup must not take down the claims read.
  const [dominantPayer, policyRow, globalFresh, payerSpread, policySpread] = await Promise.all([
    deps.resolvePayer(token, kind, gate.entityIds),
    deps.loadPolicy ? deps.loadPolicy(token, kind).catch(() => null) : Promise.resolve(null),
    deps.loadVobFreshness ? deps.loadVobFreshness().catch(() => null) : Promise.resolve(null),
    // Both spreads fail SOFT to []: losing a widening must degrade to the pre-existing single-value
    // behaviour, never take the search down. [] reads as "not loaded" everywhere downstream.
    deps.loadPayerSpread
      ? deps.loadPayerSpread(token, kind, gate.entityIds).catch(() => [])
      : Promise.resolve([] as QualifyPayerSpreadRow[]),
    deps.loadPolicySpread ? deps.loadPolicySpread(token, kind).catch(() => []) : Promise.resolve([]),
  ]);

  // ── THE PHI FORWARDING BOUNDARY for the VOB spread. Split ONCE, here, and never re-joined.
  //
  // `employer` rows carry employer_norm, whose display twin employer_name is a PHI column
  // (app/lib/phi.ts PHI_BASE_COLUMNS) that the AI payload has never carried (qualifyAi.ts). They stay
  // SERVER-SIDE — used below as the comparable-cohort join key, exactly like the pre-existing
  // policyRow.employer_norm, which this file already documents as "never forwarded on the wire".
  // Only the COUNT of them crosses, via policyRow.employer_count.
  //
  // `carrier` rows carry insurance_co, which is NOT a PHI column and already ships singular as
  // policy.carrier. Those ARE wire-safe and become the carrier drill-down set.
  const employerSpread = policySpread.filter((r) => r.dim === 'employer');
  const carrierSpread = policySpread.filter((r) => r.dim === 'carrier');

  // Counts and a date only — no amount — so payerOptions is byte-identical for an admissions_seat
  // session and needs no entry in stripSnapshotAmounts. Keep it that way.
  const payerOptions: QualifyPayerOption[] = payerSpread.map((r) => ({
    payer: r.primary_payer,
    lines: r.lines,
    patients: r.patients,
    lastPayment: r.last_payment,
  }));

  // ── The payer drill-down, VALIDATED against this identifier's own evidence.
  //
  // An override is honoured ONLY if the token actually bills under it. That is the whole security
  // and honesty argument in one line: `resolved` asserts "this identifier's footprint under this
  // payer", so accepting an arbitrary client string would let a hand-edited value produce a
  // confidently-empty result labelled as resolved evidence. Membership in payerSpread is the exact
  // predicate that makes the assertion true, and it costs nothing — the spread is already loaded.
  //
  // Falls back to the dominant payer (payerName) on a miss rather than erroring: the user's intent
  // was still "search this identifier", and a silent narrowing is worse than the default answer.
  // Comparison is exact — primary_payer values are matched exactly everywhere else in this file.
  const overrideRequested = typeof input.payerOverride === 'string' ? input.payerOverride.trim() : '';
  const overrideHonoured =
    overrideRequested !== '' && payerOptions.some((o) => o.payer === overrideRequested)
      ? overrideRequested
      : null;
  const payerName = overrideHonoured ?? dominantPayer;

  const now = deps.now();
  // Feed staleness (Phase 0): the GLOBAL high-water mark going stale means every policy read is
  // suspect — the exact "confidently wrong" failure mode. The loader returns a FULL UTC ISO
  // timestamp (PR #73 review fix), so the threshold applies exactly — the old day-grain source
  // needed a 24h slack that could delay the stale flag a day past the configured bar. A legacy
  // bare-date string still parses (as midnight UTC) and errs toward flagging EARLY, never late.
  const staleFloorMs = QUALIFY_VOB_STALE_HOURS * 3_600_000;
  const vobStale = globalFresh !== null && now.getTime() - Date.parse(globalFresh) > staleFloorMs;
  const policy: QualifyPolicyCard | null =
    policyRow === null
      ? null
      : {
          found: policyRow.member_count > 0,
          memberCount: policyRow.member_count,
          carrier: policyRow.carrier,
          employerName: policyRow.employer_name,
          funding: policyRow.funding,
          policyType: policyRow.policy_type,
          planType: policyRow.plan_type,
          groupOnFile: policyRow.group_on_file,
          // The TRUE distinct counts from the one-row aggregate — never carrierSpread.length, which
          // is capped at QUALIFY_SPREAD_LIMIT and would under-report a 50-carrier prefix as 25.
          employerCount: policyRow.employer_count,
          carrierCount: policyRow.carrier_count,
          carriers: carrierSpread.map((r) => ({ value: r.value, members: r.members })),
          network: null, // Phase D: not extracted from the VOB yet (three parser generations, none carries it)
          vobFreshAsOf: policyRow.vob_fresh_as_of,
          vobStale,
          deductible: policyRow.deductible,
          deductibleMet: policyRow.deductible_met,
          oopMax: policyRow.oop_max,
          oopMet: policyRow.oop_met,
        };

  const { from, to } = qualifyWindowBounds(window2, now);

  if (payerName) {
    // ── DIRECT provenance: this identifier has its own claims history. Identifier-scoped ranking:
    // the panel + counts + Recent Claims all describe the SEARCHED token's footprint (ruling: the
    // facilities the user sees must be the ones that billed what they searched).
    // Factor context (coding + census) is independent of the row loads — run all three together
    // (review finding #11: two avoidable serial round-trips on a latency-sensitive surface).
    const [ctx, facRows, landingRaw] = await Promise.all([
      factorContext(deps, payerName, from, to, 'direct'),
      deps.loadFacilities(payerName, from, to, gate.entityIds, input.market, token, kind),
      deps.loadIdentifierLandingFacility(token, kind, payerName, from, to, gate.entityIds),
    ]);
    const facilities = assembleFacilities(facRows, ctx, false); // no floor — every billed facility is relevant
    const identifierLandingFacility =
      landingRaw !== null && facilities.some((f) => f.facilityKey === landingRaw) ? landingRaw : null;
    const resolved: QualifyResolved = {
      payerName,
      matchedOn: kind,
      matchedValue: alphaEcho(raw),
      totalCharges: facilities.reduce((s, f) => s + f.lineCount, 0),
      facilityCount: facilities.length,
      windowStart: from,
      windowEnd: to,
      identifierScoped: true,
    };
    const snap: QualifySnapshot = {
      resolved,
      facilities,
      identifierLandingFacility,
      viewerHasAmountsCapability: gate.hasAmounts,
      tenantScope: QUALIFY_TENANT_SCOPE,
      policy,
      ladder,
      provenance: 'direct',
      // The DIRECT path is the only one where alternatives exist to offer: the identifier has its own
      // claims, and payerOptions[0] is the payerName resolved just above.
      payerOptions,
      payerOverridden: overrideHonoured !== null,
    };
    return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
  }

  // ── COMPARABLE provenance (Phase B): no claims for THIS identifier, but the VOB tells us its
  // plan. Rank facilities over the policy's behavioral peer group — same employer plan first
  // (member_benefits employer_norm semi-join), else the funding market — clearly labeled ESTIMATED,
  // never dressed as direct evidence. resolved stays null (the honest "no own history" signal);
  // the policy card + provenance carry the story. No cohort at all → the plain VOB path.
  if (policy?.found && deps.loadFacilities) {
    const employerNorm = policyRow?.employer_norm ?? null;
    const funding = policyRow?.funding ?? null;
    // EVERY employer behind the prefix, not just the modal one. `VobMarketFilter.employers` has
    // always been a string[]; passing a single element was the narrowing. MEASURED 2026-08-06: in 57%
    // of member-weighted searches the modal employer is a MINORITY of the prefix, so the old
    // one-element cohort excluded most of the peer group it claimed to rank over — and did so most
    // aggressively on the big prefixes real searches land on. The spread is ranked and capped at
    // QUALIFY_SPREAD_LIMIT, so this stays bounded (the pathological prefix carries 300 employers).
    //
    // employerNorm remains the FALLBACK: if the spread failed soft or is empty, this path must still
    // behave exactly as it did before rather than losing comparable provenance entirely.
    const employers = employerSpread.length > 0 ? employerSpread.map((r) => r.value) : employerNorm ? [employerNorm] : [];
    const comparable: { market: VobMarketFilter; provenance: QualifyProvenance } | null =
      employers.length > 0
        ? { market: { employers }, provenance: 'comparable_employer' }
        : funding
          ? { market: { funding: [funding] }, provenance: 'comparable_funding' }
          : null;
    if (comparable) {
      try {
        // payer=null + a NON-EMPTY market: the builder ranks the cohort across all payers. The
        // payer-wide floor applies (this is a book-shaped ranking, not an identifier footprint).
        // Window is CLAMPED to the comparable span (see the constant above) — never the ladder's
        // 365d worst case, which this path would otherwise always hit (zero own-claims ⇒ widest rung).
        const cb = qualifyWindowBounds({ kind: 'trailing', days: QUALIFY_COMPARABLE_WINDOW_DAYS }, now);
        const [ctx, facRows] = await Promise.all([
          factorContext(deps, null, cb.from, cb.to, comparable.provenance),
          deps.loadFacilities(null, cb.from, cb.to, gate.entityIds, comparable.market),
        ]);
        const facilities = assembleFacilities(facRows, ctx, true);
        const snap: QualifySnapshot = {
          resolved: null,
          facilities,
          identifierLandingFacility: null,
          viewerHasAmountsCapability: gate.hasAmounts,
          tenantScope: QUALIFY_TENANT_SCOPE,
          policy,
          ladder,
          provenance: facilities.length > 0 ? comparable.provenance : 'none',
          // COMPARABLE provenance means this identifier has NO claims of its own, so payerSpread is
          // empty by construction — there is nothing to disambiguate. Stated explicitly rather than
          // spread in, so the empty is a decision and not an oversight.
          payerOptions: [],
          payerOverridden: false,
        };
        return gate.hasAmounts ? snap : stripSnapshotAmounts(snap);
      } catch {
        // comparable ranking failure degrades to the plain VOB path below
      }
    }
  }

  const empty = emptySnapshot(gate.hasAmounts);
  const snap: QualifySnapshot = { ...empty, policy, ladder };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap);
}

/**
 * Resolve-by-primary-payer: load a payer's facilities DIRECTLY from its label (a QualifyMover's `label`,
 * i.e. a primary_payer value), bypassing the member-id/prefix PHI resolve. Reuses the SAME facility loader,
 * assembly, tenancy scope, and amounts choke point as getQualifySnapshotCore. No mintToken, no resolvePayer,
 * no SEARCH_QUALIFY_PHI — no PHI term is searched, so there is NO identifier to be exact about: the claims
 * panel on this path stays payer-wide (ruling 3), driven by the facility drill with no identifier narrow. A
 * real payer with no in-window facilities yields the non-null resolved + facilities:[] state (never VOB null).
 */
export async function getQualifySnapshotByPayerCore(
  deps: QualifyDeps,
  input: QualifyPayerInput,
): Promise<QualifySnapshot> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');

  const payer = (input.payer ?? '').trim();
  if (payer === '' || payer.length > 120) return emptySnapshot(gate.hasAmounts);

  // Non-PHI lookup (payer label, not a member term) → distinct audit action; payer name is not PHI.
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_PAYER,
    detail: { payer, window: serializeQualifyWindow(window) },
  });

  const { from, to } = qualifyWindowBounds(window, deps.now());
  const [ctx, facRows] = await Promise.all([
    factorContext(deps, payer, from, to, 'direct'),
    deps.loadFacilities(payer, from, to, gate.entityIds, input.market),
  ]);

  const facilities = assembleFacilities(facRows, ctx);
  const resolved: QualifyResolved = {
    payerName: payer,
    matchedOn: 'payer',
    matchedValue: '', // no PHI prefix echo on the resolve-by-payer path
    totalCharges: facilities.reduce((s, f) => s + f.lineCount, 0),
    facilityCount: facilities.length,
    windowStart: from,
    windowEnd: to,
    identifierScoped: false, // by-payer stays payer-wide (no identifier narrow)
  };
  const snap: QualifySnapshot = {
    resolved,
    facilities,
    identifierLandingFacility: null, // resolve-by-payer carries NO identifier → payer-wide (ruling 3)
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    // The user NAMED the payer — that IS the disambiguation, already made. Offering alternatives
    // here would invite them to undo the choice they just expressed. Empty is correct, not missing.
    payerOptions: [],
    // Not an override of a resolve: there was no resolve to override on this path.
    payerOverridden: false,
    policy: null, // a payer label carries no member identity → nothing to resolve a policy from
    ladder: null,
    provenance: 'direct',
  };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
}

/**
 * Resolve by CLIENT NAME (Change C): HMAC the typed name against the EXACT normalized-name blind
 * index (patient_name_bidx), resolve the dominant payer among matching rows, then the standard
 * facility ranking + Fix-A landing (the client's most-recent in-window facility). Mirrors
 * getQualifySnapshotCore's flow with three deliberate differences: (1) the token is minted by
 * mintNameToken (patientNameBlindIndex — the 0049-parity normalization), never the member-id sniff;
 * (2) the audit action is SEARCH_QUALIFY_NAME with field NAME only — the raw name reaches neither
 * the audit detail nor any log/URL; (3) matchedValue is ALWAYS '' — a name is PHI and is never
 * echoed back (unlike the ≤3-char alpha prefix). Names are not unique: the resolution spans every
 * same-named patient cross-tenant (dominant payer wins) — the UI captions this.
 */
export async function getQualifySnapshotByNameCore(
  deps: QualifyDeps,
  input: QualifyNameInput,
): Promise<QualifySnapshot> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');

  const raw = (input.name ?? '').trim();
  if (raw === '' || raw.length > 120) return emptySnapshot(gate.hasAmounts);

  let token: string | null;
  try {
    token = deps.mintNameToken(raw);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  if (!token) return emptySnapshot(gate.hasAmounts); // normalizes to nothing → nothing searched → no audit

  // A real PHI search executed → audit BEFORE any data (field NAME only; never the term/token).
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_NAME,
    detail: { field: 'client_name', window: serializeQualifyWindow(window) },
  });

  const payerName = await deps.resolvePayer(token, 'client_name', gate.entityIds);
  if (!payerName) return emptySnapshot(gate.hasAmounts); // never-seen name → VOB (resolved stays null)

  const { from, to } = qualifyWindowBounds(window, deps.now());
  // Identifier-scoped ranking (same as the member/prefix path) — narrowed to the searched name's
  // footprint. Factor context rides the same Promise.all (review finding #11).
  const [ctx, facRows, landingRaw] = await Promise.all([
    factorContext(deps, payerName, from, to, 'direct'),
    deps.loadFacilities(payerName, from, to, gate.entityIds, input.market, token, 'client_name'),
    deps.loadIdentifierLandingFacility(token, 'client_name', payerName, from, to, gate.entityIds),
  ]);

  const facilities = assembleFacilities(facRows, ctx, false); // no floor — every facility the name billed is relevant
  const identifierLandingFacility =
    landingRaw !== null && facilities.some((f) => f.facilityKey === landingRaw) ? landingRaw : null;
  const resolved: QualifyResolved = {
    payerName,
    matchedOn: 'client_name',
    matchedValue: '', // NEVER echo a name (PHI) — unlike the ≤3-char alpha prefix
    totalCharges: facilities.reduce((s, f) => s + f.lineCount, 0),
    facilityCount: facilities.length,
    windowStart: from,
    windowEnd: to,
    identifierScoped: true,
  };
  const snap: QualifySnapshot = {
    resolved,
    facilities,
    identifierLandingFacility,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    // DELIBERATELY EMPTY, and a known gap rather than a decision on the merits. A client-name resolve
    // is identifier-shaped and can be multi-payer exactly like a prefix, so this path deserves the
    // same widening. It does not get it here because the Client Name surface is still gated off
    // (.claude/rules/qualify.md), which means the change would ship unverifiable against real use.
    // Wire loadPayerSpread(token, 'client_name', …) here when that surface turns on.
    payerOptions: [],
    payerOverridden: false,
    policy: null, // name resolution carries no prefix → no policy lookup (a name is not a plan)
    ladder: null,
    provenance: 'direct',
  };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
}

/**
 * Facility drill (THE rendered recent-claims panel on both surfaces): the resolved payer's CLAIMS at ONE
 * facility (the desktop facility row + mobile facility-card tap), claim grain. Masking (assembleClaims),
 * tenancy scope, and the amounts choke point (stripClaimsAmounts) run here; the axes are the raw-facility-text
 * filter plus the optional identifier narrow (prefix/exact member). A distinct SEARCH_QUALIFY_FACILITY audit
 * records the more-granular access (payer + facility are non-PHI; the narrow's field NAME only, never the term).
 */
export async function getQualifyFacilityCasesCore(
  deps: QualifyDeps,
  input: QualifyFacilityCasesInput,
): Promise<QualifyFacilityCases> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');

  const payer = (input.payer ?? '').trim();
  const facility = (input.facility ?? '').trim();
  const empty: QualifyFacilityCases = {
    claims: [],
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    capped: false,
  };
  if (payer === '' || payer.length > 120 || facility === '' || facility.length > 200) return empty;

  // IDENTIFIER narrow (Direction B): mint the SAME blind index the resolve path uses — server-side, opaque.
  // The raw term (the caller's own typed value: the resolving search OR the manual prefix input — never row
  // PHI) reaches neither SQL nor the audit. EXACT member-id (member_id_bidx) takes precedence over the ≤3
  // alpha-PREFIX (member_id_prefix_bidx); mutually exclusive in practice. A term minting no token (e.g. a
  // <3-char prefix) yields no filter (parity with collections' alpha-prefix behavior).
  const memberId = (input.filter?.memberId ?? '').trim();
  const prefix = (input.filter?.prefix ?? '').trim();
  const clientName = (input.filter?.clientName ?? '').trim();
  let memberToken: string | null = null;
  let prefixToken: string | null = null;
  let nameToken: string | null = null;
  let narrowField: QualifyTokenKind | null = null;
  try {
    if (memberId !== '' && memberId.length <= 120) {
      memberToken = deps.mintToken(memberId, 'member_id');
      if (memberToken) narrowField = 'member_id';
    } else if (prefix !== '' && prefix.length <= 40) {
      prefixToken = deps.mintToken(prefix, 'prefix');
      if (prefixToken) narrowField = 'prefix';
    } else if (clientName !== '' && clientName.length <= 120) {
      // Change C: the EXACT client-name narrow (carried from a name-resolving search). Same mint
      // discipline — server-side, opaque, the raw name never logged.
      nameToken = deps.mintNameToken(clientName);
      if (nameToken) narrowField = 'client_name';
    }
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  // Group-number narrow (EXACT — the employer proxy; Phase 2). Independent of the member narrow
  // (ANDed in SQL). Same mint discipline: server-side, opaque, raw term never logged.
  const groupTerm = (input.filter?.group ?? '').trim();
  let groupToken: string | null = null;
  try {
    if (groupTerm !== '' && groupTerm.length <= 40) groupToken = deps.mintGroupToken(groupTerm);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }

  // Narrowing a payer to one facility is a distinct, more-granular access → its own audit action. When a
  // narrow is actually applied, record the FIELD NAME(S) only (never the term/token).
  const narrowFields = [...(narrowField ? [narrowField] : []), ...(groupToken ? ['group_number'] : [])];
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_FACILITY,
    detail: { payer, facility, window: serializeQualifyWindow(window), ...(narrowFields.length ? { fields: narrowFields } : {}) },
  });

  // The drill returns the WHOLE (facility, payer, window) set — no keyset pager — capped at QUALIFY_CASES_MAX.
  // allPayers (mobile) only drops the single-payer filter. The identifier narrow (when the session arrived via
  // a search) still applies (ruling 5). The builder over-fetches by one (limit+1) so `capped` is a length
  // check, not a count.
  const allPayers = input.allPayers === true;
  const { from, to } = qualifyWindowBounds(window, deps.now());
  // Build the shared-predicate filter (one-element facility/payer arrays — the single-facility drill is
  // just a degenerate compose set). member/prefix/group ride phiIndex; nameToken is the Qualify extra AND.
  const cmdFilter: CmdExplorerFilter = {
    facility: [facility],
    primary_payers: allPayers ? null : [payer],
    employers: input.market?.employers ?? null,
    funding: input.market?.funding ?? null,
    from,
    to,
    phiIndex: { memberIdBidx: memberToken, memberIdPrefixBidx: prefixToken, groupNumberBidx: groupToken },
  };
  const claimRows = await deps.loadFacilityCases(cmdFilter, gate.entityIds, {
    nameToken,
    allPayers,
    limit: QUALIFY_CASES_MAX,
  });
  const capped = claimRows.length > QUALIFY_CASES_MAX;
  const pageRows = capped ? claimRows.slice(0, QUALIFY_CASES_MAX) : claimRows; // keep the MOST RECENT (payment desc)
  // Route through the ONE amounts choke point (stripClaimsAmounts) — stripAmounts LAST.
  const claims = gate.hasAmounts ? assembleClaims(pageRows) : stripClaimsAmounts(assembleClaims(pageRows));
  return {
    claims,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    capped,
  };
}

// ── Compose-bar cores (Phase 1) ──────────────────────────────────────────────────────────────────

/** String-array sanitizer for the compose filter: trim, drop blanks/overlong, cap count → null when empty
 *  (an EMPTY array must be "no restriction", never `= any(ARRAY[])` which matches nothing). */
function boundArray(a?: string[]): string[] | null {
  if (!Array.isArray(a)) return null;
  const cleaned = a
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s !== '' && s.length <= 200)
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Bound + HMAC a compose-bar input into the shared-predicate CmdExplorerFilter (+ Qualify's name-token
 * extra). Every raw PHI term is minted server-side (deps.mint*), never logged; non-PHI arrays are trimmed
 * + capped. `phiFields` lists which PHI narrows actually fired (field NAMES only) for the audit.
 */
function buildComposeFilter(
  deps: QualifyDeps,
  input: QualifyComposeInput,
  from: string,
  to: string,
): { filter: CmdExplorerFilter; nameToken: string | null; phiFields: string[] } {
  const term = (s: string | undefined, max: number): string =>
    typeof s === 'string' ? s.trim().slice(0, max) : '';
  const memberId = term(input.memberId, 120);
  const alphaPrefix = term(input.alphaPrefix, 40);
  const group = term(input.group, 40);
  const clientName = term(input.clientName, 120);
  let memberToken: string | null = null;
  let prefixToken: string | null = null;
  let groupToken: string | null = null;
  let nameToken: string | null = null;
  const phiFields: string[] = [];
  try {
    if (memberId) {
      memberToken = deps.mintToken(memberId, 'member_id');
      if (memberToken) phiFields.push('member_id');
    }
    if (alphaPrefix) {
      prefixToken = deps.mintToken(alphaPrefix, 'prefix');
      if (prefixToken) phiFields.push('prefix');
    }
    if (group) {
      groupToken = deps.mintGroupToken(group);
      if (groupToken) phiFields.push('group_number');
    }
    if (clientName) {
      // Change C — the admissions-first name narrow. Cases-only (the summary can't express it); dormant
      // until QUALIFY_CLIENT_NAME_ENABLED, so clientName is always empty in Phase 1.
      nameToken = deps.mintNameToken(clientName);
      if (nameToken) phiFields.push('client_name');
    }
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  const filter: CmdExplorerFilter = {
    facility: boundArray(input.facilities),
    primary_payers: boundArray(input.payers),
    employers: boundArray(input.employers),
    funding: boundArray(input.funding),
    from,
    to,
    phiIndex: { memberIdBidx: memberToken, memberIdPrefixBidx: prefixToken, groupNumberBidx: groupToken },
  };
  return { filter, nameToken, phiFields };
}

/** True when a compose filter carries at least one restriction (else it's the whole-book window — the
 *  Qualify landing shows the hero for that, so the cores return empty rather than fetch the whole book). */
function composeHasAny(filter: CmdExplorerFilter, nameToken: string | null): boolean {
  const p = filter.phiIndex;
  return !!(
    filter.facility ||
    filter.primary_payers ||
    filter.employers ||
    filter.funding ||
    p?.memberIdBidx ||
    p?.memberIdPrefixBidx ||
    p?.groupNumberBidx ||
    nameToken
  );
}

/**
 * COMPOSE-BAR claims (Phase 1): the charge lines matching an AND-composed filter SET, claim grain,
 * cross-tenant. Same masking (assembleClaims) + amounts choke point (stripClaimsAmounts) as the
 * single-facility drill, but the axes are the whole set. This IS the row-returning PHI access, so it
 * audits SEARCH_QUALIFY_FACILITY with the active PHI field NAMES + non-PHI selection cardinalities only
 * (never a term/token/label). An empty filter (no restriction) short-circuits to empty — never a
 * whole-book fetch.
 */
export async function getQualifyComposedCasesCore(
  deps: QualifyDeps,
  input: QualifyComposeInput,
): Promise<QualifyFacilityCases> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop
  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');
  const { from, to } = qualifyWindowBounds(window, deps.now());
  const { filter, nameToken, phiFields } = buildComposeFilter(deps, input, from, to);
  const empty: QualifyFacilityCases = {
    claims: [],
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    capped: false,
  };
  if (!composeHasAny(filter, nameToken)) return empty;

  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_FACILITY,
    detail: {
      facilities: (filter.facility ?? []).length,
      payers: (filter.primary_payers ?? []).length,
      window: serializeQualifyWindow(window),
      ...(phiFields.length ? { fields: phiFields } : {}),
    },
  });

  const claimRows = await deps.loadFacilityCases(filter, gate.entityIds, { nameToken, limit: QUALIFY_CASES_MAX });
  const capped = claimRows.length > QUALIFY_CASES_MAX;
  const pageRows = capped ? claimRows.slice(0, QUALIFY_CASES_MAX) : claimRows; // keep the MOST RECENT (payment desc)
  const claims = gate.hasAmounts ? assembleClaims(pageRows) : stripClaimsAmounts(assembleClaims(pageRows));
  return { claims, viewerHasAmountsCapability: gate.hasAmounts, tenantScope: QUALIFY_TENANT_SCOPE, capped };
}

/**
 * COMPOSE-BAR live match count (Phase 1). Gate-only (NON-PHI aggregate, parity with the book KPIs +
 * movers) — the row-returning claims core owns the PHI audit, so the debounced count does NOT re-audit
 * per keystroke. Percentages are derived from the sums BEFORE the amounts strip, so admissions_seat gets
 * count + percentages with ZERO dollars. The client-name narrow is deliberately NOT applied here (the
 * shared summary builder can't express patient_name_bidx) — harmless while QUALIFY_CLIENT_NAME_ENABLED is
 * off; flipping that flag will also require making this count name-aware.
 */
export async function getQualifyMatchSummaryCore(
  deps: QualifyDeps,
  input: QualifyComposeInput,
): Promise<QualifyMatchSummary> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');
  const { from, to } = qualifyWindowBounds(window, deps.now());
  const { filter } = buildComposeFilter(deps, input, from, to);
  // The count-of-charge-lines + dollar totals (Collections' shared builder) and the distinct-client
  // EVIDENCE count (Qualify-owned) run concurrently over the SAME composed predicate — the evidence
  // gauge and the "N charge lines match" number therefore describe the identical population.
  const [row, distinctPatients] = await Promise.all([
    deps.loadMatchSummary(filter, gate.entityIds),
    deps.loadMatchClientCount(filter, gate.entityIds),
  ]);
  const charge = row?.total_charge ?? 0;
  const allowed = row?.total_allowed ?? 0;
  const paid = row?.total_paid ?? 0;
  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 10000) / 100 : null;
  const strip = !gate.hasAmounts;
  return {
    count: row?.total_count ?? 0,
    // Distinct clients (count(distinct member_id_bidx)) — NON-DOLLAR, so never stripped for admissions_seat.
    distinctPatients,
    totalCharge: strip ? null : charge,
    totalAllowed: strip ? null : allowed,
    totalPaid: strip ? null : paid,
    totalBalance: strip ? null : row?.total_balance ?? 0,
    pctAllowedOfBilled: pct(allowed, charge),
    pctPaidOfBilled: pct(paid, charge),
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

/**
 * VOB single-payer probe (Phase 1): is this payer billed ANYWHERE, EVER? Reuses the shared summary
 * `totals` with a WINDOWLESS `{primary_payers:[payer]}` filter (no from/to ⇒ cmdExplorerBaseConds emits
 * no window predicate) — the SAME deliberate unwindowed semantics as buildResolvePayerQuery: a zero
 * count means "never billed, ever", NOT "not in the selected window". The caller (the compose bar) fires
 * this ONLY when the composed count is 0 AND exactly one payer is selected AND no PHI narrow is active,
 * so a name-only or window-only empty can never be mistaken for "never billed". NON-PHI (payer label
 * only), gate-only, NO audit — parity with the live count. Returns the charge-line count (0 ⇒ VOB path).
 */
export async function getQualifyPayerEverBilledCore(deps: QualifyDeps, payer: string): Promise<number> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  const p = typeof payer === 'string' ? payer.trim().slice(0, 200) : '';
  if (p === '') throw new Error('A payer is required for the VOB probe.'); // fail LOUD, never a false "never billed"
  const filter: CmdExplorerFilter = { primary_payers: [p] }; // NO from/to ⇒ unwindowed, cross-tenant
  const row = await deps.loadMatchSummary(filter, gate.entityIds);
  return row?.total_count ?? 0;
}

/**
 * Resolve the DOMINANT payer for a single PHI identifier (member id / alpha prefix), so the compose bar
 * can show the facility ranking when the user has searched an identifier but selected no payer chip —
 * without forcing them to pick one. The server sniffs the kind (never client-declared), mints the blind
 * index, and resolves the identifier's dominant payer (unwindowed, cross-tenant — buildResolvePayerQuery).
 * Returns the payer LABEL (non-PHI) or null when the identifier was never seen.
 *
 * NO audit here on purpose: this returns only a non-PHI payer label, and the row-returning composed-cases
 * access for the SAME identifier already audits SEARCH_QUALIFY_FACILITY (fields: ['prefix'|'member_id']).
 * Adding an audit here would double-count the same access. A blank/oversize term or an unmintable token
 * yields null (no resolution), never an error the UI must special-case.
 */
export async function getQualifyResolvePayerCore(deps: QualifyDeps, term: string): Promise<string | null> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  const raw = typeof term === 'string' ? term.trim() : '';
  if (raw === '' || raw.length > 120) return null;
  const kind = sniffQualifyKind(raw); // 'member_id' | 'prefix' (server-side; <=3 chars ⇒ prefix)
  let token: string | null;
  try {
    token = deps.mintToken(raw, kind);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  if (!token) return null; // e.g. a <3-char prefix → nothing to resolve
  return deps.resolvePayer(token, kind, gate.entityIds);
}

/**
 * Phase 3 — the patient-group "View cohort" slide-over: the member's LIFETIME alpha-prefix cohort
 * (payer-behavior peer group). Flow: gate → audit (field-level, non-PHI) → re-derive the prefix
 * token SERVER-SIDE from one claim id (never from the client) → load the floor-gated context →
 * strip dollars for non-amounts viewers. Every failure path (bad id, foreign id, below-floor
 * cohort) collapses to the SAME suppressed shape — a caller can't distinguish "not yours" from
 * "too small" (no oracle).
 */
export async function getQualifyPatientCohortCore(
  deps: QualifyDeps,
  input: QualifyPatientCohortInput,
): Promise<QualifyPatientCohort> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop

  const window: QualifyWindow = input.window;
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');
  const suppressed: QualifyPatientCohort = {
    suppressed: true,
    floor: COHORT_MIN_PATIENTS,
    patients: null,
    pctCollected: null,
    pctAllowed: null,
    pctPaid: null,
    byPayer: [],
    byCpt: [],
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  if (!Number.isSafeInteger(input.claimId) || input.claimId < 1) return suppressed;

  // Audit BEFORE any data (the cohort context is a distinct, more-granular access). Non-PHI detail:
  // labels + window + the synthetic claim id (the reveal-audit precedent) — never a term or token.
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_COHORT,
    detail: {
      payer: (input.payer ?? '').slice(0, 120),
      facility: (input.facility ?? '').slice(0, 200),
      window: serializeQualifyWindow(window),
      claimId: input.claimId,
    },
  });

  const token = await deps.loadClaimPrefixToken(input.claimId, gate.entityIds);
  if (!token) return suppressed; // unknown / cross-tenant claim id — fail closed, same shape
  const raw = await deps.loadPatientCohort(token, gate.entityIds);
  if (!raw) return suppressed; // below the collections cohort floor — same shape

  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? Math.round((num / den) * 10000) / 100 : null;
  const strip = !gate.hasAmounts;
  return {
    suppressed: false,
    floor: COHORT_MIN_PATIENTS,
    patients: raw.patients,
    pctCollected: ratio(raw.paid, raw.billed),
    pctAllowed: ratio(raw.allowed, raw.billed),
    pctPaid: ratio(raw.paid, raw.allowed),
    byPayer: raw.byPayer.map((g) => ({ label: g.label, count: g.count, charge: strip ? null : g.charge })),
    byCpt: raw.byCpt.map((g) => ({ label: g.label, count: g.count, charge: strip ? null : g.charge })),
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

export async function getQualifyMoversCore(
  deps: QualifyDeps,
  window: QualifyWindow,
  market?: VobMarketFilter,
): Promise<QualifyMovers> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');

  const { from, to, priorFrom, priorTo } = qualifyWindowBounds(window, deps.now());
  const rows = await deps.loadMovers(from, to, priorFrom, priorTo, gate.entityIds, market);
  const movers: QualifyMover[] = rows.map((r, i) => ({
    rank: i + 1,
    label: r.primary_payer,
    thisWindowPatients: r.this_patients,
    priorWindowPatients: r.prior_patients,
    deltaPatients: r.delta_patients,
    deltaPct: r.prior_patients > 0 ? Math.round((r.delta_patients / r.prior_patients) * 100) : null,
  }));
  // Movers carries NO dollar fields → nothing to strip; hasAmounts is informational only.
  return {
    windowStart: from,
    windowEnd: to,
    priorWindowStart: priorFrom,
    priorWindowEnd: priorTo,
    movers,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

/**
 * Combined ON-LOAD resolution (perf): movers + the auto-resolved top payer's snapshot + its rank-1
 * facility's seed cases, in ONE server round-trip. Composes the THREE existing cores back-to-back, so
 * gating, audits (SEARCH_QUALIFY_PAYER on the resolve, SEARCH_QUALIFY_FACILITY on the seed), and the
 * amounts choke points are byte-identical to the old client waterfall — only the client hops between
 * them are removed. No movers → the empty-prompt shape (all nulls). Mirrors the client's on-load logic:
 * resolve the top mover by payer, seed rank-1's cases (payer-wide; no identifier narrow on this path).
 */
export async function getQualifyInitialCore(
  deps: QualifyDeps,
  window: QualifyWindow,
  market?: QualifyMarket,
): Promise<QualifyInitial> {
  const movers = await getQualifyMoversCore(deps, window, market);
  const top = movers.movers[0]?.label ?? null;
  const empty: QualifyInitial = {
    movers: movers.movers, topPayer: top, snapshot: null,
    seedFacility: null, seedCases: [], seedCapped: false,
  };
  if (!top) return empty;

  const snapshot = await getQualifySnapshotByPayerCore(deps, { payer: top, window, market });
  const rank1 = snapshot.resolved ? snapshot.facilities[0]?.facilityKey ?? null : null;
  if (!snapshot.resolved || !rank1) return { ...empty, snapshot };

  const cases = await getQualifyFacilityCasesCore(deps, {
    payer: snapshot.resolved.payerName,
    facility: rank1,
    window,
    market,
  });
  return {
    movers: movers.movers,
    topPayer: top,
    snapshot,
    seedFacility: rank1,
    seedCases: cases.claims,
    seedCapped: cases.capped,
  };
}

// ── Redesign overview cores (book KPIs + facility trend + the combined on-load payload) ──────────

/** Shape a raw trend row → the client contract: attach city/state + entity label, compute the delta. */
function assembleTrend(r: QualifyFacilityTrendRow): QualifyFacilityTrend {
  const loc = facilityLocation(r.facility_code);
  const cur = r.cur_rating;
  const prior = r.prior_rating;
  return {
    facilityKey: r.facility,
    name: r.facility_name ?? r.facility,
    city: loc?.city ?? null,
    state: loc?.state ?? null,
    careSetting: r.care_setting,
    entity: entityLabel(r.entity_ids),
    dominantPayer: r.dominant_payer,
    lineCount: r.line_count,
    currentRating: cur,
    priorRating: prior,
    // Delta in whole-tenth points; null when there is no prior-window evidence (a NEW facility).
    deltaPts: cur !== null && prior !== null ? Math.round((cur - prior) * 10) / 10 : null,
    points: Array.isArray(r.points) ? r.points : [],
  };
}

/**
 * Book-wide KPI percentages for the window (redesign overview tiles). Gate-only (non-PHI aggregate,
 * parity with movers — no per-fetch PHI audit). Returns percentages only; the SQL never projects the
 * dollar sums, so this is admissions_seat-safe by construction.
 */
/** Bound a client-supplied scope list (payer/facility labels): trim, drop blanks, cap count + element
 *  length; null when nothing survives (= no restriction). Every value is a bound param downstream. */
const QUALIFY_SCOPE_SET_MAX = 100;
const QUALIFY_SCOPE_ELEM_MAX = 200;
function normalizeScopeList(xs?: string[] | null): string[] | null {
  if (!Array.isArray(xs)) return null;
  const out = xs
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= QUALIFY_SCOPE_ELEM_MAX)
    .slice(0, QUALIFY_SCOPE_SET_MAX);
  return out.length > 0 ? out : null;
}

export async function getQualifyBookKpisCore(
  deps: QualifyDeps,
  window: QualifyWindow,
  scope?: { payers?: string[] | null; facilities?: string[] | null },
): Promise<QualifyBookKpis> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');
  const { from, to } = qualifyWindowBounds(window, deps.now());
  // DESIGN B (Phase 2): payer + facility scope ONLY. QualifyOrientationScope structurally excludes
  // employer/funding, so they can never reach the tile aggregate — the asymmetry is enforced by the type.
  const orientation: QualifyOrientationScope = {
    from,
    to,
    primary_payers: normalizeScopeList(scope?.payers),
    facility: normalizeScopeList(scope?.facilities),
  };
  const row = await deps.loadBookKpis(orientation, gate.entityIds);
  return {
    pctAllowedOfBilled: row?.pct_allowed_of_billed ?? null,
    pctPaidOfAllowed: row?.pct_paid_of_allowed ?? null,
    pctPaidOfBilled: row?.pct_paid_of_billed ?? null,
    distinctPatients: row?.distinct_patients ?? 0,
    windowStart: from,
    windowEnd: to,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

/**
 * Per-facility rating trend rows (redesign "Facilities Heating Up" + sparklines). Gate-only (ratings
 * only, non-PHI). `payer` null = book-wide (the overview row); set = the resolved payer's facilities
 * (per-facility sparklines in the panel). Order is preserved from SQL (rating-delta desc, new last).
 */
export async function getQualifyFacilityTrendsCore(
  deps: QualifyDeps,
  window: QualifyWindow,
  opts?: { payer?: string | null },
): Promise<QualifyFacilityTrend[]> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(window)) throw new Error('Invalid window.');
  const { from, to, priorFrom } = qualifyWindowBounds(window, deps.now());
  // Design B: payer-only scope (exactly-one-payer → payer-scoped ticker; null → book-wide). No market.
  const rows = await deps.loadFacilityTrends(from, to, priorFrom, gate.entityIds, { payer: opts?.payer ?? null });
  return rows.map(assembleTrend);
}

/**
 * Combined ON-LOAD overview (ONE round-trip): book KPIs + trending facilities in parallel, then the
 * HYBRID resolve — the top trending facility's dominant payer is resolved and the cases are seeded to
 * THAT facility (not rank-1), so the surface lands showing the exact facility the top card names.
 * Composes the existing cores, so every gate/audit/strip is byte-identical to the manual flow. No
 * trend / no dominant payer → the KPIs + trends still return, with a null snapshot (empty prompt).
 */
export async function getQualifyOverviewCore(
  deps: QualifyDeps,
  window: QualifyWindow,
  market?: QualifyMarket,
  opts?: { resolve?: boolean },
): Promise<QualifyOverview> {
  const [kpis, trends] = await Promise.all([
    // On-load strip is book-wide: no orientation scope (Design B — employer/funding never scope tiles;
    // the compose-driven refetch supplies payer + facility via getQualifyBookKpis directly).
    getQualifyBookKpisCore(deps, window),
    getQualifyFacilityTrendsCore(deps, window, { payer: null }),
  ]);
  const empty: QualifyOverview = {
    kpis, trends, topFacility: null, topPayer: null, snapshot: null, seedFacility: null, seedCases: [], seedCapped: false,
  };
  // resolve:false (a URL-restore load) → the caller resolves its OWN subject; return the strip only,
  // skipping the hybrid resolve + its audits entirely (no wasted resolve-by-payer audit row).
  if (opts?.resolve === false) return empty;
  // The hybrid focus is the FIRST trending facility that carries a resolvable dominant payer.
  const top = trends.find((t) => t.dominantPayer) ?? null;
  if (!top || !top.dominantPayer) return empty;

  const snapshot = await getQualifySnapshotByPayerCore(deps, { payer: top.dominantPayer, window, market });
  if (!snapshot.resolved) return { ...empty, topPayer: top.dominantPayer, topFacility: top.facilityKey, snapshot };
  // Scope to the trend facility IF it ranks under its dominant payer this window; else the payer's rank-1.
  const focus = snapshot.facilities.some((f) => f.facilityKey === top.facilityKey)
    ? top.facilityKey
    : snapshot.facilities[0]?.facilityKey ?? null;
  if (!focus) return { ...empty, topPayer: top.dominantPayer, topFacility: top.facilityKey, snapshot };

  const cases = await getQualifyFacilityCasesCore(deps, {
    payer: snapshot.resolved.payerName,
    facility: focus,
    window,
    market,
  });
  return {
    kpis, trends,
    topFacility: focus,
    topPayer: top.dominantPayer,
    snapshot,
    seedFacility: focus,
    seedCases: cases.claims,
    seedCapped: cases.capped,
  };
}

export async function revealQualifyRowCore(deps: QualifyDeps, id: number): Promise<RevealQualifyRowResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'Invalid row.' };
  try {
    const phi = await deps.revealRow(id, gate.actor, gate.entityIds, REVEAL_QUALIFY_ROW);
    if (!phi) return { ok: false, error: 'That record is not available.' };
    return { ok: true, phi };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}

export async function revealQualifyRowsCore(deps: QualifyDeps, ids: number[]): Promise<RevealQualifyRowsResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'No rows to reveal.' };
  if (ids.length > REVEAL_BATCH_CAP) return { ok: false, error: 'Too many rows.' };
  if (!ids.every((i) => Number.isInteger(i) && i >= 0)) return { ok: false, error: 'Invalid row.' };
  try {
    const rows = await deps.revealRows(ids, gate.actor, gate.entityIds, REVEAL_QUALIFY_ROWS);
    return { ok: true, rows };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}
