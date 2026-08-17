'use server';

/**
 * Payer Intel AI Server Action — a SERVER ACTION, deliberately NOT an API route.
 *
 * The build spec asked for a "new API route"; that letter is overridden by three standing facts,
 * flagged in the build report: (1) the browser's only data path is Server Actions (CLAUDE.md);
 * (2) every Bearer-gated API route is live on EVERY branch's preview URL against prod data with
 * no user principal (the preview-deployment credential posture the spec itself says not to
 * widen); (3) the AI audit contract requires a real actor recorded BEFORE the first model byte,
 * which only a session path has. `ANTHROPIC_API_KEY` is read inside the SDK server-side and never
 * reaches the client — the spec's actual requirement.
 *
 * SINGLE-SHOT (messages.create), temperature 0, small/fast model class:
 * `PAYER_INTEL_AI_MODEL || claude-haiku-4-5` — its own env knob first (the QUALIFY_AI_MODEL
 * lesson: the shared ANTHROPIC_MODEL knob points opus-class surfaces and would silently 10x the
 * per-run cost of a read that fires on every result load).
 */
import Anthropic from '@anthropic-ai/sdk';
import { requirePayerIntelPrincipal } from './gate';
import { buildPayerIntelAiPayloadCore } from './core';
import type { PayerIntelAiResult } from './contract';
import { buildPayerIntelRealDeps, sanitizePayerIntelSearchInput } from './deps';
import {
  PAYER_INTEL_AI_DEFAULT_MODEL,
  runPayerIntelAiRead,
  type PayerIntelAiRunDeps,
} from '../../../src/collections/payerIntelAi';
import { recordAccess } from '../server';

function transport(): PayerIntelAiRunDeps['transport'] {
  return async ({ system, user, model, maxTokens, temperature }) => {
    const sdk = new Anthropic(); // reads ANTHROPIC_API_KEY from env, server-side only
    const msg = await sdk.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      stopReason: msg.stop_reason,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    };
  };
}

/**
 * Assemble the aggregates-only payload SERVER-SIDE from the search input (the client never builds
 * or sees the payload), then run the fixed-shape read. Returns only the parsed structure or a
 * typed failure — raw model text never crosses the wire.
 */
export async function generatePayerIntelAiRead(input: unknown): Promise<PayerIntelAiResult> {
  try {
    const assembled = await buildPayerIntelAiPayloadCore(
      buildPayerIntelRealDeps(),
      sanitizePayerIntelSearchInput(input),
    );
    if (!assembled.ok) return { ok: false, reason: assembled.reason };

    const run = await runPayerIntelAiRead(assembled.payload, {
      gate: async () => {
        const p = await requirePayerIntelPrincipal();
        return p.ok ? { ok: true, actor: p.actor, hasAmounts: p.hasAmounts } : { ok: false };
      },
      recordAccess,
      transport: transport(),
      model: process.env.PAYER_INTEL_AI_MODEL || PAYER_INTEL_AI_DEFAULT_MODEL,
      log: (line) => console.log(line),
    });
    if (!run.ok) return { ok: false, reason: run.reason === 'invalid' ? 'failed' : run.reason };
    // The collapsed "underlying data" tables are the PAYLOAD's own buckets — the viewer-stripped
    // aggregates the model actually received, nothing more.
    const bucketsOf = (key: 'by_visit' | 'by_days_bucket') => {
      const arr = assembled.payload[key];
      if (!Array.isArray(arr)) return null;
      return arr.map((b) => {
        const r = b as {
          bucket: number;
          patients: number;
          lines: number;
          pct_allowed: number | null;
          pct_paid: number | null;
          pct_zero_paid: number;
        };
        return {
          bucket: r.bucket,
          patients: r.patients,
          lines: r.lines,
          pctAllowed: r.pct_allowed,
          pctPaid: r.pct_paid,
          pctZeroPaid: r.pct_zero_paid,
        };
      });
    };
    const byVisit = bucketsOf('by_visit');
    const byDays = bucketsOf('by_days_bucket');
    return {
      ok: true,
      read: { tldr: run.read.tldr, signals: run.read.signals, basis: run.read.basis },
      underlying: byVisit !== null || byDays !== null ? { byVisit: byVisit ?? [], byDays: byDays ?? [] } : null,
    };
  } catch (err) {
    console.error('generatePayerIntelAiRead failed', err instanceof Error ? err.message : '');
    return { ok: false, reason: 'failed' };
  }
}
