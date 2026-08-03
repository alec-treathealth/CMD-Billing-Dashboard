/**
 * Shapes for payer policy intelligence ingest. Non-PHI throughout: every field
 * originates from a public payer bulletin, CMS fact sheet, Federal Register
 * document, or standards-body page. Nothing here is patient-, member-, or
 * claim-derived.
 *
 * Mirrors intel.* in `SQL Schemas/025_payer_policy_intel.sql`.
 */

export const CHANGE_TYPES = [
  'reimbursement', 'coverage', 'prior_auth', 'edit',
  'modifier', 'unit', 'code_set', 'transparency',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const ORIGINATORS = ['payer', 'AMA', 'NUBC', 'CMS', 'CDC-NCHS'] as const;
export type Originator = (typeof ORIGINATORS)[number];

export const SCOPES = ['in_network', 'out_of_network', 'both', 'unclear'] as const;
export type Scope = (typeof SCOPES)[number];

/** Model's judgement of the CLAIM. Orthogonal to FindingStatus — never collapse them. */
export const CONFIDENCES = ['confirmed', 'needs_verification'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Our pipeline's judgement of the SOURCE. `quarantined` = source_url was not in
 *  the run's retrieved set, so the finding is retained for audit but excluded
 *  from retrieval. */
export const FINDING_STATUSES = ['confirmed', 'needs_verification', 'quarantined'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export type SourceTier = 'primary' | 'secondary';

/** Operationally distinct: budget_exhausted is a knob to turn, login_gated is a
 *  wall to route around permanently. Free text cannot express that difference. */
export const UNREACHABLE_REASON_CODES = [
  'login_gated', 'pdf_not_parsed', 'content_not_retrieved',
  'budget_exhausted', 'not_published', 'other',
] as const;
export type UnreachableReasonCode = (typeof UNREACHABLE_REASON_CODES)[number];

/** Exactly what the `emit_findings` strict tool returns. Dates arrive as strings
 *  and may be the literal 'unknown'; normalizeDate maps that to null. */
export interface RawFinding {
  payer_plan: string;
  change_type: ChangeType;
  originator: Originator;
  summary: string;
  codes_affected: string[];
  scope: Scope;
  self_funded_relevant: boolean;
  date_published: string;
  date_approved: string;
  date_effective: string;
  source_url: string;
  source_domain: string;
  confidence: Confidence;
  embed_text: string;
}

export interface RawUnreachable {
  payer: string;
  reason_code: UnreachableReasonCode;
  reason: string;
  url: string;
}

export interface EmitFindingsPayload {
  findings: RawFinding[];
  checked_no_change: string[];
  unreachable: RawUnreachable[];
}

/** A finding after the provenance gate, ready to persist. */
export interface ResolvedFinding {
  finding_hash: string;
  payer_key: string;
  payer_plan: string;
  change_type: ChangeType;
  originator: Originator;
  summary: string;
  codes_affected: string[];
  scope: Scope;
  self_funded_relevant: boolean;
  date_published: string | null;
  date_approved: string | null;
  date_effective: string | null;
  source_url: string;
  source_domain: string;
  source_tier: SourceTier;
  confidence: Confidence;
  status: FindingStatus;
  embed_text: string;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  service_tier?: string;
  inference_geo?: string;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

export type RunStatus = 'ok' | 'failed';

export type RetrievalVia = 'search' | 'fetch';

export interface RetrievedUrl {
  url: string;
  via: RetrievalVia;
}

export interface ResearchResult {
  payload: EmitFindingsPayload | null;
  /** Every URL the API actually returned this run, from search AND fetch. This is
   *  the provenance set: a source_url absent from it is quarantined. */
  retrievedUrls: string[];
  /**
   * Same URLs, carrying which tool surfaced each one.
   *
   * Kept because `allowed_domains` proved not to be strictly honored: the
   * 2026-08-03 aetna run returned arxiv.org, medrxiv.org, uspto.gov and
   * nih.gov URLs against an allow-list of aetna.com + meritain.com. Gate D caught
   * them, but the aggregate counts alone could not say whether search or fetch let
   * them in — which is the first question any Gate D failure raises.
   */
  retrievedVia: RetrievedUrl[];
  toolErrors: string[];
  searchRequests: number;
  fetchRequests: number;
  turnCount: number;
  stopReason: string;
  usages: TokenUsage[];
  emitCallCount: number;
  /** Gate failures, most significant first. Empty means the run is healthy. */
  failures: string[];
  anomalies: string[];
  wallMs: number;
}
