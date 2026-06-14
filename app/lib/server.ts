/**
 * Server-side wiring for the Next.js API routes. This is the production
 * transport's composition root — the analogue of the retired Express harness's
 * `main()`. It builds, once per server process (singletons reused across warm
 * serverless invocations):
 *   - a claims_reader pg pool / executor (verify-full TLS via src/ssl.ts),
 *   - a real Anthropic client (from ANTHROPIC_API_KEY), and
 *   - the shared Bearer secret (RESULTS_API_SECRET) both routes gate on.
 *
 * The route handlers (../app/api/*) stay thin: they parse the HTTP request and
 * call handleAgent / handleResults here. All PHI-boundary, validation, and audit
 * logic lives in the transport-agnostic handlers under ../../src/routes.
 */
import { makeAnthropicClientFromEnv } from '../../src/agent/index.js';
import type { AnthropicMessagesClient } from '../../src/agent/index.js';
import { distribution, payerGapAnalysis } from '../../src/queries/index.js';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../src/queries/executor.js';
import type {
  DistributionField,
  DistributionMetric,
  DistributionSummary,
  PayerGapSummary,
  QueryContext,
} from '../../src/queries/types.js';
import { handleAgentRequest, type AgentHttpRequest } from '../../src/routes/agentHandler.js';
import type { ResultsContext } from '../../src/routes/results.js';
import { handleResultsRequest, type ResultsHttpRequest } from '../../src/routes/resultsHandler.js';

let cachedExecutor: PgExecutor | undefined;
function readerExecutor(): PgExecutor {
  // verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts).
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

let cachedClient: AnthropicMessagesClient | undefined;
function agentClient(): AnthropicMessagesClient {
  cachedClient ??= makeAnthropicClientFromEnv();
  return cachedClient;
}

function bearerSecret(): string {
  const s = process.env.RESULTS_API_SECRET;
  if (!s || s.trim() === '') {
    throw new Error('Missing RESULTS_API_SECRET (set it in .env; never hardcode or log it)');
  }
  return s;
}

/** Agent route: NL question → one query function → non-PHI { tool_name, query_id, summary_stats }. */
export function handleAgent(req: AgentHttpRequest) {
  return handleAgentRequest(req, {
    client: agentClient(),
    makeQueryCtx: (createdBy: string): QueryContext => ({
      executor: readerExecutor(),
      createdBy,
    }),
    secret: bearerSecret(),
  });
}

/** Results route: query_id (+ optional client_history identity) → PHI rows. */
export function handleResults(req: ResultsHttpRequest) {
  const ctx: ResultsContext = { executor: readerExecutor() };
  return handleResultsRequest(req, { ctx, secret: bearerSecret() });
}

// ---------------------------------------------------------------------------
// Dashboard data path (non-PHI, summary-only).
//
// The default dashboard calls the vetted query functions DIRECTLY (not via the
// agent — no LLM, deterministic) and returns ONLY their non-PHI `summary_stats`.
// The `query_id` is intentionally dropped: the dashboard never fetches rows, so
// no PHI can ever be reached on this path. `summary_stats` is PHI-free by type.
// ---------------------------------------------------------------------------

function dashboardCtx(): QueryContext {
  // Same least-privilege claims_reader executor; a fixed non-PHI audit principal.
  return { executor: readerExecutor(), createdBy: 'phase5-dashboard' };
}

/** Per-payer billed/allowed/paid + collection gap + avg rate (non-PHI summary). */
export async function dashboardPayerGap(): Promise<PayerGapSummary> {
  const { summary_stats } = await payerGapAnalysis({}, dashboardCtx());
  return summary_stats;
}

/** A single allowlisted-dimension distribution (non-PHI summary). */
export async function dashboardDistribution(
  field: DistributionField,
  metric: DistributionMetric,
): Promise<DistributionSummary> {
  const { summary_stats } = await distribution({ field, metric }, dashboardCtx());
  return summary_stats;
}
