/**
 * PHI-safe agent audit line. The agent emits exactly one structured line per
 * turn recording WHICH tool ran, WHEN, the resulting query_id, and token counts.
 *
 * It NEVER records:
 *   - the tool input args (so a `client_history` patient_last / member id can
 *     never leak here),
 *   - the question text or the messages transcript,
 *   - any summary_stats values or claim rows.
 *
 * The shape is identical for every tool — there is no per-tool branch that could
 * accidentally widen it for `client_history`. The query library's own
 * `finalize()` audit line (counts-only) is separate and complementary; this line
 * is the agent layer's record that a model turn selected and ran a tool.
 */
import type { FunctionName } from '../queries/types.js';
import type { Usage } from './client.js';

export interface AgentAuditFields {
  tool_name: FunctionName;
  query_id: string;
  usage?: Usage;
  now?: () => Date;
}

export type AgentAuditSink = (line: string) => void;

const stdoutAudit: AgentAuditSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * Build and emit the agent audit line. Token counts default to null when the
 * model response carried no usage. No PHI, no args, no transcript — by shape.
 */
export function emitAgentAudit(fields: AgentAuditFields, sink: AgentAuditSink = stdoutAudit): void {
  const u = fields.usage ?? {};
  const line = JSON.stringify({
    timestamp: (fields.now?.() ?? new Date()).toISOString(),
    layer: 'agent',
    tool_name: fields.tool_name,
    query_id: fields.query_id,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
  });
  sink(line);
}
