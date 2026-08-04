/**
 * DB preflight for the payer-intel worker.
 *
 * WHY: the worker researches all nine keys (~$40, ~50 min) BEFORE its first
 * write. With migration 025 unapplied, every write then fails against a missing
 * `intel` schema — the per-key try/catch logs each failure and moves on, so the
 * whole research spend is burned for zero persisted rows. This check runs
 * before the first API call and fails fast, naming EVERY gap in one line
 * (mirrors app/lib/env-preflight.ts, which does the same for env vars).
 *
 * One round-trip, fixed-literal SQL only — table/role names are compile-time
 * constants, nothing user-supplied is interpolated. `has_table_privilege`
 * raises (rather than returning false) when the role or table name does not
 * resolve, so every call sits under a CASE guard on the role_ok AND *_table_ok
 * flags — a partial apply reports gaps instead of erroring the probe. Non-PHI
 * throughout: the query touches pg_catalog only.
 */

import type { Queryable } from './upsert.js';

/**
 * One row, one boolean per asserted precondition. Every has_table_privilege is
 * CASE-guarded on BOTH the table and the role existing — the function raises
 * (rather than returning false) when either name does not resolve, and CASE
 * guarantees the guarded branch is not evaluated.
 */
export const PREFLIGHT_SQL = `
  WITH state AS (
    SELECT
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intel_writer') AS role_ok,
      (to_regclass('intel.payer_policy_run') IS NOT NULL)            AS run_table_ok,
      (to_regclass('intel.payer_policy_finding') IS NOT NULL)        AS finding_table_ok,
      (to_regclass('intel.payer_policy_run_check') IS NOT NULL)      AS check_table_ok
  )
  SELECT
    (to_regnamespace('intel') IS NOT NULL) AS schema_ok,
    role_ok,
    run_table_ok,
    finding_table_ok,
    check_table_ok,
    CASE WHEN role_ok AND run_table_ok
         THEN has_table_privilege('intel_writer', 'intel.payer_policy_run', 'INSERT')
          AND has_table_privilege('intel_writer', 'intel.payer_policy_run', 'UPDATE')
         ELSE false END AS run_write_ok,
    CASE WHEN role_ok AND finding_table_ok
         THEN has_table_privilege('intel_writer', 'intel.payer_policy_finding', 'INSERT')
          AND has_table_privilege('intel_writer', 'intel.payer_policy_finding', 'UPDATE')
         ELSE false END AS finding_write_ok,
    CASE WHEN role_ok AND check_table_ok
         THEN has_table_privilege('intel_writer', 'intel.payer_policy_run_check', 'INSERT')
         ELSE false END AS check_insert_ok
  FROM state
`;

export interface PreflightRow {
  schema_ok: boolean;
  role_ok: boolean;
  run_table_ok: boolean;
  finding_table_ok: boolean;
  check_table_ok: boolean;
  run_write_ok: boolean;
  finding_write_ok: boolean;
  check_insert_ok: boolean;
}

/** Human-readable gap per failed precondition, in a stable order. */
export function preflightGaps(row: PreflightRow): string[] {
  const gaps: string[] = [];
  if (!row.schema_ok) gaps.push('schema intel');
  if (!row.role_ok) gaps.push('role intel_writer');
  if (!row.run_table_ok) gaps.push('table intel.payer_policy_run');
  if (!row.finding_table_ok) gaps.push('table intel.payer_policy_finding');
  if (!row.check_table_ok) gaps.push('table intel.payer_policy_run_check');
  // A grant gap on a missing table or role is implied by that gap — skip the noise.
  if (row.role_ok && row.run_table_ok && !row.run_write_ok) {
    gaps.push('grant INSERT,UPDATE on intel.payer_policy_run to intel_writer');
  }
  if (row.role_ok && row.finding_table_ok && !row.finding_write_ok) {
    gaps.push('grant INSERT,UPDATE on intel.payer_policy_finding to intel_writer');
  }
  if (row.role_ok && row.check_table_ok && !row.check_insert_ok) {
    gaps.push('grant INSERT on intel.payer_policy_run_check to intel_writer');
  }
  return gaps;
}

/**
 * Assert the intel schema and intel_writer grants exist. Throws once with every
 * gap named. Also proves the connection string actually connects (pg.Pool is
 * lazy), so a bad credential fails here instead of after the research spend.
 */
export async function assertIntelPreflight(db: Queryable): Promise<void> {
  const result = await db.query(PREFLIGHT_SQL, []);
  const row = result.rows[0] as PreflightRow | undefined;
  if (!row) throw new Error('payer-intel preflight: probe query returned no row');
  const gaps = preflightGaps(row);
  if (gaps.length === 0) return;
  throw new Error(
    `payer-intel preflight: missing ${gaps.join('; ')} — apply "SQL Schemas/025_payer_policy_intel.sql" ` +
    'before running (a full roster researches ~$40 of API spend before the first write)',
  );
}
