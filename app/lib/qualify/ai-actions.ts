'use server';

/**
 * Qualify AI EXPLAINER server action (Phase H) — the streaming edge over src/collections/qualifyAi.
 * Since 2026-08-04 this file is a THIN BINDER: the whole pipeline (zod-strict PHI firewall → gate →
 * audit-before-stream → model stream → blind-role defensive scrub → cost line → refusal check)
 * lives in runQualifyAiExplanation (src/collections/qualifyAi.ts) with every side effect injected,
 * so the root hermetic suite proves the ordering and the scrub without a live call. This binder
 * supplies the real dependencies and adapts the delta iterable to a ReadableStream:
 *
 *   gate = requireQualifyPrincipal (super_admin + admissions_seat only, fail-closed) ·
 *   audit = recordAccess (durable, BEFORE streaming) · transport = Anthropic SDK streaming ·
 *   log = one PHI-free JSON line per event (cost + scrub alerts) · generic error to the client.
 *
 * MODEL: QUALIFY_AI_MODEL env override first, then ANTHROPIC_MODEL, else claude-opus-5 (the current
 * Opus tier — deliberately NOT the repo agent's stale claude-opus-4-8 default, which
 * qualify-v2-build-plan §7H flags). Short, latency-sensitive generations.
 */
import Anthropic from '@anthropic-ai/sdk';
import { requireQualifyPrincipal } from '@/lib/qualify/gate';
import { recordAccess } from '@/lib/server';
import {
  runQualifyAiExplanation,
  type QualifyAiGateResult,
  type QualifyAiTransport,
} from '../../../src/collections/qualifyAi';

export type QualifyAiStreamResult =
  | { ok: true; stream: ReadableStream<string> }
  | { ok: false; reason: 'insufficient' | 'invalid' | 'unavailable' };

const anthropicTransport: QualifyAiTransport = (req) => {
  const sdk = new Anthropic(); // ANTHROPIC_API_KEY from env; never logged
  const live = sdk.messages.stream({
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  });
  return {
    deltas: (async function* () {
      for await (const event of live) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    })(),
    final: async () => {
      const final = await live.finalMessage();
      return {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        stopReason: final.stop_reason as string | null,
      };
    },
    abort: () => live.abort(),
  };
};

export async function generateQualifyAiExplanation(input: unknown): Promise<QualifyAiStreamResult> {
  // QUALIFY_AI_MODEL first: ANTHROPIC_MODEL is a shared knob (agent + collections panel default it
  // to claude-opus-4-8) — pinning those surfaces must not silently repoint this one.
  const model = process.env.QUALIFY_AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5';

  const run = await runQualifyAiExplanation(input, {
    gate: async (): Promise<QualifyAiGateResult> => {
      const principal = await requireQualifyPrincipal();
      return principal.ok
        ? { ok: true, actor: principal.actor, hasAmounts: principal.hasAmounts }
        : { ok: false };
    },
    recordAccess,
    transport: anthropicTransport,
    model,
    log: (line) => console.log(JSON.stringify(line)),
  });
  if (!run.ok) return run;

  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of run.deltas) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (err) {
        console.error('qualify_ai_explain failed'); // generic; the SDK error may echo prompt content
        controller.error(new Error('qualify_ai_failed'));
        void err;
      }
    },
    cancel() {
      run.abort(); // client abandoned the panel — stop paying for tokens
    },
  });

  return { ok: true, stream };
}
