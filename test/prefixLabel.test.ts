/**
 * prefixLabel — the token → alpha-prefix resolver behind the policy tape's readable handle.
 *
 * Hermetic: a fixed test key in env, no DB, no network. The map is built once for the whole file
 * (~47k HMACs, ~100ms) which is why the cases share it rather than resetting between them — the one
 * case that DOES reset asserts the reset itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HMAC_KEY = 'b'.repeat(64);
process.env.INDEX_HMAC_KEY = TEST_HMAC_KEY;

const { alphaPrefixBlindIndex } = await import('../src/collections/blindIndex.js');
const { prefixLabelFor, prefixLabelsFor, resetPrefixLabelIndex, PREFIX_LABEL_SPACE, PREFIX_ALPHABET } =
  await import('../src/collections/prefixLabel.js');

test('a token minted from a real prefix resolves back to that prefix', () => {
  for (const prefix of ['GGS', 'ABC', 'XYZ', 'W12', '123', '0A9']) {
    const token = alphaPrefixBlindIndex(prefix);
    assert.ok(token, `${prefix} must produce a token`);
    assert.equal(prefixLabelFor(token), prefix, `${prefix} must round-trip`);
  }
});

test('the SAME prefix typed with lowercase / whitespace resolves too — normalization is shared', () => {
  // The search path normalizes before hashing; the resolver enumerates NORMALIZED candidates, so a
  // token minted from messy input must still land on the clean label.
  const token = alphaPrefixBlindIndex('  ggs123  ');
  assert.ok(token);
  assert.equal(prefixLabelFor(token), 'GGS');
});

test('NEVER FABRICATED: an unknown token resolves to null, not to a guess', () => {
  assert.equal(prefixLabelFor('f'.repeat(64)), null);
  assert.equal(prefixLabelFor(''), null);
});

test('a prefix outside the candidate alphabet degrades to null rather than a wrong label', () => {
  // '.' is reachable: normalization only upper-cases, strips whitespace and strips a LEADING '-'.
  const token = alphaPrefixBlindIndex('A.B');
  assert.ok(token);
  assert.equal(prefixLabelFor(token), null, 'out-of-alphabet prefixes must miss, never mis-resolve');
});

test('the map is COMPLETE over the candidate space — every candidate is reachable', () => {
  assert.equal(PREFIX_LABEL_SPACE, PREFIX_ALPHABET.length ** 3);
  assert.equal(PREFIX_LABEL_SPACE, 46_656);
  // Spot-check the extremes of the enumeration, which an off-by-one in the triple loop would drop.
  for (const prefix of ['AAA', 'ZZZ', '000', '999', 'A00', '9ZZ']) {
    assert.equal(prefixLabelFor(alphaPrefixBlindIndex(prefix)!), prefix);
  }
});

test('prefixLabelsFor maps many tokens at once and OMITS the unresolvable ones', () => {
  const good = alphaPrefixBlindIndex('QWE')!;
  const bad = 'a'.repeat(64);
  const out = prefixLabelsFor([good, bad]);
  assert.equal(out.get(good), 'QWE');
  assert.equal(out.has(bad), false, 'an unresolvable token must be ABSENT, not mapped to null/""');
  assert.equal(out.size, 1);
});

test('a different key produces different tokens — the map is key-scoped, and reset re-derives it', () => {
  const tokenUnderTestKey = alphaPrefixBlindIndex('GGS')!;
  process.env.INDEX_HMAC_KEY = 'c'.repeat(64);
  resetPrefixLabelIndex();
  try {
    assert.equal(
      prefixLabelFor(tokenUnderTestKey),
      null,
      'a token from the OLD key must not resolve under the new one — otherwise the map is stale',
    );
    assert.equal(prefixLabelFor(alphaPrefixBlindIndex('GGS')!), 'GGS', 'and the new key resolves its own tokens');
  } finally {
    process.env.INDEX_HMAC_KEY = TEST_HMAC_KEY;
    resetPrefixLabelIndex();
  }
});
