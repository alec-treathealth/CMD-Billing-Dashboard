/**
 * Shared chokepoint every query function passes through to (1) persist a
 * query_log row via the SECURITY DEFINER claims.log_query (executed on the
 * claims_reader connection — the reader has no table rights on query_log), and
 * (2) emit exactly one structured audit line. Centralizing this guarantees no
 * function can return a result without logging, and that PHI never reaches
 * either sink: only the caller-provided non-PHI `args`/`auditShape` and counts
 * are recorded.
 */
import type { FunctionName, QueryContext, QueryResult } from './types.js';

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export interface FinalizeParams<S> {
  functionName: FunctionName;
  /** Client-generated uuid = query_id (also the query_log PK). */
  queryId: string;
  /** Sanitized, non-PHI args persisted in query_log.arguments (drives re-execution). */
  args: Record<string, unknown>;
  /** Non-PHI shape for the audit line (identity fields appear as presence flags only). */
  auditShape: Record<string, unknown>;
  summaryStats: S;
  /** 64-hex SHA-256 for client_history; null for every other function. */
  identityHash: string | null;
  resultRowCount: number;
}

export async function finalize<S>(
  ctx: QueryContext,
  p: FinalizeParams<S>,
): Promise<QueryResult<S>> {
  // 1. Persist the handle row. The reader can only reach query_log through this
  //    definer function; the table CHECKs + the function's RAISEs reject bad input.
  await ctx.executor.query(
    'select claims.log_query($1, $2, $3, $4::jsonb, $5::jsonb, $6) as id',
    [
      p.queryId,
      ctx.createdBy,
      p.functionName,
      JSON.stringify(p.args),
      JSON.stringify(p.summaryStats),
      p.identityHash,
    ],
  );

  // 2. One structured audit line — timestamp, function, non-PHI arg shape,
  //    query_id, row count. Never any PHI value.
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    function_name: p.functionName,
    args_shape: p.auditShape,
    query_id: p.queryId,
    result_row_count: p.resultRowCount,
  });
  (ctx.audit ?? stdoutAudit)(line);

  // 3. Two-shape result. PHI result rows are NOT here.
  return { summary_stats: p.summaryStats, query_id: p.queryId };
}
