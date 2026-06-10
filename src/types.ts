/**
 * Canonical column model and per-year header mapping for the three source
 * sheets. The spec ("Column map") guarantees columns are positionally
 * identical across years; only the first column's HEADER text differs
 * (`Office Name` in 2024, `Facility Name` in 2025/2026).
 */

/** Canonical column order — matches the left-to-right order of every sheet. */
export const CANONICAL_COLUMNS = [
  'facility_name',
  'date_of_service',
  'hcpcs_code',
  'revenue_code',
  'patient_name',
  'member_id',
  'group_number',
  'employer_name',
  'charge_debit_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
  'payer_name',
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/**
 * Expected header text per position. The first entry accepts either year's
 * variant; the rest are identical across years. Used to FAIL LOUD if a sheet's
 * shape has drifted — silently mis-mapping PHI columns is far worse than
 * stopping.
 */
export const EXPECTED_HEADERS: ReadonlyArray<readonly string[]> = [
  ['Office Name', 'Facility Name'], // facility_name (header differs by year)
  ['Date of Service'],
  ['HCPCS Code'],
  ['Revenue Code'],
  ['Patient Name'],
  ['Member ID'],
  ['Group Number'],
  ['Employer Name'],
  ['Charge/Debit Amount'],
  ['Allowed Amount'],
  ['Paid Amount'],
  ['Adjustment'],
  ['Balance Due Pt'],
  ['Payer Name'],
];

/** A row's cell values keyed by canonical column name (verbatim strings). */
export type RawRow = Record<CanonicalColumn, string>;

/** One source sheet to ingest. */
export interface SheetSource {
  readonly year: number;
  readonly sheetId: string;
  /** Tab/range to read; all three sheets keep data in Sheet1. */
  readonly tab: string;
}

/**
 * A clean typed claim ready to insert into `claims`. Money fields are kept as
 * canonical numeric STRINGS (e.g. "-1660.05") so Postgres `numeric` does exact
 * arithmetic — never float. `null` means a genuinely blank source cell.
 */
export interface TypedClaim {
  claims_raw_id: number;
  source_year: number;
  facility_name: string;
  date_of_service: string; // ISO YYYY-MM-DD
  hcpcs_code: string | null;
  revenue_code: string | null;
  patient_name: string;
  patient_last: string;
  patient_first: string;
  member_id_raw: string | null;
  member_id_norm: string | null;
  group_number: string | null;
  employer_name: string | null;
  charge_amount: string | null;
  allowed_amount: string | null;
  paid_amount: string | null;
  adjustment: string | null;
  balance_due_pt: string | null;
  payer_name: string;
}

/**
 * One failed coercion. Written to the gitignored ./reports JSONL file — NEVER
 * to logs (raw_value may carry PHI). Shape is exactly as the spec mandates.
 */
export interface CoercionFailure {
  source_file_id: string;
  source_row_num: number;
  column: string;
  raw_value: string;
  reason: string;
}
