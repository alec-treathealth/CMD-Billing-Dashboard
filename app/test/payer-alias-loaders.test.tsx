/**
 * Payer-alias queue LOADER — the assembly, not the pieces (hermetic; a fake reader, no pg, no net).
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
 * The builders are tested as strings and the leaves are tested with hand-built props, so BOTH sides
 * of `loadPayerAliasQueue` were green while the wiring BETWEEN them had zero coverage. That gap has
 * a specific, silent failure mode, found by adversarial review 2026-09-06:
 *
 *     neighbours = groupBy(nbrRes.rows, (r) => r.seed)
 *
 * A neighbour row carries TWO alias-shaped columns — `alias_norm` (the look-alike) and `seed` (the
 * row it belongs to). Key it on `alias_norm` and every card groups under the wrong string, so the
 * look-alike panel — the single highest-value piece of decision support on the surface — renders
 * empty everywhere, with all 3,247 tests still passing.
 *
 * ⚠️ SO THE KEY TEST MUST FAIL WHEN THE KEY FIELD CHANGES, not merely pass when it is correct. The
 * fixtures below give `seed` and `alias_norm` DELIBERATELY DIFFERENT values, and the assertions name
 * the seed. A fixture where the two happened to coincide would pass under either keying and would be
 * worthless — that is the trap this file is written to avoid.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPayerAliasQueue, type QueueReader } from '../lib/payer-alias/loaders';
import type { PayerAliasQueueRow } from '../../src/collections/payerAliasQueue';

/* ── A fake reader that routes by SQL shape and records what it was asked ────────────────────────── */

interface Call {
  sql: string;
  params: readonly unknown[];
}

interface FakeSpec {
  counts?: Array<{ vocabulary: string; unruled: number }>;
  queue?: PayerAliasQueueRow[];
  siblings?: Array<Record<string, unknown>>;
  neighbours?: Array<Record<string, unknown>>;
  vobNames?: Array<Record<string, unknown>>;
}

function fakeReader(spec: FakeSpec): { db: QueueReader; calls: Call[] } {
  const calls: Call[] = [];
  const db: QueueReader = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      // Routed on distinctive SQL fragments rather than call order, so a future reordering of the
      // loader's queries cannot silently hand the wrong fixture to the wrong consumer.
      if (sql.includes('group by vocabulary')) return { rows: (spec.counts ?? []) as T[] };
      if (sql.includes('operator(claims.%)')) return { rows: (spec.neighbours ?? []) as T[] };
      if (sql.includes('vob.member_benefits_latest')) return { rows: (spec.vobNames ?? []) as T[] };
      if (sql.includes('s.vocabulary <> $2')) return { rows: (spec.siblings ?? []) as T[] };
      if (sql.includes('where m.needs_review')) return { rows: (spec.queue ?? []) as T[] };
      throw new Error(`fakeReader: unrouted SQL: ${sql.slice(0, 80)}`);
    },
  };
  return { db, calls };
}

const qrow = (alias: string, over: Partial<PayerAliasQueueRow> = {}): PayerAliasQueueRow => ({
  vocabulary: 'claims_primary_payer',
  alias_norm: alias,
  relationship: 'same_payer',
  provenance: 'idf_cosine',
  confidence: '0.900',
  review_note: null,
  created_at: '2026-08-05',
  canonical_payer_id: 'pi_x',
  display_name: 'X',
  payer_family: 'COMMERCIAL',
  entity_kind: 'insurer',
  is_active: true,
  administers_for: null,
  administers_for_name: null,
  ...over,
});

/** Seed and look-alike are ALWAYS different strings here — that is what makes the key test real. */
const nrow = (seed: string, lookalike: string) => ({
  seed,
  alias_norm: lookalike,
  vocabulary: 'vob_insurance_co',
  relationship: 'same_payer',
  canonical_payer_id: 'pi_y',
  display_name: 'Y',
  similarity: '0.812',
});

const srow = (alias: string, vocab: string) => ({
  alias_norm: alias,
  vocabulary: vocab,
  relationship: 'carve_out',
  canonical_payer_id: 'pi_z',
  needs_review: false,
  display_name: 'Z',
});

/** A VOB name under a payer id. `payer_id` and `name` are ALWAYS different strings here, for the
 *  same reason seed ≠ look-alike above: a key test that could pass under either keying is worthless. */
const vrow = (payerId: string, name: string, members = 5) => ({
  payer_id: payerId,
  name,
  members,
  total_names: 2,
  total_members: 10,
});

const COUNTS = [
  { vocabulary: 'claims_primary_payer', unruled: 145 },
  { vocabulary: 'vob_insurance_co', unruled: 646 },
  { vocabulary: 'vob_payer_id', unruled: 199 },
];

/* ── 1. THE KEY TEST — must FAIL if groupBy switches to alias_norm ───────────────────────────────── */

test('neighbours group by SEED, not by the look-alike alias_norm', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('ANTHEM BCBS GA'), qrow('CIGNA HEALTHCARE')],
    neighbours: [
      nrow('ANTHEM BCBS GA', 'ANTHEM BCBS OF GA'),
      nrow('ANTHEM BCBS GA', 'ANTHEM BCBS GEORGIA'),
      nrow('CIGNA HEALTHCARE', 'CIGNA'),
    ],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 1, db);

  // Keyed on seed → the two Anthem look-alikes attach to the Anthem ROW.
  assert.equal(page.neighbours['ANTHEM BCBS GA']?.length, 2);
  assert.equal(page.neighbours['CIGNA HEALTHCARE']?.length, 1);

  // ⚠️ THE FAILING HALF. If the key were `alias_norm`, these buckets would exist and the two above
  // would be undefined. Asserting their ABSENCE is what makes a key change a red test.
  assert.equal(page.neighbours['ANTHEM BCBS OF GA'], undefined);
  assert.equal(page.neighbours['ANTHEM BCBS GEORGIA'], undefined);
  assert.equal(page.neighbours['CIGNA'], undefined);
  assert.deepEqual(Object.keys(page.neighbours).sort(), ['ANTHEM BCBS GA', 'CIGNA HEALTHCARE']);
});

test('every queue row can look up its own neighbours by alias_norm', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('ALPHA'), qrow('BETA')],
    neighbours: [nrow('ALPHA', 'ALPHA CORP'), nrow('BETA', 'BETA INC')],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 1, db);
  // This is exactly what QueueList does: neighbours[row.alias_norm].
  for (const row of page.rows) {
    const attached = page.neighbours[row.alias_norm];
    assert.ok(attached && attached.length > 0, `no neighbours attached to ${row.alias_norm}`);
    for (const n of attached) assert.equal(n.seed, row.alias_norm);
  }
});

test('a neighbour never leaks onto a different alias', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('ALPHA'), qrow('BETA')],
    neighbours: [nrow('ALPHA', 'SHARED LOOKALIKE'), nrow('BETA', 'SHARED LOOKALIKE')],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 1, db);
  // The SAME look-alike is a neighbour of both seeds — under alias_norm keying these would collapse
  // into ONE bucket of 2 and both cards would be wrong.
  assert.equal(page.neighbours['ALPHA']?.length, 1);
  assert.equal(page.neighbours['BETA']?.length, 1);
  assert.equal(page.neighbours['SHARED LOOKALIKE'], undefined);
});

/* ── 2. Siblings attach to the right alias, and are keyed differently on purpose ──────────────────── */

test('siblings group by alias_norm — the sibling IS the alias, unlike a neighbour', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('CIGNA'), qrow('AETNA')],
    siblings: [
      srow('CIGNA', 'vob_insurance_co'),
      srow('CIGNA', 'vob_payer_id'),
      srow('AETNA', 'vob_insurance_co'),
    ],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 1, db);
  assert.equal(page.siblings['CIGNA']?.length, 2);
  assert.equal(page.siblings['AETNA']?.length, 1);
  for (const [alias, rows] of Object.entries(page.siblings)) {
    for (const s of rows) assert.equal(s.alias_norm, alias);
  }
});

test('the sibling query excludes the CURRENT vocabulary and binds the page aliases', async () => {
  const { db, calls } = fakeReader({ counts: COUNTS, queue: [qrow('CIGNA'), qrow('AETNA')] });
  await loadPayerAliasQueue('claims_primary_payer', 1, db);
  const sib = calls.find((c) => c.sql.includes('s.vocabulary <> $2'));
  assert.ok(sib, 'no sibling query issued');
  assert.deepEqual(sib.params[0], ['CIGNA', 'AETNA']);
  assert.equal(sib.params[1], 'claims_primary_payer');
});

test('context queries are SKIPPED entirely when the page is empty', async () => {
  const { db, calls } = fakeReader({ counts: [{ vocabulary: 'vob_payer_id', unruled: 0 }], queue: [] });
  const page = await loadPayerAliasQueue('vob_payer_id', 1, db);
  assert.deepEqual(page.siblings, {});
  assert.deepEqual(page.neighbours, {});
  assert.equal(calls.filter((c) => c.sql.includes('operator(claims.%)')).length, 0);
  assert.equal(calls.filter((c) => c.sql.includes('s.vocabulary <> $2')).length, 0);
});

/* ── 2b. VOB names — fetched on ONE tab, keyed on the id the card renders ─────────────────────────── */

test('VOB names are fetched ONLY on the vob_payer_id tab, batched by the page aliases', async () => {
  // A payer-id join is meaningless for a NAME vocabulary: no query, and an empty record — not
  // undefined, so the card can index it without a guard.
  for (const vocab of ['claims_primary_payer', 'vob_insurance_co'] as const) {
    const { db, calls } = fakeReader({ counts: COUNTS, queue: [qrow('CIGNA'), qrow('AETNA')] });
    const page = await loadPayerAliasQueue(vocab, 1, db);
    assert.equal(calls.filter((c) => c.sql.includes('vob.member_benefits_latest')).length, 0, vocab);
    assert.deepEqual(page.vobNames, {});
  }

  const { db, calls } = fakeReader({
    counts: COUNTS,
    queue: [qrow('62308', { vocabulary: 'vob_payer_id' }), qrow("'01260", { vocabulary: 'vob_payer_id' })],
    vobNames: [vrow('62308', 'AETNA')],
  });
  await loadPayerAliasQueue('vob_payer_id', 1, db);
  const vob = calls.filter((c) => c.sql.includes('vob.member_benefits_latest'));
  assert.equal(vob.length, 1, 'exactly one batched query, never one per card');
  assert.deepEqual(vob[0]!.params[0], ['62308', "'01260"], 'the whole page, apostrophe row included');
});

test('VOB names group by PAYER_ID — the alias the card renders — not by the name', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('62308', { vocabulary: 'vob_payer_id' }), qrow('60054', { vocabulary: 'vob_payer_id' })],
    vobNames: [vrow('62308', 'AETNA', 40), vrow('62308', 'AETNA BETTER HEALTH', 3), vrow('60054', 'CIGNA', 9)],
  });
  const page = await loadPayerAliasQueue('vob_payer_id', 1, db);
  assert.equal(page.vobNames['62308']?.length, 2);
  assert.equal(page.vobNames['60054']?.length, 1);
  // THE FAILING HALF: under `name` keying these would exist and the two above would be undefined.
  assert.equal(page.vobNames['AETNA'], undefined);
  assert.equal(page.vobNames['CIGNA'], undefined);
  // SQL order (heaviest first) survives grouping — the UI does not re-sort.
  assert.deepEqual(page.vobNames['62308']!.map((r) => r.name), ['AETNA', 'AETNA BETTER HEALTH']);
  for (const row of page.rows) {
    for (const n of page.vobNames[row.alias_norm] ?? []) assert.equal(n.payer_id, row.alias_norm);
  }
});

test('a vob_payer_id row with NO VOB names simply has no bucket — the leaf states the absence', async () => {
  const { db } = fakeReader({
    counts: COUNTS,
    queue: [qrow('99999', { vocabulary: 'vob_payer_id' })],
    vobNames: [],
  });
  const page = await loadPayerAliasQueue('vob_payer_id', 1, db);
  assert.deepEqual(page.vobNames, {});
});

/* ── 3. hasMore agrees with the row count ────────────────────────────────────────────────────────── */

test('hasMore is true on a middle page and false on the last', async () => {
  // 145 unruled at 25/page → lastPage 6.
  for (const [page, expected] of [[1, true], [5, true], [6, false]] as Array<[number, boolean]>) {
    const { db } = fakeReader({ counts: COUNTS, queue: [qrow('X')] });
    const result = await loadPayerAliasQueue('claims_primary_payer', page, db);
    assert.equal(result.hasMore, expected, `page ${page}`);
    assert.equal(result.lastPage, 6);
  }
});

test('hasMore is false when the queue fits on one page, and when it is empty', async () => {
  const { db: d1 } = fakeReader({ counts: [{ vocabulary: 'vob_payer_id', unruled: 3 }], queue: [qrow('A')] });
  const one = await loadPayerAliasQueue('vob_payer_id', 1, d1);
  assert.equal(one.hasMore, false);
  assert.equal(one.lastPage, 1);

  const { db: d2 } = fakeReader({ counts: [], queue: [] });
  const none = await loadPayerAliasQueue('vob_payer_id', 1, d2);
  assert.equal(none.hasMore, false);
  assert.equal(none.lastPage, 1, 'an empty queue still has a page 1');
});

test('an exact multiple of the page size does not invent a trailing empty page', async () => {
  // 25 rows at 25/page is exactly one page — hasMore must be false, not "there might be more".
  const { db } = fakeReader({ counts: [{ vocabulary: 'vob_payer_id', unruled: 25 }], queue: [qrow('A')] });
  const page = await loadPayerAliasQueue('vob_payer_id', 1, db);
  assert.equal(page.lastPage, 1);
  assert.equal(page.hasMore, false);
});

/* ── 4. M2 — the page is clamped to the REAL last page, not MAX_PAGE ─────────────────────────────── */

test('M2: a past-the-end page clamps to the last real page instead of a huge offset', async () => {
  const { db, calls } = fakeReader({ counts: COUNTS, queue: [qrow('X')] });
  const page = await loadPayerAliasQueue('claims_primary_payer', 200, db);

  assert.equal(page.page, 6, 'served page must be the real last page, not 200');
  assert.equal(page.hasMore, false);

  // The offset actually sent to Postgres is (6-1)*25 = 125, not (200-1)*25 = 4975.
  const queueCall = calls.find((c) => c.sql.includes('where m.needs_review'));
  assert.ok(queueCall);
  assert.equal(queueCall.params[2], 125, 'offset must derive from the clamped page');
});

test('M2: counts are fetched BEFORE the queue, because the clamp depends on them', async () => {
  const { db, calls } = fakeReader({ counts: COUNTS, queue: [qrow('X')] });
  await loadPayerAliasQueue('claims_primary_payer', 200, db);
  const countsIdx = calls.findIndex((c) => c.sql.includes('group by vocabulary'));
  const queueIdx = calls.findIndex((c) => c.sql.includes('where m.needs_review'));
  assert.ok(countsIdx >= 0 && queueIdx >= 0);
  assert.ok(countsIdx < queueIdx, 'the count must precede the page query, or the clamp is guesswork');
});

test('M2: clamping never pushes a valid page UP, and never below 1', async () => {
  const { db: d1 } = fakeReader({ counts: COUNTS, queue: [qrow('X')] });
  assert.equal((await loadPayerAliasQueue('claims_primary_payer', 3, d1)).page, 3);

  for (const bad of [0, -7, Number.NaN, 'abc' as unknown as number]) {
    const { db } = fakeReader({ counts: COUNTS, queue: [qrow('X')] });
    assert.equal((await loadPayerAliasQueue('claims_primary_payer', bad, db)).page, 1, String(bad));
  }
});

/* ── 5. Counts assembly ──────────────────────────────────────────────────────────────────────────── */

test('counts are zero-filled for every vocabulary the DB did not return', async () => {
  const { db } = fakeReader({ counts: [{ vocabulary: 'vob_payer_id', unruled: 199 }], queue: [] });
  const page = await loadPayerAliasQueue('vob_payer_id', 1, db);
  assert.deepEqual(page.counts, { vob_insurance_co: 0, claims_primary_payer: 0, vob_payer_id: 199 });
});

test('an unknown vocabulary in the count rows is dropped, not spread into the record', async () => {
  const { db } = fakeReader({
    counts: [...COUNTS, { vocabulary: 'some_future_vocabulary', unruled: 42 }],
    queue: [qrow('X')],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 1, db);
  assert.deepEqual(Object.keys(page.counts).sort(), [
    'claims_primary_payer',
    'vob_insurance_co',
    'vob_payer_id',
  ]);
});

test('a count arriving as a STRING is coerced — node-pg returns some integer types as text', async () => {
  // pg hands back int8 as a string; count(*)::int is int4 today, but the loader must not depend on
  // that staying true. A string here would make lastPage NaN and every page render empty.
  const { db } = fakeReader({
    counts: [{ vocabulary: 'claims_primary_payer', unruled: '145' as unknown as number }],
    queue: [qrow('X')],
  });
  const page = await loadPayerAliasQueue('claims_primary_payer', 200, db);
  assert.equal(page.counts.claims_primary_payer, 145);
  assert.equal(page.lastPage, 6);
  assert.equal(page.page, 6);
});

/* ── 6. The loader issues SELECTs only ───────────────────────────────────────────────────────────── */

test('the loader is READ-ONLY — every SQL it issues is a select', async () => {
  const { db, calls } = fakeReader({
    counts: COUNTS,
    queue: [qrow('X')],
    siblings: [srow('X', 'vob_payer_id')],
    neighbours: [nrow('X', 'X CORP')],
  });
  await loadPayerAliasQueue('claims_primary_payer', 1, db);
  assert.ok(calls.length >= 4, 'expected counts + queue + siblings + neighbours');
  // The vob_payer_id tab adds the fifth query; it must be a select too.
  const vobTab = fakeReader({
    counts: COUNTS,
    queue: [qrow('62308', { vocabulary: 'vob_payer_id' })],
    vobNames: [vrow('62308', 'AETNA')],
  });
  await loadPayerAliasQueue('vob_payer_id', 1, vobTab.db);
  assert.equal(vobTab.calls.length, 5, 'counts + queue + siblings + neighbours + VOB names');
  calls.push(...vobTab.calls);
  for (const c of calls) {
    assert.ok(c.sql.trimStart().toLowerCase().startsWith('select'), c.sql.slice(0, 60));
    for (const verb of ['insert ', 'update ', 'delete ', 'truncate']) {
      assert.equal(c.sql.toLowerCase().includes(verb), false, `${verb} in a loader query`);
    }
  }
});
