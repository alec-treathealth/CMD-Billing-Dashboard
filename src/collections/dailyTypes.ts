/**
 * Phase 7.1 — types for Catherine's daily collections views (read-only, non-PHI).
 *
 * All shapes aggregate/scan ONLY collections.daily_collections joined to
 * collections.facilities. They never read collections_raw or payment_lines, and
 * never expose source_group_code (TREAT_FRCA / LSMH_DMH are lineage only). A NULL
 * facility_code renders as `UNASSIGNED_FACILITY_LABEL` (see summaryTypes).
 *
 * IP vs OP and "IP Billing Amt = IP MTD × 6%" are DEFERRED in this slice: the
 * in-scope typed tables carry no inpatient/outpatient classification (that lives
 * only in the BXR IP/OP rollup grids). No IP/OP key appears in any type here.
 */
import type { Expect, HasNoPhiKey } from '../queries/types.js';

// ---------------------------------------------------------------------------
// collectionsDaily — granular daily rows
// ---------------------------------------------------------------------------

export interface CollectionsDailyArgs {
  /** Exact facility_code filter (non-PHI dimension), e.g. 'CAMH'. */
  facility_code?: string;
  /** Inclusive lower bound on payment_date, 'YYYY-MM-DD'. */
  from?: string;
  /** Exclusive upper bound on payment_date, 'YYYY-MM-DD'. */
  to?: string;
}

export interface CollectionsDailyRow {
  /** 'YYYY-MM-DD'. */
  payment_date: string;
  facility_code: string | null;
  facility_name: string | null;
  checks_amount: number;
  eft_amount: number;
  gross_amount: number;
}

export interface CollectionsDailyResult {
  /** Echo of the effective window actually queried (non-PHI); null when open. */
  from: string | null;
  to: string | null;
  /** Echo of the facility filter, or null. */
  facility_code: string | null;
  row_count: number;
  rows: CollectionsDailyRow[];
}

// ---------------------------------------------------------------------------
// collectionsKpis — MTD/YTD by facility + overall, anchored to an "as of" date
// ---------------------------------------------------------------------------

export interface CollectionsKpisArgs {
  /** Anchor date 'YYYY-MM-DD'; defaults to max(payment_date) in the data. */
  as_of?: string;
}

export interface CollectionsAmounts {
  checks: number;
  eft: number;
  gross: number;
}

export interface CollectionsFacilityKpi {
  facility_code: string | null;
  facility_name: string | null;
  mtd_checks: number;
  mtd_eft: number;
  mtd_gross: number;
  ytd_checks: number;
  ytd_eft: number;
  ytd_gross: number;
}

export interface CollectionsKpis {
  /** The anchor date used for MTD/YTD windows; null when the data is empty. */
  as_of: string | null;
  /** Overall month-to-(as_of) totals. */
  mtd: CollectionsAmounts;
  /** Overall year-to-(as_of) totals. */
  ytd: CollectionsAmounts;
  by_facility: CollectionsFacilityKpi[];
}

// Compile-time proofs: no PHI key in any output shape.
export type _DailyRowNoPhi = Expect<HasNoPhiKey<CollectionsDailyRow>>;
export type _DailyResultNoPhi = Expect<HasNoPhiKey<CollectionsDailyResult>>;
export type _FacilityKpiNoPhi = Expect<HasNoPhiKey<CollectionsFacilityKpi>>;
export type _KpisNoPhi = Expect<HasNoPhiKey<CollectionsKpis>>;
