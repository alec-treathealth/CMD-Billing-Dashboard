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
  loadQualifyPayerSpread,
  loadQualifyFacilities,
  loadQualifyIdentifierLandingFacility,
  loadQualifyFacilityCases,
  loadQualifyMatchSummary,
  loadQualifyMatchClientCount,
  loadQualifyMovers,
  loadQualifyBookKpis,
  loadQualifyFacilityTrends,
  loadQualifyClaimPrefixToken,
  loadQualifyPatientCohort,
  cmdExplorerEmployers,
  qualifyFacilityOptions,
  cmdExplorerPayers,
  CMD_FUNDING_MARKETS,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
  type CmdEmployerOption,
} from '@/lib/server';
import type { QualifyFacilityOption } from '../../../src/collections/cmdExplorerQuery';
import { memberIdBlindIndex, alphaPrefixBlindIndex, groupNumberBlindIndex, patientNameBlindIndex } from '../../../src/collections/blindIndex';
import {
  loadQualifyPolicy,
  loadQualifyPolicySpread,
  loadQualifyVobFreshness,
  loadRollupRefreshFreshness,
  loadQualifyWindowRungs,
  loadCurrentCodingDecisions,
  loadQualifyCensusAuth,
  loadQualifyFacilityOutcomes,
} from '@/lib/qualify/loaders';
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

/**
 * loadQualifyFacilities' published type still says `payer: string` (app/lib/server.ts is under
 * concurrent development and is deliberately untouched by the v2 branch), but the SQL builder
 * underneath (buildFacilityRankingQuery) accepts `payer: string | null` — null is the v2
 * comparable-cohort ranking, guarded at the builder chokepoint (a null payer without a market
 * narrow throws). The wrapper widens ONLY the payer parameter — every other argument stays
 * type-checked (review finding #12). Delete when server.ts's own signature widens.
 */
const loadFacilitiesV2: QualifyDeps['loadFacilities'] = (payer, from, to, entityIds, market, token, kind) =>
  loadQualifyFacilities(payer as string, from, to, entityIds, market, token ?? undefined, kind ?? undefined);

const realDeps: QualifyDeps = {
  requirePrincipal: requireQualifyPrincipal,
  mintToken: (query, kind) => (kind === 'prefix' ? alphaPrefixBlindIndex(query) : memberIdBlindIndex(query)),
  mintGroupToken: (raw) => groupNumberBlindIndex(raw),
  mintNameToken: (raw) => patientNameBlindIndex(raw),
  resolvePayer: resolveQualifyPayer,
  loadPayerSpread: loadQualifyPayerSpread,
  loadFacilities: loadFacilitiesV2,
  loadIdentifierLandingFacility: loadQualifyIdentifierLandingFacility,
  loadFacilityCases: loadQualifyFacilityCases,
  loadMatchSummary: loadQualifyMatchSummary,
  loadMatchClientCount: loadQualifyMatchClientCount,
  loadClaimPrefixToken: loadQualifyClaimPrefixToken,
  loadPatientCohort: loadQualifyPatientCohort,
  loadMovers: loadQualifyMovers,
  loadBookKpis: loadQualifyBookKpis,
  loadFacilityTrends: loadQualifyFacilityTrends,
  recordAccess,
  revealRow: (id, actor, entityIds, action) => revealCmdExplorerRow(id, actor, entityIds, action),
  revealRows: (ids, actor, entityIds, action) => revealCmdExplorerRows(ids, actor, entityIds, action),
  now: () => new Date(),
  // ── v2 seams (Phases 0/A/B/E) — loaders.ts owns the second reader pool; census binds in Phase G.
  loadPolicy: (token, kind) => loadQualifyPolicy(token, kind),
  loadPolicySpread: (token, kind) => loadQualifyPolicySpread(token, kind),
  loadVobFreshness: () => loadQualifyVobFreshness(),
  loadWindowRungs: (token, kind, entityIds, froms, to) => loadQualifyWindowRungs(token, kind, entityIds, froms, to),
  loadCodingDecisions: () => loadCurrentCodingDecisions(),
  loadFacilityOutcomes: () => loadQualifyFacilityOutcomes(),
  loadCensusAuth: () => loadQualifyCensusAuth(),
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

/** Max length of a payer drill-down label. primary_payer values are short; this only bounds abuse —
 *  the core still validates membership in the identifier's own spread, which is the real check. */
const QUALIFY_PAYER_OVERRIDE_MAX = 200;

export async function getQualifySnapshot(input: QualifyInput): Promise<QualifySnapshot> {
  // Bound the drill-down label at the trust boundary (this IS the 'use server' edge), matching how
  // sanitizeMarket bounds employer strings. Length only: the VALUE is authorized in the core against
  // the identifier's own payer spread, because only there is the evidence to authorize it against.
  const payerOverride =
    typeof input.payerOverride === 'string' && input.payerOverride.length <= QUALIFY_PAYER_OVERRIDE_MAX
      ? input.payerOverride
      : null;
  // Identifier-wide scope: a CLOSED vocabulary of exactly one value, so the boundary re-derives it
  // rather than forwarding whatever arrived. Anything else — including the string 'ALL', a boolean,
  // an object — becomes undefined and the request is payer-scoped, which is the pre-existing
  // behaviour. Fail-closed toward the NARROWER claim: a widened scope is a widened assertion about
  // what the numbers describe, and it must be asked for exactly.
  const payerScope = input.payerScope === 'all' ? ('all' as const) : undefined;
  return getQualifySnapshotCore(realDeps, {
    ...input,
    payerOverride,
    ...(payerScope ? { payerScope } : { payerScope: undefined }),
    market: sanitizeMarket(input.market),
  });
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

/** Phase 2 overview: per-facility rating trend + delta (Heating-Up ticker + sparklines). Design B:
 *  payer-only scope — exactly-one-payer → payer-scoped ticker, null → book-wide. NO market (employer/
 *  funding never scope the ticker). The builder enforces the both-window distinct-patient delta gate. */
export async function getQualifyFacilityTrends(
  window: QualifyWindow,
  opts?: { payer?: string | null },
): Promise<QualifyFacilityTrend[]> {
  return getQualifyFacilityTrendsCore(realDeps, window, { payer: opts?.payer ?? null });
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

export type QualifyFacilityOptionsResult = { ok: true; facilities: QualifyFacilityOption[] } | { ok: false };
export type QualifyPayerOptionsResult = { ok: true; payers: string[] } | { ok: false };

/**
 * Facility + payer options for Qualify's compose-bar pickers (non-PHI). CLIENT-mode vocabularies (loaded
 * once, filtered client-side as the user types), gated by requireQualifyPrincipal and scoped to that
 * principal's PINNED cross-tenant [BXR, Indigo] entityIds — Qualify is deliberately cross-tenant, so the
 * option sets span both books. Reuse the SAME collections option loaders (same rollup, same dimension
 * crosswalk) with Qualify's entity array where collections passes one tenant. Never PHI.
 *
 * FACILITIES ARE DE-DUPLICATED HERE and NOT in Collections: `qualifyFacilityOptions` collapses the
 * raw-text grain to one row per resolved facility_code and returns every spelling in `variants`, so
 * the picker stops showing two identical `LONESTAR MENTAL HEALTH LLC` rows that scope to 4,156 and
 * 81 lines respectively. The Collections explorer deliberately keeps the raw-text list.
 */
export async function loadQualifyFacilityOptions(): Promise<QualifyFacilityOptionsResult> {
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false };
  try {
    return { ok: true, facilities: await qualifyFacilityOptions(gate.entityIds) };
  } catch {
    return { ok: false };
  }
}

export type QualifyDataFreshnessResult = { ok: true; rebuiltAt: string | null } | { ok: false };

/**
 * WHEN THE RANKING INDEX WAS LAST REBUILT (S5) — `collections.rollup_refresh_run.finished_at` for
 * the newest ok run, full UTC ISO. The answer stage renders it as "Ranking data rebuilt …" beside
 * the refresh control, so the operator can tell whether pressing it can possibly help.
 *
 * ⚠ ITS OWN ACTION, NOT A FIELD ON `QualifySnapshot`, and the choice is deliberate. The snapshot is
 * a member-scoped, PHI-audited payload built by `getQualifySnapshotCore`; this is a global
 * operational fact with no tenant, no identifier and no user input. Folding it in would (a) make
 * every v2-tab and mobile snapshot pay for a read neither renders, (b) put an ops lookup inside the
 * one call the whole surface waits on, and (c) share a failure mode with the ranking — where the
 * whole point is that a freshness failure must degrade to "unknown" and leave the answer untouched.
 * The cost is one extra effect in the shell, keyed on the refresh nonce so the time moves when the
 * operator asks for fresher data.
 *
 * Gated by `requireQualifyPrincipal` (Q-A roles only) like every other action here, even though the
 * value is non-PHI: an ungated action is an ungated action. Fail-soft to `{ ok: false }` — the UI
 * says "freshness unknown" rather than a number it cannot stand behind.
 *
 * Non-PHI: one timestamp. Nothing member-identifying exists on this path.
 */
export async function loadQualifyDataFreshness(): Promise<QualifyDataFreshnessResult> {
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false };
  try {
    return { ok: true, rebuiltAt: await loadRollupRefreshFreshness() };
  } catch (err) {
    /* ⚠ THE SWALLOW MUST STAY DISCOVERABLE — the sibling loaders' own words, and the 0089 rule's
     * other half. Correctness is not the exposure here: a 42501 cannot fabricate a timestamp, and
     * the unknown arm carries no digit. The exposure is that this table's SELECT POLICY has never
     * been exercised on the app path, so the FIRST failure is the one that matters most — and a bare
     * catch makes a permission error indistinguishable from an empty log, in the UI and in the logs.
     * 0089 is exactly that: a swallowed 42501 became permanently wrong data instead of a visible
     * failure. SQLSTATE only; the driver's message can carry query text and answers nothing here. */
    /* ⚠ `?? 'no-sqlstate'`, BECAUSE `String(undefined)` IS THE WORD "undefined" (final review,
     * 2026-08-08). A thrown object WITHOUT a `code` — a TypeError from the driver, an AggregateError
     * from a pool, anything that is not a Postgres error — logged "sqlstate undefined", which reads
     * as a driver that returned a null SQLSTATE rather than as a throw that never had one. The whole
     * point of this line is that the FIRST failure of an untested policy is legible; a log that
     * misdescribes the shape of the error is the swallow this catch exists to avoid. */
    const code = String(
      typeof err === 'object' && err !== null
        ? // `?? 'no-sqlstate'` — an object that IS an error but carries no SQLSTATE. Kept distinct
          // from 'unknown' below, which means the throw was not an object at all.
          ((err as { code?: unknown }).code ?? 'no-sqlstate')
        : 'unknown',
    );
    console.error(`qualify data freshness read failed (sqlstate ${code}) — rendering "freshness unknown"`);
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
