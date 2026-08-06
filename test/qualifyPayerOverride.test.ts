/**
 * The payer drill-down's LIFETIME rule (code review, 2026-08-06).
 *
 * The bug: the override was stored as a bare payer string and cleared by
 * `useEffect(() => setPayerOverride(null), [singleIdentifier])`. Effects run after the commit, so on
 * the render where the identifier changed the snapshot-fetch effect in the SAME commit still closed
 * over the previous override and sent it — scoping a NEW patient's first fetch to the PREVIOUS
 * patient's payer. The server honours an override that matches the new identifier's own spread, so a
 * common carrier name is silently applied rather than rejected.
 *
 * The fix pairs the payer with its identifier so the stale state is unrepresentable, and derives the
 * effective value during render. These tests pin the derivation. The component wiring itself is not
 * unit-testable here (no jsdom/interaction infrastructure in this repo, and the standing rules
 * forbid adding a test-runner dependency) — extracting the rule to a pure function IS how it becomes
 * verifiable, which is the reason it lives in its own module.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { effectivePayerOverride } from '../app/lib/qualify/payerOverride.js';

test('THE REGRESSION: a search transition drops the previous identifier’s payer immediately', () => {
  // The user drilled into CIGNA while searching W20, then searched W29. This is evaluated during
  // the render where singleIdentifier is already W29 but the stored override still says W20 —
  // exactly the state the old effect-based reset could not clear in time.
  const stored = { identifier: 'W20', payer: 'CIGNA' };
  assert.equal(effectivePayerOverride(stored, 'W29'), null, 'the new patient is NOT scoped to CIGNA');
  // And it stays applied for the identifier it was actually chosen for.
  assert.equal(effectivePayerOverride(stored, 'W20'), 'CIGNA');
});

test('a payer that EXISTS on both identifiers is still dropped — the pairing, not the name, decides', () => {
  // The dangerous case: AETNA is on nearly every prefix, so the server would accept it as a valid
  // override for the new identifier and silently scope the result. Membership in the new spread must
  // not be what saves us here; the identifier pairing is.
  const stored = { identifier: 'W20', payer: 'AETNA' };
  assert.equal(effectivePayerOverride(stored, 'W29'), null);
});

test('no override, no identifier, and a blank identifier all resolve to null', () => {
  assert.equal(effectivePayerOverride(null, 'W29'), null);
  assert.equal(effectivePayerOverride({ identifier: 'W20', payer: 'CIGNA' }, null), null);
  // '' is the cleared-search state; an override must not survive into it and re-apply on the next
  // search that happens to reuse the same identifier string.
  assert.equal(effectivePayerOverride({ identifier: '', payer: 'CIGNA' }, ''), null);
});

test('matching is exact — a different-cased or padded identifier is a DIFFERENT search', () => {
  const stored = { identifier: 'W20', payer: 'CIGNA' };
  assert.equal(effectivePayerOverride(stored, 'w20'), null);
  assert.equal(effectivePayerOverride(stored, ' W20'), null);
  // Anything else would guess at equivalence between two searches, and guessing wrong here means
  // scoping one patient's ranking to another patient's payer.
});

test('re-selecting on the SAME identifier keeps working — the fix must not disable the feature', () => {
  const first = { identifier: 'W29', payer: 'CIGNA' };
  assert.equal(effectivePayerOverride(first, 'W29'), 'CIGNA');
  const second = { identifier: 'W29', payer: 'BCBS' };
  assert.equal(effectivePayerOverride(second, 'W29'), 'BCBS');
});

test('returning to a previous identifier does NOT resurrect its old override', () => {
  // W20 -> W29 -> W20. Only ONE override is stored, and by the time the user is back on W20 it
  // belongs to whatever they last picked. A stored W20 entry that survived the round trip would
  // re-apply a scope the user set minutes ago and has no reason to expect.
  const storedAfterSearchingW29 = { identifier: 'W29', payer: 'BCBS' };
  assert.equal(effectivePayerOverride(storedAfterSearchingW29, 'W20'), null, 'W20 comes back unscoped');
});
