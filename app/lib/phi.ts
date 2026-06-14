/**
 * PHI-column identification for the results table.
 *
 * `/api/results` returns only the per-function allowlisted columns (the route
 * never SELECTs *), but several of those columns ARE patient identifiers. This UI
 * masks them by default and reveals per-row on an explicit click (gate 2). This
 * module is the single source of truth for "which returned columns are PHI."
 *
 * The base PHI set mirrors `PhiKey` in src/queries/types.ts. readmission_candidates
 * projects every allowlisted column twice, prefixed `a_` / `b_`, so a PHI column
 * there appears as e.g. `a_patient_name` — `isPhiColumn` strips that pair prefix
 * before testing. Pure (no I/O) so the rule is trivially auditable.
 */

/** The patient-identifier columns — must stay in lockstep with src PhiKey. */
const PHI_BASE_COLUMNS: ReadonlySet<string> = new Set([
  'patient_name',
  'patient_first',
  'patient_last',
  'member_id_raw',
  'member_id_norm',
  'group_number',
  'employer_name',
]);

/** Strip a readmission pair prefix (`a_` / `b_`) so paired columns test correctly. */
function stripPairPrefix(column: string): string {
  if (column.startsWith('a_') || column.startsWith('b_')) return column.slice(2);
  return column;
}

/** True when a returned results column carries patient PHI and must be masked. */
export function isPhiColumn(column: string): boolean {
  return PHI_BASE_COLUMNS.has(stripPairPrefix(column));
}

/** A fixed mask shown in place of an unrevealed PHI value (never the real value). */
export const PHI_MASK = '••••••';

/**
 * Render a cell value for display. PHI cells show the mask unless `revealed`.
 * Non-PHI cells always render their value. `null`/`undefined` render as an em dash
 * regardless (no value to hide, nothing to reveal).
 */
export function displayCell(column: string, value: unknown, revealed: boolean): string {
  if (value === null || value === undefined) return '—';
  if (isPhiColumn(column) && !revealed) return PHI_MASK;
  // Values arrive plain/JSON-safe (the Server Action normalizes Date and other
  // non-plain pg values before they cross to the client), so a String() suffices.
  return String(value);
}
