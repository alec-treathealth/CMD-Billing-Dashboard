/**
 * Transport-agnostic handler for the agent route. The Next.js route handler
 * (app/app/api/agent/route.ts) is a thin adapter that maps an HTTP request to
 * `AgentHttpRequest` and this result back to a Response — the same split the
 * retired Express harness used over the results route.
 *
 * Contract: a NL question in, `{ tool_name, summary_stats, query_id }` out. PHI
 * NEVER appears in the response — `summary_stats` is non-PHI by type, and raw
 * claim rows are not on this path (the UI fetches them via the results route with
 * the returned query_id). Auth is enforced here (Bearer, constant-time).
 *
 * Errors never leak internals: the model picking an unknown tool or emitting
 * malformed input throws inside runAgentTurn and is collapsed to a generic 500 —
 * the underlying message (which could name a tool/column) is never echoed.
 */
import { runAgentTurn } from '../agent/agent.js';
import type { AnthropicMessagesClient } from '../agent/client.js';
import { isAuthorized } from '../bearerAuth.js';
import type { FunctionName, QueryContext, SummaryStats } from '../queries/types.js';

export interface AgentHttpRequest {
  /** HTTP method. POST only — any other verb is 405. */
  method?: string;
  /** Raw `Authorization` header value. */
  authorization?: string | null;
  /** Parsed JSON body (untrusted). */
  body: unknown;
  /** Optional non-PHI principal for the audit trail (e.g. an `x-created-by` header). */
  createdBy?: string | null;
}

export interface AgentRouteDeps {
  client: AnthropicMessagesClient;
  /** Builds a claims_reader QueryContext bound to the given (non-PHI) principal. */
  makeQueryCtx: (createdBy: string) => QueryContext;
  /** Shared Bearer secret (RESULTS_API_SECRET / a dedicated AGENT secret). */
  secret: string;
  model?: string;
  now?: () => Date;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface AgentResponseBody {
  tool_name: FunctionName;
  query_id: string;
  summary_stats: SummaryStats;
}

export async function handleAgentRequest(
  req: AgentHttpRequest,
  deps: AgentRouteDeps,
): Promise<HandlerResult> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'POST') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (!isAuthorized(req.authorization, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const question = extractQuestion(req.body);
  if (question === null) {
    return { status: 400, body: { error: 'bad_request' } };
  }

  const createdBy = req.createdBy?.trim() || 'agent-api';

  try {
    const turn = await runAgentTurn(question, {
      client: deps.client,
      queryCtx: deps.makeQueryCtx(createdBy),
      model: deps.model,
      now: deps.now,
    });
    const body: AgentResponseBody = {
      tool_name: turn.tool_name,
      query_id: turn.query_id,
      summary_stats: turn.summary_stats,
    };
    return { status: 200, body };
  } catch {
    // Never echo the underlying error — it may name a tool/column.
    return { status: 500, body: { error: 'agent_failed' } };
  }
}

/** Pull a non-empty `question` string from an untrusted JSON body, else null. */
function extractQuestion(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const q = (body as Record<string, unknown>).question;
  if (typeof q !== 'string' || q.trim() === '') return null;
  return q;
}
