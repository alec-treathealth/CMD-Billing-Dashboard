/**
 * Reader queries for the behavioral-health code-intelligence layer (migrations
 * 0043–0045). Runs over the least-privilege claims_reader path via QueryExecutor —
 * unnamed parameterized queries only, same pattern as the rest of src/queries.
 *
 * NON-PHI: these return reference data only (codes, payer/facility names, policy
 * attributes, CMS change signals). There is no PHI in code_intel, so — unlike the
 * agent query path — there is no query_id / reveal indirection here.
 */
import type { QueryExecutor } from './types.js';

export interface ActiveBillingCodeRow {
  facility: string;
  payer: string;
  plan_name: string;
  state: string;
  setting: string;
  hcpcs_code: string | null;
  hcpcs_desc: string | null;
  rev_code: string | null;
  rev_desc: string | null;
  billing_role: string;
  rule_type: string;
  dos_batch_rule: string | null;
  tob: string | null;
  drg_code: string | null;
  modifier: string | null;
  admit_type: string | null;
  condition_code: string | null;
  observed_per_diem: number | null;
  test_status: string;
  decision_date: string | null;
  notes: string | null;
}

export interface ActiveBillingCodesArgs {
  facilityCode: string;
  payerName: string;
  setting: string;
  asOf?: string; // ISO yyyy-mm-dd; defaults to current_date in SQL
}

/** numeric(…) comes back from pg as a string; normalize to number|null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * "What codes do we bill today for this facility × payer × setting?"
 * Thin wrapper over the code_intel.get_active_billing_codes RPC (0044).
 */
export async function getActiveBillingCodes(
  executor: QueryExecutor,
  args: ActiveBillingCodesArgs,
): Promise<ActiveBillingCodeRow[]> {
  const res = await executor.query<ActiveBillingCodeRow>(
    `select * from code_intel.get_active_billing_codes($1, $2, $3, $4::date)`,
    [args.facilityCode, args.payerName, args.setting, args.asOf ?? null],
  );
  return res.rows.map((r) => ({ ...r, observed_per_diem: num(r.observed_per_diem) }));
}

export interface PendingCodeFlagRow {
  id: string;
  source: string;
  source_ref: string | null;
  change_type: string;
  change_summary: string | null;
  effective_date: string | null;
  detected_at: string;
  affected_code: string | null;
  code_type: string | null;
  code_description: string | null;
  payer: string | null;
  plan_name: string | null;
  state: string | null;
  facility: string | null;
  previous_value: unknown;
  new_value: unknown;
  notes: string | null;
}

/** All pending code-change flags, urgency-ordered (deletions first). View from 0044. */
export async function getPendingCodeFlags(
  executor: QueryExecutor,
): Promise<PendingCodeFlagRow[]> {
  const res = await executor.query<PendingCodeFlagRow>(
    `select id, source, source_ref, change_type, change_summary, effective_date,
            detected_at, affected_code, code_type, code_description, payer, plan_name,
            state, facility, previous_value, new_value, notes
       from code_intel.v_pending_code_change_flags`,
    [],
  );
  return res.rows;
}
