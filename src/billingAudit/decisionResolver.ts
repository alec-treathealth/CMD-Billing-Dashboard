/**
 * Billing Audit — FACILITY-SCOPED decision resolver (Phase-3 contract; Alec 2026-07-14).
 *
 * This is the mechanism the flag engine will consume; NO flag RULES live here (they stay
 * Phase-3, gated on the soak). It is landed + unit-tested now so it is ready the moment
 * the soak clears, and so the facility-scoping guarantee is provable against today's data.
 *
 * THE GUARANTEE — a payer is resolved ONLY against the row's OWN facility's decision
 * carriers, so a cross-facility tie can never mis-route. Two facilities spell the same
 * concept differently (CAMH "Anthem BCBS CALIFORNIA" vs Treat CA "Anthem of CALIFORNIA",
 * both matching the report payer "ANTHEM BLUE CROSS CALIFORNIA"); scoping the candidate
 * alias set to the facility's carriers means each facility only ever sees its own alias.
 *
 * FAIL-CLOSED, ALWAYS (Alec's ruling): a row is left UNRESOLVED — never resolved against
 * the tenant-wide carrier set — when any of these holds:
 *   · unmapped_facility     — facility_code is NULL/blank (0052 held it out, e.g. TEEN)
 *   · no_facility_carriers  — the facility has no active billing_code_decision carriers
 *   · no_payer_match        — no alias among THIS facility's carriers matches the payer
 *   · no_decision_for_cohort— the carrier matched but no decision row fits the sub-cohort
 * The flag engine skips decision-based rules for an unresolved row and COUNTS it; the
 * alias-independent rules (MISSING_AUTH, STALE_AT_PAYER, …) are unaffected.
 *
 * SHAPE — a PURE core (`resolveDecision`, all data pre-fetched → hermetically testable,
 * incl. the cross-facility isolation case) plus a thin DB wrapper (`resolveDecisionForRow`)
 * that fetches this facility's carriers + the tenant aliases + this facility's active
 * decisions and calls the core. The flag engine will fetch these sets ONCE per run and
 * call the pure core per row (never a query-per-row); the wrapper is the single-row path.
 */
import { resolvePayerAlias, type PayerAliasRow } from './payerAlias.js';
import { withTenant } from '../veris/withTenant.js';
import type { Db } from '../collections/db.js';

/** The subset of claims.billing_code_decision the resolver + flag engine need. */
export interface DecisionRow {
  id: number;
  facility_code: string;
  carrier_text: string;
  alpha_prefix: string | null; // EH sub-cohort: member-id alpha prefix (null = all)
  loc: string | null; //          EH sub-cohort: level of care (null = all)
  hcpcs: string | null;
  rev_code: string | null;
  rules_text: string | null;
  active: boolean;
}

export type DecisionUnresolvedReason =
  | 'unmapped_facility'
  | 'no_facility_carriers'
  | 'no_payer_match'
  | 'no_decision_for_cohort';

export type DecisionResolution =
  | { status: 'resolved'; facilityCode: string; carrier: string; alias: PayerAliasRow; decisions: DecisionRow[] }
  | { status: 'unresolved'; reason: DecisionUnresolvedReason; facilityCode: string | null; carrier?: string };

export interface ResolveDecisionInput {
  facilityCode: string | null | undefined;
  payerName: string | null | undefined;
  /** DISTINCT active carrier_text for THIS facility (billing_code_decision). */
  facilityCarriers: readonly string[];
  /** ALL payer_alias rows for the tenant — scoped down to the facility's carriers here. */
  tenantAliases: readonly PayerAliasRow[];
  /** Active decision rows for THIS facility (all its carriers). */
  facilityDecisions: readonly DecisionRow[];
  /** Row's member-id alpha prefix (plaintext; Phase-3 supplies). null → cohort-agnostic. */
  alphaPrefix?: string | null;
  /** Row's level of care. null → cohort-agnostic. */
  loc?: string | null;
}

/**
 * Among a carrier's decision rows, pick the most sub-cohort-specific rows that APPLY to a
 * row's (alphaPrefix, loc). A decision field of null matches any value; a non-null field
 * must equal the row's value. Specificity = alpha_prefix(2) + loc(1); the highest-scoring
 * applicable tier wins (so an exact ZGP/RTC decision beats a ZGP-only beats a catch-all).
 */
function selectByCohort(
  rows: readonly DecisionRow[],
  alphaPrefix: string | null,
  loc: string | null,
): DecisionRow[] {
  const score = (d: DecisionRow) => (d.alpha_prefix !== null ? 2 : 0) + (d.loc !== null ? 1 : 0);
  const applicable = rows.filter(
    (d) =>
      (d.alpha_prefix === null || d.alpha_prefix === alphaPrefix) &&
      (d.loc === null || d.loc === loc),
  );
  if (applicable.length === 0) return [];
  const max = applicable.reduce((m, d) => Math.max(m, score(d)), -1);
  return applicable.filter((d) => score(d) === max);
}

/**
 * PURE facility-scoped resolution. All inputs are pre-fetched; no I/O, no throws — an
 * unresolvable row returns an {unresolved, reason} discriminant (never a tenant-wide match).
 */
export function resolveDecision(input: ResolveDecisionInput): DecisionResolution {
  const fc = input.facilityCode?.trim();
  if (!fc) return { status: 'unresolved', reason: 'unmapped_facility', facilityCode: null };

  const carriers = new Set(input.facilityCarriers);
  if (carriers.size === 0) return { status: 'unresolved', reason: 'no_facility_carriers', facilityCode: fc };

  // FACILITY SCOPING — the candidate alias set is ONLY this facility's carriers.
  const candidates = input.tenantAliases.filter((a) => carriers.has(a.alias_text));
  const winner = resolvePayerAlias(input.payerName, candidates);
  if (winner === null) return { status: 'unresolved', reason: 'no_payer_match', facilityCode: fc };

  const forCarrier = input.facilityDecisions.filter((d) => d.carrier_text === winner.alias_text);
  const decisions = selectByCohort(forCarrier, input.alphaPrefix ?? null, input.loc ?? null);
  if (decisions.length === 0) {
    return { status: 'unresolved', reason: 'no_decision_for_cohort', facilityCode: fc, carrier: winner.alias_text };
  }
  return { status: 'resolved', facilityCode: fc, carrier: winner.alias_text, alias: winner, decisions };
}

/**
 * Thin DB wrapper — single-row resolution as the least-privilege claims_audit_writer.
 * Wrapped in withTenant so the GUC-checked writer SELECT policies (0049) pass, and every
 * query carries the tenant WHERE. Returns the same discriminant as the pure core. Skips
 * all I/O for an unmapped facility (the common held-NULL case) — no wasted round trip.
 */
export async function resolveDecisionForRow(
  db: Db,
  input: {
    businessEntityId: string;
    facilityCode: string | null | undefined;
    payerName: string | null | undefined;
    alphaPrefix?: string | null;
    loc?: string | null;
  },
): Promise<DecisionResolution> {
  const fc = input.facilityCode?.trim();
  if (!fc) return { status: 'unresolved', reason: 'unmapped_facility', facilityCode: null };

  return withTenant(db, input.businessEntityId, async (client) => {
    const carriersRes = await client.query<{ carrier_text: string }>(
      `select distinct carrier_text from claims.billing_code_decision
        where business_entity_id = $1 and facility_code = $2 and active`,
      [input.businessEntityId, fc],
    );
    const facilityCarriers = carriersRes.rows.map((r) => r.carrier_text);
    if (facilityCarriers.length === 0) {
      return { status: 'unresolved', reason: 'no_facility_carriers', facilityCode: fc };
    }

    const aliasRes = await client.query<{ id: string; alias_text: string; match_kind: string; match_value: string; precedence: number }>(
      `select id, alias_text, match_kind, match_value, precedence from claims.payer_alias
        where business_entity_id = $1 and alias_text = any($2::text[])`,
      [input.businessEntityId, facilityCarriers],
    );
    const tenantAliases: PayerAliasRow[] = aliasRes.rows.map((r) => ({
      id: Number(r.id),
      alias_text: r.alias_text,
      match_kind: r.match_kind as PayerAliasRow['match_kind'],
      match_value: r.match_value,
      precedence: r.precedence,
    }));

    const decRes = await client.query<{ id: string; facility_code: string; carrier_text: string; alpha_prefix: string | null; loc: string | null; hcpcs: string | null; rev_code: string | null; rules_text: string | null; active: boolean }>(
      `select id, facility_code, carrier_text, alpha_prefix, loc, hcpcs, rev_code, rules_text, active
         from claims.billing_code_decision
        where business_entity_id = $1 and facility_code = $2 and active`,
      [input.businessEntityId, fc],
    );
    const facilityDecisions: DecisionRow[] = decRes.rows.map((r) => ({ ...r, id: Number(r.id) }));

    return resolveDecision({
      facilityCode: fc,
      payerName: input.payerName,
      facilityCarriers,
      tenantAliases,
      facilityDecisions,
      alphaPrefix: input.alphaPrefix,
      loc: input.loc,
    });
  });
}
