/** Public surface of the Phase 4 search-agent layer. */
export type {
  AnthropicMessagesClient,
  AnthropicMessage,
  ContentBlock,
  MessageCreateParams,
  MessageParam,
  ToolDef,
  ToolUseBlock,
  Usage,
} from './client.js';
export { firstToolUse } from './client.js';
export {
  makeAnthropicClient,
  makeAnthropicClientFromEnv,
  anthropicApiKeyFromEnv,
} from './anthropicClient.js';
export { TOOL_DEFS, TOOL_NAMES, isToolName } from './tools.js';
export {
  validateClientHistory,
  validateDistribution,
  validatePayerGap,
  validateReadmissionCandidates,
  validateSearchClaims,
} from './validators.js';
export { dispatchTool, type DispatchResult } from './dispatch.js';
export { emitAgentAudit, type AgentAuditFields, type AgentAuditSink } from './logging.js';
export {
  runAgentTurn,
  buildToolResultBlock,
  DEFAULT_MODEL,
  type RunAgentOptions,
  type AgentTurnResult,
} from './agent.js';
