/**
 * The search agent — one natural-language question → one query-function call.
 *
 * Flow (single tool call per turn; NO multi-turn loop):
 *   1. Send the question to the model with the five tool definitions and
 *      `tool_choice: { type: 'any', disable_parallel_tool_use: true }` — it must
 *      pick exactly one tool.
 *   2. Read the first `tool_use` block. Validate its (untrusted) input at the
 *      boundary and dispatch the matching query function as `claims_reader`.
 *   3. The function runs `finalize()` and returns `{ summary_stats, query_id }`.
 *      The model-facing tool result is constructed from THAT return — only after
 *      finalize has run, never before — and contains only the non-PHI summary +
 *      query_id (identity is never reflected back, `client_history` included).
 *   4. Emit one PHI-safe agent audit line (tool, query_id, token counts only).
 *
 * The model NEVER sees raw SQL and NEVER sees claim rows. The UI (not the agent)
 * later fetches PHI via the results route using the returned query_id.
 */
import type { FunctionName, QueryContext } from '../queries/types.js';
import type { AnthropicMessagesClient, MessageCreateParams, ToolUseBlock, Usage } from './client.js';
import { firstToolUse } from './client.js';
import { dispatchTool } from './dispatch.js';
import { emitAgentAudit, type AgentAuditSink } from './logging.js';
import { isToolName, TOOL_DEFS } from './tools.js';
import { validateSearchClaims } from './validators.js';

/**
 * The safe, NON-PHI filter fields the deterministic field-picker may collect to
 * sharpen an over-broad search_claims. None is a patient identifier — they mirror
 * ClaimFilter (validated by validateClaimFilter). Surfaced in the `needs_input`
 * response so the UI knows which inputs to offer.
 */
export const CLAIM_FILTER_FIELDS = [
  'facility',
  'payer',
  'source_year',
  'date_from',
  'date_to',
  'hcpcs_code',
  'revenue_code',
] as const;

/** Default model id. Override via `model` or the `ANTHROPIC_MODEL` env var. */
export const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  'You route a question about out-of-network behavioral-health billing claims to exactly ' +
  'one of the provided query tools. You never write SQL and never see raw claim rows — you ' +
  'choose the single best-fitting tool and fill in its typed inputs. Pick the tool whose ' +
  'purpose matches the question; use distribution for "break down by", payer_gap_analysis ' +
  'for payer underpayment, search_claims for a filtered slice the user wants the underlying ' +
  'records for, client_history when a specific patient is named, and readmission_candidates ' +
  'for repeat-encounter scans. Leave optional inputs unset when the question does not ' +
  'constrain them. For client_history, the patient identifiers you supply are used only to ' +
  'run the query and are never returned to you.';

export interface RunAgentOptions {
  /** The faked (tests) or real Anthropic client. */
  client: AnthropicMessagesClient;
  /** Connected as `claims_reader`, plus createdBy / injectables — passed to the query fn. */
  queryCtx: QueryContext;
  model?: string;
  maxTokens?: number;
  /** PHI-safe agent audit sink; defaults to one JSON line on stdout. */
  audit?: AgentAuditSink;
  /** Deterministic clock for the audit line (tests). */
  now?: () => Date;
}

export interface AgentTurnResult {
  tool_name: FunctionName;
  query_id: string;
  /** Non-PHI summary the UI renders; raw rows are fetched separately by query_id. */
  summary_stats: import('../queries/types.js').SummaryStats;
  /** The model's tool_use id — used by Step 2 to build a tool_result block in a loop. */
  tool_use_id: string;
  usage?: Usage;
}

/** A normal, executed turn. */
export type AgentOkOutcome = { status: 'ok' } & AgentTurnResult;

/**
 * A deterministic "this query is too broad — collect filters first" outcome. No
 * query ran (no query_id, no DB hit, no audit), so PHI is unreachable here. The UI
 * renders `missing` as a field-picker and re-dispatches with the filled filter.
 */
export interface AgentNeedsInputOutcome {
  status: 'needs_input';
  tool_name: FunctionName;
  /** Safe, NON-PHI filter fields that would sharpen the query (subset of CLAIM_FILTER_FIELDS). */
  missing: string[];
}

export type AgentTurnOutcome = AgentOkOutcome | AgentNeedsInputOutcome;

/**
 * Run one agent turn. Returns a normal `ok` outcome, or a deterministic
 * `needs_input` outcome when the model picks search_claims with no constraining
 * filter (an unbounded scan) — in which case nothing is dispatched. Throws if the
 * model returns no tool call or names a tool outside the closed allowlist, or if
 * the model's input fails boundary validation.
 */
export async function runAgentTurn(
  question: string,
  opts: RunAgentOptions,
): Promise<AgentTurnOutcome> {
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('runAgentTurn: question must be a non-empty string');
  }

  const params: MessageCreateParams = {
    model: opts.model ?? (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL),
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
    tools: [...TOOL_DEFS],
    // Force exactly one tool call this turn.
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    // NO `thinking` here: forced tool use (tool_choice type 'any'/'tool') is
    // incompatible with extended/adaptive thinking — the Messages API rejects the
    // pair with 400 "Thinking may not be enabled when tool_choice forces tool use"
    // (confirmed live against claude-opus-4-8, Phase 4 Step 3). The forced single
    // tool choice is load-bearing (the model must pick one of the five query
    // functions, never emit prose/SQL), so thinking is the side that goes. We never
    // read the model's text — only its tool_use block — so omitting thinking is
    // harmless here. Do not re-add it.
  };

  const message = await opts.client.messages.create(params);

  const toolUse: ToolUseBlock | null = firstToolUse(message);
  if (toolUse === null) {
    throw new Error('runAgentTurn: model returned no tool call');
  }
  if (!isToolName(toolUse.name)) {
    throw new Error(`runAgentTurn: model chose unknown tool ${JSON.stringify(toolUse.name)}`);
  }

  // Deterministic guard: a search_claims with no constraining filter would scan the
  // whole table. Do NOT run it — return needs_input so the UI collects safe filters
  // first. validateSearchClaims throws on malformed input (kept as a 500 upstream);
  // an empty validated filter is the "too broad" signal.
  if (toolUse.name === 'search_claims') {
    const { filter } = validateSearchClaims(toolUse.input);
    if (filter === undefined || Object.keys(filter).length === 0) {
      return { status: 'needs_input', tool_name: 'search_claims', missing: [...CLAIM_FILTER_FIELDS] };
    }
  }

  // Validate (inside dispatch) + execute as claims_reader. finalize() runs here;
  // the result we build below is therefore constructed only after finalize.
  const dispatched = await dispatchTool(toolUse.name, toolUse.input, opts.queryCtx);

  // PHI-safe audit: tool, query_id, token counts — no args, no transcript.
  emitAgentAudit(
    { tool_name: dispatched.tool_name, query_id: dispatched.query_id, usage: message.usage, now: opts.now },
    opts.audit,
  );

  return {
    status: 'ok',
    tool_name: dispatched.tool_name,
    query_id: dispatched.query_id,
    summary_stats: dispatched.summary_stats,
    tool_use_id: toolUse.id,
    usage: message.usage,
  };
}

/**
 * Build the Anthropic `tool_result` content block to feed back to the model in a
 * multi-turn loop (Step 2). The content is the NON-PHI `{ summary_stats,
 * query_id }` only — for `client_history` this is exactly the same shape, so no
 * identity is ever reflected into the transcript.
 */
export function buildToolResultBlock(result: AgentTurnResult): {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
} {
  return {
    type: 'tool_result',
    tool_use_id: result.tool_use_id,
    content: JSON.stringify({ summary_stats: result.summary_stats, query_id: result.query_id }),
  };
}
