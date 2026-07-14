/**
 * Billing Audit — per-scope CMD rosters + env-only report/filter configuration.
 *
 * SCOPE IS THE ROSTER (Alec, 2026-07-13, LOCKED): the CMD audit reports do NOT
 * self-filter by care setting — the live probe proved the OP report runs fine under an
 * IP customer and simply returns that customer's charges in the OP projection. A row is
 * IP or OP because of WHICH roster its customer sits in, so these lists are the semantic
 * boundary: never run a customer under the other scope's report.
 *
 * Rosters are Alec's verbatim ruling (2026-07-13), all under BXR's CMD account 475729.
 * Four OP customers (HOUSTON MH, TEEN MH TX, TREAT CO, WELLNESS RECOVERY) are the
 * collections cron's deliberate EXCLUSIONS — that exclusion was about the COLLECTIONS
 * saved filter; the audit filters are different and Alec lists them as valid here.
 * `facilityCode` is a LOG LABEL only on this plane — row-level facility attribution
 * comes from the report's Office Name via claims.facility_alias, never from the roster.
 *
 * ENV-VAR-ONLY (deliberate break from the collections pattern, per the session brief):
 * report/filter ids have NO hardcoded fallbacks. A missing var throws at compose time —
 * the collections-style in-code default is tracked debt we do not replicate.
 */
import { BXR_ENTITY_ID } from '../tenants.js';
import type { CmdCustomerTarget } from '../collections/cmdExplorerCron.js';

export type AuditScope = 'IP' | 'OP';

/** IP audit roster — the 8 inpatient facilities (Alec, 2026-07-13). */
export const AUDIT_IP_CUSTOMERS: readonly CmdCustomerTarget[] = [
  { customerId: '10027973', facilityCode: 'CAMH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10033950', facilityCode: 'DMH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10034908', facilityCode: 'KWC', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10031977', facilityCode: 'LSMH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10033690', facilityCode: 'LAMH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10030911', facilityCode: 'NASH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10030471', facilityCode: 'PCMH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10029105', facilityCode: 'TBH', businessEntityId: BXR_ENTITY_ID },
] as const;

/** OP audit roster — 9 outpatient customers (Alec, 2026-07-13; roster trimmed 2026-07-14).
 *  facilityCode is a LOG LABEL only (row attribution comes from the report's Office Name).
 *
 *  EXCLUDED on purpose — the audit saved filter is NOT valid under these customers (live
 *  invoke 2026-07-14 returned `INVALID CRITERIA (no identifier)` for each): 10035976
 *  HOUSTON_MH, 10035974 TREAT_CO. Same class as the collections cron's excluded accounts —
 *  BUT the exclusion sets differ: 10035166 TEEN_MH_TX is excluded from collections yet the
 *  audit filter IS valid under it (223 rows landed), so it STAYS here. WRC (10033951) is
 *  kept — it returns a valid-but-empty report, not INVALID CRITERIA. If an excluded account
 *  later gets a valid audit filter, re-add it here (and confirm with a probe first). */
export const AUDIT_OP_CUSTOMERS: readonly CmdCustomerTarget[] = [
  { customerId: '10032340', facilityCode: 'FRCA', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10034666', facilityCode: 'TELEHEALTH_MH', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10030101', facilityCode: 'TREAT_CA', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10034671', facilityCode: 'TREAT_NV', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10029905', facilityCode: 'TREAT_TN', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10029722', facilityCode: 'TREAT_TX', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10031212', facilityCode: 'TREAT_WA', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10035166', facilityCode: 'TEEN_MH_TX', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10033951', facilityCode: 'WRC', businessEntityId: BXR_ENTITY_ID },
] as const;

export function auditCustomersFor(scope: AuditScope): readonly CmdCustomerTarget[] {
  return scope === 'IP' ? AUDIT_IP_CUSTOMERS : AUDIT_OP_CUSTOMERS;
}

export interface AuditReportIds {
  reportId: string;
  filterId: string;
}

/**
 * Resolve the scope's report+filter ids from env — THROWS on a missing/blank var
 * (env-var-only; no fallback ids, ever). Pure: env is a parameter for testability;
 * the composition root passes process.env.
 */
export function auditReportIds(scope: AuditScope, env: Record<string, string | undefined>): AuditReportIds {
  const reportKey = `CMD_${scope}_AUDIT_REPORT_ID`;
  const filterKey = `CMD_${scope}_AUDIT_FILTER_ID`;
  const reportId = env[reportKey]?.trim();
  const filterId = env[filterKey]?.trim();
  if (!reportId || !filterId) {
    // Names only — never values. This is the deliberate no-fallback failure mode.
    throw new Error(`Billing-audit env not configured: set ${reportKey} and ${filterKey}`);
  }
  return { reportId, filterId };
}
