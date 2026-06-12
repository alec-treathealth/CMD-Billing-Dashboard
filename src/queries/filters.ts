/**
 * ClaimFilter validation + parameterized WHERE construction, shared by the
 * aggregation functions (distribution, payer_gap_analysis, search_claims).
 *
 * Security: column names are FIXED literals; only values become $n parameters.
 * Placeholder numbers are generated from a counter, never from caller input.
 * Inputs are validated and bounded at this boundary (length caps, date format,
 * year range) before any SQL is built.
 */
import type { ClaimFilter } from './types.js';

const MAX_TEXT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkText(label: string, raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(`filter.${label} must be a string`);
  if (raw.length > MAX_TEXT) throw new Error(`filter.${label} exceeds ${MAX_TEXT} chars`);
  return raw.trim();
}

function checkDate(label: string, raw: unknown): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
    throw new Error(`filter.${label} must be a YYYY-MM-DD date`);
  }
  return raw;
}

/**
 * Validate + normalize a filter at the boundary. Returns only the keys that are
 * present and non-empty after trimming; throws on malformed input.
 */
export function validateClaimFilter(filter: ClaimFilter | undefined): ClaimFilter {
  const f: ClaimFilter = {};
  if (filter === undefined) return f;

  if (filter.facility !== undefined) {
    const v = checkText('facility', filter.facility);
    if (v) f.facility = v;
  }
  if (filter.payer !== undefined) {
    const v = checkText('payer', filter.payer);
    if (v) f.payer = v;
  }
  if (filter.date_from !== undefined) f.date_from = checkDate('date_from', filter.date_from);
  if (filter.date_to !== undefined) f.date_to = checkDate('date_to', filter.date_to);
  if (filter.source_year !== undefined) {
    const y = filter.source_year;
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new Error('filter.source_year must be an integer in [2000, 2100]');
    }
    f.source_year = y;
  }
  if (filter.hcpcs_code !== undefined) {
    const v = checkText('hcpcs_code', filter.hcpcs_code);
    if (v) f.hcpcs_code = v;
  }
  if (filter.revenue_code !== undefined) {
    const v = checkText('revenue_code', filter.revenue_code);
    if (v) f.revenue_code = v;
  }
  return f;
}

/**
 * Build a parameterized WHERE fragment (no leading `where`) from a validated
 * filter, numbering placeholders from `startIndex`. Returns an empty clause when
 * the filter is empty.
 */
export function buildClaimFilter(
  filter: ClaimFilter,
  startIndex: number,
): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  if (filter.facility !== undefined) {
    conds.push(`lower(facility_name) = lower($${i++})`);
    params.push(filter.facility);
  }
  if (filter.payer !== undefined) {
    conds.push(`lower(payer_name) = lower($${i++})`);
    params.push(filter.payer);
  }
  if (filter.date_from !== undefined) {
    conds.push(`date_of_service >= $${i++}`);
    params.push(filter.date_from);
  }
  if (filter.date_to !== undefined) {
    conds.push(`date_of_service <= $${i++}`);
    params.push(filter.date_to);
  }
  if (filter.source_year !== undefined) {
    conds.push(`source_year = $${i++}`);
    params.push(filter.source_year);
  }
  if (filter.hcpcs_code !== undefined) {
    conds.push(`lower(hcpcs_code) = lower($${i++})`);
    params.push(filter.hcpcs_code);
  }
  if (filter.revenue_code !== undefined) {
    conds.push(`lower(revenue_code) = lower($${i++})`);
    params.push(filter.revenue_code);
  }

  return { clause: conds.join(' and '), params };
}
