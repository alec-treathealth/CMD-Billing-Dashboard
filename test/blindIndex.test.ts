import assert from 'node:assert/strict';
import { test } from 'node:test';

// A fixed, valid 32-byte test key. Set BEFORE importing the module so getKey() picks it up;
// individual tests toggle it to exercise the unset path.
const TEST_KEY = 'ab'.repeat(32); // 64 hex chars
process.env.INDEX_HMAC_KEY = TEST_KEY;

const {
  memberIdBlindIndex,
  alphaPrefixBlindIndex,
  groupNumberBlindIndex,
  blindIndexesForRow,
  blindIndexesForRowSafe,
  memberIdNormalized,
  alphaPrefixNormalized,
  BlindIndexError,
  tokensEqual,
} = await import('../src/collections/blindIndex.js');

const HEX64 = /^[0-9a-f]{64}$/;

test('member-id blind index is deterministic and 64-char lowercase hex', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  const a = memberIdBlindIndex('ABC123456');
  const b = memberIdBlindIndex('ABC123456');
  assert.equal(a, b);
  assert.match(a!, HEX64);
});

test('normalization equivalence: case, internal whitespace, leading dash collapse to one token', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  const canonical = memberIdBlindIndex('AB123456');
  assert.equal(memberIdBlindIndex('ab 12 34 56'), canonical); // case + whitespace
  assert.equal(memberIdBlindIndex('-AB123456'), canonical); // leading dash stripped
  assert.equal(memberIdNormalized('ab 123'), 'AB123');
});

test('alpha prefix indexes the first 3 chars; a value and its own prefix agree', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  // Searching prefix "XYZ" must match a member whose id starts XYZ.
  assert.equal(alphaPrefixBlindIndex('XYZ998877'), alphaPrefixBlindIndex('xyz'));
  assert.equal(alphaPrefixNormalized('XYZ998877'), 'XYZ');
  // Fewer than 3 chars → no token (can't be matched against the 3-char index).
  assert.equal(alphaPrefixBlindIndex('XY'), null);
  assert.equal(alphaPrefixNormalized('XY'), null);
});

test('distinct values yield distinct tokens; group normalization mirrors member id', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  assert.notEqual(memberIdBlindIndex('AAA111'), memberIdBlindIndex('BBB222'));
  assert.equal(groupNumberBlindIndex('grp 001'), groupNumberBlindIndex('GRP001'));
});

test('blank / null inputs produce null tokens (not a hash of empty string)', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  assert.equal(memberIdBlindIndex(''), null);
  assert.equal(memberIdBlindIndex(null), null);
  assert.equal(groupNumberBlindIndex('   '), null);
  const row = blindIndexesForRow('AB123456', null);
  assert.match(row.member_id_bidx!, HEX64);
  assert.match(row.member_id_prefix_bidx!, HEX64);
  assert.equal(row.group_number_bidx, null); // no group number → null
});

test('key separation: a different INDEX_HMAC_KEY produces a different token', () => {
  process.env.INDEX_HMAC_KEY = TEST_KEY;
  const withKeyA = memberIdBlindIndex('AB123456');
  process.env.INDEX_HMAC_KEY = 'cd'.repeat(32);
  const withKeyB = memberIdBlindIndex('AB123456');
  assert.notEqual(withKeyA, withKeyB);
  process.env.INDEX_HMAC_KEY = TEST_KEY;
});

test('missing key: throwing variant throws; ingest-safe variant returns nulls (never breaks ingest)', () => {
  const saved = process.env.INDEX_HMAC_KEY;
  delete process.env.INDEX_HMAC_KEY;
  try {
    assert.throws(() => memberIdBlindIndex('AB123456'), BlindIndexError);
    const safe = blindIndexesForRowSafe('AB123456', 'GRP001');
    assert.deepEqual(safe, { member_id_bidx: null, member_id_prefix_bidx: null, group_number_bidx: null });
  } finally {
    process.env.INDEX_HMAC_KEY = saved;
  }
});

test('invalid key shape is rejected (fail-closed)', () => {
  const saved = process.env.INDEX_HMAC_KEY;
  process.env.INDEX_HMAC_KEY = 'too-short';
  try {
    assert.throws(() => memberIdBlindIndex('AB123456'), BlindIndexError);
  } finally {
    process.env.INDEX_HMAC_KEY = saved;
  }
});

test('tokensEqual is a length-safe constant-time comparison', () => {
  assert.equal(tokensEqual('abcd', 'abcd'), true);
  assert.equal(tokensEqual('abcd', 'abce'), false);
  assert.equal(tokensEqual('abcd', 'abcde'), false);
});
