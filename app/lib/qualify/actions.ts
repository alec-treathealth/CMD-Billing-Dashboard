'use server';

/**
 * Qualify SERVER ACTIONS — the browser's only data path for the Qualify tab (desktop, Prompt 3) and
 * the mobile PWA (Prompt 4); both consume the IDENTICAL contract (contract.ts). Thin wrappers: they
 * build the REAL dependencies and delegate to the dependency-injected cores (core.ts), where the
 * orchestration, the Q-A gate, the single stripAmounts choke point, and the audits live and are
 * unit-tested. A 'use server' module may export ONLY async functions — types + cores live elsewhere.
 */
import { requireQualifyPrincipal } from '@/lib/qualify/gate';
import {
  resolveQualifyPayer,
  loadQualifyFacilities,
  loadQualifyIdentifierLandingFacility,
  loadQualifyFacilityCases,
  loadQualifyMatchSummary,
  loadQualifyMovers,
  loadQualifyBookKpis,
  loadQualifyFacilityTrends,
  loadQualifyClaimPrefixToken,
  loadQualifyPatientCohort,
  cmdExplorerEmployers,
  cmdExplorerFacilities,
  cmdExplorerPayers,
  CMD_FUNDING_MARKETS,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
  type CmdEmployerOption,
} from '@/lib/server';
import type { CmdFacilityOption } from '../../../src/collections/cmdExplorerQuery';
import { memberIdBlindIndex, alphaPrefixBlindIndex, groupNumberBlindIndex, patientNameBlindIndex } from '../../../src/collections/blindIndex';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifySnapshotByNameCore,
  getQualifyFacilityCasesCore,
  getQualifyComposedCasesCore,
  getQualifyMatchSummaryCore,
  getQualifyPayerEverBilledCore,
  getQualifyResolvePayerCore,
  getQualifyMoversCore,
  getQualifyInitialCore,
  getQualifyBookKpisCore,
  getQualifyFacilityTrendsCore,
  getQualifyOverviewCore,
  getQualifyPatientCohortCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  type QualifyDeps,
} from '@/lib/qualify/core';
import type {
  QualifyInput,
  QualifyPayerInput,
  QualifyNameInput,
  QualifyFacilityCasesInput,
  QualifyFacilityCases,
  QualifyComposeInput,
  QualifyMatchSummary,
  QualifyPatientCohortInput,
  QualifyPatientCohort,
  QualifySnapshot,
  QualifyMovers,
  QualifyInitial,
  QualifyBookKpis,
  QualifyFacilityTrend,
  QualifyOverview,
  QualifyMarket,
  QualifyWindow,
  RevealQualifyRowResult,
  RevealQualifyRowsResult,
} from '@/lib/qualify/contract';

const realDeps: QualifyDeps = {
  requirePrincipal: requireQualifyPrincipal,
  mintToken: (query, kind) => (kind === 'prefix' ? alphaPrefixBlindIndex(query) : memberIdBlindIndex(query)),
  mintGroupToken: (raw) => groupNumberBlindIndex(raw),
  mintNameToken: (raw) => patientNameBlindIndex(raw),
  resolvePayer: resolveQualifyPayer,
  loadFacilities: loadQualifyFacilities,
  loadIdentifierLandingFacility: loadQualifyIdentifierLandingFacility,
  loadFacilityCases: loadQualifyFacilityCases,
  loadMatchSummary: loadQualifyMatchSummary,
  loadClaimPrefixToken: loadQualifyClaimPrefixToken,
  loadPatientCohort: loadQualifyPatientCohort,
  loadMovers: loadQualifyMovers,
  loadBookKpis: loadQualifyBookKpis,
  loadFacilityTrends: loadQualifyFacilityTrends,
  recordAccess,
  revealRow: (id, actor, entityIds, action) => revealCmdExplorerRow(id, actor, entityIds, action),
  revealRows: (ids, actor, entityIds, action) => revealCmdExplorerRows(ids, actor, entityIds, action),
  now: () => new Date(),
};

/** Max employers accepted in one market narrow (bounded input — the vocabulary is ~11.6k). */
const QUALIFY_EMPLOYER_SET_MAX = 200;
/** Max length of a single employer_norm string in a market narrow (bounds abuse; real values short). */
const QUALIFY_EMPLOYER_NAME_MAX = 200;

/**
 * Sanitize a client-supplied VOB market narrow at the trust boundary (this is the 'use server' edge):
 * bound the employer set count + each element length, and intersect funding with the closed
 * CMD_FUNDING_MARKETS vocabulary. Returns undefined when nothing survives (no restriction). All values
 * are bound as parameters downstream, so this only guards cardinality/vocabulary, never injection.
 */
function sanitizeMarket(market?: QualifyMarket): QualifyMarket | undefined {
  if (!market) return undefined;
  const out: QualifyMarket = {};
  if (Array.isArray(market.employers) && market.employers.length > 0) {
    const employers = market.employers
      .filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length <= QUALIFY_EMPLOYER_NAME_MAX)
      .slice(0, QUALIFY_EMPLOYER_SET_MAX);
    if (employers.length > 0) out.employers = employers;
  }
  if (Array.isArray(market.funding) && market.funding.length > 0) {
    const funding = market.funding.filter(
      (f): f is (typeof CMD_FUNDING_MARKETS)[number] =>
        typeof f === 'string' && (CMD_FUNDING_MARKETS as readonly string[]).includes(f),
    );
    if (funding.length > 0) out.funding = funding;
  }
  return out.employers || out.funding ? out : undefined;
}

export async function getQualifySnapshot(input: QualifyInput): Promise<QualifySnapshot> {
  return getQualifySnapshotCore(realDeps, { ...input, market: sanitizeMarket(input.market) });
}

/** Resolve-by-payer: load a payer's facilities/cases directly from its label (the Heating-up path). */
export async function getQualifySnapshotByPayer(input: QualifyPayerInput): Promise<QualifySnapshot> {
  return getQualifySnapshotByPayerCore(realDeps, { ...input, market: sanitizeMarket(input.market) });
}

/** Change C — resolve by CLIENT NAME: exact normalized-name blind index → dominant payer → the
 *  standard facility + cases drill. Audited (SEARCH_QUALIFY_NAME, field name only); the raw name is
 *  HMAC'd here at the boundary and never logged, URL'd, or echoed back. */
export async function getQualifySnapshotByName(input: QualifyNameInput): Promise<QualifySnapshot> {
  return getQualifySnapshotByNameCore(realDeps, { ...input, market: sanitizeMarket(input.market) });
}

/** Facility drill: the resolved payer's cases narrowed to ONE facility (the mobile facility-card tap). */
export async function getQualifyFacilityCases(input: QualifyFacilityCasesInput): Promise<QualifyFacilityCases> {
  return getQualifyFacilityCasesCore(realDeps, { ...input, market: sanitizeMarket(input.market) });
}

/** Intersect client-supplied funding with the closed vocabulary (defense-in-depth; the core also bounds
 *  the arrays + trims/HMACs the PHI terms). Funding values are bound params downstream regardless. */
function sanitizeCompose(input: QualifyComposeInput): QualifyComposeInput {
  const funding = Array.isArray(input.funding)
    ? input.funding.filter(
        (f): f is (typeof CMD_FUNDING_MARKETS)[number] =>
          typeof f === 'string' && (CMD_FUNDING_MARKETS as readonly string[]).includes(f),
      )
    : undefined;
  return { ...input, funding: funding && funding.length > 0 ? funding : undefined };
}

/** COMPOSE BAR — the live "N charge lines match" count over the AND-composed filter set. Count +
 *  percentages are non-dollar (admissions_seat-safe); the CORE strips dollar totals for that role. */
export async function getQualifyMatchSummary(input: QualifyComposeInput): Promise<QualifyMatchSummary> {
  return getQualifyMatchSummaryCore(realDeps, sanitizeCompose(input));
}

/** COMPOSE BAR — the charge lines matching the AND-composed filter set (the recent-claims panel).
 *  This is the row-returning PHI access; the core audits it (field names + selection cardinalities only). */
export async function getQualifyComposedCases(input: QualifyComposeInput): Promise<QualifyFacilityCases> {
  return getQualifyComposedCasesCore(realDeps, sanitizeCompose(input));
}

/** VOB PROBE — is this payer billed anywhere, EVER (unwindowed, cross-tenant)? The compose bar calls this
 *  ONLY when the composed count is 0 AND exactly one payer is selected AND no PHI narrow is active; a
 *  `count` of 0 means "provably never billed" → the VOB path. Non-PHI (payer label only); fail-closed to
 *  `{ ok: false }` on a blank payer or any error so a probe failure never renders a false "never billed". */
export async function getQualifyPayerEverBilled(payer: string): Promise<{ ok: true; count: number } | { ok: false }> {
  const p = typeof payer === 'string' ? payer.trim() : '';
  if (p === '') return { ok: false };
  try {
    return { ok: true, count: await getQualifyPayerEverBilledCore(realDeps, p) };
  } catch {
    return { ok: false };
  }
}

/** COMPOSE BAR — derive the dominant payer for a single PHI identifier (member id / alpha prefix) so the
 *  facility ranking can render on an identifier search with no payer chip selected. `payer` is null when
 *  the identifier was never seen. Non-PHI return (payer label only); fail-closed to `{ ok: false }`. */
export async function getQualifyResolvePayer(term: string): Promise<{ ok: true; payer: string | null } | { ok: false }> {
  const t = typeof term === 'string' ? term.trim() : '';
  if (t === '') return { ok: false };
  try {
    return { ok: true, payer: await getQualifyResolvePayerCore(realDeps, t) };
  } catch {
    return { ok: false };
  }
}

export async function getQualifyMovers(
  window: QualifyWindow,
  market?: QualifyMarket,
): Promise<QualifyMovers> {
  return getQualifyMoversCore(realDeps, window, sanitizeMarket(market));
}

/** Combined on-load: movers + auto-resolved top-payer snapshot + rank-1 seed cases in ONE round-trip. */
export async function getQualifyInitial(
  window: QualifyWindow,
  market?: QualifyMarket,
): Promise<QualifyInitial> {
  return getQualifyInitialCore(realDeps, window, sanitizeMarket(market));
}

/** Bound a client-supplied scope label list (payer/facility) at the 'use server' trust boundary: cap
 *  count + element length. Values are bound params downstream; the core re-normalizes (defense in
 *  depth). Design B: ONLY payer + facility lists exist here — there is no employer/funding channel. */
function sanitizeLabelList(xs?: string[]): string[] | undefined {
  if (!Array.isArray(xs)) return undefined;
  const out = xs
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= QUALIFY_EMPLOYER_NAME_MAX)
    .slice(0, QUALIFY_EMPLOYER_SET_MAX);
  return out.length > 0 ? out : undefined;
}

/** Phase 2 overview: KPI percentages + the slice's distinct-patient count for the window, in-plane.
 *  DESIGN B: scope is payer + facility ONLY (employer/funding never scope the tiles — they'd shred the
 *  slice to ~1 patient). No scope = book-wide (the landing tiles). Non-PHI aggregate (payer/facility
 *  labels only; no member term/token) — gate-only, parity with the movers path. */
export async function getQualifyBookKpis(
  window: QualifyWindow,
  scope?: { payers?: string[]; facilities?: string[] },
): Promise<QualifyBookKpis> {
  return getQualifyBookKpisCore(realDeps, window, {
    payers: sanitizeLabelList(scope?.payers),
    facilities: sanitizeLabelList(scope?.facilities),
  });
}

/** Redesign overview: per-facility rating trend + delta (Heating-Up + sparklines). payer null = book-wide. */
export async function getQualifyFacilityTrends(
  window: QualifyWindow,
  opts?: { payer?: string | null; market?: QualifyMarket },
): Promise<QualifyFacilityTrend[]> {
  return getQualifyFacilityTrendsCore(realDeps, window, {
    payer: opts?.payer ?? null,
    market: sanitizeMarket(opts?.market),
  });
}

/** Redesign combined on-load overview: KPIs + trends + the hybrid-resolved top facility, ONE round-trip.
 *  `opts.resolve === false` (a URL-restore load) returns the strip only — the caller resolves its own
 *  subject, so no wasted hybrid resolve/audit. */
export async function getQualifyOverview(
  window: QualifyWindow,
  market?: QualifyMarket,
  opts?: { resolve?: boolean },
): Promise<QualifyOverview> {
  return getQualifyOverviewCore(realDeps, window, sanitizeMarket(market), { resolve: opts?.resolve !== false });
}

/** Phase 3: the patient-group "View cohort" slide-over — audited, floor-gated, dollar-stripped in core. */
export async function getQualifyPatientCohort(input: QualifyPatientCohortInput): Promise<QualifyPatientCohort> {
  return getQualifyPatientCohortCore(realDeps, input);
}

export async function revealQualifyRow(id: number): Promise<RevealQualifyRowResult> {
  return revealQualifyRowCore(realDeps, id);
}

export async function revealQualifyRows(ids: number[]): Promise<RevealQualifyRowsResult> {
  return revealQualifyRowsCore(realDeps, ids);
}

export type QualifyEmployersResult = { ok: true; employers: CmdEmployerOption[] } | { ok: false };

/** Min term length before the employer type-ahead runs a search (mirrors collections' floor). */
const QUALIFY_EMPLOYER_TERM_MIN = 3;
/** Max term length (bounded input guard). */
const QUALIFY_EMPLOYER_TERM_MAX = 120;
/** Max employer options returned per keystroke (the vocabulary is large; the picker shows a slice). */
const QUALIFY_EMPLOYER_OPTIONS_LIMIT = 50;

/**
 * Employer options for Qualify's guided employer type-ahead (non-PHI). SERVER-SIDE per-keystroke
 * search: a sub-minimum term returns an EMPTY list (not an error). Gated by requireQualifyPrincipal
 * (Q-A roles only) and scoped to that principal's PINNED cross-tenant [BXR, Indigo] entityIds —
 * Qualify is deliberately cross-tenant, so the employer vocabulary spans both. Reuses the collections
 * employer-options loader (the rollup Qualify reads is derived from collections.cmd_explorer_rows, so
 * the member pool is the same). Employer is a plan-level dimension (plaintext, like payer), never PHI.
 */
export async function loadQualifyEmployers(term: string): Promise<QualifyEmployersResult> {
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false };
  const t = typeof term === 'string' ? term.trim() : '';
  if (t.length < QUALIFY_EMPLOYER_TERM_MIN) return { ok: true, employers: [] };
  if (t.length > QUALIFY_EMPLOYER_TERM_MAX) return { ok: false };
  try {
    return { ok: true, employers: await cmdExplorerEmployers(gate.entityIds, t, QUALIFY_EMPLOYER_OPTIONS_LIMIT) };
  } catch {
    return { ok: false };
  }
}

export type QualifyFacilityOptionsResult = { ok: true; facilities: CmdFacilityOption[] } | { ok: false };
export type QualifyPayerOptionsResult = { ok: true; payers: string[] } | { ok: false };

/**
 * Facility + payer options for Qualify's compose-bar pickers (non-PHI). CLIENT-mode vocabularies (loaded
 * once, filtered client-side as the user types), gated by requireQualifyPrincipal and scoped to that
 * principal's PINNED cross-tenant [BXR, Indigo] entityIds — Qualify is deliberately cross-tenant, so the
 * option sets span both books. Reuse the SAME collections option loaders (same rollup, same dimension
 * crosswalk) with Qualify's entity array where collections passes one tenant. Never PHI.
 */
export async function loadQualifyFacilityOptions(): Promise<QualifyFacilityOptionsResult> {
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false };
  try {
    return { ok: true, facilities: await cmdExplorerFacilities(gate.entityIds) };
  } catch {
    return { ok: false };
  }
}

export async function loadQualifyPayerOptions(): Promise<QualifyPayerOptionsResult> {
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false };
  try {
    return { ok: true, payers: await cmdExplorerPayers(gate.entityIds) };
  } catch {
    return { ok: false };
  }
}
