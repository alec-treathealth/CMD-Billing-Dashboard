/**
 * CMS Alpha-Numeric HCPCS file — record layout + behavioral-health relevance config.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ VERIFY BEFORE FIRST PRODUCTION RUN. The column offsets below are the SINGLE
 * source of truth for the fixed-width parser (parse.ts). CMS distributes the
 * quarterly file with a companion "HCPCS Record Layout" document
 * (https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/
 * alpha-numeric → the "<year> HCPCS Record Layout" ZIP). A maintainer MUST confirm
 * these 1-based, inclusive column ranges against the record-layout PDF for the
 * TARGET year before enabling the job, and adjust as needed. Offsets have been
 * stable for years but CMS can revise them. The parser MECHANISM is unit-tested;
 * these offsets are reviewed configuration, not tested truth. See AUDIT.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Only the fields the change-detector needs are declared. The full ANWEB record is
 * much wider (coverage/pricing/action indicators, multiple date fields); we read
 * code + descriptions + one effective/added date and derive all change signals by
 * DIFFING against our own prior snapshot (diff.ts) rather than trusting any embedded
 * action flag — the quarterly file is a full active-set snapshot, not a delta.
 */

/** A 1-based, inclusive [start, end] column range into a fixed-width line. */
export interface FixedWidthField {
  readonly start: number;
  readonly end: number;
}

export interface HcpcsRecordLayout {
  /** Lines shorter than this are treated as non-data (headers/footers) and skipped. */
  readonly minLineLength: number;
  readonly code: FixedWidthField;
  readonly longDesc: FixedWidthField;
  readonly shortDesc: FixedWidthField;
  /** Optional YYYYMMDD "added/effective" date column; omit if the target layout lacks it. */
  readonly effectiveDate?: FixedWidthField;
}

/**
 * Best-known ANWEB layout. TREAT AS A DEFAULT TO VERIFY, not gospel (see banner).
 * Ranges are 1-based inclusive to match how CMS documents the record layout.
 */
export const HCPCS_RECORD_LAYOUT: HcpcsRecordLayout = {
  minLineLength: 11,
  code: { start: 1, end: 5 },
  longDesc: { start: 12, end: 91 },
  shortDesc: { start: 92, end: 119 },
  effectiveDate: { start: 236, end: 243 }, // YYYYMMDD "action effective date", if present
};

/**
 * Behavioral-health / RTC relevance filter for HCPCS Level II codes.
 *
 * Applied to HCPCS ONLY. Revenue codes are NUBC-maintained and are NOT present in the
 * CMS HCPCS file — they are out of scope for this sync (see AUDIT.md). Prefixes cover
 * the H (mental health / SUD services), a curated set of S (non-Medicare BH services),
 * T (state Medicaid BH), and specific G group-psychotherapy codes seen in RTC billing.
 */
export const BH_HCPCS_PREFIXES: readonly string[] = ['H0', 'H1', 'H2', 'S9', 'T20', 'T21'];

/** Explicit codes to always include even if a prefix rule misses them. */
export const BH_HCPCS_EXPLICIT: ReadonlySet<string> = new Set<string>([
  'G0410', // group psychotherapy in a PHP, 45–50 min
  'G0411', // interactive group psychotherapy in a PHP
  'G2086',
  'G2087',
  'G2088', // office-based opioid use disorder treatment bundles
  '90791',
  '90792', // psychiatric diagnostic evaluation (CPT, tracked if present)
]);
