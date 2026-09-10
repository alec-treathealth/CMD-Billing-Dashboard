/**
 * The documented AR facility purge is a procedure a human will copy-paste to PERMANENTLY DELETE
 * PHI, so its safety properties are machine-checked here rather than left to review. Same shape as
 * the repo's other source scans (the ?view= writer invariant, the SELECT * guard): the doc is the
 * artefact, so the doc is what gets asserted.
 *
 * Hermetic — reads one file, no DB, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const doc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'rules', 'billing-audit.md'),
  'utf8',
);

/** Strip `--` comments: prose describing a parameter must not satisfy — or trip — a scan for it. */
function stripSql(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, '').replace(/\s--.*$/gm, '');
}

/** The fenced sql block that contains the purge, isolated so unrelated snippets cannot satisfy these. */
function purgeBlock(): string {
  const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const found = blocks.filter((b) => /create temp table _purge/.test(b));
  assert.equal(found.length, 1, 'exactly one purge procedure is documented');
  return found[0]!;
}

test('every DELETE in the documented purge is scoped by business_entity_id', () => {
  // A CMD id is NOT a key: every table here is unique on (business_entity_id, cmd_*_id), and CMD's
  // SEQNOs are per-customer-database, so two accounts can hold the same claim id. The purge runs as
  // claims_admin, which BYPASSES RLS — the predicate in the statement is the only isolation there
  // is. Unqualified, it would reach another customer's (and, once a second tenant exists, another
  // tenant's) remits, status events, work and change history.
  const sql = purgeBlock();
  const deletes = sql.split(/\n(?=delete from)/).filter((s) => s.startsWith('delete from'));
  assert.ok(deletes.length >= 9, `expected the full statement set, found ${deletes.length}`);
  for (const stmt of deletes) {
    const target = /delete from (\S+)/.exec(stmt)?.[1] ?? '?';
    assert.match(
      stmt,
      /business_entity_id/,
      `DELETE on ${target} carries no business_entity_id predicate:\n${stmt}`,
    );
  }
});

test('the purge binds its parameters as QUOTED psql literals, never raw substitution', () => {
  // Plain :cust substitutes raw text, so `-v cust=10033951` compares a text column to an integer and
  // aborts with "operator does not exist: text = integer" before deleting anything. :'cust' quotes.
  // Comments stripped first: the block's own header explains :entity and :cust in prose, and that
  // sentence is not a substitution. Scanning the raw text failed on its own documentation.
  const sql = stripSql(purgeBlock());
  assert.ok(!/[^:]:cust\b/.test(sql), "raw :cust substitution would fail on a numeric-looking id");
  assert.ok(!/[^:]:entity\b/.test(sql), 'raw :entity substitution');
  assert.match(sql, /:'cust'/, 'the customer id is a quoted literal');
  assert.match(sql, /:'entity'::uuid/, 'the tenant is a quoted literal cast to uuid');
});

test('the purge deletes ar_patient by (entity, patient) and only when unreferenced', () => {
  // ar_patient is unique per (entity, patient) with cmd_customer_id a MUTABLE attribute stamped by
  // whichever facility last upserted them — so a customer-scoped delete can remove an identity
  // another facility's live claims still reference, and miss one whose row carries another id.
  const sql = purgeBlock();
  const stmt = sql.split(/\n(?=delete from)/).find((x) => x.includes('claims.ar_patient'));
  assert.ok(stmt, 'ar_patient is purged');
  assert.match(stmt, /\(p\.business_entity_id, p\.cmd_patient_id\) in/, 'matched on the composite key');
  assert.match(stmt, /not exists/, 'only identities no surviving claim references');
  assert.ok(!/delete from claims\.ar_patient\s+where\s+cmd_customer_id/.test(sql), 'never by customer alone');
});

test('the purge captures its ids BEFORE deleting ar_claim', () => {
  // Four tables are reachable only through ar_claim; deleting it first would orphan them silently.
  const sql = purgeBlock();
  const tmp = sql.indexOf('create temp table _purge');
  const delClaim = sql.search(/delete from claims\.ar_claim\s+where/);
  assert.ok(tmp >= 0 && delClaim > tmp, 'the temp table is built first');
  for (const child of ['ar_claim_event', 'ar_claim_work', 'ar_claim_status_event', 'ar_remit']) {
    const at = sql.indexOf(`claims.${child}`);
    assert.ok(at >= 0 && at < delClaim, `${child} is deleted before ar_claim`);
  }
});
