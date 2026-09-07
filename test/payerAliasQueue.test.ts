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
  buildPayerAliasContainmentQuery,
  buildPayerAliasNeighboursQuery,
  buildPayerAliasQueueCountsQuery,
  buildPayerAliasQueueQuery,
  buildPayerAliasRulingCall,
  buildPayerAliasSiblingsQuery,
  buildPayerIdentityOptionsQuery,
  clampPage,
  clampVocabulary,
  isPayerAliasVocabulary,
  PAYER_ALIAS_RELATIONSHIPS,
  PAYER_ALIAS_RULING_AUDIT_ACTION,
  PAYER_ALIAS_RULING_FN,
  PAYER_ALIAS_VOCABULARIES,
  QUEUE_PAGE_SIZE,
  RELATIONSHIP_REQUIRES_CANONICAL,
  validateRulingContainment,
  validateRulingShape,
  type PayerAliasRelationship,
} from '../src/collections/payerAliasQueue.js';

/**
 * ⚠️ THE READ/WRITE SPLIT IS THE GUARD, AND IT WAS TIGHTENED RATHER THAN RELAXED WHEN THE WRITE PATH
 * LANDED (2026-09-06).
 *
 * Before: one list, "no builder emits a write verb". That check would have stayed GREEN when the
 * definer call arrived, because `select ref.rule_payer_alias(...)` contains no write verb — it would
 * have gone on asserting a property that had quietly stopped meaning anything.
 *
 * After: two lists. READ builders must additionally NOT invoke the definer — a genuinely new
 * assertion the old grep could not make — and the WRITE list must contain exactly ONE builder, which
 * must itself be a bare `select` of the definer and nothing else. Adding a second write builder, or
 * slipping a definer call into a read builder, now fails. The exemption is scoped to one named
 * function, not to the file.
 */
const READ_BUILDERS = () => [
  buildPayerAliasQueueQuery('vob_insurance_co', 1),
  buildPayerAliasQueueCountsQuery(),
  buildPayerAliasSiblingsQuery(['CIGNA'], 'vob_insurance_co'),
  buildPayerAliasNeighboursQuery(['CIGNA']),
  buildPayerIdentityOptionsQuery(),
  buildPayerAliasContainmentQuery('vob_insurance_co', 'CIGNA', 'pi_cigna'),
];

const WRITE_BUILDERS = () => [
  buildPayerAliasRulingCall({
    vocabulary: 'vob_insurance_co',
    aliasNorm: 'CIGNA',
    action: 'confirm',
    relationship: 'same_payer',
    canonicalPayerId: 'pi_cigna',
    reviewNote: null,
    ruledBy: 'a@b.co',
  }),
];

const ALL_BUILDERS = () => [...READ_BUILDERS(), ...WRITE_BUILDERS()];

const WRITE_VERBS = ['insert ', 'update ', 'delete ', 'truncate', 'drop ', 'alter ', 'grant '];

test('READ builders are read-only — no write verb AND no definer invocation', () => {
  for (const q of READ_BUILDERS()) {
    const sql = q.sql.toLowerCase();
    for (const verb of WRITE_VERBS) {
      assert.equal(sql.includes(verb), false, `read builder emitted "${verb.trim()}": ${q.sql}`);
    }
    // THE TIGHTENING: a read builder may not reach the write path by calling the definer either.
    assert.equal(sql.includes('rule_payer_alias'), false, `read builder calls the definer: ${q.sql}`);
    assert.ok(sql.trimStart().startsWith('select'), 'every read builder starts with select');
  }
});

test('exactly ONE builder may cause a write, and only through the definer', () => {
  const writers = WRITE_BUILDERS();
  assert.equal(writers.length, 1, 'a second write builder is a rule violation, not a refactor');
  const sql = writers[0]!.sql;
  // The builder itself still emits no write verb — the mutation is the definer's, under its owner.
  for (const verb of WRITE_VERBS) {
    assert.equal(sql.toLowerCase().includes(verb), false, `the write builder emitted "${verb.trim()}"`);
  }
  assert.match(sql, /^select ref\.rule_payer_alias\(\$1, \$2, \$3, \$4, \$5, \$6, \$7\) as ruling_id$/);
  assert.equal(PAYER_ALIAS_RULING_FN, 'ref.rule_payer_alias');
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE WRITE PATH — containment must cover EVERY rejection the definer can raise.
 *
 * ⚠️ WHY THIS MATTERS MORE THAN USUAL. Probing the applied definer (2026-09-06) showed its
 * `needs_review` row guard runs FIRST, before any field validation. So a bad relationship on an
 * already-ruled (or misspelled) alias returns `P0002 no unruled row`, not the `22023` the field
 * deserves — the database structurally cannot tell a user which field is wrong. Four probes intended
 * to exercise relationship validation all came back P0002 for exactly this reason.
 *
 * That ordering is correct and must not be reordered. The consequence is that every definer
 * rejection has to be restated in TS, and this block is the proof that none was missed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

const baseInput = (over: Partial<Parameters<typeof validateRulingShape>[0]> = {}) => ({
  vocabulary: 'vob_insurance_co' as const,
  aliasNorm: 'CIGNA',
  action: 'confirm' as const,
  relationship: 'same_payer' as PayerAliasRelationship | null,
  canonicalPayerId: 'pi_cigna' as string | null,
  reviewNote: null as string | null,
  ruledBy: 'alec@treathealth.ai',
  ...over,
});

test('containment covers EVERY definer rejection — each names a field, none is left to the DB', () => {
  // Each row is a rejection ref.rule_payer_alias can raise, and the field a user should be pointed at.
  const cases: Array<[string, ReturnType<typeof baseInput>, string]> = [
    ['bad action', baseInput({ action: 'vaporize' as never }), 'action'],
    ['empty ruled_by', baseInput({ ruledBy: '  ' }), 'ruledBy'],
    ['ruled_by under 3 chars', baseInput({ ruledBy: 'ab' }), 'ruledBy'],
    ['alias over 200 chars', baseInput({ aliasNorm: 'x'.repeat(201) }), 'alias'],
    ['empty alias', baseInput({ aliasNorm: '' }), 'alias'],
    ['confirm with null relationship', baseInput({ relationship: null }), 'relationship'],
    ['confirm with unknown relationship', baseInput({ relationship: 'friend' as never }), 'relationship'],
    ['same_payer without canonical', baseInput({ canonicalPayerId: null }), 'canonicalPayerId'],
    ['tpa without canonical', baseInput({ relationship: 'tpa', canonicalPayerId: null }), 'canonicalPayerId'],
    ['carve_out without canonical', baseInput({ relationship: 'carve_out', canonicalPayerId: null }), 'canonicalPayerId'],
    ['employer_self_funded without canonical', baseInput({ relationship: 'employer_self_funded', canonicalPayerId: null }), 'canonicalPayerId'],
    ['unmapped WITH canonical', baseInput({ relationship: 'unmapped', canonicalPayerId: 'pi_cigna' }), 'canonicalPayerId'],
    ['program_label WITH canonical', baseInput({ relationship: 'program_label', canonicalPayerId: 'pi_cigna' }), 'canonicalPayerId'],
    ['canonical of the wrong shape', baseInput({ canonicalPayerId: 'CIGNA' }), 'canonicalPayerId'],
    ['canonical with uppercase', baseInput({ canonicalPayerId: 'pi_CIGNA' }), 'canonicalPayerId'],
    ['defer with no note', baseInput({ action: 'defer', reviewNote: null }), 'reviewNote'],
    ['defer with a 1-char note', baseInput({ action: 'defer', reviewNote: 'x' }), 'reviewNote'],
    ['defer with a 501-char note', baseInput({ action: 'defer', reviewNote: 'x'.repeat(501) }), 'reviewNote'],
    ['confirm with a 501-char note', baseInput({ reviewNote: 'x'.repeat(501) }), 'reviewNote'],
  ];
  for (const [name, input, field] of cases) {
    const err = validateRulingShape(input);
    assert.ok(err !== null, `${name}: expected a rejection, got none`);
    assert.equal(err.field, field, `${name}: blamed the wrong field`);
    assert.ok(err.message.length > 0, `${name}: rejection carries no message`);
  }
});

test('containment does NOT over-reject — every legitimate ruling passes', () => {
  const ok: Array<[string, ReturnType<typeof baseInput>]> = [
    ['same_payer with canonical', baseInput()],
    ['carve_out with canonical', baseInput({ relationship: 'carve_out' })],
    ['tpa with canonical', baseInput({ relationship: 'tpa' })],
    ['employer_self_funded with canonical', baseInput({ relationship: 'employer_self_funded' })],
    ['rule as unmapped', baseInput({ relationship: 'unmapped', canonicalPayerId: null })],
    ['program_label', baseInput({ relationship: 'program_label', canonicalPayerId: null })],
    ['confirm with a note', baseInput({ reviewNote: 'checked the payer id spine' })],
    ['confirm with an empty note (stored as NULL)', baseInput({ reviewNote: '' })],
    ['defer with a note', baseInput({ action: 'defer', reviewNote: 'ambiguous, needs the plan doc' })],
    ['a 500-char note exactly', baseInput({ reviewNote: 'x'.repeat(500) })],
    ['a 200-char alias exactly', baseInput({ aliasNorm: 'x'.repeat(200) })],
  ];
  for (const [name, input] of ok) {
    assert.equal(validateRulingShape(input), null, `${name}: rejected a legitimate ruling`);
  }
});

test('EVERY relationship is covered by the pairing rule — a seventh cannot slip through unchecked', () => {
  for (const r of PAYER_ALIAS_RELATIONSHIPS) {
    const requires = RELATIONSHIP_REQUIRES_CANONICAL[r];
    // With the canonical it requires → accepted. Without → rejected. Both directions, all six.
    const withCanon = baseInput({ relationship: r, canonicalPayerId: 'pi_x' });
    const without = baseInput({ relationship: r, canonicalPayerId: null });
    assert.equal(validateRulingShape(requires ? withCanon : without), null, `${r}: valid form rejected`);
    assert.ok(validateRulingShape(requires ? without : withCanon) !== null, `${r}: invalid form accepted`);
  }
});

test('DB containment: a missing row, an already-ruled row, and a dead canonical each name a field', () => {
  const input = baseInput();
  assert.equal(
    validateRulingContainment(input, { rowNeedsReview: null, canonicalActive: true })?.field,
    'alias',
  );
  assert.equal(
    validateRulingContainment(input, { rowNeedsReview: false, canonicalActive: true })?.field,
    'alias',
  );
  assert.equal(
    validateRulingContainment(input, { rowNeedsReview: true, canonicalActive: null })?.field,
    'canonicalPayerId',
  );
  assert.equal(
    validateRulingContainment(input, { rowNeedsReview: true, canonicalActive: false })?.field,
    'canonicalPayerId',
  );
  assert.equal(validateRulingContainment(input, { rowNeedsReview: true, canonicalActive: true }), null);
});

test('DB containment ignores canonical facts when the ruling carries no canonical', () => {
  const unmapped = baseInput({ relationship: 'unmapped', canonicalPayerId: null });
  // A null canonicalActive here means "we did not ask", not "it is missing".
  assert.equal(validateRulingContainment(unmapped, { rowNeedsReview: true, canonicalActive: null }), null);
});

test('the already-ruled message tells the reviewer to refresh, not that something broke', () => {
  const err = validateRulingContainment(baseInput(), { rowNeedsReview: false, canonicalActive: true });
  assert.ok(err !== null, 'an already-ruled row must be rejected');
  assert.match(err.message, /already ruled/i);
  assert.match(err.message, /refresh/i);
});

test('the write builder binds every value, and never interpolates the alias', () => {
  const q = buildPayerAliasRulingCall(
    baseInput({ aliasNorm: "O'MALLEY EMPLOYER HEALTH", reviewNote: '  spaced  ' }),
  );
  assert.equal(q.sql.includes("O'MALLEY"), false, 'the alias reached the SQL text');
  assert.equal(q.params[1], "O'MALLEY EMPLOYER HEALTH");
  assert.equal(q.params[5], 'spaced', 'the note is trimmed before binding');
  assert.equal(q.params.length, 7);
});

test('a defer sends null relationship and null canonical — the audit row must show no change', () => {
  const q = buildPayerAliasRulingCall(
    baseInput({ action: 'defer', relationship: 'same_payer', canonicalPayerId: 'pi_cigna', reviewNote: 'note' }),
  );
  assert.equal(q.params[2], 'defer');
  assert.equal(q.params[3], null, 'a defer must not carry a relationship');
  assert.equal(q.params[4], null, 'a defer must not carry a canonical payer');
});

test('an empty or whitespace-only note binds as NULL, never as an empty string', () => {
  // payer_alias_map_review_note_len rejects a 0- or 1-char note; NULL is the legal "no note".
  for (const note of ['', '   ', null]) {
    const q = buildPayerAliasRulingCall(baseInput({ reviewNote: note }));
    assert.equal(q.params[5], null, `note ${JSON.stringify(note)} did not bind as null`);
  }
});

test('the audit action name is defined on the src side, not exported from the use-server module', () => {
  // A 'use server' file may export ONLY async functions. Exporting a plain string from one passes
  // next build, both typechecks and both suites, then 500s EVERY Server Action on the page at first
  // require. The constant therefore lives here.
  assert.equal(PAYER_ALIAS_RULING_AUDIT_ACTION, 'payer_alias_ruling_write');
});
