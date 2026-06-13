/**
 * Real implementation of the `AnthropicMessagesClient` seam (client.ts), backed
 * by `@anthropic-ai/sdk`. The fake client used in tests stays — this is the
 * production wiring the seam was designed for (see client.ts header).
 *
 * The agent sends a NARROW `MessageCreateParams` (our seam type); we forward it
 * to the SDK and adapt the SDK's richer `Message` back to our `AnthropicMessage`.
 * The cast is deliberate and isolated to this one boundary: the agent core never
 * depends on SDK types, so tests need no SDK and Step 2's wiring is the only
 * place version-specific SDK shapes appear.
 *
 * The API key is read from env (ANTHROPIC_API_KEY) — never hardcoded, never
 * logged. This module is the only one that constructs a live LLM client.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicMessage, AnthropicMessagesClient, MessageCreateParams } from './client.js';

/** Read the Anthropic API key from env; throw (names only) if absent. */
export function anthropicApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('Missing ANTHROPIC_API_KEY (check, do not log, this var)');
  }
  return key;
}

/**
 * Build an `AnthropicMessagesClient` over a real `new Anthropic()`. The forwarded
 * params (`tool_choice`, `tools`, `system`, …) are passed exactly as the agent
 * set them; the SDK serializes the object as the request body. Note the agent does
 * NOT send `thinking` — it forces tool use, which the API forbids combining with
 * thinking (see agent.ts).
 */
export function makeAnthropicClient(apiKey: string): AnthropicMessagesClient {
  const sdk = new Anthropic({ apiKey });
  return {
    messages: {
      create: (params: MessageCreateParams): Promise<AnthropicMessage> =>
        // `as never` forwards our narrow params without binding to a versioned
        // SDK param type; the result is adapted back to our seam's message shape.
        sdk.messages.create(params as never) as unknown as Promise<AnthropicMessage>,
    },
  };
}

/** Convenience: build the client straight from env. */
export function makeAnthropicClientFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicMessagesClient {
  return makeAnthropicClient(anthropicApiKeyFromEnv(env));
}
