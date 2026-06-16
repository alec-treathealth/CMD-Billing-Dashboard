/**
 * Shared types for the Phase 2 query-function library.
 *
 * The PHI boundary is enforced in the type system: every function returns a
 * non-PHI `summary_stats` (agent-visible) plus an opaque `query_id`. PHI result
 * rows are NEVER part of that return — they are re-fetched later via the results
 * route keyed by query_id. `NoPhi<T>` makes a summary that carries a PHI key fail
 * to typecheck.
 */

/** Identity / PHI fields that must NEVER appear as a key in any summary_stats. */
export type PhiKey =
  | 'patient_name'
  | 'patient_first'
  | 'patient_last'
  | 'member_id_raw'
  | 'member_id_norm'
  | 'group_number'
  | 'employer_name';

/**
 * Compile-time guard: `NoPhi<T>` is `T` when T has no PHI key, else `never`.
 * A function declared `Promise<QueryResult<NoPhi<S>>>` therefore fails to
 * typecheck if S ever gains a PHI-named key (summary_stats collapses to `never`,
 * so the real object can't be assigned).
 */
export type NoPhi<T> = Extract<keyof T, PhiKey> extends never ? T : never;

/**
 * Standalone compile-time assertions (non-circular). `HasNoPhiKey<T>` is `true`
 * iff T has no PHI-named key; `Expect<T extends true>` raises a compile error
 * unless T is exactly `true`. So `type _ = Expect<HasNoPhiKey<SomeSummary>>`
 * fails to compile the moment SomeSummary gains a PHI key.
 */
export type HasNoPhiKey<T> = [Extract<keyof T, PhiKey>] extends [never] ? true : false;
export type Expect<T extends true> = T;

export type FunctionName =
  | 'distribution'
  | 'payer_gap_analysis'
  | 'search_claims'
  | 'client_history'
  | 'readmission_candidates';

/** The two-shape return: a non-PHI summary + an opaque handle. */
export interface QueryResult<S> {
  summary_stats: S;
  query_id: string;
}

export interface ExecResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal DB seam. The real implementation runs parameterized SQL as
 * claims_reader; fixtures inject a fake so summary_stats shaping is tested with
 * deterministic rows and no live database.
 */
export interface QueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<ExecResult<T>>;
}

/** Per-call context. The injectables (uuid/now/audit) keep functions deterministic in tests. */
export interface QueryContext {
  /** Connected as claims_reader (CLAIMS_READER_DATABASE_URL). */
  executor: QueryExecutor;
  /** Session/user identifier for the audit trail — NEVER PHI. */
  createdBy: string;
  uuid?: () => string;
  now?: () => Date;
  /** Audit sink; defaults to one JSON line on stdout. */
  audit?: (line: string) => void;
}

/** Filter shared by the aggregation functions. All fields are non-PHI (allowlisted). */
export interface ClaimFilter {
  facility?: string;
  payer?: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string; // YYYY-MM-DD
  source_year?: number;
  hcpcs_code?: string;
  revenue_code?: string;
  /**
   * The synthetic, internal-only surrogate row key (claims.claims.id). NOT PHI —
   * it is a generated bigint, the same handle already used as the explorer's
   * non-PHI row key and the /claims/[claimId] route param. Used to scope an
   * audited reveal to exactly one claim (Phase 8.0); it is NOT exposed in the
   * agent tool schema, so the model can never set it.
   */
  id?: number;
}

// ---------------------------------------------------------------------------
// distribution
// ---------------------------------------------------------------------------

export type DistributionField =
  | 'facility_name'
  | 'payer_name'
  | 'hcpcs_code'
  | 'revenue_code'
  | 'source_year';

export type DistributionMetric =
  | 'count'
  | 'total_charge'
  | 'total_paid'
  | 'avg_collection_rate';

export interface DistributionArgs {
  field: DistributionField;
  metric: DistributionMetric;
  filter?: ClaimFilter;
}

export interface DistributionBucket {
  /** The grouped value (cast to text; null = the NULL group, e.g. blank hcpcs_code). */
  value: string | null;
  /** The metric for this bucket; null when the aggregate is undefined (e.g. avg over all-null rates). */
  metric_value: number | null;
  /** Share of the summed metric across buckets, %, 2 d.p.; null when not computable. */
  pct_of_total: number | null;
}

export interface DistributionSummary {
  field: DistributionField;
  metric: DistributionMetric;
  buckets: DistributionBucket[];
}

// ---------------------------------------------------------------------------
// payer_gap_analysis
// ---------------------------------------------------------------------------

export interface PayerGapArgs {
  filter?: ClaimFilter;
}

export interface PayerGapRow {
  /** Grouped payer (null = the NULL-payer group). NOT PHI — payer is allowlisted. */
  payer_name: string | null;
  claim_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  /** avg(collection_rate); null when no row in the group has a representable rate. */
  avg_collection_rate: number | null;
  /** sum(charge_amount - allowed_amount) — contractual write-down. */
  total_write_down: number;
  /** sum(charge_amount - paid_amount) — real collection shortfall. */
  total_collection_gap: number;
}

export interface PayerGapSummary {
  rows_analyzed: number;
  by_payer: PayerGapRow[];
}

// ---------------------------------------------------------------------------
// search_claims
// ---------------------------------------------------------------------------

export interface SearchClaimsArgs {
  filter?: ClaimFilter;
}

/**
 * Flat aggregate over the filtered slice — no grouping, no rows. Every field is
 * a non-PHI aggregate; the matching PHI rows are fetched later via query_id.
 */
export interface SearchClaimsSummary {
  /** Number of claims matching the filter (also how many rows the results route returns). */
  rows_matched: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  /** avg(collection_rate); null when no matched row has a representable rate. */
  avg_collection_rate: number | null;
  /**
   * Matched rows with paid & allowed both present but collection_rate NULL —
   * the payer/policy-gap signal (a non-representable rate, not "missing").
   */
  rate_anomaly_count: number;
  /** min/max date_of_service over the matched set, 'YYYY-MM-DD'; null when empty. */
  date_from: string | null;
  date_to: string | null;
  distinct_facilities: number;
  distinct_payers: number;
}

// ---------------------------------------------------------------------------
// client_history
// ---------------------------------------------------------------------------

export interface ClientHistoryArgs {
  /** PHI VALUE — used as a bound query parameter only; never stored or logged. */
  patient_last: string;
  /** Optional PHI VALUE to narrow the match; never stored or logged (presence flag only). */
  member_id_norm?: string;
  /** Non-PHI additional filter. */
  filter?: ClaimFilter;
}

/** Per-year roll-up of a client's matched claims. All fields are non-PHI aggregates. */
export interface ClientHistoryYearBucket {
  source_year: number;
  claim_count: number;
  distinct_facilities: number;
  distinct_payers: number;
  total_charge: number;
  total_paid: number;
  avg_collection_rate: number | null;
  date_from: string | null;
  date_to: string | null;
}

export interface ClientHistorySummary {
  /** Total claims matched (sum across year buckets); the count behind the query_id. */
  rows_matched: number;
  /** The pg_trgm similarity threshold applied to patient_last. */
  match_threshold: number;
  by_source_year: ClientHistoryYearBucket[];
}

// ---------------------------------------------------------------------------
// readmission_candidates
// ---------------------------------------------------------------------------

export interface ReadmissionCandidatesArgs {
  facility?: string;
  payer?: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string; // YYYY-MM-DD
  /** Max days between the two claims' service dates. Default 30; bounded [1, 365]. */
  gap_days?: number;
}

export interface ReadmissionConfidenceCounts {
  exact: number;
  strong: number;
  possible: number;
}

export interface ReadmissionSummary {
  candidate_pairs: number;
  by_confidence: ReadmissionConfidenceCounts;
  /** Distinct facilities appearing among the candidate pairs (allowlisted, non-PHI). */
  facilities: string[];
  /** Distinct payers appearing among the candidate pairs (allowlisted, non-PHI). */
  payers: string[];
}

/**
 * The closed set of agent-visible summary shapes. Grows as each function lands.
 * Every member is proven PHI-free below.
 */
export type SummaryStats =
  | DistributionSummary
  | PayerGapSummary
  | SearchClaimsSummary
  | ClientHistorySummary
  | ReadmissionSummary;

// Compile-time proof each summary is PHI-free (errors here if a PHI key slips in).
export type _DistributionNoPhi = Expect<HasNoPhiKey<DistributionSummary>>;
export type _PayerGapNoPhi = Expect<HasNoPhiKey<PayerGapSummary>>;
export type _SearchClaimsNoPhi = Expect<HasNoPhiKey<SearchClaimsSummary>>;
export type _ClientHistoryNoPhi = Expect<HasNoPhiKey<ClientHistorySummary>>;
// The year bucket is part of the summary; assert it too.
export type _ClientHistoryBucketNoPhi = Expect<HasNoPhiKey<ClientHistoryYearBucket>>;
export type _ReadmissionNoPhi = Expect<HasNoPhiKey<ReadmissionSummary>>;
