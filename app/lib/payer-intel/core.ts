/**
 * Payer Intel CORES — pure, dependency-injected orchestration for the /payer-intel tab. The
 * `'use server'` binders in actions.ts supply real deps; the hermetic suite supplies fakes and
 * proves the gate, the amounts strip, the row_ids short-circuit and the audit ordering at the
 * wire level (the qualifyCore.test.ts pattern).
 *
 * R-AMOUNTS CHOKE POINT: `stripBoardAmounts` / `stripResultAmounts` are module-PRIVATE and applied
 * LAST before every return (`return gate.hasAmounts ? x : strip(x)`), the Qualify core.ts
 * discipline. Any NEW dollar-bearing field on these wires must be added to the strip explicitly —
 * a second list that skips the choke point hands a blind session the full dollar set
 * (bookFacilities was Qualify's worked example).
 *
 * PHI DISCIPLINE: raw search terms (group numbers, member identifiers) exist only inside
 * `runPayerIntelSearchCore`'s locals — they are HMAC'd through injected token fns and the raw
 * value never reaches SQL, the audit detail, a log line, or the returned payload (the result
 * carries a last-4 mask). PHI-tokened searches audit BEFORE any data read, fail-closed.
 */
import { iqBandOf } from '../qualify/ratingV2';
import {
  getQualifyPolicyTapeCore,
  type QualifyPolicyTapeContext,
  type QualifyPolicyTapeResult,
} from '../qualify/board';
import type { QualifyPolicyTapeRow } from '../../../src/collections/qualifyRatingHistory';
import type { CmdExplorerFilter } from '../../../src/collections/cmdExplorerQuery';
import { deriveYield } from '../../../src/collections/cmdExplorerQuery';
import {
  PAYER_INTEL_DECLINE_THRESHOLD_PTS,
  PAYER_INTEL_DECLINE_WINDOW_DAYS,
  type PayerIntelCensusRowRaw,
  type PayerIntelComboRow,
  type PayerIntelDeclinerRow,
  type PayerIntelFacilityNameRow,
  type PayerIntelPlacementRow,
  type PayerIntelRatingRow,
  type PayerIntelSavedSearchRow,
} from '../../../src/collections/payerIntelSearch';
import type { PayerIntelPrincipal } from './principal';
import type {
  PayerIntelBoard,
  PayerIntelCensusRow,
  PayerIntelDeclinerItem,
  PayerIntelEntityType,
  PayerIntelFacets,
  PayerIntelPlacementItem,
  PayerIntelResult,
  PayerIntelSavedSearch,
  PayerIntelSearchInput,
} from './contract';

// ── Deps (the DI seam) ───────────────────────────────────────────────────────────────────────────

export interface PayerIntelDeps {
  requirePrincipal: () => Promise<PayerIntelPrincipal>;
  // IDLE board
  loadGainers: () => Promise<QualifyPolicyTapeRow[] | null>;
  /** Both enrichment legs are optional + fail-soft, the tape core's contract. */
  resolvePrefixes?: (tokens: readonly string[]) => Map<string, string>;
  loadTapeContext?: (tokens: readonly string[]) => Promise<QualifyPolicyTapeContext[]>;
  loadDecliners: (entityIds: string[]) => Promise<PayerIntelDeclinerRow[]>;
  loadCensus: () => Promise<PayerIntelCensusRowRaw[]>;
  loadFacilityNames: () => Promise<PayerIntelFacilityNameRow[]>;
  loadSavedSearches: (userId: string) => Promise<PayerIntelSavedSearchRow[] | null>;
  // RESULT
  loadAggregates: (
    filter: CmdExplorerFilter,
    entityIds: string[],
  ) => Promise<{
    totals: { total_count: number; total_charge: number; total_allowed: number; total_paid: number };
    distinctMembers: number;
    placement: PayerIntelPlacementRow[];
    combos: PayerIntelComboRow[];
  }>;
  loadPayerGroups: (
    filter: CmdExplorerFilter,
    entityIds: string[],
  ) => Promise<{ label: string | null; count: number }[]>;
  loadRating: (token: string | null, payer: string) => Promise<PayerIntelRatingRow | null>;
  loadPayerVocabulary: (entityIds: string[]) => Promise<string[]>;
  /** Keyed-HMAC blind-index fns (blindIndex.ts) — injected so the core stays hermetic. */
  alphaPrefixToken: (raw: string) => string | null;
  groupNumberToken: (raw: string) => string | null;
  /** Durable audit (claims.access_audit). MUST complete before any PHI-tokened read; NON-PHI
   *  detail only (field names + facet kinds, never values). */
  recordAccess: (entry: {
    actorEmail: string;
    actorUserId: string;
    action: string;
    detail?: Record<string, unknown>;
  }) => Promise<string>;
  /** Search-history writes (0104 definers) — fail-soft {persisted:false} on absent relations. */
  recordSearch: (args: {
    userId: string;
    payer: string | null;
    echo: string | null;
    planClass: string | null;
    entityType: PayerIntelEntityType | null;
    resolved: boolean | null;
  }) => Promise<{ persisted: boolean }>;
  setStarred: (userId: string, id: string, starred: boolean) => Promise<{ persisted: boolean; found: boolean }>;
  clearSearches: (userId: string) => Promise<{ persisted: boolean }>;
  /** Trend-watcher save (0097 definer) — the hero's Watch button. */
  saveWatcher: (args: {
    userId: string;
    payer: string;
    token: string | null;
  }) => Promise<{ persisted: boolean }>;
  /** Cohort curve for the AI payload (the SAME suppressed builders the Collections panel uses,
   *  min-patient floor in SQL) — only called when the search carries a prefix token. */
  loadCohortCurve: (
    prefixToken: string,
    entityIds: string[],
  ) => Promise<{
    byPosition: { bucket: number; patients: number; claims: number; pct_allowed: number | null; pct_paid: number | null; pct_zero_paid: number }[];
    byDays: { bucket: number; patients: number; claims: number; pct_allowed: number | null; pct_paid: number | null; pct_zero_paid: number }[];
  }>;
  /** The min-patient suppression floor the curve buckets already enforce — rides the payload so
   *  the model can name the confidence floor it is bound by. */
  cohortMinPatients: number;
  /** Business-day ISO date ('YYYY-MM-DD') — injected so window stamps are testable. */
  today: () => string;
  windowDays: number;
}

// ── Amounts strips (module-private; applied LAST) ────────────────────────────────────────────────

function stripBoardAmounts(board: PayerIntelBoard): PayerIntelBoard {
  return {
    ...board,
    decliners: {
      ...board.decliners,
      items: board.decliners.items.map((d) => ({ ...d, billedCurrent: null })),
    },
  };
}

function stripResultAmounts(result: PayerIntelResult): PayerIntelResult {
  return {
    ...result,
    totals: { ...result.totals, billed: null },
    placement: result.placement.map((p) => ({ ...p, paidPerPatient: null, billed: null })),
    combos: result.combos.map((c) => ({ ...c, charge: null })),
  };
}

// ── Term classification (pure; exported for hermetic tests) ─────────────────────────────────────

export type PayerIntelTermKind =
  | { kind: 'prefix'; value: string }
  | { kind: 'group'; value: string }
  | { kind: 'payer'; value: string }
  | { kind: 'unknown'; value: string };

/**
 * Classify the free-text bar's term, server-side:
 *   · exactly 3 chars over [A-Z0-9] after normalization → an alpha PREFIX (the Qualify domain);
 *   · ≥5 digits → a GROUP NUMBER (PHI-adjacent — HMAC'd, audited, never echoed raw);
 *   · otherwise a PAYER match against the live vocabulary (exact first, then contains — shortest
 *     hit wins, so "aetna" beats "AETNA BETTER HEALTH" only when typed as the full label);
 *   · no match → unknown (the UI says so; nothing silently widens).
 */
export function classifyPayerIntelTerm(term: string, payerVocabulary: readonly string[]): PayerIntelTermKind {
  const trimmed = term.trim();
  const norm = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z0-9]{3}$/.test(norm) && /[A-Z]/.test(norm)) return { kind: 'prefix', value: norm };
  if (/^\d{5,}$/.test(norm)) return { kind: 'group', value: norm };
  const lower = trimmed.toLowerCase();
  if (lower.length >= 3) {
    const exact = payerVocabulary.find((p) => p.toLowerCase() === lower);
    if (exact) return { kind: 'payer', value: exact };
    const contains = payerVocabulary
      .filter((p) => p.toLowerCase().includes(lower))
      .sort((a, b) => a.length - b.length);
    const first = contains[0];
    if (first !== undefined) return { kind: 'payer', value: first };
  }
  return { kind: 'unknown', value: trimmed };
}

// ── IDLE board core ──────────────────────────────────────────────────────────────────────────────

const OUTPATIENT = 'outpatient';
const RESIDENTIAL = 'residential';

function assembleCensus(
  raw: readonly PayerIntelCensusRowRaw[],
  names: ReadonlyMap<string, PayerIntelFacilityNameRow>,
): PayerIntelBoard['census'] {
  const rows: PayerIntelCensusRow[] = raw
    .map((r) => {
      const family = r.board_family === RESIDENTIAL || r.board_family === OUTPATIENT ? r.board_family : null;
      const residential = family === RESIDENTIAL;
      const occupancy =
        residential && r.admitted_count !== null && r.bed_capacity !== null && r.bed_capacity > 0
          ? Math.round((r.admitted_count / r.bed_capacity) * 100)
          : null;
      return {
        facilityCode: r.facility_code,
        facilityName: names.get(r.facility_code)?.facility_name ?? r.facility_code,
        boardFamily: family,
        admittedCount: r.admitted_count,
        // Outpatient open_beds is stored 0 meaning N/A, never "full" (0078 contract) — null it out
        // so no renderer can misread the sentinel.
        openBeds: residential ? r.open_beds : null,
        bedCapacity: residential ? r.bed_capacity : null,
        // Not stored anywhere (statuses other than Admitted/Open Bed* are dropped before write).
        pendingAdmits: null,
        occupancyPct: occupancy,
        // Only the capacity half of the mock's pill vocabulary is derivable without pending
        // admits; the pipeline pills light up if/when that column ships.
        status: residential ? (r.open_beds === 0 ? 'full' : 'open') : null,
        syncedAt: r.synced_at,
      } satisfies PayerIntelCensusRow;
    })
    // Residential first (bed decisions), then outpatient caseloads; alphabetical within each.
    .sort((a, b) =>
      a.boardFamily === b.boardFamily
        ? a.facilityName.localeCompare(b.facilityName)
        : a.boardFamily === RESIDENTIAL
          ? -1
          : 1,
    );
  const syncedAt = rows.reduce<string | null>((max, r) => {
    if (r.syncedAt === null) return max;
    return max === null || r.syncedAt > max ? r.syncedAt : max;
  }, null);
  return { rows, syncedAt };
}

function toSavedSearch(r: PayerIntelSavedSearchRow): PayerIntelSavedSearch {
  const entity = r.entity_type;
  const known: readonly PayerIntelEntityType[] = [
    'prefix',
    'payer',
    'employer',
    'funding',
    'group',
    'facility',
    'individual',
  ];
  return {
    id: String(r.id),
    payer: r.payer_label,
    prefixEcho: r.prefix_echo,
    planClass: r.plan_class,
    entityType: entity !== null && (known as readonly string[]).includes(entity) ? (entity as PayerIntelEntityType) : null,
    resolved: r.resolved,
    starred: r.starred,
    searchedAt: r.searched_at,
  };
}

export async function getPayerIntelBoardCore(deps: PayerIntelDeps): Promise<PayerIntelBoard> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);

  // The gainers rail REUSES the Qualify tape core wholesale — same enrichment, same fail-soft
  // legs — with this tab's gate already satisfied (pass-through principal) and the gainers loader.
  const gainersPromise: Promise<QualifyPolicyTapeResult> = getQualifyPolicyTapeCore({
    requirePrincipal: async () => ({ ok: true }),
    loadTape: deps.loadGainers,
    resolvePrefixes: deps.resolvePrefixes,
    loadContext: deps.loadTapeContext,
    deltaDays: deps.windowDays,
  });

  const [gainers, declinerRows, censusRaw, nameRows, savedRows] = await Promise.all([
    gainersPromise,
    deps.loadDecliners(gate.entityIds),
    deps.loadCensus(),
    deps.loadFacilityNames(),
    deps.loadSavedSearches(gate.actor.userId),
  ]);

  const names = new Map(nameRows.map((n) => [n.facility_code, n]));
  const declinerItems: PayerIntelDeclinerItem[] = declinerRows.map((d) => ({
    facility: d.facility,
    facilityCode: d.facility_code,
    careSetting: d.care_setting,
    pctCurrent: d.pct_current,
    pctPrior: d.pct_prior,
    deltaPts: d.delta_pts,
    lineCount: d.line_count,
    distinctMembers: d.distinct_members,
    billedCurrent: d.billed_current,
    declineReason: null, // no server-side attribution exists — see PayerIntelDeclinerRow's TODO
  }));

  const saved = (savedRows ?? []).map(toSavedSearch);
  const board: PayerIntelBoard = {
    gainers,
    decliners: {
      items: declinerItems,
      windowDays: PAYER_INTEL_DECLINE_WINDOW_DAYS,
      thresholdPts: PAYER_INTEL_DECLINE_THRESHOLD_PTS,
    },
    census: assembleCensus(censusRaw, names),
    searches: {
      starred: saved.filter((s) => s.starred),
      recent: saved.filter((s) => !s.starred),
    },
    viewerHasAmountsCapability: gate.hasAmounts,
  };
  return gate.hasAmounts ? board : stripBoardAmounts(board); // strip LAST
}

// ── Search core ──────────────────────────────────────────────────────────────────────────────────

/** Placement flags: the capacity×collectability contradictions the mock centers on. Only rows with
 *  a real ratio participate; needs ≥2 such rows for "best"/"worst" to mean anything. */
export function derivePlacementFlags(items: readonly PayerIntelPlacementItem[]): PayerIntelPlacementItem[] {
  const rated = items.filter((p) => p.pctCollected !== null);
  if (rated.length < 2) return [...items];
  let best = rated[0]!;
  let worst = rated[0]!;
  for (const p of rated) {
    if ((p.pctCollected ?? 0) > (best.pctCollected ?? 0)) best = p;
    if ((p.pctCollected ?? 0) < (worst.pctCollected ?? 0)) worst = p;
  }
  return items.map((p) => {
    if (p === best && p.openBeds === 0) return { ...p, flag: 'best_yield_full' as const };
    if (p === worst && p.openBeds !== null && p.openBeds >= 1) return { ...p, flag: 'open_beds_worst_yield' as const };
    return p;
  });
}

function maskGroupNumber(norm: string): string {
  return `•••• ${norm.slice(-4)}`;
}

/** The resolved search: everything both the RESULT core and the AI payload core need. Shared so
 *  the two can never disagree about what a search MEANS (facets, tokens, resolution). */
interface ResolvedPayerIntelSearch {
  filter: CmdExplorerFilter;
  facilityCodes: string[];
  employerNames: string[];
  funding: string[];
  payer: string | null;
  resolvedPayer: string | null;
  prefix: string | null;
  prefixToken: string | null;
  groupNumber: string | null;
  groupToken: string | null;
  entityType: PayerIntelEntityType | null;
  termUnresolved: boolean;
}

/** Steps 1–4 of a search: sanitize at the trust boundary, classify the free term, audit PHI
 *  fields BEFORE any read, HMAC the identifiers, compose the shared Collections filter, resolve
 *  the payer. The raw group number stays inside this frame. */
async function resolvePayerIntelSearch(
  deps: PayerIntelDeps,
  gate: Extract<PayerIntelPrincipal, { ok: true }>,
  input: PayerIntelSearchInput,
): Promise<ResolvedPayerIntelSearch> {
  // ── 1. Sanitize + classify at the trust boundary ────────────────────────────────────────────
  const facilityCodes = (input.facilityCodes ?? []).filter((f) => f.length > 0 && f.length <= 40).slice(0, 20);
  const employerNames = (input.employerNames ?? []).filter((e) => e.length > 0 && e.length <= 200).slice(0, 50);
  const funding = (input.funding ?? []).filter((f) => f === 'Self-Funded' || f === 'Fully Insured');
  let payer = typeof input.payer === 'string' && input.payer.trim().length > 0 ? input.payer.trim().slice(0, 120) : null;
  let prefix =
    typeof input.prefix === 'string' && /^[A-Za-z0-9]{1,3}$/.test(input.prefix.trim())
      ? input.prefix.trim().toUpperCase()
      : null;
  let groupNumber =
    typeof input.groupNumber === 'string' && input.groupNumber.trim().length > 0
      ? input.groupNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40)
      : null;

  let termUnresolved = false;
  const term = typeof input.term === 'string' ? input.term.trim().slice(0, 120) : '';
  if (term.length > 0) {
    const vocab = await deps.loadPayerVocabulary(gate.entityIds);
    const classified = classifyPayerIntelTerm(term, vocab);
    if (classified.kind === 'prefix') prefix = classified.value;
    else if (classified.kind === 'group') groupNumber = classified.value;
    else if (classified.kind === 'payer') payer = classified.value;
    else termUnresolved = true;
  }

  // ── 2. PHI tokens: audit BEFORE any data read, then HMAC — the raw value goes no further ─────
  const phiFields: string[] = [];
  if (prefix !== null) phiFields.push('alpha_prefix');
  if (groupNumber !== null) phiFields.push('group_number');
  if (phiFields.length > 0) {
    // Fail-closed: a throw here denies the search. Detail carries field NAMES only, never values.
    await deps.recordAccess({
      actorEmail: gate.actor.email,
      actorUserId: gate.actor.userId,
      action: 'search_payer_intel',
      detail: { fields: phiFields },
    });
  }
  const prefixToken = prefix !== null ? deps.alphaPrefixToken(prefix) : null;
  const groupToken = groupNumber !== null ? deps.groupNumberToken(groupNumber) : null;

  // ── 3. Compose the Collections engine's filter ────────────────────────────────────────────────
  const filter: CmdExplorerFilter = {
    ...(facilityCodes.length > 0 ? { facility: facilityCodes } : {}),
    ...(payer !== null ? { primary_payers: [payer] } : {}),
    ...(employerNames.length > 0 ? { employer_names: employerNames } : {}),
    ...(funding.length > 0 ? { funding } : {}),
    ...(prefixToken !== null || groupToken !== null
      ? {
          phiIndex: {
            ...(prefixToken !== null ? { memberIdPrefixBidx: prefixToken } : {}),
            ...(groupToken !== null ? { groupNumberBidx: groupToken } : {}),
          },
        }
      : {}),
  };

  // ── 4. Resolve a payer for prefix/group searches that lack one (the mock's "resolved" state) ──
  let resolvedPayer = payer;
  if (resolvedPayer === null && !termUnresolved && (prefixToken !== null || groupToken !== null)) {
    const groups = await deps.loadPayerGroups(filter, gate.entityIds);
    resolvedPayer = groups[0]?.label ?? null;
  }

  const entityType: PayerIntelEntityType | null =
    prefix !== null
      ? 'prefix'
      : groupNumber !== null
        ? 'group'
        : payer !== null
          ? 'payer'
          : employerNames.length > 0
            ? 'employer'
            : funding.length > 0
              ? 'funding'
              : facilityCodes.length > 0
                ? 'facility'
                : null;

  return {
    filter,
    facilityCodes,
    employerNames,
    funding,
    payer,
    resolvedPayer,
    prefix,
    prefixToken,
    groupNumber,
    groupToken,
    entityType,
    termUnresolved,
  };
}

export async function runPayerIntelSearchCore(
  deps: PayerIntelDeps,
  input: PayerIntelSearchInput,
): Promise<PayerIntelResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);

  const resolved = await resolvePayerIntelSearch(deps, gate, input);
  const { filter, facilityCodes, employerNames, funding, prefix, prefixToken, groupNumber, resolvedPayer, entityType, termUnresolved } =
    resolved;

  // ── 5. Aggregates. A term that classified as NOTHING short-circuits to a zero result BEFORE any
  // query — the row_ids-empty lesson from Collections (a matched-nothing state must return zero
  // rows AND a zero summary, never silently widen to the whole book). v1 has no row_ids facet;
  // the payer-intel builders additionally harden `row_ids: []` to a `false` predicate themselves.
  const empty = {
    totals: { total_count: 0, total_charge: 0, total_allowed: 0, total_paid: 0 },
    distinctMembers: 0,
    placement: [],
    combos: [],
  };
  const agg = termUnresolved ? empty : await deps.loadAggregates(filter, gate.entityIds);

  // ── 6. Rating off the nightly table (pair when a prefix resolved, payer-wide otherwise) ───────
  let rating: PayerIntelResult['rating'] = { value: null, band: null, deltaPts: null, asOf: null, subject: 'none' };
  if (resolvedPayer !== null) {
    const row = await deps.loadRating(prefixToken, resolvedPayer);
    if (row !== null && row.rating !== null) {
      rating = {
        value: row.rating,
        band: iqBandOf(row.rating),
        deltaPts: row.rating_then !== null ? row.rating - row.rating_then : null,
        asOf: row.as_of,
        subject: prefixToken !== null ? 'pair' : 'payer',
      };
    }
  }

  // ── 7. Record the search (non-PHI facets only; fail-soft) ─────────────────────────────────────
  try {
    await deps.recordSearch({
      userId: gate.actor.userId,
      payer: resolvedPayer,
      echo: prefix,
      planClass: null,
      entityType,
      resolved: resolvedPayer !== null,
    });
  } catch (err) {
    // History is a convenience surface — its failure must not cost the search. SQLSTATE only.
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
    console.error(`payer intel: record search failed (sqlstate ${code || 'unknown'})`);
  }

  // ── 8. Assemble, flag, strip LAST ─────────────────────────────────────────────────────────────
  const to = deps.today();
  const from = addDaysIsoLocal(to, -(deps.windowDays - 1));
  const facets: PayerIntelFacets = {
    payer: resolvedPayer,
    prefix,
    facilityCodes,
    facilityLabels: facilityCodes, // page maps codes → names client-side from the board's census/names
    employerNames,
    funding,
    groupNumberMasked: groupNumber !== null ? maskGroupNumber(groupNumber) : null,
  };
  const placement = derivePlacementFlags(
    agg.placement.map((p) => ({
      facility: p.facility,
      facilityCode: p.facility_code,
      careSetting: p.care_setting,
      lineCount: p.line_count,
      distinctMembers: p.distinct_members,
      pctCollected: p.pct_collected,
      paidPerPatient: p.paid_per_patient,
      billed: p.billed,
      openBeds: null,
      bedCapacity: null,
      pendingAdmits: null,
      censusSyncedAt: null,
      flag: null,
    })),
  );
  const result: PayerIntelResult = {
    facets,
    resolved: resolvedPayer !== null,
    totals: {
      lineCount: agg.totals.total_count,
      distinctMembers: agg.distinctMembers,
      billed: agg.totals.total_charge,
    },
    yieldPct: deriveYield({
      billed: agg.totals.total_charge,
      allowed: agg.totals.total_allowed,
      paid: agg.totals.total_paid,
    }),
    rating,
    placement,
    combos: agg.combos.map((c) => ({
      cpt: c.cpt,
      revenue: c.revenue,
      count: c.count,
      charge: c.charge,
      pctAllowed: c.pct_allowed,
      pctPaid: c.pct_paid,
      pctZeroPaid: c.pct_zero_paid,
    })),
    window: { from, to },
    viewerHasAmountsCapability: gate.hasAmounts,
  };
  return gate.hasAmounts ? result : stripResultAmounts(result); // strip LAST
}

/** Local ISO date add (UTC-slice arithmetic on a plain date string — no clock reads). */
function addDaysIsoLocal(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Small write cores ────────────────────────────────────────────────────────────────────────────

export type PayerIntelToggleStarResult =
  | { ok: true; starred: boolean; persisted: boolean }
  | { ok: false; reason: 'denied' | 'invalid' | 'limit' | 'failed' };

export async function togglePayerIntelStarCore(
  deps: PayerIntelDeps,
  id: string,
  starred: boolean,
): Promise<PayerIntelToggleStarResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, reason: 'denied' };
  if (!/^\d{1,18}$/.test(id)) return { ok: false, reason: 'invalid' }; // bigint arrives as a string
  try {
    const res = await deps.setStarred(gate.actor.userId, id, starred);
    if (!res.found && res.persisted) return { ok: false, reason: 'invalid' }; // not theirs / gone
    return { ok: true, starred, persisted: res.persisted };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('starred limit')) return { ok: false, reason: 'limit' };
    console.error('payer intel: star toggle failed');
    return { ok: false, reason: 'failed' };
  }
}

export async function clearPayerIntelHistoryCore(
  deps: PayerIntelDeps,
): Promise<{ ok: boolean; persisted: boolean }> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, persisted: false };
  const res = await deps.clearSearches(gate.actor.userId);
  return { ok: true, persisted: res.persisted };
}

// ── AI payload assembly (server-side — the spec's requirement) ───────────────────────────────────

/**
 * Assemble the aggregates-only AI payload for the ACTIVE search, SERVER-SIDE. The client sends
 * only the search input; every number in the payload is derived here from the same builders the
 * RESULT screen uses, so the model can never be fed figures the screen does not show.
 *
 * BLIND PARITY BY CONSTRUCTION: when the viewer is amounts-blind, every dollar field is nulled
 * BEFORE the payload leaves this function — the model cannot leak a number it never received.
 * Ratios/counts ride for everyone (they survive the amounts strip everywhere else too).
 */
export async function buildPayerIntelAiPayloadCore(
  deps: PayerIntelDeps,
  input: PayerIntelSearchInput,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: 'denied' | 'insufficient' }> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, reason: 'denied' };

  const resolved = await resolvePayerIntelSearch(deps, gate, input);
  if (resolved.termUnresolved) return { ok: false, reason: 'insufficient' };

  const [agg, curve] = await Promise.all([
    deps.loadAggregates(resolved.filter, gate.entityIds),
    resolved.prefixToken !== null
      ? deps.loadCohortCurve(resolved.prefixToken, gate.entityIds)
      : Promise.resolve(null),
  ]);
  if (agg.totals.total_count <= 0) return { ok: false, reason: 'insufficient' };

  const ratingRow = resolved.resolvedPayer !== null ? await deps.loadRating(resolved.prefixToken, resolved.resolvedPayer) : null;
  const y = deriveYield({
    billed: agg.totals.total_charge,
    allowed: agg.totals.total_allowed,
    paid: agg.totals.total_paid,
  });
  const blind = !gate.hasAmounts;
  const to = deps.today();
  const from = addDaysIsoLocal(to, -(deps.windowDays - 1));
  const facetKinds: string[] = [];
  if (resolved.resolvedPayer !== null) facetKinds.push('payer');
  if (resolved.prefix !== null) facetKinds.push('prefix');
  if (resolved.facilityCodes.length > 0) facetKinds.push('facility');
  if (resolved.employerNames.length > 0) facetKinds.push('employer');
  if (resolved.funding.length > 0) facetKinds.push('funding');
  if (resolved.groupNumber !== null) facetKinds.push('group');

  const bucketOf = (p: { bucket: number; patients: number; claims: number; pct_allowed: number | null; pct_paid: number | null; pct_zero_paid: number }) => ({
    bucket: p.bucket,
    patients: p.patients,
    lines: p.claims,
    pct_allowed: p.pct_allowed,
    pct_paid: p.pct_paid,
    pct_zero_paid: p.pct_zero_paid,
  });

  const payload: Record<string, unknown> = {
    window: { from, to },
    patients: agg.distinctMembers,
    line_count: agg.totals.total_count,
    min_bucket_size: deps.cohortMinPatients,
    totals: {
      pct_allowed: y.pct_allowed,
      pct_paid: y.pct_paid,
      pct_collected: y.pct_collected,
      zero_paid_pct: null, // whole-selection zero-paid share is not aggregated yet — per-combo rates ride below
      billed: blind ? null : agg.totals.total_charge,
    },
    ...(curve !== null ? { by_visit: curve.byPosition.slice(0, 40).map(bucketOf) } : {}),
    ...(curve !== null ? { by_days_bucket: curve.byDays.slice(0, 40).map(bucketOf) } : {}),
    cpt_rev: agg.combos.slice(0, 25).map((c) => ({
      cpt: c.cpt,
      revenue: c.revenue,
      lines: c.count,
      charge: blind ? null : c.charge,
      pct_allowed: c.pct_allowed,
      pct_paid: c.pct_paid,
      pct_zero_paid: c.pct_zero_paid,
    })),
    search_context: {
      entity_type: resolved.entityType,
      resolution: resolved.resolvedPayer !== null ? 'resolved' : 'unresolved',
      payer: resolved.resolvedPayer,
      funding: resolved.funding,
      facet_kinds: facetKinds,
    },
    ...(ratingRow !== null && ratingRow.rating !== null
      ? { rating: { value: ratingRow.rating, band: iqBandOf(ratingRow.rating) } }
      : {}),
    ...(ratingRow !== null && ratingRow.rating_then !== null
      ? {
          prior_run: {
            rating: ratingRow.rating_then,
            pct_paid: null, // prior % paid is not snapshotted per search yet — a results table is the follow-up
            as_of: addDaysIsoLocal(ratingRow.as_of, -deps.windowDays),
          },
        }
      : {}),
  };
  return { ok: true, payload };
}

export type PayerIntelWatchResult = { ok: true; persisted: boolean } | { ok: false; reason: 'denied' | 'invalid' | 'failed' };

/** The hero's Watch button — a TREND watcher on (payer, optional prefix token), the 0097 shape. */
export async function watchPayerIntelSubjectCore(
  deps: PayerIntelDeps,
  payer: string,
  prefix: string | null,
): Promise<PayerIntelWatchResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, reason: 'denied' };
  const cleanPayer = payer.trim().slice(0, 120);
  if (cleanPayer.length === 0) return { ok: false, reason: 'invalid' };
  const token =
    prefix !== null && /^[A-Za-z0-9]{3}$/.test(prefix.trim())
      ? deps.alphaPrefixToken(prefix.trim().toUpperCase())
      : null;
  try {
    const res = await deps.saveWatcher({ userId: gate.actor.userId, payer: cleanPayer, token });
    return { ok: true, persisted: res.persisted };
  } catch {
    console.error('payer intel: watch save failed');
    return { ok: false, reason: 'failed' };
  }
}
