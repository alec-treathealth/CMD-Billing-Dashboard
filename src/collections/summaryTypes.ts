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
  /** Owning tenant (business_entity_id) — drives the Consolidated By-Facility tenant
   *  filter/color split. Always present (the query groups by it); non-PHI. */
  business_entity_id: string;
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

/**
 * The OVERVIEW tab's name for the same bucket (Alec, 2026-08-10): "'No Facility' label or
 * container shouldn't exist, this should be called 'Interest Payments/Other'".
 *
 * WHY A SECOND CONSTANT INSTEAD OF RENAMING THE FIRST. `facilityLabel` is shared with the
 * Collections tab (app/components/dashboard/collections.tsx, 7 call sites), and that tab is
 * explicitly out of scope for this change. Renaming `UNASSIGNED_FACILITY_LABEL` would silently
 * restyle a surface nobody asked to touch — and on Collections the bucket genuinely IS
 * group-code lineage (TREAT_FRCA / LSMH_DMH), for which "(unassigned)" is the accurate word
 * and "Interest Payments" would be a lie.
 *
 * ⚠️ THIS IS A DISPLAY NAME, NOT A CLASSIFIER. Nothing here decides that a row is interest;
 * it names the bucket a row falls into when it has no facility and no care setting. CMD's
 * interest lines (cpt_code INT / INTRST) live at CHARGE grain in cmd_explorer_rows, and the
 * deposit rows this label renders carry no CPT at all — so a row shown under this label may be
 * interest, may be group-code lineage, may be an unmapped facility. The "/Other" half of the
 * name is doing real work: do not shorten it to "Interest Payments".
 */
export const OTHER_FACILITY_LABEL = 'Interest Payments/Other';

/** `facilityLabel` with the Overview tab's wording for the no-facility bucket. */
export function overviewFacilityLabel(row: Pick<CollectionsMonthRow, 'facility_name'>): string {
  return row.facility_name ?? OTHER_FACILITY_LABEL;
}

// Compile-time proof the summary shapes carry no PHI key (defense in depth;
// these tables have no patient identifiers to begin with).
export type _CollectionsRowNoPhi = Expect<HasNoPhiKey<CollectionsMonthRow>>;
export type _CollectionsSummaryNoPhi = Expect<HasNoPhiKey<CollectionsMonthlySummary>>;
