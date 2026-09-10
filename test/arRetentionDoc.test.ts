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

test('the retention window is RATIFIED, with both numbers and the column it measures', () => {
  // Ruled by Alec 2026-09-10. Pinned because a retention policy that quietly reverts to "proposed"
  // is indistinguishable from never having had one, and this is the obligation an auditor reads.
  const section = doc.slice(doc.indexOf('### PHI retention and removal'));
  assert.match(section, /RATIFIED 2026-09-10/, 'the heading states the ruling, not a draft');
  assert.ok(!/THE WINDOW IS UNRATIFIED|IS ALEC'S CALL AND IS NOT SET/.test(section), 'no draft language survives');
  assert.match(section, /24 months.*from `last_seen_at`/s, 'the retention period and its column');
  assert.match(section, /90 days/, 'the offboarding deadline');
  // last_seen_at is the only column that makes the clock mean "since CMD stopped reporting it".
  assert.match(section, /`first_seen_at` would purge a long-lived claim/, 'why not first_seen_at');
  // And the ruling must keep saying that nothing enforces it automatically — that is the design.
  assert.match(section, /Nothing enforces this yet, and that is deliberate/);
  assert.match(section, /run by a human/, 'the named mechanism stays manual');
});

test('the migration header carries the same ratified window as the rule file', () => {
  // Two copies, deliberately: 0109 is what someone opens when they ask what this plane is, and the
  // rule file is what loads when they touch the code. They must not disagree about the policy.
  const sql = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations', '0109_ar_management.sql'),
    'utf8',
  );
  const header = sql.slice(0, sql.indexOf('set role claims_admin;'));
  assert.match(header, /RULED BY ALEC 2026-09-10/);
  assert.match(header, /24 months from last_seen_at/);
  assert.match(header, /within 90 days/);
  assert.ok(!/unratified/i.test(header), 'the migration header does not still call it unratified');
});

test('the documented psql invocation passes BOTH values bare — pre-quoting breaks it', () => {
  // `-v` does not dequote, and :'name' escapes-and-wraps whatever it holds, so a pre-quoted value is
  // quoted twice: -v entity="'af504…'" loses the shell's double quotes, keeps the single ones, and
  // :'entity' expands to '''af504…'''::uuid -> "invalid input syntax for type uuid". It aborts inside
  // `begin;` so nothing is deleted, but an operator then improvises quoting mid-PHI-delete.
  // Read the RAW block: the invocation lives in a `--` comment, which stripSql would remove.
  const raw = purgeBlock();
  const inv = raw.split('\n').find((l) => /psql .*-v /.test(l));
  assert.ok(inv, 'the block documents how to invoke it');
  const entity = /-v\s+entity=(\S+)/.exec(inv)?.[1];
  const cust = /-v\s+cust=(\S+)/.exec(inv)?.[1];
  assert.ok(entity && cust, `both parameters are shown: ${inv.trim()}`);
  for (const [name, v] of [['entity', entity], ['cust', cust]] as const) {
    assert.ok(!/^["']/.test(v), `-v ${name}= must be bare, got ${v}`);
  }
});

test('the collision check reads ar_charge, never ar_claim, because ar_claim cannot answer', () => {
  // ar_claim is unique on (business_entity_id, cmd_claim_id), so grouping by cmd_claim_id yields at
  // most one row per group and `count(distinct cmd_customer_id) > 1` can never be true. This file
  // shipped exactly that query and reported "zero collisions" from it — a tautology, not a
  // measurement. ar_charge is unique on cmd_charge_id, so one claim has many rows and it can fire.
  const section = doc.slice(doc.indexOf('TRAP 0'), doc.indexOf('TRAP 1'));
  const blocks = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const checks = blocks.filter((b) => /count\(distinct cmd_customer_id\)\s*>\s*1/.test(b));
  assert.equal(checks.length, 1, 'exactly one collision check is offered');
  const sql = checks[0]!;
  assert.match(sql, /from claims\.ar_charge/, 'reads ar_charge');
  assert.ok(!/from claims\.ar_claim\b/.test(sql), 'must NOT read ar_claim — it cannot answer');
  assert.match(sql, /group by business_entity_id, cmd_claim_id/, 'grouped so the HAVING can fire');
  // And the trap must keep explaining why, or the next person "simplifies" it back.
  assert.match(section, /STRUCTURALLY INCAPABLE/, 'the dead-query warning survives');
  assert.match(section, /overwrites/, 'and the row-overwrite consequence');
});

test('TRAP 3 names BOTH roster edit points, not just the obvious one', () => {
  // AR_SNAPSHOT_CUSTOMERS spreads AUDIT_CONSOLIDATED_CUSTOMERS, so 17 of 19 accounts — including
  // WRC, the doc's own worked example — are only removable in auditConfig.ts. Getting this wrong
  // means the next 14:05 ingest silently re-creates everything the purge deleted.
  const trap = doc.slice(doc.indexOf('TRAP 3'));
  const section = trap.slice(0, 1800);
  assert.match(section, /arConfig\.ts/);
  assert.match(section, /auditConfig\.ts/, 'the roster that actually holds the 17 audit accounts');
  assert.match(section, /billing-audit-consolidated/, 'the coupled cron is disclosed');
});
