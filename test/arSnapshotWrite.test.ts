/**
 * Hermetic tests for the AR snapshot WRITER (src/billingAudit/arSnapshotWrite.ts): the synthetic
 * fixture is mapped for real, then written into a fake tenant pool that records every statement.
 * Proves: every statement runs inside a withTenant envelope; upserts target the right conflict
 * keys; PHI reaches the parameters ONLY as libsodium ciphertext; notes are append-only and only the
 * genuinely new ones are inserted; the stale mark runs last.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSnapshot } from '../src/billingAudit/arSnapshotMap.js';
import { writeArSnapshot } from '../src/billingAudit/arSnapshotWrite.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';
import { buildFixture } from './fixtures/arSnapshotFixture.js';
import { fakeArPool, tupleCount } from './helpers/fakeArPool.js';

// Test-only keys (64 hex chars each) — never real secrets.
process.env.LIBSODIUM_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.INDEX_HMAC_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

const ctx = { businessEntityId: BXR_ENTITY_ID, cmdCustomerId: '10099999', facilityCode: 'SYNTH', runId: 101, runStartedAt: '2026-09-09T12:00:00.000Z' };

test('writeArSnapshot: upserts every table with the right conflict key, inside tenant transactions', async () => {
  const mapped = mapSnapshot(buildFixture());
  const fake = fakeArPool({ existingNoteIds: ['200000001'] });
  const stats = await writeArSnapshot(fake.pool, mapped, ctx);

  assert.deepEqual(fake.assertAllScoped(), []);
  // Only the client the callback received is used — never pool.query (it throws).
  const inserts = fake.calls.filter((c) => /^insert into claims\.ar_/i.test(c.sql));
  const byTable = (t: string) => inserts.filter((c) => c.sql.startsWith(`insert into claims.${t} `));

  assert.equal(tupleCount(byTable('ar_patient')[0]!.sql), 2);
  assert.match(byTable('ar_patient')[0]!.sql, /on conflict \(business_entity_id, cmd_patient_id\) do update set/);
  assert.match(byTable('ar_patient')[0]!.sql, /last_seen_at = now\(\)/);

  assert.equal(tupleCount(byTable('ar_claim')[0]!.sql), 6);
  assert.match(byTable('ar_claim')[0]!.sql, /on conflict \(business_entity_id, cmd_claim_id\) do update set/);
  assert.match(byTable('ar_claim')[0]!.sql, /in_latest_snapshot = excluded\.in_latest_snapshot/);
  assert.match(byTable('ar_claim')[0]!.sql, /last_run_id = excluded\.last_run_id/);
  // A column present in the INSERT list but absent from the DO UPDATE set is the silent-skew shape:
  // the first snapshot writes it, and every refresh afterwards leaves the stale value in place. The
  // work state would then freeze at whatever the claim looked like the day it was first ingested.
  assert.match(byTable('ar_claim')[0]!.sql, /insert into claims\.ar_claim \([^)]*\bcmd_work_state\b/);
  assert.match(byTable('ar_claim')[0]!.sql, /cmd_work_state = excluded\.cmd_work_state/);
  // 52 columns × 6 rows of parameters (cmd_work_state added by 0113), denial_summary cast to jsonb,
  // code arrays cast to text[]. This count is the tripwire on CLAIM_COLS and claimParams keeping the
  // same length AND the same order — a skew would write values into the wrong columns, silently.
  assert.equal(byTable('ar_claim')[0]!.params!.length, 52 * 6);
  assert.match(byTable('ar_claim')[0]!.sql, /::jsonb/);
  assert.match(byTable('ar_claim')[0]!.sql, /::text\[\]/);

  assert.equal(tupleCount(byTable('ar_charge')[0]!.sql), 7);
  assert.match(byTable('ar_charge')[0]!.sql, /on conflict \(business_entity_id, cmd_charge_id\)/);
  assert.equal(tupleCount(byTable('ar_remit')[0]!.sql), 5);
  assert.match(byTable('ar_remit')[0]!.sql, /on conflict \(business_entity_id, cmd_remit_id\)/);
  assert.equal(tupleCount(byTable('ar_claim_status_event')[0]!.sql), 4);
  assert.match(byTable('ar_claim_status_event')[0]!.sql, /on conflict \(business_entity_id, cmd_status_id\)/);

  assert.deepEqual(
    { patients: stats.patients, claims: stats.claims, charges: stats.charges, remits: stats.remits, statusEvents: stats.statusEvents },
    { patients: 2, claims: 6, charges: 7, remits: 5, statusEvents: 4 },
  );
});

test('writeArSnapshot: PHI reaches the parameters only as ciphertext; blind indexes are hex tokens', async () => {
  const mapped = mapSnapshot(buildFixture());
  const fake = fakeArPool();
  await writeArSnapshot(fake.pool, mapped, ctx);
  const patientInsert = fake.calls.find((c) => c.sql.startsWith('insert into claims.ar_patient '))!;
  const flat = patientInsert.params!.map((p) => (Buffer.isBuffer(p) ? `<buf ${p.length}>` : String(p))).join('|');
  assert.equal(flat.includes('TESTLAST'), false);
  assert.equal(flat.includes('ALEX'), false);
  assert.equal(flat.includes('1990-01-02'), false);
  assert.equal(flat.includes('ZZZ111POL'), false);
  assert.ok(patientInsert.params!.some((p) => Buffer.isBuffer(p) && p.length > 40));
  const tokens = patientInsert.params!.filter((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p));
  assert.ok(tokens.length >= 2, 'name + member blind-index tokens present');
});

test('writeArSnapshot: notes are append-only — pre-read, then insert only the new ones, ciphertext only', async () => {
  const mapped = mapSnapshot(buildFixture());
  const fake = fakeArPool({ existingNoteIds: ['200000001'] });
  const stats = await writeArSnapshot(fake.pool, mapped, ctx);
  const preread = fake.calls.find((c) => /select cmd_note_id from claims\.ar_claim_note/i.test(c.sql))!;
  assert.deepEqual(preread.params, [BXR_ENTITY_ID, '10099999']);
  const noteInsert = fake.calls.find((c) => c.sql.startsWith('insert into claims.ar_claim_note '))!;
  assert.equal(tupleCount(noteInsert.sql), 2, 'notes 200000002 (claim-level) + 200000005 (patient-level) are new');
  assert.match(noteInsert.sql, /cmd_claim_id, cmd_patient_id, source/);
  assert.match(noteInsert.sql, /on conflict \(business_entity_id, cmd_note_id\) where cmd_note_id is not null do nothing/);
  assert.equal(/do update/.test(noteInsert.sql), false, 'notes are never updated');
  const flat = noteInsert.params!.map((p) => (Buffer.isBuffer(p) ? `<buf ${p.length}>` : String(p))).join('|');
  assert.equal(flat.includes('Synthetic follow-up'), false, 'note plaintext never reaches the statement');
  assert.ok(flat.includes('200000002'));
  assert.ok(flat.includes('cmd'));
  assert.equal(stats.notesInserted, 2);
});

test('writeArSnapshot: the stale mark runs last and is scoped to the customer + run', async () => {
  const mapped = mapSnapshot(buildFixture());
  const fake = fakeArPool();
  const stats = await writeArSnapshot(fake.pool, mapped, ctx);
  const updates = fake.calls.filter((c) => /^update claims\.ar_(claim|charge) set in_latest_snapshot = false/i.test(c.sql));
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0]!.params, [BXR_ENTITY_ID, '10099999', 101]);
  assert.match(updates[0]!.sql, /\(last_run_id is null or last_run_id < \$3\)/, 'only OLDER runs are stale-marked (an overlapping newer run keeps its rows)');
  assert.equal(/is distinct from/.test(updates[0]!.sql), false);
  assert.deepEqual(updates[1]!.params, [BXR_ENTITY_ID, '10099999', '2026-09-09T12:00:00.000Z']);
  assert.match(updates[1]!.sql, /last_seen_at < \$3::timestamptz/);
  const lastInsertIdx = Math.max(...fake.calls.map((c, i) => (/^insert into/i.test(c.sql) ? i : -1)));
  const firstUpdateIdx = fake.calls.findIndex((c) => /^update claims\.ar_claim set in_latest_snapshot/i.test(c.sql));
  assert.ok(firstUpdateIdx > lastInsertIdx, 'stale mark after every upsert');
  assert.equal(stats.claimsMarkedStale, 3);
});

test('writeArSnapshot: the optional progress object IS the live accumulator (a caller sees partial counts)', async () => {
  const mapped = mapSnapshot(buildFixture());
  const fake = fakeArPool();
  const progress = { patients: 0, claims: 0, charges: 0, remits: 0, statusEvents: 0, notesInserted: 0, claimsMarkedStale: 0, chargesMarkedStale: 0 };
  const returned = await writeArSnapshot(fake.pool, mapped, ctx, progress);
  assert.equal(returned, progress, 'the accumulator is returned, not a copy — a mid-write throw leaves it readable');
  assert.equal(progress.claims, 6);
  assert.equal(progress.charges, 7);
  assert.equal(progress.patients, 2);
});

test('writeArSnapshot: an empty mapping writes nothing but still runs the stale mark', async () => {
  const fake = fakeArPool();
  const stats = await writeArSnapshot(fake.pool, { facilityName: null, snapshotAsOf: null, patients: [], claims: [], charges: [], remits: [], statusEvents: [], notes: [], skips: {} }, ctx);
  assert.equal(fake.calls.filter((c) => /^insert/i.test(c.sql)).length, 0);
  assert.equal(fake.calls.filter((c) => /^update claims\.ar_/i.test(c.sql)).length, 2);
  assert.equal(stats.claims, 0);
});
