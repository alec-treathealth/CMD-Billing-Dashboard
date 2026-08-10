/**
 * THE COMPOSER'S EXTERNAL-ASK CONSUME DECISION — an untested, audited, BILLED model trigger before
 * this file existed.
 *
 * `QualifyAiPanel` (`components/qualify/qualify-ai-panel.tsx`) imports the `'use server'` chain
 * (`@/lib/qualify/ai-actions`), so it cannot be mounted hermetically — that is exactly why the
 * decision was extracted into `lib/qualify/externalAsk.ts` (see that file's header) rather than left
 * as the inline nonce comparison it used to be. This file calls the extracted decision directly AND
 * pins that the panel actually calls it, per this repo's house rule that a test of a copy of the
 * logic is worth nothing (`qualify-shell-session.test.tsx`'s header).
 *
 * What must hold, per the brief:
 *   - fires once
 *   - does NOT re-fire on the same nonce (including the cross-remount case, where the ref resets but
 *     the OWNER's disarm — nulling `externalAsk` itself — is what actually protects)
 *   - DOES fire for a repeat identical ask carrying a NEW nonce (a second press is a second request)
 *   - never fires on null
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a `.ts` file here would "pass"
 * by never running (see `forecast-edit-feedback.test.tsx`'s header for the precedent).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideExternalAsk, type QualifyExternalAsk } from '../lib/qualify/externalAsk';

/** The panel's source, for the CALL-SITE pin below. */
const PANEL_SRC = readFileSync(
  fileURLToPath(new URL('../components/qualify/qualify-ai-panel.tsx', import.meta.url)),
  'utf8',
);

/**
 * `indexOf` returns -1 for an absent needle, which is how a bare `indexOf` comparison can stay true
 * after the thing it guards is deleted (`qualify-shell-session.test.tsx`'s `indexOfOrFail`, after the
 * `makeRetryHandler` MUT-25 precedent). Every position this file takes goes through here.
 */
function indexOfOrFail(hay: string, needle: string, from = 0): number {
  const at = hay.indexOf(needle, from);
  assert.notEqual(at, -1, `missing from the panel: ${needle}`);
  return at;
}

const ask = (nonce: number, over: Partial<QualifyExternalAsk> = {}): QualifyExternalAsk => ({
  question: 'placement',
  slots: null,
  nonce,
  ...over,
});

// ── The pure decision ──────────────────────────────────────────────────────────────────────────
test('never fires on null, regardless of what was last consumed', () => {
  assert.deepEqual(decideExternalAsk(null, null), { fire: false });
  assert.deepEqual(decideExternalAsk(null, 3), { fire: false });
});

test('fires once: a fresh ask with nothing consumed yet fires and reports its nonce as consumed', () => {
  const a = ask(1);
  const decision = decideExternalAsk(a, null);
  assert.deepEqual(decision, { fire: true, nextConsumed: 1, ask: a });
});

test('does NOT re-fire on the same nonce', () => {
  const a = ask(1);
  assert.deepEqual(decideExternalAsk(a, 1), { fire: false });
});

test('DOES fire for a repeat identical ask under a NEW nonce — a second press is a second request', () => {
  const first = ask(1, { question: 'ranks' });
  const second = ask(2, { question: 'ranks' }); // same question + slots, only the nonce differs
  assert.deepEqual(decideExternalAsk(second, first.nonce), {
    fire: true,
    nextConsumed: 2,
    ask: second,
  });
});

test('across a remount, the local ref alone cannot protect — the OWNER disarming IS the protection', () => {
  const a = ask(5);
  // First mount: nothing consumed yet, so it fires.
  assert.equal(decideExternalAsk(a, null).fire, true);
  // The owner's disarm (`onExternalAsked`) nulls `externalAsk` itself. Once that has happened, no
  // remount can resurrect the ask — the ref is irrelevant because the INPUT is gone.
  assert.deepEqual(decideExternalAsk(null, null), { fire: false });
  // Without that disarm, a fresh mount's ref restarts at `null` too, and the SAME ask object would
  // fire again — proving the ref by itself does not survive a remount; only the owner nulling the
  // prop does. This is why `onExternalAsked` must run before the panel can unmount for any reason.
  assert.equal(decideExternalAsk(a, null).fire, true, 'the ref alone is not what protects a remount');
});

// ── The panel's call site (the copy-of-the-logic trap) ────────────────────────────────────────
test('the panel WIRES the decision: it imports and calls decideExternalAsk, not an inline nonce check', () => {
  assert.match(
    PANEL_SRC,
    /import \{ decideExternalAsk, type QualifyExternalAsk \} from '\.\.\/\.\.\/lib\/qualify\/externalAsk';/,
    'the panel must import the extracted decision',
  );
  const effectAt = indexOfOrFail(PANEL_SRC, 'const externalConsumedRef = useRef<number | null>(null);');
  const closeAt = indexOfOrFail(PANEL_SRC, "}, [externalAsk, run, onExternalAsked]);", effectAt);
  const callAt = indexOfOrFail(PANEL_SRC, 'decideExternalAsk(externalAsk, externalConsumedRef.current)', effectAt);
  assert.ok(callAt < closeAt, 'the call must be inside the externalAsk consume effect');
  // The ref must be written from the DECISION's own field, not re-derived from `externalAsk.nonce`
  // directly — that re-derivation is exactly the inline copy this extraction replaced.
  const setRefAt = indexOfOrFail(PANEL_SRC, 'externalConsumedRef.current = decision.nextConsumed;', effectAt);
  assert.ok(setRefAt > callAt && setRefAt < closeAt);
  assert.doesNotMatch(
    PANEL_SRC,
    /externalConsumedRef\.current === externalAsk\.nonce/,
    'the inline nonce comparison is the defect this extraction replaced — it must not come back',
  );
  // Exactly one call site — a second copy could drift from this one.
  assert.equal(PANEL_SRC.split('decideExternalAsk(').length - 1, 1, 'one call site, no second decision');
});

test('the panel runs the ask BEFORE trusting the decision’s own gate — onAsked and run both read decision.ask', () => {
  const effectAt = indexOfOrFail(PANEL_SRC, 'const externalConsumedRef = useRef<number | null>(null);');
  const closeAt = indexOfOrFail(PANEL_SRC, "}, [externalAsk, run, onExternalAsked]);", effectAt);
  const guardAt = indexOfOrFail(PANEL_SRC, 'if (!decision.fire) return;', effectAt);
  const onAskedAt = indexOfOrFail(PANEL_SRC, 'onExternalAsked?.();', effectAt);
  const runAt = indexOfOrFail(PANEL_SRC, 'void run(decision.ask.question, decision.ask.slots);', effectAt);
  assert.ok(guardAt < onAskedAt && onAskedAt < runAt && runAt < closeAt, 'guard, then disarm, then run, in order');
});
