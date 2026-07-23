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
  loadQualifyMovers,
  loadQualifyClaimPrefixToken,
  loadQualifyPatientCohort,
  cmdExplorerEmployers,
  CMD_FUNDING_MARKETS,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
  type CmdEmployerOption,
} from '@/lib/server';
import { memberIdBlindIndex, alphaPrefixBlindIndex, groupNumberBlindIndex } from '../../../src/collections/blindIndex';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifyFacilityCasesCore,
  getQualifyMoversCore,
  getQualifyPatientCohortCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  type QualifyDeps,
} from '@/lib/qualify/core';
import type {
  QualifyInput,
  QualifyPayerInput,
  QualifyFacilityCasesInput,
  QualifyFacilityCases,
  QualifyPatientCohortInput,
  QualifyPatientCohort,
  QualifySnapshot,
  QualifyMovers,
  QualifyMarket,
  QualifyWindowDays,
  RevealQualifyRowResult,
  RevealQualifyRowsResult,
} from '@/lib/qualify/contract';

const realDeps: QualifyDeps = {
  requirePrincipal: requireQualifyPrincipal,
  mintToken: (query, kind) => (kind === 'prefix' ? alphaPrefixBlindIndex(query) : memberIdBlindIndex(query)),
  mintGroupToken: (raw) => groupNumberBlindIndex(raw),
  resolvePayer: resolveQualifyPayer,
  loadFacilities: loadQualifyFacilities,
  loadIdentifierLandingFacility: loadQualifyIdentifierLandingFacility,
  loadFacilityCases: loadQualifyFacilityCases,
  loadClaimPrefixToken: loadQualifyClaimPrefixToken,
  loadPatientCohort: loadQualifyPatientCohort,
  loadMovers: loadQualifyMovers,
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

/** Facility drill: the resolved payer's cases narrowed to ONE facility (the mobile facility-card tap). */
export async function getQualifyFacilityCases(input: QualifyFacilityCasesInput): Promise<QualifyFacilityCases> {
  return getQualifyFacilityCasesCore(realDeps, { ...input, market: sanitizeMarket(input.market) });
}

export async function getQualifyMovers(
  windowDays: QualifyWindowDays,
  market?: QualifyMarket,
): Promise<QualifyMovers> {
  return getQualifyMoversCore(realDeps, windowDays, sanitizeMarket(market));
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
