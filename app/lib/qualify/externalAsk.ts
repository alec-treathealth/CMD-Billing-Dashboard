/**
 * THE COMPOSER'S EXTERNAL-ASK CONSUME DECISION (Smoke shell, 2026-08-10) — pure, for the same reason
 * `aiPayload.ts` and `bookPlacement.ts` are pure.
 *
 * `qualify-ai-panel.tsx` imports the `'use server'` chain (`@/lib/qualify/ai-actions`), so it cannot
 * be rendered or imported by a hermetic test — that is precisely why an untested optional field once
 * silently stopped reaching the model with every suite green (`aiPayload.ts`'s own header) and why the
 * placement ternary once shipped inverted with a clean build (`bookPlacement.ts`'s). The consume
 * decision below is the same class of risk: it gates an AUDITED, BILLED model call, and until now it
 * lived only as an inline nonce comparison inside that unreachable file.
 *
 * THE RULE, stated once so the panel and the test agree on it:
 *   - `externalAsk === null` → never fires.
 *   - `externalAsk.nonce === lastConsumedNonce` → already consumed THIS nonce → does not re-fire.
 *     This is what makes a REMOUNT safe: the ref that tracks `lastConsumedNonce` lives only for the
 *     mount, so surviving a remount is the OWNER's job (disarming via `onExternalAsked`, which nulls
 *     `externalAsk` itself) — not this function's. See the panel's own comment on `onExternalAsked`.
 *   - otherwise → fires, and the nonce just consumed becomes the new `lastConsumedNonce`.
 *
 * A REPEAT IDENTICAL ASK UNDER A NEW NONCE MUST FIRE — the composer mints a fresh nonce per press
 * (`askNonceRef.current` in `resolution-flow-client.tsx`), so two presses of the same chip are two
 * distinct requests, exactly like a rep clicking the same fixed chip twice. Comparing anything about
 * the ask's CONTENT (question, slots) instead of its nonce would silently swallow the second press.
 *
 * PURE and client-safe: no React, no `'use server'` chain, relative imports only, so a hermetic test
 * can call it directly — the panel is wired to CALL this, not to keep a parallel copy of the logic.
 */
import type { QualifyAiChipId } from './aiChips';
import type { QualifyChipSlots } from './chipTemplates';

/** The composer's pending ask, exactly as it arrives on the panel's `externalAsk` prop. */
export interface QualifyExternalAsk {
  question: QualifyAiChipId;
  slots: QualifyChipSlots | null;
  nonce: number;
}

export type QualifyExternalAskDecision =
  | { fire: false }
  /** `ask` is echoed back rather than making the caller re-read `externalAsk` (which TypeScript
   *  cannot narrow to non-null from `fire: true` alone without this). */
  | { fire: true; nextConsumed: number; ask: QualifyExternalAsk };

export function decideExternalAsk(
  externalAsk: QualifyExternalAsk | null,
  lastConsumedNonce: number | null,
): QualifyExternalAskDecision {
  if (externalAsk === null || externalAsk.nonce === lastConsumedNonce) return { fire: false };
  return { fire: true, nextConsumed: externalAsk.nonce, ask: externalAsk };
}
