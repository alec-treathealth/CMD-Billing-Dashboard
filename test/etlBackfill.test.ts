/**
 * Hermetic PHI-firewall tests for src/veris/etl_backfill.ts (migration 020's
 * loader counterpart). No DB, no network.
 *
 * The PHI denylist is enforced STRUCTURALLY: the loader's SQL is a fixed
 * column allowlist, so the strongest hermetic assertion is that no denylisted
 * name appears anywhere in the module — not in the upsert SQL, not in the
 * dry-run SQL, not in the gate queries, not in any log-line template. The
 * loader also never SELECTs row data into process memory (INSERT..SELECT is
 * DB-side; only counts return), so "selected into application memory" reduces
 * to the same source-level assertion.
 *
 * Companion runtime guard: migration 020 carries an apply-time DO-block that
 * RAISEs if staging.brain1_features ever grows a PHI column (the
 * information_schema assertion, enforced where the schema actually lives).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BRAIN1_INSERT_COLUMNS,
  BACKFILL_UPSERT_SQL,
  DRY_RUN_COUNTS_SQL,
  GATE_QUERIES,
} from '../src/veris/etl_backfill.js';

/**
 * The absolute four (the CLAUDE.md PHI denylist for staging.brain1_features)
 * plus the wider set of PHI-bearing names in this schema. Matched as
 * whole-word, case-insensitive.
 */
const PHI_DENYLIST = [
  'patient_last',
  'patient_first',
  'member_id',
  'dob',
  'patient_name',
  'patient_id',
  'group_number',
  'member_id_raw',
  'member_id_norm',
  'employer_name',
] as const;

/** claim_line's encrypted PHI columns — never referenced, even as ciphertext. */
const ENC_COLUMN_RE = /\b\w+_enc\b/i;

function assertNoPhi(label: string, text: string): void {
  for (const term of PHI_DENYLIST) {
    const re = new RegExp(`\\b${term}\\b`, 'i');
    assert.ok(!re.test(text), `${label} must not reference PHI column "${term}"`);
  }
  assert.ok(!ENC_COLUMN_RE.test(text), `${label} must not reference any *_enc encrypted column`);
}

test('insert column allowlist is exactly the fixed non-PHI set', () => {
  const allowed = new Set([
    'business_entity_id', 'charge_debit_id', 'claim_line_id', 'claim_facility_id',
    'outcome', 'days_to_pay', 'was_underpayment', 'net_underpayment_amt', 'allowed_amount',
    'residual_type', 'label_is_terminal',
    'canonical_primary_payer_name', 'canonical_primary_payer_family', 'payer_type',
    'network_status', 'participates_in_era',
    'cpt_code', 'rev_code', 'tos_code', 'units', 'diagnosis_pointer_count',
    'tob_facility_type', 'tob_care_setting', 'tob_frequency', 'claim_type', 'claim_frequency',
    'billed_amount', 'dos', 'dos_year', 'dos_month', 'dos_dow', 'insurance_billing_lag',
    'claim_rendering_provider', 'charge_rendering_provider', 'is_training_eligible',
    'built_at', 'built_by',
  ]);
  assert.equal(BRAIN1_INSERT_COLUMNS.length, allowed.size, 'allowlist length drifted');
  for (const col of BRAIN1_INSERT_COLUMNS) {
    assert.ok(allowed.has(col), `unexpected column in insert allowlist: ${col}`);
  }
  assertNoPhi('BRAIN1_INSERT_COLUMNS', BRAIN1_INSERT_COLUMNS.join(' '));
});

test('upsert SQL references no PHI column', () => {
  assertNoPhi('BACKFILL_UPSERT_SQL', BACKFILL_UPSERT_SQL);
});

test('dry-run SQL references no PHI column', () => {
  assertNoPhi('DRY_RUN_COUNTS_SQL', DRY_RUN_COUNTS_SQL);
});

test('every conservation-gate query references no PHI column', () => {
  for (const [name, sql] of Object.entries(GATE_QUERIES)) {
    assertNoPhi(`GATE_QUERIES.${name}`, sql);
  }
});

test('entire loader source (including log templates) references no PHI column', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/veris/etl_backfill.ts'),
    'utf8',
  );
  assertNoPhi('src/veris/etl_backfill.ts', src);
});

test('upsert is structurally monotonic: it can never write PENDING and never deletes', () => {
  assert.ok(!/\bPENDING\b/.test(BACKFILL_UPSERT_SQL),
    'upsert SQL must not be able to write outcome=PENDING');
  const loaderSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/veris/etl_backfill.ts'),
    'utf8',
  );
  assert.ok(!/\bDELETE\s+FROM\b/i.test(loaderSrc), 'loader must contain no DELETE statement');
  assert.ok(!/\bTRUNCATE\b/i.test(loaderSrc), 'loader must contain no TRUNCATE statement');
});

test('upsert conflicts on the ratified Option-A key and updates only label-side columns', () => {
  assert.ok(BACKFILL_UPSERT_SQL.includes('ON CONFLICT (business_entity_id, charge_debit_id)'),
    'upsert must target the existing (business_entity_id, charge_debit_id) unique key');
  const doUpdate = BACKFILL_UPSERT_SQL.split('DO UPDATE SET')[1] ?? '';
  const assigned = [...doUpdate.matchAll(/^\s*(\w+)\s*=/gm)]
    .map((m) => m[1])
    .filter((c): c is string => typeof c === 'string');
  const labelSide = new Set([
    'outcome', 'days_to_pay', 'was_underpayment', 'net_underpayment_amt',
    'allowed_amount', 'residual_type', 'label_is_terminal', 'claim_line_id',
    'built_at', 'built_by',
  ]);
  assert.ok(assigned.length > 0, 'expected DO UPDATE SET assignments');
  for (const col of assigned) {
    assert.ok(labelSide.has(col), `DO UPDATE must not rewrite feature column: ${col}`);
  }
});
