'use server';

/**
 * Qualify AI EXPLAINER server action (Phase H) — the streaming edge over src/collections/qualifyAi.
 * Mirrors generateCollectionsAiAnalysis (app/lib/actions.ts) exactly in shape and discipline:
 *
 *   zod-strict PHI firewall FIRST (the schema cannot express a dollar, an identifier, or an
 *   employer — .strict() rejects unknown keys outright) → Qualify gate (super_admin +
 *   admissions_seat only, fail-closed) → durable audit BEFORE streaming → ReadableStream<string>
 *   of text deltas → one PHI-free cost line → generic error to the client.
 *
 * MODEL: ANTHROPIC_MODEL env override, else claude-opus-5 (the current Opus tier — deliberately NOT
 * the repo agent's stale claude-opus-4-8 default, which qualify-v2-build-plan §7H flags). Short,
 * latency-sensitive generations; max_tokens 1024.
 */
import Anthropic from '@anthropic-ai/sdk';
import { requireQualifyPrincipal } from '@/lib/qualify/gate';
import { recordAccess } from '@/lib/server';
import {
  QualifyAiInputSchema,
  buildQualifyAiMessages,
  isQualifyAiSufficient,
  QUALIFY_AI_MAX_TOKENS,
} from '../../../src/collections/qualifyAi';

const QUALIFY_AI_ACTION = 'qualify_ai_explain';

export type QualifyAiStreamResult =
  | { ok: true; stream: ReadableStream<string> }
  | { ok: false; reason: 'insufficient' | 'invalid' | 'unavailable' };

export async function generateQualifyAiExplanation(input: unknown): Promise<QualifyAiStreamResult> {
  // 1. PHI firewall BEFORE anything else — unknown keys (and therefore any identifier or dollar
  //    field a compromised client might attach) are rejected structurally, never forwarded.
  const parsed = QualifyAiInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const ai = parsed.data;

  // 2. Gate — same principal policy as every Qualify surface (fail-closed).
  const gate = await requireQualifyPrincipal();
  if (!gate.ok) return { ok: false, reason: 'unavailable' };

  // The prompt is dollar-free for EVERY role by schema construction; amountsBlind only tunes copy.
  // Trust the server-side principal over the client's claim.
  const blind = !gate.hasAmounts;
  const safeInput = { ...ai, amountsBlind: blind || ai.amountsBlind };

  if (!isQualifyAiSufficient(safeInput)) return { ok: false, reason: 'insufficient' };

  // QUALIFY_AI_MODEL first: ANTHROPIC_MODEL is a shared knob (agent + collections panel default it
  // to claude-opus-4-8) — pinning those surfaces must not silently repoint this one.
  const model = process.env.QUALIFY_AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  const sdk = new Anthropic(); // ANTHROPIC_API_KEY from env; never logged

  // 3. Durable audit BEFORE streaming (best-effort; non-PHI detail — question id + shape only).
  try {
    await recordAccess({
      actorEmail: gate.actor.email,
      actorUserId: gate.actor.userId,
      action: QUALIFY_AI_ACTION,
      detail: {
        question: safeInput.question,
        provenance: safeInput.provenance,
        facilities: safeInput.facilities.length,
        window_days: safeInput.windowDays,
        model,
      },
    });
  } catch {
    // an audit hiccup must not block a non-PHI aggregate read; the action name is still attributable
    // via the model-cost log line below
  }

  const { system, user } = buildQualifyAiMessages(safeInput);

  let ms: { abort(): void } | null = null;
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        const live = sdk.messages.stream({
          model,
          max_tokens: QUALIFY_AI_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        });
        ms = live;
        for await (const event of live) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(event.delta.text);
          }
        }
        const final = await live.finalMessage();
        // One PHI-free cost line (the collections-panel discipline): counts only, never content.
        console.log(
          JSON.stringify({
            evt: 'qualify_ai_explain_cost',
            model,
            question: safeInput.question,
            input_tokens: final.usage.input_tokens,
            output_tokens: final.usage.output_tokens,
            stop_reason: final.stop_reason, // truncation ('max_tokens') and refusals must be visible in ops, not silent
          }),
        );
        if ((final.stop_reason as string | null) === 'refusal') {
          // An opus-5 safety refusal arrives as HTTP 200 — never render it as a finished answer.
          controller.error(new Error('qualify_ai_failed'));
          return;
        }
        controller.close();
      } catch (err) {
        console.error('qualify_ai_explain failed'); // generic; the SDK error may echo prompt content
        controller.error(new Error('qualify_ai_failed'));
        void err;
      }
    },
    cancel() {
      ms?.abort(); // client abandoned the panel — stop paying for tokens
    },
  });

  return { ok: true, stream };
}
