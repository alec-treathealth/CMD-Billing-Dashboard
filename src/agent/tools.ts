/**
 * Anthropic tool definitions — one per vetted query function. The input schema
 * of each mirrors that function's args type (`DistributionArgs`, `PayerGapArgs`,
 * `SearchClaimsArgs`, `ClientHistoryArgs`, `ReadmissionCandidatesArgs`).
 *
 * These schemas ARE the closed allowlist the model picks from: the agent never
 * lets the model write SQL, only choose a tool + fill its typed inputs. The
 * runtime validators in `validators.ts` re-check the model's output at the
 * dispatch boundary (the schema is a hint to the model, not a security control).
 *
 * `client_history` is the only tool whose input carries PHI (patient_last,
 * member_id_norm). Those values are passed to the QUERY as bound params and are
 * NEVER echoed back into the model transcript and NEVER logged (see agent.ts /
 * logging.ts). The tool RESULT the model sees is `{ summary_stats, query_id }`
 * only — identity fields are never reflected back.
 */
import type { FunctionName } from '../queries/types.js';
import type { ToolDef } from './client.js';

/** The closed set of tool names = the five function names. */
export const TOOL_NAMES: readonly FunctionName[] = [
  'distribution',
  'payer_gap_analysis',
  'search_claims',
  'client_history',
  'readmission_candidates',
];

/** Shared non-PHI filter schema (mirrors `ClaimFilter`). */
const CLAIM_FILTER_SCHEMA = {
  type: 'object',
  description:
    'Optional non-PHI filter. All fields are allowlisted dimensions; omit any not constrained.',
  properties: {
    facility: { type: 'string', description: 'Exact facility_name (case-insensitive).' },
    payer: { type: 'string', description: 'Exact payer_name (case-insensitive).' },
    date_from: { type: 'string', description: 'Inclusive lower bound, YYYY-MM-DD.' },
    date_to: { type: 'string', description: 'Inclusive upper bound, YYYY-MM-DD.' },
    source_year: { type: 'integer', description: 'Calendar year of the source sheet (e.g. 2025).' },
    hcpcs_code: { type: 'string', description: 'Exact HCPCS code (case-insensitive).' },
    revenue_code: { type: 'string', description: 'Exact revenue code (case-insensitive).' },
  },
  additionalProperties: false,
} as const;

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'distribution',
    description:
      'Group claims by ONE allowlisted dimension and report a metric per bucket with each bucket\'s share of the total. Use for "break down X by Y" / "which payers/facilities/codes account for the most …" questions.',
    input_schema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          enum: ['facility_name', 'payer_name', 'hcpcs_code', 'revenue_code', 'source_year'],
          description: 'The dimension to group by.',
        },
        metric: {
          type: 'string',
          enum: ['count', 'total_charge', 'total_paid', 'avg_collection_rate'],
          description: 'The per-bucket metric.',
        },
        filter: CLAIM_FILTER_SCHEMA,
      },
      required: ['field', 'metric'],
      additionalProperties: false,
    },
  },
  {
    name: 'payer_gap_analysis',
    description:
      'Per payer, report billed vs allowed vs paid totals plus the contractual write-down and the real collection gap. Use for "where are we losing money by payer" / payer underpayment questions.',
    input_schema: {
      type: 'object',
      properties: { filter: CLAIM_FILTER_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'search_claims',
    description:
      'Return one flat aggregate summary of the claims matching a non-PHI filter (counts, money totals, collection-rate stats, rate-anomaly count, date span, distinct facilities/payers). This is the primary path whose query_id the UI uses to fetch the underlying claim rows.',
    input_schema: {
      type: 'object',
      properties: { filter: CLAIM_FILTER_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'client_history',
    description:
      "Find ONE patient's claims by last-name similarity (and optional member id) and return a per-year, non-PHI roll-up. Use when the question names a specific patient. The patient identifiers are used only to run the query; they are never returned to you — you receive only the aggregate summary and a query_id.",
    input_schema: {
      type: 'object',
      properties: {
        patient_last: {
          type: 'string',
          description: "The patient's last name (used as a bound search term only).",
        },
        member_id_norm: {
          type: 'string',
          description: 'Optional member id to narrow the match (bound search term only).',
        },
        filter: CLAIM_FILTER_SCHEMA,
      },
      required: ['patient_last'],
      additionalProperties: false,
    },
  },
  {
    name: 'readmission_candidates',
    description:
      'Population scan that self-joins claims to surface likely readmissions (two claims for the same person within gap_days), graded exact/strong/possible. Use for "find readmissions at facility X" / cross-claim repeat-encounter questions. No single patient is named.',
    input_schema: {
      type: 'object',
      properties: {
        facility: { type: 'string', description: 'Restrict to one facility_name.' },
        payer: { type: 'string', description: 'Restrict to one payer_name.' },
        date_from: { type: 'string', description: 'Inclusive lower bound, YYYY-MM-DD.' },
        date_to: { type: 'string', description: 'Inclusive upper bound, YYYY-MM-DD.' },
        gap_days: {
          type: 'integer',
          description: 'Max days between the two claims (default 30; bounded [1, 365]).',
        },
      },
      additionalProperties: false,
    },
  },
];

/** Is `name` one of the five allowlisted tools? Narrows to `FunctionName`. */
export function isToolName(name: string): name is FunctionName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}
