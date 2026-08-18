/**
 * THE PATIENT DIRECTORY (migration 0105) - the bounded name index behind full-book patient search.
 *
 * The tests that matter here are the ones about COMPLETENESS and about not lying:
 *   - a dependent's name must survive the dedup (the grain is the whole reason this table exists);
 *   - the watermark must advance even when a batch inserts nothing;
 *   - a plaintext name must never reach a returned value;
 *   - a missing fingerprint key must throw rather than produce a clean empty run.
 *
 * Hermetic: no pg, no libsodium, no INDEX_HMAC_KEY. Every dependency is injected.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildPatientDirectoryInsert,
  buildPatientDirectoryReadQuery,
  buildPatientDirectoryScanQuery,
  entriesFromRows,
  syncPatientDirectory,
  type DirectoryScanRow,
  type DirectoryWriter,
} from '../src/collections/patientDirectory.js';

const ENTITY_A = 'a1b2c3d4-0000-0000-0000-00000000000a';
const ENTITY_B = 'a1b2c3d4-0000-0000-0000-00000000000b';

/** Fake crypto: the "ciphertext" is the name in a Buffer. Keeps the test about the LOGIC. */
const decrypt = (b: Buffer): Promise<string> => Promise.resolve(b.toString('utf8'));
/** Fake HMAC: the normalization that matters (upper + collapsed whitespace), no key. */
const fingerprint = (n: string): string | null => {
  const norm = n.trim().replace(/\s+/g, ' ').toUpperCase();
  return norm === '' ? null : `fp:${norm}`;
};

function row(id: string, member: string | null, name: string, entity = ENTITY_A): DirectoryScanRow {
  return { id, business_entity_id: entity, member_id_bidx: member, patient_name: Buffer.from(name, 'utf8') };
}

// -- 1. The grain ------------------------------------------------------------------------------

test('a member with TWO patients keeps BOTH names - the reason the name is in the key', async () => {
  // 0.44% of members carry more than one name (dependents on one subscriber policy). Keying on the
  // member alone would keep one and make the other unfindable, which is a SILENT MISS - the single
  // failure a search must not have. This is the test that pins that decision.
  const { entries } = await entriesFromRows(
    [row('1', 'm1', 'DOE, JOHN'), row('2', 'm1', 'DOE, JANE'), row('3', 'm1', 'DOE, JOHN')],
    decrypt,
    fingerprint,
  );
  assert.equal(entries.length, 2, 'two distinct people, one policy');
  assert.deepEqual(entries.map((e) => e.name_fp).sort(), ['fp:DOE, JANE', 'fp:DOE, JOHN']);
  assert.ok(entries.every((e) => e.member_id_bidx === 'm1'), 'both resolve to the same policy');
});

test('one patient with 400 charge lines contributes ONE row', async () => {
  const many = Array.from({ length: 400 }, (_, i) => row(String(i + 1), 'm1', 'DOE, JOHN'));
  const { entries } = await entriesFromRows(many, decrypt, fingerprint);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.first_seen_row_id, '1', 'provenance is the FIRST row, not the last');
});

test('the same name under DIFFERENT tenants stays two rows', async () => {
  // Tenant is the leading key column. Merging here would let one tenant`s search resolve to a
  // member token that only exists in the other`s book.
  const { entries } = await entriesFromRows(
    [row('1', 'm1', 'DOE, JOHN', ENTITY_A), row('2', 'm1', 'DOE, JOHN', ENTITY_B)],
    decrypt,
    fingerprint,
  );
  assert.equal(entries.length, 2);
});

test('spelling variants of one name collapse, because the fingerprint normalizes', async () => {
  const { entries } = await entriesFromRows(
    [row('1', 'm1', 'DOE,  JOHN'), row('2', 'm1', ' doe, john ')],
    decrypt,
    fingerprint,
  );
  assert.equal(entries.length, 1, 'whitespace + case are not a different person');
});

// -- 2. What must never happen ------------------------------------------------------------------

test('NO PLAINTEXT NAME appears anywhere in the returned entries', async () => {
  // The whole PHI argument for this module is that a name is decrypted, fingerprinted and dropped.
  // Serialising the result and hunting for the name is the bluntest way to keep that true, and it
  // catches a future field that carries it "just for debugging".
  //
  // ⚠ THIS TEST USES A HASHING FINGERPRINT, not the readable `fp:NAME` fake the other tests use.
  // That fake embeds the plaintext in its own output, so it would fail this assertion for a reason
  // that says nothing about the module. Production's fingerprint is HMAC-SHA256 hex, which is what
  // is mirrored here. (It failed exactly that way when first written - kept as a note rather than
  // silently corrected, because the same trap is waiting for anyone who reuses the readable fake.)
  const hashing = (n: string): string =>
    createHash('sha256').update(n.trim().replace(/\s+/g, ' ').toUpperCase()).digest('hex');
  const { entries } = await entriesFromRows([row('1', 'm1', 'RUMPELSTILTSKIN')], decrypt, hashing);
  const serialised = JSON.stringify(entries.map((e) => ({ ...e, patient_name: '<ciphertext>' })));
  assert.doesNotMatch(serialised, /RUMPELSTILTSKIN/i, 'no field may carry the plaintext');
  // The ciphertext is only the name here because the FAKE decrypt is identity; in production it is
  // libsodium output. Asserted separately so the check above stays meaningful.
  assert.ok(Buffer.isBuffer(entries[0]!.patient_name));
});

test('a row with no member token is SKIPPED and COUNTED, never indexed', async () => {
  // Indexing it would produce a match that resolves to nothing. It is 0 of 686,503 rows today, so a
  // non-zero count means the ingest stopped stamping the token - worth seeing, not worth hiding.
  const res = await entriesFromRows([row('1', null, 'DOE, JOHN'), row('2', '', 'ROE, JANE')], decrypt, fingerprint);
  assert.equal(res.entries.length, 0);
  assert.equal(res.skippedNoMember, 2);
});

test('one undecryptable row does not deny the whole batch', async () => {
  const boom = (b: Buffer): Promise<string> =>
    b.toString('utf8') === 'BAD' ? Promise.reject(new Error('nope')) : Promise.resolve(b.toString('utf8'));
  const res = await entriesFromRows([row('1', 'm1', 'BAD'), row('2', 'm2', 'DOE, JOHN')], boom, fingerprint);
  assert.equal(res.entries.length, 1);
  assert.equal(res.decryptFailures, 1);
});

// -- 3. The queries ----------------------------------------------------------------------------

test('the scan projects an explicit allowlist and keysets on the primary key', () => {
  const q = buildPatientDirectoryScanQuery(0, 5000);
  assert.doesNotMatch(q.sql, /select \*/, 'never select *');
  assert.match(q.sql, /^select id, business_entity_id, member_id_bidx, patient_name from/);
  assert.match(q.sql, /where id > \$1 order by id limit \$2/);
  assert.deepEqual(q.params, ['0', 5000]);
  // Money and the other two identifiers must never be pulled by a name-index build.
  for (const leaked of ['member_id,', 'group_number', 'charge_amount', 'insurance_payments']) {
    assert.doesNotMatch(q.sql, new RegExp(leaked));
  }
});

test('the search read is TENANT-SCOPED and bound, not interpolated', () => {
  const q = buildPatientDirectoryReadQuery([ENTITY_A, ENTITY_B]);
  assert.match(q.sql, /where business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(q.params, [[ENTITY_A, ENTITY_B]]);
  assert.doesNotMatch(q.sql, new RegExp(ENTITY_A), 'the id is a parameter, never inlined');
});

test('the insert binds every value and carries the conflict filter', () => {
  const q = buildPatientDirectoryInsert([
    { business_entity_id: ENTITY_A, member_id_bidx: 'm1', name_fp: 'fp:A', patient_name: Buffer.from('x'), first_seen_row_id: '7' },
    { business_entity_id: ENTITY_B, member_id_bidx: 'm2', name_fp: 'fp:B', patient_name: Buffer.from('y'), first_seen_row_id: '9' },
  ]);
  assert.match(q.sql, /on conflict \(business_entity_id, member_id_bidx, name_fp\) do nothing$/);
  assert.equal(q.params.length, 10, 'five bound values per row');
  assert.match(q.sql, /\$10::bigint\)/, 'placeholders continue across tuples');
});

// -- 4. The sync loop --------------------------------------------------------------------------

interface Recorded { sql: string; params: readonly unknown[] | undefined }

function fakeDb(pages: DirectoryScanRow[][], watermark = '0') {
  const writes: Recorded[] = [];
  let page = 0;
  const read = {
    query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('cmd_patient_directory_state')) {
        return Promise.resolve({ rows: [{ last_row_id: watermark }] as unknown as T[] });
      }
      const rows = pages[page] ?? [];
      page += 1;
      return Promise.resolve({ rows: rows as unknown as T[] });
    },
  };
  const write: DirectoryWriter = {
    query(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }> {
      writes.push({ sql, params });
      return Promise.resolve({ rowCount: sql.includes('cmd_patient_directory_state') ? 1 : 1 });
    },
  };
  return { read, write, writes };
}

test('THE WATERMARK ADVANCES EVEN WHEN A BATCH INSERTS NOTHING', async () => {
  // This is the bug a derived watermark (max(first_seen_row_id)) would have: a batch of new charge
  // lines for patients ALREADY indexed inserts zero rows, so a derived watermark would stall and
  // every run would re-scan the same rows forever. Batch 1 indexes the patient; batch 2 is more of
  // that same patient's lines and must still move the mark.
  const db = fakeDb([[row('1', 'm1', 'DOE, JOHN')], [row('2', 'm1', 'DOE, JOHN')], []], '0');
  const stats = await syncPatientDirectory({
    read: db.read, write: db.write, decrypt, fingerprint, batch: 1,
  });
  assert.equal(stats.rows_scanned, 2);
  assert.equal(stats.last_row_id, 2, 'the mark reached the last row SEEN, not the last row written');
  const stateWrites = db.writes.filter((w) => w.sql.includes('cmd_patient_directory_state'));
  assert.equal(stateWrites.length, 3, 'one per batch, plus the caught-up stamp that ends the run');
  assert.deepEqual(stateWrites.at(-1)!.params?.[0], 2);
});

test('a short page ends the run and reports exhausted', async () => {
  const db = fakeDb([[row('1', 'm1', 'A'), row('2', 'm2', 'B')]], '0');
  const stats = await syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint, batch: 10 });
  assert.equal(stats.exhausted, true);
  assert.equal(stats.rows_scanned, 2);
});

test('the wall-clock budget stops the scan and says so, rather than overrunning', async () => {
  // The hourly slice is bolted onto a production-critical route, so "stop early and resume" is the
  // required behaviour. exhausted:false is how the caller can tell the difference from "caught up".
  let t = 0;
  const db = fakeDb([[row('1', 'm1', 'A')], [row('2', 'm2', 'B')], [row('3', 'm3', 'C')]], '0');
  const stats = await syncPatientDirectory({
    read: db.read, write: db.write, decrypt, fingerprint, batch: 1,
    budgetMs: 10,
    now: () => (t += 8),
  });
  assert.equal(stats.exhausted, false, 'budget-stopped, NOT caught up');
  assert.ok(stats.rows_scanned < 3);
});

test('a fingerprint key that yields null THROWS before any work', async () => {
  // Without it every name fingerprints to null, the sync scans the whole book, inserts nothing, and
  // reports a clean run - the same "succeeded while doing nothing" shape that hid the BXR outage
  // for eleven hours. One probe up front is what makes that impossible.
  const db = fakeDb([[row('1', 'm1', 'A')]], '0');
  await assert.rejects(
    () => syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint: () => null }),
    /INDEX_HMAC_KEY/,
  );
  assert.equal(db.writes.length, 0, 'it throws BEFORE writing anything');
});

test('an empty table is a clean, exhausted run that STILL records itself', async () => {
  // ⚠ THIS TEST USED TO ASSERT `db.writes.length === 0` — "nothing scanned, nothing written, not
  // even a state row" — and that assertion WAS the bug. It sounded like admirable restraint and it
  // meant `refreshed_at` never advanced on a run with no work, so a quiet feed was indistinguishable
  // from a dead sync and the freshness alarm fired against a perfectly current directory.
  //
  // A test can encode a defect as confidently as code can. Nothing about "no writes" was ever a
  // requirement; it was an observation about the implementation, promoted to an assertion.
  const db = fakeDb([[]], '0');
  const stats = await syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint });
  assert.equal(stats.exhausted, true);
  assert.equal(stats.rows_scanned, 0);
  assert.equal(db.writes.length, 1, 'exactly one write: the "I ran, there was nothing to do" stamp');
  assert.match(db.writes[0]!.sql, /cmd_patient_directory_state/);
  assert.deepEqual(db.writes[0]!.params, [0, 0, 0]);
});

test('the sync resumes from the STORED watermark, not from zero', async () => {
  const db = fakeDb([[row('501', 'm1', 'A')], []], '500');
  const stats = await syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint, batch: 1 });
  assert.equal(stats.last_row_id, 501);
  assert.equal(stats.rows_scanned, 1, 'the first 500 rows were not re-scanned');
});

// -- 5. Freshness: "already caught up" is a SUCCESSFUL run and must be recorded ----------------

test('a zero-row scan STILL stamps the state row', async () => {
  // ⚠ IT DID NOT, AND THAT MADE THE FRESHNESS ALARM CRY WOLF EVERY NIGHT. The loop broke out on an
  // empty scan before writing, so `refreshed_at` only advanced when there was new data. The CMD
  // feed legitimately adds nothing overnight (measured: 0 rows in 3 hours at 03:30 Pacific), so a
  // completely current directory would report itself hours stale and warn the user its search was
  // incomplete. "Nothing to do" is a successful run.
  const db = fakeDb([[]], '500');
  const stats = await syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint });
  assert.equal(stats.exhausted, true);
  assert.equal(stats.rows_scanned, 0);
  const stateWrites = db.writes.filter((w) => w.sql.includes('cmd_patient_directory_state'));
  assert.equal(stateWrites.length, 1, 'the caught-up run records itself');
  assert.deepEqual(stateWrites[0]!.params, [500, 0, 0], 'watermark held; counters add zero');
});

test('the counters ACCUMULATE, so a caught-up stamp cannot reset them', async () => {
  const db = fakeDb([[row('1', 'm1', 'A')], []], '0');
  await syncPatientDirectory({ read: db.read, write: db.write, decrypt, fingerprint, batch: 1 });
  const stateWrites = db.writes.filter((w) => w.sql.includes('cmd_patient_directory_state'));
  assert.equal(stateWrites.length, 2, 'one for the batch, one for the caught-up scan');
  assert.match(stateWrites[0]!.sql, /rows_scanned\s*=\s*collections\.cmd_patient_directory_state\.rows_scanned \+ excluded/);
  assert.deepEqual(stateWrites[1]!.params, [1, 0, 0], 'the final stamp adds nothing but the time');
});
