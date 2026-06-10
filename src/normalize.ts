/**
 * Pure normalization functions. No I/O, no logging — fully unit-testable
 * against the documented dirty-data patterns. The orchestrator (ingest.ts)
 * composes these and decides what lands in `claims` vs the failure report.
 */
import type { CanonicalColumn, CoercionFailure, RawRow, TypedClaim } from './types.js';

export type Coerced<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Money: strip `$` and thousands `,`, preserve sign, parse to a canonical
 * fixed(2) numeric string. Blank -> null (valid). Order-independent removal of
 * `$`/`,` so BOTH sign placements parse identically: "$-1,660.05" and
 * "-$1,660.05" -> "-1660.05". Anything not a clean number fails.
 */
export function normalizeMoney(raw: string): Coerced<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  // Accept accounting-style parentheses negatives, e.g. "($1,660.05)".
  let s = trimmed;
  let parenNegative = false;
  if (/^\(.*\)$/.test(s)) {
    parenNegative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/\$/g, '').replace(/,/g, '').trim();
  if (parenNegative && !s.startsWith('-')) s = `-${s}`;

  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: `unparseable money value: ${JSON.stringify(raw)}` };
  }

  // Normalize to two decimals, exact (string math, no float rounding surprises
  // beyond the final fixed(2) the column already enforces).
  const num = Number(s);
  if (!Number.isFinite(num)) {
    return { ok: false, reason: `non-finite money value: ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: num.toFixed(2) };
}

/**
 * Date of service: accept `M/D/YYYY` and `MM/DD/YYYY`; emit ISO `YYYY-MM-DD`.
 * Validates a real calendar date (rejects 2/30, month 13, etc.). Blank or any
 * other format fails — never string-compared, never locale-guessed.
 */
export function normalizeDate(raw: string): Coerced<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!m) {
    return { ok: false, reason: `unparseable date (expected M/D/YYYY): ${JSON.stringify(raw)}` };
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: `date out of range: ${JSON.stringify(raw)}` };
  }
  // Confirm the day exists in that month (handles Feb/short months + leap years).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, reason: `invalid calendar date: ${JSON.stringify(raw)}` };
  }

  const iso = `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return { ok: true, value: iso };
}

/** HCPCS / Revenue code: blank -> null (NOT empty string). Never fails. */
export function normalizeCode(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Optional free text (group_number, employer_name): blank -> null. */
export function normalizeOptionalText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Split `LAST, FIRST` on the FIRST comma. No comma -> whole string is the last
 * name, first name is empty (both remain non-null to satisfy NOT NULL).
 */
export function splitPatientName(patientName: string): { last: string; first: string } {
  const idx = patientName.indexOf(',');
  if (idx === -1) return { last: patientName.trim(), first: '' };
  return {
    last: patientName.slice(0, idx).trim(),
    first: patientName.slice(idx + 1).trim(),
  };
}

/**
 * Member ID: keep raw (trimmed), and a normalized form = upper-cased with a
 * single leading `-` removed (absolute value for later matching).
 *   "-11724767" -> norm "11724767"; "PGE081" -> "PGE081"; " pge081 " -> "PGE081".
 * Blank -> both null.
 */
export function normalizeMemberId(raw: string): { raw: string | null; norm: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { raw: null, norm: null };
  const norm = trimmed.toUpperCase().replace(/^-/, '');
  return { raw: trimmed, norm };
}

/** Money columns share one coercion path. */
const MONEY_COLUMNS: readonly CanonicalColumn[] = [
  'charge_debit_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
];

/** Required (NOT NULL) canonical text columns that must be present & non-blank. */
const REQUIRED_TEXT_COLUMNS: readonly CanonicalColumn[] = ['facility_name', 'patient_name', 'payer_name'];

export type CoerceResult =
  | { ok: true; claim: Omit<TypedClaim, 'claims_raw_id'> }
  | { ok: false; failures: CoercionFailure[] };

/**
 * Turn a verbatim RawRow into a clean typed claim, or a list of coercion
 * failures. ALL failing columns in the row are collected (so the report is
 * complete), and ANY failure means the row is skipped from `claims` — it can
 * no longer produce a clean typed row. Blank money/codes/optional-text are
 * valid (-> NULL); blank required text or date is a failure.
 */
export function coerceRow(
  row: RawRow,
  ctx: { source_file_id: string; source_row_num: number; source_year: number },
): CoerceResult {
  const failures: CoercionFailure[] = [];
  const fail = (column: string, raw_value: string, reason: string) =>
    failures.push({
      source_file_id: ctx.source_file_id,
      source_row_num: ctx.source_row_num,
      column,
      raw_value,
      reason,
    });

  // Required text fields must be present and non-blank.
  for (const col of REQUIRED_TEXT_COLUMNS) {
    if (row[col].trim() === '') fail(col, row[col], 'required field is blank');
  }

  // Date (required).
  let isoDate: string | null = null;
  const date = normalizeDate(row.date_of_service);
  if (!date.ok) fail('date_of_service', row.date_of_service, date.reason);
  else if (date.value === null) fail('date_of_service', row.date_of_service, 'required field is blank');
  else isoDate = date.value;

  // Money fields (optional; blank -> null).
  const money: Partial<Record<CanonicalColumn, string | null>> = {};
  for (const col of MONEY_COLUMNS) {
    const r = normalizeMoney(row[col]);
    if (!r.ok) fail(col, row[col], r.reason);
    else money[col] = r.value;
  }

  if (failures.length > 0) return { ok: false, failures };

  const name = splitPatientName(row.patient_name.trim());
  const member = normalizeMemberId(row.member_id);

  const claim: Omit<TypedClaim, 'claims_raw_id'> = {
    source_year: ctx.source_year,
    facility_name: row.facility_name.trim(),
    // Non-null here: any null/failed date pushed a failure and we returned above.
    date_of_service: isoDate as string,
    hcpcs_code: normalizeCode(row.hcpcs_code),
    revenue_code: normalizeCode(row.revenue_code),
    patient_name: row.patient_name.trim(),
    patient_last: name.last,
    patient_first: name.first,
    member_id_raw: member.raw,
    member_id_norm: member.norm,
    group_number: normalizeOptionalText(row.group_number),
    employer_name: normalizeOptionalText(row.employer_name),
    charge_amount: money.charge_debit_amount ?? null,
    allowed_amount: money.allowed_amount ?? null,
    paid_amount: money.paid_amount ?? null,
    adjustment: money.adjustment ?? null,
    balance_due_pt: money.balance_due_pt ?? null,
    payer_name: row.payer_name.trim(),
  };

  return { ok: true, claim };
}
