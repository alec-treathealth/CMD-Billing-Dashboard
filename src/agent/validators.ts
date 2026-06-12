/**
 * Boundary validation of the model's tool input. The model's output is
 * UNTRUSTED: before any dispatch we coerce its raw JSON into the typed args of
 * the chosen query function, rejecting malformed shapes. This is defense in
 * depth — the query functions validate again internally (enum allowlists,
 * `validateClaimFilter`, `validateGapDays`), but nothing reaches a function
 * without passing here first.
 *
 * We deliberately do NOT trust the tool's JSON-schema to have constrained the
 * model; the schema is a hint, this is the control.
 */
import { validateClaimFilter } from '../queries/filters.js';
import type {
  ClaimFilter,
  ClientHistoryArgs,
  DistributionArgs,
  DistributionField,
  DistributionMetric,
  PayerGapArgs,
  ReadmissionCandidatesArgs,
  SearchClaimsArgs,
} from '../queries/types.js';

const DISTRIBUTION_FIELDS: readonly DistributionField[] = [
  'facility_name',
  'payer_name',
  'hcpcs_code',
  'revenue_code',
  'source_year',
];
const DISTRIBUTION_METRICS: readonly DistributionMetric[] = [
  'count',
  'total_charge',
  'total_paid',
  'avg_collection_rate',
];

function asObject(input: unknown, tool: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${tool}: tool input must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

/** Coerce + validate the optional `filter` field. Reuses the query library's validator. */
function coerceFilter(raw: unknown, tool: string): ClaimFilter | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${tool}: filter must be an object`);
  }
  // validateClaimFilter type-checks each field and throws on malformed input.
  return validateClaimFilter(raw as ClaimFilter);
}

function requireString(o: Record<string, unknown>, key: string, tool: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`${tool}: ${key} must be a string`);
  return v;
}

function optionalString(o: Record<string, unknown>, key: string, tool: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${tool}: ${key} must be a string`);
  return v;
}

export function validateDistribution(input: unknown): DistributionArgs {
  const o = asObject(input, 'distribution');
  const field = o.field;
  const metric = o.metric;
  if (!DISTRIBUTION_FIELDS.includes(field as DistributionField)) {
    throw new Error(`distribution: field must be one of ${DISTRIBUTION_FIELDS.join(', ')}`);
  }
  if (!DISTRIBUTION_METRICS.includes(metric as DistributionMetric)) {
    throw new Error(`distribution: metric must be one of ${DISTRIBUTION_METRICS.join(', ')}`);
  }
  return {
    field: field as DistributionField,
    metric: metric as DistributionMetric,
    filter: coerceFilter(o.filter, 'distribution'),
  };
}

export function validatePayerGap(input: unknown): PayerGapArgs {
  const o = asObject(input, 'payer_gap_analysis');
  return { filter: coerceFilter(o.filter, 'payer_gap_analysis') };
}

export function validateSearchClaims(input: unknown): SearchClaimsArgs {
  const o = asObject(input, 'search_claims');
  return { filter: coerceFilter(o.filter, 'search_claims') };
}

export function validateClientHistory(input: unknown): ClientHistoryArgs {
  const o = asObject(input, 'client_history');
  // PHI VALUES — validated here, used only as bound query params downstream.
  const patient_last = requireString(o, 'patient_last', 'client_history');
  if (patient_last.trim().length === 0) {
    throw new Error('client_history: patient_last must be non-empty');
  }
  return {
    patient_last,
    member_id_norm: optionalString(o, 'member_id_norm', 'client_history'),
    filter: coerceFilter(o.filter, 'client_history'),
  };
}

export function validateReadmissionCandidates(input: unknown): ReadmissionCandidatesArgs {
  const o = asObject(input, 'readmission_candidates');
  const gap = o.gap_days;
  if (gap !== undefined && gap !== null && typeof gap !== 'number') {
    throw new Error('readmission_candidates: gap_days must be a number');
  }
  return {
    facility: optionalString(o, 'facility', 'readmission_candidates'),
    payer: optionalString(o, 'payer', 'readmission_candidates'),
    date_from: optionalString(o, 'date_from', 'readmission_candidates'),
    date_to: optionalString(o, 'date_to', 'readmission_candidates'),
    gap_days: gap === undefined || gap === null ? undefined : (gap as number),
  };
}
