/**
 * WHAT A FAILED MANUAL DEPOSIT TELLS THE OPERATOR (0098, 2026-08-10).
 *
 * This map decides what someone sees after a money write is refused, and the failure mode it has to
 * avoid is specific: a message that says "that may not have been saved — reopen this panel to check"
 * for a refusal where nothing was written INVITES a retry. Before 0098 that retry hit a bare 23505
 * and went nowhere; the reason it matters now is that the operator's other likely move — re-keying
 * the deposit because the MTD figure never moved — is how the same payment gets recorded twice.
 *
 * So the assertions below are about the DIRECTION of each message, not its wording. Every code the
 * Server Action can actually return must be either "nothing happened, here is what to fix" or
 * "already recorded, here is where it is" — never "unknown, go and check".
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { depositErrorText, DEPOSIT_UNKNOWN_OUTCOME } from '../lib/forecast/deposit-feedback';

/** The unknown-outcome wording, read from the module rather than retyped — a copy here would drift
 *  from the source and start asserting against a sentence nobody renders. */
const UNKNOWN = DEPOSIT_UNKNOWN_OUTCOME;

/**
 * Every code `addManualDeposit` can return, read off the action rather than hand-listed — a
 * hand-listed set drifts silently the moment someone adds a guard, which is exactly how
 * `bad_facility` and `bad_method` came to fall through to the unknown-outcome message.
 */
const ACTIONS_SRC = readFileSync(new URL('../lib/actions.ts', import.meta.url), 'utf8');
const addManualDepositBody = (() => {
  const start = ACTIONS_SRC.indexOf('export async function addManualDeposit(');
  assert.ok(start > 0, 'addManualDeposit not found — this test is reading the wrong file');
  const next = ACTIONS_SRC.indexOf('\nexport ', start + 10);
  return ACTIONS_SRC.slice(start, next === -1 ? undefined : next);
})();

function codesReturnedByAction(): string[] {
  const out = new Set<string>();
  for (const m of addManualDepositBody.matchAll(/error:\s*'([a-z_]+)'/g)) out.add(m[1]!);
  return [...out];
}

test('every code the action returns has its own message — none falls through to "unknown"', () => {
  const codes = codesReturnedByAction();
  // Sanity: the scrape found a realistic set, not zero or the whole file.
  assert.ok(codes.length >= 6, `only found ${codes.length} codes — the scrape is broken`);
  const fellThrough = codes.filter((c) => c !== 'write_failed' && depositErrorText(c) === UNKNOWN);
  assert.deepEqual(
    fellThrough,
    [],
    `these codes reach the operator as an unknown outcome, but nothing was written for any of ` +
      `them — the message invites a retry that can double-count: ${fellThrough.join(', ')}`,
  );
});

test('write_failed is the one code allowed to claim an unknown outcome', () => {
  // It is the genuine unknown: the exception escaped after the write may or may not have landed.
  assert.equal(depositErrorText('write_failed'), UNKNOWN);
  assert.equal(depositErrorText('something_nobody_defined'), UNKNOWN);
});

test('deposit_exists points at the existing row instead of inviting a retry', () => {
  // SQLSTATE DP001 from migration 0098. The money IS recorded, retrying fails identically, and the
  // corrective action is remove-and-recombine — so the message has to say all three.
  const msg = depositErrorText('deposit_exists');
  assert.notEqual(msg, UNKNOWN);
  assert.match(msg, /already recorded/i, 'it must say the payment is already there');
  assert.match(msg, /remove/i, 'and name the way out');
  assert.doesNotMatch(msg, /try(ing)? again/i, 'it must not invite the retry that double-counts');
});

test('the two pre-write validation refusals say what to fix', () => {
  assert.match(depositErrorText('bad_facility'), /facility/i);
  assert.match(depositErrorText('bad_method'), /EFT|Check/);
  for (const code of ['bad_facility', 'bad_method', 'bad_amount', 'bad_date']) {
    assert.notEqual(depositErrorText(code), UNKNOWN, `${code} is rejected before any write`);
  }
});

test('facility_retired is REACHABLE and keeps its message', () => {
  // ⚠ Recorded because a review round asserted the opposite. Several angles claimed this branch was
  // dead, citing a "NO LIVENESS GUARD HERE, and its absence is deliberate" comment in actions.ts —
  // that comment does not exist, and addManualDeposit does call facilityIsActiveForEntity and
  // return 'facility_retired'. This test is the standing proof, so the claim cannot be relitigated
  // from memory.
  assert.match(addManualDepositBody, /facilityIsActiveForEntity/);
  assert.match(addManualDepositBody, /error:\s*'facility_retired'/);
  assert.notEqual(depositErrorText('facility_retired'), UNKNOWN);
});

test('the DP001 mapping is matched on SQLSTATE, never on the message text', () => {
  // The message names the row and its amount and will be reworded; the code is the contract.
  assert.match(ACTIONS_SRC, /code === 'DP001'/);
  assert.match(ACTIONS_SRC, /error:\s*'deposit_exists'/);
  assert.doesNotMatch(
    addManualDepositBody,
    /message.*already exists/i,
    'do not match the refusal by its prose — reword it once and the mapping dies silently',
  );
});
