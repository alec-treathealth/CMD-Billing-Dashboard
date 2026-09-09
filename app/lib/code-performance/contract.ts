/**
 * Code Performance — the CLIENT-SAFE contract: types the UI renders, the input shapes the Server
 * Actions accept, and the small clamps both sides share. No server imports. Runtime helpers come from
 * the pure src module (client components already import from ../../../src elsewhere in this app).
 *
 * Tenant model: this surface is ONE tenant at a time — pairings are never mixed across tenants because
 * code conventions differ (Indigo welds level-of-care onto the CPT; BXR does not). "Consolidated" is
 * therefore not a value here. The tenant is a display hint from the client; the Server Action clamps
 * it against the session's entitlement (principal.ts) and scopes by the CLAMPED tenant.
 */
import {
  CODE_PERF_WINDOWS,
  type CodePerfFlag,
  type CodePerfPairKey,
  type CodePerfPairingRow,
  type CodePerfWindow,
  type GatedMetric,
} from '../../../src/collections/codePerformanceQuery.js';

export type { CodePerfFlag, CodePerfPairKey, CodePerfPairingRow, CodePerfWindow, GatedMetric };
export { CODE_PERF_WINDOWS };

export type CodePerfTenant = 'bxr' | 'indigo';
export const CODE_PERF_TENANTS: readonly CodePerfTenant[] = ['bxr', 'indigo'];
export const CODE_PERF_TENANT_LABEL: Record<CodePerfTenant, string> = {
  bxr: 'BXR Consulting',
  indigo: 'Indigo Billing',
};

/** What the client sends for the board. Every field is re-validated server-side. */
export interface CodePerfBoardInput {
  tenant: CodePerfTenant;
  window: CodePerfWindow;
  /** null = all facilities. */
  facilities: string[] | null;
}

/** What the client sends for one pairing's drill-down (lazy-loaded; never in the board payload). */
export interface CodePerfPairInput extends CodePerfBoardInput {
  pair: CodePerfPairKey;
}

export interface CodePerfSummary {
  charges: number;
  pairings: number;
  facilities: number;
  payers: number;
  no_procedure_code_charges: number;
  no_revenue_code_charges: number;
  billed: number;
  collected: number;
  allowed_coverage: number | null;
  allowed_rate: number | null;
  paid_of_allowed: number | null;
  underpaid_dollars: number | null;
  days_p50: number | null;
  days_p90: number | null;
  pct_zero_paid: number | null;
  matured_share: number | null;
  write_off_rate: GatedMetric;
  patient_balance_rate: GatedMetric;
}

export interface CodePerfFacilityOption {
  /** CMD display text; null only if the rollup ever carries a NULL facility (none observed). */
  facility: string | null;
  charges: number;
  billed: number;
}

/** Per-tenant freshness — drives incomplete-month shading and the Indigo future-payment notice. */
export interface CodePerfFreshness {
  businessToday: string | null;
  maxIngestedAt: string | null;
  maxChargeDate: string | null;
  maxPaymentReceived: string | null;
  futurePaymentCharges: number;
  /** business_today − max(charge_date), in days; how far the charge feed lags. */
  chargeLagDays: number | null;
}

export type CodeType = 'CPT' | 'HCPCS' | 'REV' | 'OTHER';

export interface CodeDescription {
  codeType: CodeType;
  code: string;
  shortLabel: string;
  longDescription: string | null;
  priorDescription: string | null;
  sourceCitation: string | null;
  provenance: string;
  needsReview: boolean;
  descriptionConflict: boolean;
  tenantOverride: boolean;
}

/** Lookup key: procedure-slot values (CPT / HCPCS / OTHER) vs revenue codes (REV) — 038's rule. */
export type CodeSlotKind = 'procedure' | 'revenue';
export function descriptionKey(kind: CodeSlotKind, code: string): string {
  return `${kind}:${code}`;
}
export type CodeDescriptionMap = Record<string, CodeDescription>;

export interface CodePerfBoard {
  tenant: CodePerfTenant;
  window: CodePerfWindow;
  windowDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  facilitiesApplied: string[] | null;
  summary: CodePerfSummary;
  /** Window-level maturity guard: true when matured_share < 60% (yield columns de-emphasised). */
  immatureWindow: boolean;
  rows: CodePerfPairingRow[];
  facilityOptions: CodePerfFacilityOption[];
  freshness: CodePerfFreshness;
  descriptions: CodeDescriptionMap;
}

interface CodePerfMetricRow {
  charges: number;
  billed: number;
  collected: number;
  allowed_coverage: number | null;
  allowed_rate: number | null;
  paid_of_allowed: number | null;
  underpaid_dollars: number | null;
  days_p50: number | null;
  days_p90: number | null;
  pct_zero_paid: number | null;
  matured_share: number | null;
  write_off_rate: GatedMetric;
  patient_balance_rate: GatedMetric;
}

export interface CodePerfPayerRow extends CodePerfMetricRow {
  /** RAW, unaliased CMD payer string — one carrier appears on several rows. */
  payer_raw: string | null;
  share_of_billed: number | null;
}

export interface CodePerfFacilityRow extends CodePerfMetricRow {
  facility: string | null;
  rated: boolean;
}

export interface CodePerfMonthRow {
  /** First day of the month, YYYY-MM-DD. */
  month: string;
  charges: number;
  billed: number;
  collected: number;
  allowed_rate: number | null;
  allowed_coverage: number | null;
  matured_share: number | null;
  /** TRUE when the month is at/after the tenant's max(charge_date) month — feed not complete. */
  incomplete: boolean;
}

export interface CodePerfPairDetail {
  pair: CodePerfPairKey;
  payers: CodePerfPayerRow[];
  facilities: CodePerfFacilityRow[];
  /** Facilities excluded from the outlier view for having < 30 charges in the pairing. */
  belowFloor: number;
  monthly: CodePerfMonthRow[];
}

export type CodePerfBoardResult =
  | { ok: true; board: CodePerfBoard }
  | { ok: false; reason: 'forbidden' | 'error' };

export type CodePerfPairResult =
  | { ok: true; detail: CodePerfPairDetail }
  | { ok: false; reason: 'forbidden' | 'error' };
