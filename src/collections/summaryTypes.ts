/**
 * Phase 7 — types for the read-only monthly collections summary.
 *
 * This summary is NON-PHI by construction: it aggregates only
 * `collections.daily_collections` (amounts/dates/facility_code) joined to
 * `collections.facilities` for a display name. It NEVER reads
 * `collections.collections_raw` (PHI-bearing, admin-only) or
 * `collections.payment_lines`, and it NEVER exposes `source_group_code`
 * (TREAT_FRCA / LSMH_DMH are lineage only — never a facility). A daily row whose
 * `facility_code` is NULL (group-code-only lineage) surfaces with a NULL
 * `facility_name`, rendered as `UNASSIGNED_FACILITY_LABEL`.
 */
import type { Expect, HasNoPhiKey } from '../queries/types.js';

/** Optional, non-PHI date bounds on `payment_date` (both 'YYYY-MM-DD'). */
export interface CollectionsSummaryArgs {
  /** Inclusive lower bound on payment_date. */
  from?: string;
  /** Exclusive upper bound on payment_date. */
  to?: string;
}

/** One (month × facility) bucket. Every field is non-PHI. */
export interface CollectionsMonthRow {
  /** Calendar month of payment_date, 'YYYY-MM'. */
  month: string;
  /**
   * The REAL facility code, or null for group-code-only lineage rows. This is
   * NEVER a `source_group_code` — the query selects `facility_code` only.
   */
  facility_code: string | null;
  /** Facility display name; null when facility_code is null/unmatched. */
  facility_name: string | null;
  /** Number of daily_collections rows aggregated into this bucket. */
  day_rows: number;
  checks_amount: number;
  eft_amount: number;
  gross_amount: number;
}

export interface CollectionsMonthlySummary {
  /** Echo of the applied bounds (non-PHI); null when unbounded. */
  from: string | null;
  to: string | null;
  /** Total daily_collections rows aggregated across all buckets. */
  rows_analyzed: number;
  by_month_facility: CollectionsMonthRow[];
}

/** Label for a daily row with no real facility_code (group-code-only lineage). */
export const UNASSIGNED_FACILITY_LABEL = '(unassigned)';

/**
 * Display name for a bucket. A NULL facility_code/name (the TREAT_FRCA /
 * LSMH_DMH source_group_code lineage, which is never a facility) renders as
 * `UNASSIGNED_FACILITY_LABEL`. Pure + node-free so both the React tile and the
 * unit tests can use it.
 */
export function facilityLabel(row: Pick<CollectionsMonthRow, 'facility_name'>): string {
  return row.facility_name ?? UNASSIGNED_FACILITY_LABEL;
}

// Compile-time proof the summary shapes carry no PHI key (defense in depth;
// these tables have no patient identifiers to begin with).
export type _CollectionsRowNoPhi = Expect<HasNoPhiKey<CollectionsMonthRow>>;
export type _CollectionsSummaryNoPhi = Expect<HasNoPhiKey<CollectionsMonthlySummary>>;
