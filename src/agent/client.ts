/**
 * Minimal Anthropic Messages API seam — the agent's DB-executor analogue.
 *
 * The query library is tested with a fake `QueryExecutor` injected through
 * `QueryContext`; the agent is tested the same way, with a fake client injected
 * here. This interface is a NARROW subset of `@anthropic-ai/sdk`'s
 * `client.messages.create(...)` shape — only the fields the agent sends and the
 * blocks it reads — so:
 *   - `npm test` needs no live LLM and no SDK dependency (Step 1), and
 *   - Step 2 can pass a real `new Anthropic()` (structurally compatible) or a
 *     thin wrapper around it.
 *
 * It carries NO state and NO PHI policy of its own; the PHI boundary lives in
 * the dispatch layer (only `summary_stats` + `query_id` ever flow back as a tool
 * result) and the agent's PHI-safe logging.
 */

/** A tool the model may call. `input_schema` mirrors one query function's args. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  /** Untrusted: the model's chosen arguments. Validated at the dispatch boundary. */
  input: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Any other block type (thinking, etc.) — we only act on `tool_use`. */
export type ContentBlock = ToolUseBlock | TextBlock | { type: string; [k: string]: unknown };

/** Token accounting (PHI-free) — surfaced to the agent's audit line. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessage {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content: ContentBlock[];
  usage?: Usage;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface ToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
  /** When true, at most one tool call per response (single-tool-per-turn). */
  disable_parallel_tool_use?: boolean;
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  thinking?: { type: 'adaptive' | 'disabled' };
  output_config?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
}

/** The one method the agent calls. A fake (tests) or a real SDK client both satisfy it. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: MessageCreateParams): Promise<AnthropicMessage>;
  };
}

/** Narrow a response's content to the first `tool_use` block, or null. */
export function firstToolUse(message: AnthropicMessage): ToolUseBlock | null {
  for (const block of message.content) {
    if (block.type === 'tool_use') return block as ToolUseBlock;
  }
  return null;
}
