/**
 * Payer-alias ruling queue — SQL builder invariants (hermetic; no DB, no network).
 *
 * Locks the properties that a review cannot re-derive by reading the SQL string:
 *  1. READ-ONLY — no builder can ever emit a write verb (Artifact 2 ships zero writes);
 *  2. PARAMETERIZED — values are $n, never interpolated, including every LIMIT;
 *  3. the ORDER BY encodes the measured tier (proposals first, then confidence, then alias_norm);
 *  4. untrusted route values clamp — NaN/negative/float/garbage cannot reach SQL;
 *  5. pg_trgm is addressed as `claims.*`, because the extension is NOT in public;
 *  6. RELATIONSHIP_REQUIRES_CANONICAL matches the live CHECK's own split, exhaustively.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPayerAliasNeighboursQuery,
  buildPayerAliasQueueCountsQuery,
  buildPayerAliasQueueQuery,
  buildPayerAliasSiblingsQuery,
  clampPage,
  clampVocabulary,
  isPayerAliasVocabulary,
  PAYER_ALIAS_RELATIONSHIPS,
  PAYER_ALIAS_VOCABULARIES,
  QUEUE_PAGE_SIZE,
  RELATIONSHIP_REQUIRES_CANONICAL,
  type PayerAliasRelationship,
} from '../src/collections/payerAliasQueue.js';

const ALL_BUILDERS = () => [
  buildPayerAliasQueueQuery('vob_insurance_co', 1),
  buildPayerAliasQueueCountsQuery(),
  buildPayerAliasSiblingsQuery(['CIGNA'], 'vob_insurance_co'),
  buildPayerAliasNeighboursQuery(['CIGNA']),
];

test('every builder is READ-ONLY — no write verb can reach the database', () => {
  for (const q of ALL_BUILDERS()) {
    const sql = q.sql.toLowerCase();
    for (const verb of ['insert ', 'update ', 'delete ', 'truncate', 'drop ', 'alter ', 'grant ']) {
      assert.equal(sql.includes(verb), false, `builder emitted "${verb.trim()}": ${q.sql}`);
    }
    assert.ok(sql.trimStart().startsWith('select'), 'every builder starts with select');
  }
});

test('no builder uses SELECT * — columns are projected explicitly', () => {
  for (const q of ALL_BUILDERS()) {
    assert.equal(/select\s+\*/i.test(q.sql), false, q.sql);
  }
});

test('scope: only ref.payer_alias_map and ref.payer_identity are touched', () => {
  for (const q of ALL_BUILDERS()) {
    // claims.payer_alias is a DIFFERENT table, deferred to Phase 3 — it must never appear here.
    assert.equal(q.sql.includes('claims.payer_alias'), false, q.sql);
    for (const m of q.sql.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)) {
      assert.ok(
        ['ref.payer_alias_map', 'ref.payer_identity'].includes(m[1] ?? ''),
        `unexpected relation ${m[1]}`,
      );
    }
  }
});

test('cross-tenant by ratified design — no builder filters on business_entity_id', () => {
  for (const q of ALL_BUILDERS()) {
    assert.equal(q.sql.includes('business_entity_id'), false, q.sql);
  }
});

test('queue query: only unruled rows, one vocabulary, bound as $1', () => {
  const q = buildPayerAliasQueueQuery('claims_primary_payer', 1);
  assert.ok(q.sql.includes('where m.needs_review and m.vocabulary = $1'));
  assert.equal(q.params[0], 'claims_primary_payer');
});

test('queue ORDER BY encodes the measured tier: proposals, then confidence, then alias_norm', () => {
  const q = buildPayerAliasQueueQuery('vob_insurance_co', 1);
  const order = q.sql.slice(q.sql.indexOf('order by'));
  // Tier 0 = a proposal exists. The CHECK payer_alias_map_relationship_canonical makes
  // "canonical_payer_id is not null" exactly equivalent to "there is something to accept",
  // which is why the tier keys on the column rather than on provenance strings.
  assert.ok(order.includes('(m.canonical_payer_id is null)'), order);
  assert.ok(order.includes('m.confidence desc nulls last'), order);
  assert.ok(order.indexOf('canonical_payer_id is null') < order.indexOf('m.confidence'), order);
  // alias_norm is half the PK, so it makes the sort total within a vocabulary — paging is stable.
  assert.ok(order.trimEnd().endsWith('m.alias_norm') || order.includes('m.alias_norm limit'), order);
});

test('queue paging: offset is derived, bounded, and always a bound param', () => {
  assert.deepEqual(buildPayerAliasQueueQuery('vob_payer_id', 1).params, ['vob_payer_id', 25, 0]);
  assert.deepEqual(buildPayerAliasQueueQuery('vob_payer_id', 3).params, ['vob_payer_id', 25, 50]);
  assert.ok(buildPayerAliasQueueQuery('vob_payer_id', 1).sql.includes('limit $2 offset $3'));
});

test('queue paging: a NaN or garbage page size cannot reach SQL', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
    const q = buildPayerAliasQueueQuery('vob_insurance_co', 1, bad as number);
    const size = q.params[1] as number;
    assert.ok(Number.isInteger(size) && size >= 1 && size <= 100, `size was ${String(size)}`);
  }
  // The default is used when the value is unusable, not some silently different number.
  assert.equal(buildPayerAliasQueueQuery('vob_insurance_co', 1, Number.NaN).params[1], QUEUE_PAGE_SIZE);
});

test('clampPage: garbage, floats, negatives and overflow all land in range', () => {
  assert.equal(clampPage(undefined), 1);
  assert.equal(clampPage('not-a-number'), 1);
  assert.equal(clampPage(Number.NaN), 1);
  assert.equal(clampPage(-3), 1);
  assert.equal(clampPage(0), 1);
  assert.equal(clampPage(2.9), 2);
  assert.equal(clampPage('4'), 4);
  assert.equal(clampPage(10_000), 200);
});

test('clampVocabulary: defaults to the largest queue, never trusts route text', () => {
  assert.equal(clampVocabulary(undefined), 'vob_insurance_co');
  assert.equal(clampVocabulary('nonsense'), 'vob_insurance_co');
  assert.equal(clampVocabulary("'; drop table ref.payer_alias_map --"), 'vob_insurance_co');
  assert.equal(clampVocabulary('vob_payer_id'), 'vob_payer_id');
  for (const v of PAYER_ALIAS_VOCABULARIES) assert.equal(clampVocabulary(v), v);
});

test('isPayerAliasVocabulary rejects non-strings and unknown members', () => {
  assert.equal(isPayerAliasVocabulary('vob_insurance_co'), true);
  assert.equal(isPayerAliasVocabulary('claims_primary_payer'), true);
  assert.equal(isPayerAliasVocabulary(null), false);
  assert.equal(isPayerAliasVocabulary(7), false);
  assert.equal(isPayerAliasVocabulary('VOB_INSURANCE_CO'), false);
});

test('siblings query: alias_norm is a BOUND ARRAY PARAM, never interpolated', () => {
  const q = buildPayerAliasSiblingsQuery(['CIGNA', "O'MALLEY EMPLOYER"], 'vob_insurance_co');
  assert.ok(q.sql.includes('s.alias_norm = any($1::text[])'));
  assert.ok(q.sql.includes('s.vocabulary <> $2'));
  // The employer-shaped string with a quote in it must not appear in the SQL text at all.
  assert.equal(q.sql.includes("O'MALLEY"), false);
  assert.deepEqual(q.params[0], ['CIGNA', "O'MALLEY EMPLOYER"]);
  assert.equal(q.params[1], 'vob_insurance_co');
});

test('siblings query copies its input array — a later caller mutation cannot alter the params', () => {
  const input = ['CIGNA'];
  const q = buildPayerAliasSiblingsQuery(input, 'vob_payer_id');
  input.push('MUTATED');
  assert.deepEqual(q.params[0], ['CIGNA']);
});

test('neighbours query: pg_trgm is addressed as claims.*, because it is NOT in public', () => {
  const q = buildPayerAliasNeighboursQuery(['ANTHEM BCBS GA']);
  assert.ok(q.sql.includes('operator(claims.%)'), q.sql);
  assert.ok(q.sql.includes('claims.similarity('), q.sql);
  // An unqualified operator would resolve only if `claims` happened to be on the search_path.
  assert.equal(/\s%\s/.test(q.sql.replace(/operator\(claims\.%\)/g, '')), false, q.sql);
});

test('neighbours query: only CONFIRMED look-alikes, never the seed itself', () => {
  const q = buildPayerAliasNeighboursQuery(['ANTHEM BCBS GA']);
  assert.ok(q.sql.includes('not x.needs_review'), q.sql);
  assert.ok(q.sql.includes('x.alias_norm <> q.alias_norm'), q.sql);
});

test('neighbours query: the per-seed LIMIT is a bound param, and clamps', () => {
  assert.ok(buildPayerAliasNeighboursQuery(['A']).sql.includes('limit $2'));
  assert.equal(buildPayerAliasNeighboursQuery(['A']).params[1], 3);
  assert.equal(buildPayerAliasNeighboursQuery(['A'], 99).params[1], 10);
  assert.equal(buildPayerAliasNeighboursQuery(['A'], 0).params[1], 1);
  assert.equal(buildPayerAliasNeighboursQuery(['A'], Number.NaN).params[1], 3);
});

test('counts query covers every vocabulary without a WHERE on vocabulary', () => {
  const q = buildPayerAliasQueueCountsQuery();
  assert.ok(q.sql.includes('where needs_review group by vocabulary'));
  assert.deepEqual(q.params, []);
});

test('all six relationships are exposed — the four in live use are not the whole vocabulary', () => {
  assert.deepEqual([...PAYER_ALIAS_RELATIONSHIPS].sort(), [
    'carve_out',
    'employer_self_funded',
    'program_label',
    'same_payer',
    'tpa',
    'unmapped',
  ]);
});

test('RELATIONSHIP_REQUIRES_CANONICAL mirrors payer_alias_map_relationship_canonical exactly', () => {
  // The live CHECK:
  //   (relationship in (same_payer,carve_out,tpa,employer_self_funded) AND canonical IS NOT NULL)
  //   OR (relationship in (program_label,unmapped)                     AND canonical IS NULL)
  const requires: PayerAliasRelationship[] = ['same_payer', 'carve_out', 'tpa', 'employer_self_funded'];
  const forbids: PayerAliasRelationship[] = ['program_label', 'unmapped'];
  for (const r of requires) assert.equal(RELATIONSHIP_REQUIRES_CANONICAL[r], true, r);
  for (const r of forbids) assert.equal(RELATIONSHIP_REQUIRES_CANONICAL[r], false, r);
  // Exhaustive: a seventh relationship added to the union without a mapping fails here.
  assert.equal(Object.keys(RELATIONSHIP_REQUIRES_CANONICAL).length, PAYER_ALIAS_RELATIONSHIPS.length);
  for (const r of PAYER_ALIAS_RELATIONSHIPS) {
    assert.equal(typeof RELATIONSHIP_REQUIRES_CANONICAL[r], 'boolean', r);
  }
});
