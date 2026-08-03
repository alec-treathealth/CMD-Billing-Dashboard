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

  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
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

  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        const ms = sdk.messages.stream({
          model,
          max_tokens: QUALIFY_AI_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        });
        for await (const event of ms) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(event.delta.text);
          }
        }
        const final = await ms.finalMessage();
        // One PHI-free cost line (the collections-panel discipline): counts only, never content.
        console.log(
          JSON.stringify({
            evt: 'qualify_ai_explain_cost',
            model,
            question: safeInput.question,
            input_tokens: final.usage.input_tokens,
            output_tokens: final.usage.output_tokens,
          }),
        );
        controller.close();
      } catch (err) {
        console.error('qualify_ai_explain failed'); // generic; the SDK error may echo prompt content
        controller.error(new Error('qualify_ai_failed'));
        void err;
      }
    },
  });

  return { ok: true, stream };
}
