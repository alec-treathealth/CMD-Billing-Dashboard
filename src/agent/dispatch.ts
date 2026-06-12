/**
 * Dispatch — turn the model's chosen tool + (untrusted) input into a query
 * function call, and return the NON-PHI tool result.
 *
 * The PHI boundary is enforced here: every branch returns the function's
 * `QueryResult` ({ summary_stats, query_id }) and nothing else. Raw claim rows
 * are NEVER produced on this path — they are fetched later by the UI via the
 * results route keyed by query_id. The tool result handed back to the model is
 * therefore non-PHI by construction, `client_history` included (its summary is
 * PHI-free by type, and its identity inputs are not echoed).
 *
 * `finalize()` runs INSIDE each query function, so by the time a branch returns,
 * the query_log row is written and the audit line emitted. The agent constructs
 * the model-facing tool result from THIS return value — i.e. only after
 * finalize has run, never before.
 */
import {
  clientHistory,
  distribution,
  payerGapAnalysis,
  readmissionCandidates,
  searchClaims,
} from '../queries/index.js';
import type { FunctionName, QueryContext, QueryResult, SummaryStats } from '../queries/types.js';
import {
  validateClientHistory,
  validateDistribution,
  validatePayerGap,
  validateReadmissionCandidates,
  validateSearchClaims,
} from './validators.js';

/** A dispatched result, narrowed to the non-PHI two-shape return. */
export interface DispatchResult {
  tool_name: FunctionName;
  query_id: string;
  summary_stats: SummaryStats;
}

/**
 * Validate the model's raw tool input at the boundary, then execute the matching
 * query function as `claims_reader` (the executor on `ctx`). Returns only the
 * non-PHI summary + query_id.
 */
export async function dispatchTool(
  toolName: FunctionName,
  rawInput: unknown,
  ctx: QueryContext,
): Promise<DispatchResult> {
  let result: QueryResult<SummaryStats>;
  switch (toolName) {
    case 'distribution':
      result = await distribution(validateDistribution(rawInput), ctx);
      break;
    case 'payer_gap_analysis':
      result = await payerGapAnalysis(validatePayerGap(rawInput), ctx);
      break;
    case 'search_claims':
      result = await searchClaims(validateSearchClaims(rawInput), ctx);
      break;
    case 'client_history':
      // PHI INPUT: validated terms flow into the query as bound params only.
      // The return is the PHI-free summary + query_id — identity is not echoed.
      result = await clientHistory(validateClientHistory(rawInput), ctx);
      break;
    case 'readmission_candidates':
      result = await readmissionCandidates(validateReadmissionCandidates(rawInput), ctx);
      break;
    default: {
      // Exhaustiveness guard — `toolName` is a closed union.
      const never: never = toolName;
      throw new Error(`dispatch: unknown tool ${String(never)}`);
    }
  }
  return { tool_name: toolName, query_id: result.query_id, summary_stats: result.summary_stats };
}
