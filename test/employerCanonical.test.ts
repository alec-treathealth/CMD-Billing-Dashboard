/**
 * CANONICAL EMPLOYER NAMES (2026-08-17).
 *
 * The fixtures are LIVE collections data, not invented. Typing "Tesla" offered three options and
 * GOOGLE offered six; picking one returned a fraction of that employer's rows with a perfectly
 * plausible number on screen. See src/collections/employerCanonical.ts for the full measurement.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalEmployerKey,
  expandEmployerKeys,
  groupEmployerNames,
} from '../src/collections/employerCanonical.js';

// ── 1. The reported case ────────────────────────────────────────────────────────────────────────
test('the three live Tesla spellings collapse to one option', () => {
  const opts = groupEmployerNames(['TESLA,INC.', 'TESLA INC', 'TESLA, INC.']);
  assert.equal(opts.length, 1, 'three picker rows became one');
  assert.equal(opts[0]!.key, 'TESLA');
  assert.equal(opts[0]!.variantCount, 3);
  // EVERY spelling must be carried, because these are what the SQL predicate matches. Miss one and
  // the grid silently under-selects — the exact defect, just harder to see.
  assert.deepEqual(opts[0]!.variants, ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.']);
});

test('the six live GOOGLE spellings collapse to one option', () => {
  // Live: picking `GOOGLE` returned 98 of 1,044 rows before this.
  const opts = groupEmployerNames([
    'GOOGLE PPO', 'GOOGLE GHIP CHDP HSA W/NON-INT', 'GOOGLE INC',
    'GOOGLE', 'GOOGLE LLC', 'GOOGLE GHIP CHDP HSA W/NON-INT BAN',
  ]);
  assert.equal(opts.length, 1);
  assert.equal(opts[0]!.key, 'GOOGLE');
  assert.equal(opts[0]!.variantCount, 6);
});

test('other live groups: punctuation-only, and suffix-only', () => {
  // APPLE INC / APPLE INC. differ only by a period — de-punctuation alone merges them.
  assert.equal(canonicalEmployerKey('APPLE INC'), canonicalEmployerKey('APPLE INC.'));
  // TEXAS-ACTIVE / TEXAS- ACTIVE / TEXAS ACTIVE — hyphen vs space vs both.
  const texas = groupEmployerNames(['TEXAS ACTIVE', 'TEXAS- ACTIVE', 'TEXAS-ACTIVE']);
  assert.equal(texas.length, 1);
  assert.equal(texas[0]!.key, 'TEXAS ACTIVE');
  // BANK OF AMERICA CORPORATION / CORP / bare — truncation, not punctuation.
  const bofa = groupEmployerNames(['BANK OF AMERICA CORPORATION', 'BANK OF AMERICA CORP', 'BANK OF AMERICA']);
  assert.equal(bofa.length, 1);
  assert.equal(bofa[0]!.key, 'BANK OF AMERICA');
});

// ── 2. THE MERGES THAT MUST NOT HAPPEN ──────────────────────────────────────────────────────────
test('two different companies never merge', () => {
  const names = ['TESLA INC', 'APPLE INC', 'GOOGLE LLC', 'ORACLE INC', 'WALMART INC'];
  const opts = groupEmployerNames(names);
  assert.equal(opts.length, 5, 'stripping INC/LLC must not collapse unrelated employers');
  assert.deepEqual(opts.map((o) => o.key), ['APPLE', 'GOOGLE', 'ORACLE', 'TESLA', 'WALMART']);
});

test('a noise token inside a word does not truncate — the \\b guard', () => {
  // 'CO' is a noise token. If it matched without word boundaries, every one of these would be cut
  // to its first two letters and unrelated employers would pile onto the same key.
  assert.equal(canonicalEmployerKey('COCA COLA CO'), 'COCA COLA');
  assert.equal(canonicalEmployerKey('COSTCO WHOLESALE'), 'COSTCO WHOLESALE');
  assert.equal(canonicalEmployerKey('CONAGRA BRANDS'), 'CONAGRA BRANDS');
  // 'LP' inside 'ALPHABET' would be catastrophic — it would truncate to 'A'.
  assert.equal(canonicalEmployerKey('ALPHABET'), 'ALPHABET');
  // 'PLAN' inside 'PLANET' likewise.
  assert.equal(canonicalEmployerKey('PLANET FITNESS'), 'PLANET FITNESS');
});

test('a name that STARTS with a noise word keeps its full cleaned form, never ""', () => {
  // Truncation would empty these. Emptying is the worst available failure: every such employer
  // would collapse into ONE bucket keyed '', merging companies that have nothing to do with
  // each other. The fallback is what prevents it.
  for (const n of ['GROUP HEALTH COOPERATIVE', 'TRUST COMPANY OF THE WEST', 'BENEFIT ADMINISTRATORS']) {
    const k = canonicalEmployerKey(n);
    assert.notEqual(k, '', `${n} must not normalize to empty`);
  }
  assert.equal(canonicalEmployerKey('GROUP HEALTH COOPERATIVE'), 'GROUP HEALTH COOPERATIVE');
  // ...and they stay DISTINCT from each other, which is the consequence that actually matters.
  const opts = groupEmployerNames(['GROUP HEALTH COOPERATIVE', 'TRUST COMPANY OF THE WEST']);
  assert.equal(opts.length, 2);
});

// ── 3. Blanks belong to the Individual segment, not to a bucket ─────────────────────────────────
test('blank and punctuation-only names are dropped, not bucketed', () => {
  // A blank employer means "individual" — a different dimension. Bucketing them would put an
  // unpickable blank row in the type-ahead and would blur the employer/individual partition.
  const opts = groupEmployerNames(['', '   ', '---', ',,,', 'TESLA INC']);
  assert.equal(opts.length, 1);
  assert.equal(opts[0]!.key, 'TESLA');
  assert.equal(canonicalEmployerKey('---'), '');
});

// ── 4. Grouping hygiene ─────────────────────────────────────────────────────────────────────────
test('a duplicate raw spelling never inflates variantCount', () => {
  // variantCount is rendered to the user as "N spellings"; a non-DISTINCT input must not lie.
  const opts = groupEmployerNames(['TESLA INC', 'TESLA INC', 'TESLA,INC.']);
  assert.equal(opts[0]!.variantCount, 2);
  assert.deepEqual(opts[0]!.variants, ['TESLA INC', 'TESLA,INC.']);
});

test('options and variants are sorted, and an unmerged employer reports variantCount 1', () => {
  const opts = groupEmployerNames(['ZEBRA CO', 'APPLE INC']);
  assert.deepEqual(opts.map((o) => o.key), ['APPLE', 'ZEBRA']);
  assert.equal(opts[0]!.variantCount, 1);
});

// ── 5. Expansion — what actually reaches the SQL predicate ──────────────────────────────────────
test('picking a canonical key sends every raw spelling to the filter', () => {
  const opts = groupEmployerNames(['TESLA,INC.', 'TESLA INC', 'TESLA, INC.', 'APPLE INC']);
  assert.deepEqual(expandEmployerKeys(['TESLA'], opts), ['TESLA INC', 'TESLA, INC.', 'TESLA,INC.']);
  assert.equal(expandEmployerKeys(['TESLA', 'APPLE'], opts).length, 4);
});

test('an UNKNOWN key falls back to itself rather than being dropped', () => {
  // Dropping it would WIDEN the grid: a chip naming an employer while the results ignore it. Passing
  // it through at worst matches nothing, which is honest.
  const opts = groupEmployerNames(['APPLE INC']);
  assert.deepEqual(expandEmployerKeys(['NOT A REAL EMPLOYER'], opts), ['NOT A REAL EMPLOYER']);
  assert.deepEqual(expandEmployerKeys([], opts), [], 'no keys, no predicate');
});

test('expansion de-duplicates', () => {
  const opts = groupEmployerNames(['APPLE INC']);
  // The unknown-key fallback can collide with a real variant; a repeat in `= any(...)` is waste.
  assert.deepEqual(expandEmployerKeys(['APPLE', 'APPLE INC'], opts), ['APPLE INC']);
});

// ── 6. THE INVARIANT THAT KEEPS THE FILTER HONEST ───────────────────────────────────────────────
test('every raw name is reachable through exactly one canonical key', () => {
  // If a spelling belonged to no key, it would be unfindable AND unselectable — invisible data. If
  // it belonged to two, picking either would over-select. This walks the whole shape at once.
  const raw = [
    'TESLA,INC.', 'TESLA INC', 'TESLA, INC.', 'APPLE INC', 'APPLE INC.', 'APPLE',
    'GOOGLE PPO', 'GOOGLE', 'GOOGLE LLC', 'WHOLE FOODS MARKET, INC.', 'WHOLE FOODS MARKET, INC',
    'GROUP HEALTH COOPERATIVE', 'HCA HEALTHCARE', 'HCA HEALTHCARE.',
  ];
  const opts = groupEmployerNames(raw);
  const seen = opts.flatMap((o) => o.variants);
  assert.equal(seen.length, new Set(seen).size, 'no spelling appears under two keys');
  assert.deepEqual([...seen].sort(), [...raw].sort(), 'every spelling is reachable');
  // And selecting every option reproduces the entire vocabulary — the filter can always express
  // "all employers", which is what the All segment must agree with.
  assert.deepEqual(expandEmployerKeys(opts.map((o) => o.key), opts).sort(), [...raw].sort());
});
