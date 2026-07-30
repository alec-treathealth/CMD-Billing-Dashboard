/**
 * Hermetic tests for the CONSOLIDATED billing-audit ingest (report 10064394, filters
 * B/C — recon record 2026-07-29). No real DB, no network, no live keys; all PHI-shaped
 * values are SYNTHETIC. Covers: the 43-name set-validated header (Charge/Debit ID at
 * position 4, modifier order 1/3/2), TOB scope derivation incl. the FAIL-LOUD
 * quarantine on an unrecognised prefix, the revenue-code corroboration check,
 * mapConsolidatedRow (required fields, new date columns, entered-never-billed),
 * fingerprint RECIPE PARITY with the legacy 46-col IP mapper (the ruled backfill
 * match), the identity classifier (decision table for the charge_debit_id key
 * transition), the two-arbiter upsert SQL shape, honest SUCCESS-empty recording, and
 * the OP-scope soak deferral.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HMAC_KEY = 'a'.repeat(64);
const TEST_SODIUM_KEY = 'b'.repeat(64);
process.env.INDEX_HMAC_KEY = TEST_HMAC_KEY;
process.env.LIBSODIUM_KEY = TEST_SODIUM_KEY;

const {
  AUDIT_CONSOLIDATED_CUSTOMERS, EXPECTED_EMPTY_AUDIT_CUSTOMERS,
  consolidatedAuditReportIds, consolidatedOpWriteEnabled, rosterScopeForCustomer,
  AUDIT_IP_CUSTOMERS, AUDIT_OP_CUSTOMERS,
} = await import('../src/billingAudit/auditConfig.js');
const {
  CONSOLIDATED_HEADERS, IP_HEADERS, consolidatedHeaderMismatch, resolveConsolidatedHeader,
  deriveScopeFromTob, revCodeConsistentWithScope, mapConsolidatedRow, mapAuditRow,
} = await import('../src/billingAudit/auditRowMap.js');
const { classifyConsolidatedBatch, upsertConsolidatedRows, consolidatedAuditCron } =
  await import('../src/billingAudit/auditConsolidated.js');
const { recordAuditIngestRun, billingAuditCron } = await import('../src/billingAudit/auditIngest.js');
const { BXR_ENTITY_ID } = await import('../src/tenants.js');

// --- fixtures -------------------------------------------------------------------------

/** Canonical-order row from a name→value map (header names are unique on this feed). */
function cRow(values: Record<string, string>): string[] {
  return CONSOLIDATED_HEADERS.map((h) => values[h] ?? '');
}

const C_BASE: Record<string, string> = {
  'Patient Full Name': 'TESTPATIENT, JANE',
  'Patient Birthday': '1/2/1990',
  'Claim Primary Member ID': 'ZGP12345678',
  'Charge/Debit ID': '778812345',
  'Type of Bill': '863',
  'Charge From Date': '3/5/2026',
  'Charge To Date': '3/7/2026',
  'Charge CPT Code': 'H0017',
  'Charge Billed Revenue Code': '0156',
  'Charge Units': '3',
  'Charge Status': 'CLAIM AT ANTHEM BLUE CROSS CALIFORNIA',
  'Patient Admission Date': '3/1/2026',
  'Claim Principal Diag': 'F33.1',
  'Claim Principal Diag POA': 'Y',
  'Claim Diag 2': 'F41.1',
  'Claim Diag 2 POA': 'N',
  'Primary Auth #': 'AUTH-1',
  'Claim Type': 'Institutional',
  'Charge Primary Payer Name': 'ANTHEM BLUE CROSS CALIFORNIA',
  'Charge Amount': '$6,750.00',
  'Charge Claim ID': '900001',
  'Charge Patient ID': '800001',
  'Provider Full Name': 'PROVIDER, TEST',
  'Office Name': 'CALIFORNIA MENTAL HEALTH LLC',
  'Claim Status': 'CLAIM AT ANTHEM BLUE CROSS CALIFORNIA',
  'Claim Date Entered': '2/20/2026',
  'Claim First Billed Date': '3/10/2026',
};

/** CSV text (quoted where needed) for the cron-loop tests. */
function toCsv(header: readonly string[], rows: string[][]): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');
}

// --- header set -----------------------------------------------------------------------

test('CONSOLIDATED_HEADERS: 43 columns (re-locked 2026-07-30), Charge/Debit ID at position 4, modifiers 1/3/2', () => {
  assert.equal(CONSOLIDATED_HEADERS.length, 43);
  assert.equal(CONSOLIDATED_HEADERS[3], 'Charge/Debit ID');
  assert.equal(CONSOLIDATED_HEADERS[18], 'Claim Admit Code'); // inserted 2026-07-30 (validated, not stored)
  assert.equal(CONSOLIDATED_HEADERS[23], 'Charge Modifier 1'); // trio moved 27-29 → 24-26 (1-based)
  assert.equal(CONSOLIDATED_HEADERS[24], 'Charge Modifier 3'); // the report really emits 1,3,2
  assert.equal(CONSOLIDATED_HEADERS[25], 'Charge Modifier 2');
  assert.equal(CONSOLIDATED_HEADERS[41], 'Claim Date Entered');
  assert.equal(CONSOLIDATED_HEADERS[42], 'Claim First Billed Date');
});

test('name-set guard: exact set passes; REORDER-ONLY input passes (ruling 2026-07-30)', () => {
  assert.equal(consolidatedHeaderMismatch([...CONSOLIDATED_HEADERS]), null);
  const reversed = [...CONSOLIDATED_HEADERS].reverse();
  assert.equal(consolidatedHeaderMismatch(reversed), null);
  const swapped = [...CONSOLIDATED_HEADERS];
  [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
  assert.equal(consolidatedHeaderMismatch(swapped), null); // a pure move is a non-event
});

test('name-set guard: an ADDED name fails loud and is named', () => {
  const added = [...CONSOLIDATED_HEADERS, 'Brand New Column'];
  assert.match(consolidatedHeaderMismatch(added)!, /unexpected \[Brand New Column\]/);
});

test('name-set guard: a DROPPED name fails loud and is named', () => {
  const dropped = CONSOLIDATED_HEADERS.filter((h) => h !== 'Charge/Debit ID');
  assert.match(consolidatedHeaderMismatch([...dropped])!, /missing \[Charge\/Debit ID\]/);
});

test('name-set guard: a DUPLICATED name fails loud (resolution would be ambiguous)', () => {
  const duped = [...CONSOLIDATED_HEADERS.slice(0, 42), 'Charge Status'];
  const msg = consolidatedHeaderMismatch(duped)!;
  assert.match(msg, /duplicated \[Charge Status\]/);
});

test('name-set guard: the dead 46-col IP set still fails (different name set)', () => {
  assert.notEqual(consolidatedHeaderMismatch([...IP_HEADERS]), null);
});

test('reordered file maps to IDENTICAL values and fingerprint via the per-file index', () => {
  const canonical = mapConsolidatedRow(cRow(C_BASE));
  assert.ok(canonical.kind === 'ok');
  // Reverse the whole file: header and row cells move together, as in a real reorder.
  const revHeader = [...CONSOLIDATED_HEADERS].reverse();
  const revRow = [...cRow(C_BASE)].reverse();
  const resolved = resolveConsolidatedHeader(revHeader);
  assert.ok(resolved.ok);
  if (!resolved.ok || canonical.kind !== 'ok') return;
  const remapped = mapConsolidatedRow(revRow, null, resolved.index);
  assert.equal(remapped.kind, 'ok');
  if (remapped.kind !== 'ok') return;
  assert.deepEqual(remapped.row, canonical.row); // identical fields INCLUDING row_fingerprint
});

// --- TOB scope derivation (fail-loud) ---------------------------------------------------

test('deriveScopeFromTob: {11,86}→IP, {13,89,76}→OP — measured prefixes, two digits', () => {
  for (const t of ['863', '861', '862', '867', '868', '111', '112', '113', '117']) {
    assert.equal(deriveScopeFromTob(t), 'IP', `tob ${t}`);
  }
  for (const t of ['893', '892', '897', '898', '133', '132', '137', '763']) {
    assert.equal(deriveScopeFromTob(t), 'OP', `tob ${t}`);
  }
  assert.equal(deriveScopeFromTob('0863'), 'IP'); // official 4-digit leading-zero form
});

test('deriveScopeFromTob: unrecognised prefixes/shapes return null — NEVER a default scope', () => {
  for (const t of ['999', '213', '12', '86', 'ABC', '86X', '', '  ', '8631']) {
    assert.equal(deriveScopeFromTob(t), null, `tob "${t}"`);
  }
  assert.equal(deriveScopeFromTob(null), null);
});

test('revCodeConsistentWithScope: 01xx/10xx are IP-only, 09xx OP-only, unknown shapes pass', () => {
  assert.equal(revCodeConsistentWithScope('IP', '0156'), true);
  assert.equal(revCodeConsistentWithScope('IP', '1002'), true);
  assert.equal(revCodeConsistentWithScope('OP', '0156'), false);
  assert.equal(revCodeConsistentWithScope('OP', '0912'), true);
  assert.equal(revCodeConsistentWithScope('IP', '0912'), false);
  assert.equal(revCodeConsistentWithScope('IP', '912'), false); // 3-digit form pads to 0912
  assert.equal(revCodeConsistentWithScope('IP', null), true);
  assert.equal(revCodeConsistentWithScope('OP', 'junk'), true);
});

// --- mapConsolidatedRow -----------------------------------------------------------------

test('mapConsolidatedRow: full happy path — derived scope, key, new date columns, mod order', () => {
  const res = mapConsolidatedRow(cRow({ ...C_BASE, 'Charge Modifier 2': 'HK', 'Charge Modifier 3': 'ZZ' }));
  assert.equal(res.kind, 'ok');
  if (res.kind !== 'ok') return;
  assert.equal(res.row.audit_scope, 'IP'); // 863 → IP
  assert.equal(res.row.charge_debit_id, '778812345');
  assert.equal(res.row.claim_date_entered, '2026-02-20');
  assert.equal(res.row.claim_first_billed_date, '2026-03-10');
  assert.equal(res.row.modifier_2, 'HK'); // read by NAME from position 28, not 27
  assert.equal(res.row.rev_code, '0156');
  assert.equal(res.row.member_id, 'ZGP12345678');
  assert.equal(res.row.payer_name, 'ANTHEM BLUE CROSS CALIFORNIA');
  assert.equal(res.row.status_category, 'AT_PAYER');
  assert.equal(res.row.charge_amount_cents, 675000);
  assert.equal(res.row.claim_frequency, null); //  not on this projection
  assert.equal(res.row.billing_provider_id, null);
  assert.equal(res.row.last_fu_note, null); //     PHI-surface reduction
  assert.deepEqual(res.row.diagnoses.map((d) => [d.code, d.poa, d.pos]), [['F33.1', 'Y', 1], ['F41.1', 'N', 2]]);
  assert.equal(res.row.rev_scope_consistent, true);
  assert.equal(res.row.scope_source, 'tob');
});

test('mapConsolidatedRow: entered-never-billed (blank first-billed) is a VALID state, not a skip', () => {
  const res = mapConsolidatedRow(cRow({ ...C_BASE, 'Claim First Billed Date': '' }));
  assert.equal(res.kind, 'ok');
  if (res.kind === 'ok') assert.equal(res.row.claim_first_billed_date, null);
});

test('mapConsolidatedRow: unrecognised TOB quarantines (fail-loud), never defaults a scope', () => {
  // A roster fallback being AVAILABLE must not rescue a non-blank unrecognised TOB.
  const res = mapConsolidatedRow(cRow({ ...C_BASE, 'Type of Bill': '999' }), 'OP');
  assert.equal(res.kind, 'quarantine');
  if (res.kind === 'quarantine') assert.match(res.label, /type_of_bill: unrecognized "999"/);
});

// --- professional-claim roster fallback (ruling 2026-07-29) ------------------------------

/** A professional (CMS-1500) row: TOB and revenue code both structurally blank. */
const PROF_ROW: Record<string, string> = {
  ...C_BASE, 'Type of Bill': '', 'Charge Billed Revenue Code': '',
  'Claim Type': 'Professional', 'Charge CPT Code': '90853', 'Charge Units': '1',
};

test('fallback: TOB+rev both blank scopes from the roster with scope_source provenance', () => {
  const op = mapConsolidatedRow(cRow(PROF_ROW), 'OP');
  assert.equal(op.kind, 'ok');
  if (op.kind === 'ok') {
    assert.equal(op.row.audit_scope, 'OP');
    assert.equal(op.row.scope_source, 'roster_fallback');
    assert.equal(op.row.rev_code, null);
  }
  const ip = mapConsolidatedRow(cRow(PROF_ROW), 'IP');
  assert.equal(ip.kind, 'ok');
  if (ip.kind === 'ok') {
    assert.equal(ip.row.audit_scope, 'IP');
    assert.equal(ip.row.scope_source, 'roster_fallback');
  }
});

test('fallback: a recognisable TOB always wins over the roster (never overridden)', () => {
  const res = mapConsolidatedRow(cRow(C_BASE), 'OP'); // TOB 863 → IP even under an OP roster
  assert.equal(res.kind, 'ok');
  if (res.kind === 'ok') {
    assert.equal(res.row.audit_scope, 'IP');
    assert.equal(res.row.scope_source, 'tob');
  }
});

test('fail-loud STAYS (narrowed): both-blank without a single-roster customer quarantines', () => {
  const res = mapConsolidatedRow(cRow(PROF_ROW), null);
  assert.equal(res.kind, 'quarantine');
  if (res.kind === 'quarantine') assert.match(res.label, /not in a single-scope roster/);
});

test('fail-loud STAYS: blank TOB with a revenue code PRESENT is not the professional signature', () => {
  const res = mapConsolidatedRow(cRow({ ...C_BASE, 'Type of Bill': '' }), 'OP'); // rev 0156 present
  assert.equal(res.kind, 'quarantine');
  if (res.kind === 'quarantine') assert.match(res.label, /blank with revenue code present/);
});

test('rosterScopeForCustomer: exactly-one-roster membership, else null', () => {
  assert.equal(rosterScopeForCustomer('10027973'), 'IP'); // CAMH
  assert.equal(rosterScopeForCustomer('10029722'), 'OP'); // TREAT_TX
  assert.equal(rosterScopeForCustomer('10035976'), null); // HOUSTON_MH — not rostered
  assert.equal(rosterScopeForCustomer(''), null);
});

test('mapConsolidatedRow: required-field skips carry column labels only', () => {
  const noKey = mapConsolidatedRow(cRow({ ...C_BASE, 'Charge/Debit ID': '' }));
  assert.deepEqual(noKey, { kind: 'skip', label: 'charge_debit_id: missing' });
  const badKey = mapConsolidatedRow(cRow({ ...C_BASE, 'Charge/Debit ID': '77-88' }));
  assert.deepEqual(badKey, { kind: 'skip', label: 'charge_debit_id: invalid' });
  const noName = mapConsolidatedRow(cRow({ ...C_BASE, 'Patient Full Name': '' }));
  assert.deepEqual(noName, { kind: 'skip', label: 'patient_name: missing' });
  const badDate = mapConsolidatedRow(cRow({ ...C_BASE, 'Claim Date Entered': 'not-a-date' }));
  assert.deepEqual(badDate, { kind: 'skip', label: 'claim_date_entered: invalid' });
});

test('fingerprint RECIPE PARITY: a legacy 46-col IP row and its consolidated equivalent hash identically', () => {
  // The ruled backfill matches legacy rows BY FINGERPRINT — this is the invariant that
  // makes it work. Same identity values through both mappers → same fingerprint.
  const shared = {
    claim: '900001', patient: '800001', tob: '863', from: '3/5/2026', to: '3/7/2026',
    admit: '3/1/2026', cpt: 'H0017', rev: '0156', units: '3', amount: '$6,750.00',
  };
  const legacy = mapAuditRow('IP', IP_HEADERS.map((h) => ({
    'Patient Full Name': 'TESTPATIENT, JANE', 'Charge Claim ID': shared.claim,
    'Charge Patient ID': shared.patient, 'Type of Bill': shared.tob,
    'Charge From Date': shared.from, 'Charge To Date': shared.to,
    'Admission Date': shared.admit, 'Charge CPT Code': shared.cpt,
    'Charge Rev Code': shared.rev, 'Charge Units': shared.units,
    'Charge Amount': shared.amount, 'Charge Status': 'PAID',
  } as Record<string, string>)[h] ?? ''));
  const consolidated = mapConsolidatedRow(cRow({
    ...C_BASE, 'Charge Claim ID': shared.claim, 'Charge Patient ID': shared.patient,
    'Type of Bill': shared.tob, 'Charge From Date': shared.from, 'Charge To Date': shared.to,
    'Patient Admission Date': shared.admit, 'Charge CPT Code': shared.cpt,
    'Charge Billed Revenue Code': shared.rev, 'Charge Units': shared.units,
    'Charge Amount': shared.amount,
    'Statement Covers From Date': '', 'Statement Covers To Date': '',
  }));
  assert.ok(legacy.ok && consolidated.kind === 'ok');
  if (!legacy.ok || consolidated.kind !== 'ok') return;
  assert.equal(consolidated.row.row_fingerprint, legacy.row.row_fingerprint);
  // No modifier 2 on the row → the legacy variant is redundant and stays null.
  assert.equal(consolidated.row.legacy_fingerprint, null);
});

test('fingerprint legacy variant: only materializes for IP rows that DO carry a modifier 2', () => {
  const withMod2 = mapConsolidatedRow(cRow({ ...C_BASE, 'Charge Modifier 2': 'HK' }));
  assert.ok(withMod2.kind === 'ok');
  if (withMod2.kind !== 'ok') return;
  assert.notEqual(withMod2.row.legacy_fingerprint, null);
  assert.notEqual(withMod2.row.legacy_fingerprint, withMod2.row.row_fingerprint);
});

// --- identity classifier (the ruled key transition) -------------------------------------

function mkRow(key: string, fp: string, legacyFp: string | null = null) {
  const base = mapConsolidatedRow(cRow({ ...C_BASE, 'Charge/Debit ID': key }));
  assert.ok(base.kind === 'ok');
  if (base.kind !== 'ok') throw new Error('fixture');
  return { ...base.row, charge_debit_id: key, row_fingerprint: fp, legacy_fingerprint: legacyFp };
}

test('classifyConsolidatedBatch: decision table', () => {
  const rows = [
    mkRow('100000001', 'fp-existing-key'), //      key already exists → viaKey
    mkRow('100000002', 'fp-legacy-null'), //       fp match, NULL key → stamp
    mkRow('100000003', 'fp-x', 'fp-legacy-variant'), // legacy VARIANT match, NULL key → stamp on the variant
    mkRow('100000004', 'fp-owned-by-other'), //    fp owned by a different key → quarantine
    mkRow('100000005', 'fp-brand-new'), //         nothing matches → viaKey (plain insert)
  ];
  const out = classifyConsolidatedBatch(rows, {
    fingerprintOwners: new Map([
      ['fp-legacy-null', null],
      ['fp-legacy-variant', null],
      ['fp-owned-by-other', '999999999'],
    ]),
    existingKeys: new Set(['100000001']),
  });
  assert.deepEqual(out.upsertViaKey.map((r) => r.charge_debit_id), ['100000001', '100000005']);
  assert.deepEqual(
    out.stampViaFingerprint.map((s) => [s.row.charge_debit_id, s.arbiterFingerprint]),
    [['100000002', 'fp-legacy-null'], ['100000003', 'fp-legacy-variant']],
  );
  assert.deepEqual(out.quarantined, [{ label: 'fingerprint_conflict' }]);
});

test('classifyConsolidatedBatch: in-batch duplicate fingerprints quarantine the later row', () => {
  const rows = [mkRow('100000010', 'fp-same'), mkRow('100000011', 'fp-same')];
  const out = classifyConsolidatedBatch(rows, { fingerprintOwners: new Map(), existingKeys: new Set() });
  assert.equal(out.upsertViaKey.length, 1);
  assert.deepEqual(out.quarantined, [{ label: 'fingerprint_duplicate_in_batch' }]);
});

// --- upsert SQL shape --------------------------------------------------------------------

function fakeConsolidatedDb(opts?: { fingerprintOwners?: Array<{ row_fingerprint: string; charge_debit_id: string | null }>; existingKeys?: string[] }) {
  const upserts: { sql: string; params: unknown[] }[] = [];
  let guc: string | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (/set_config/i.test(s)) { guc = params?.[0] == null ? null : String(params[0]); return { rowCount: 1, rows: [{ set_config: guc }] }; }
      if (/current_setting/i.test(s)) return { rowCount: 1, rows: [{ v: guc }] };
      if (/^select row_fingerprint, charge_debit_id/i.test(s)) return { rowCount: 0, rows: opts?.fingerprintOwners ?? [] };
      if (/^select charge_debit_id from claims\.audit_row/i.test(s)) {
        return { rowCount: 0, rows: (opts?.existingKeys ?? []).map((k) => ({ charge_debit_id: k })) };
      }
      if (/^insert into claims\.audit_row/i.test(s)) {
        upserts.push({ sql: s, params: params ?? [] });
        const tuples = (s.match(/\(\$\d+/g) ?? []).length;
        return { rowCount: tuples, rows: Array.from({ length: tuples }, (_, i) => ({ inserted: i === 0 })) };
      }
      if (/^insert into claims\.audit_ingest_run/i.test(s)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  return { db: { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client }, upserts };
}

test('upsertConsolidatedRows: key-arbiter SQL shape — partial-index conflict target + customer guard', async () => {
  const fake = fakeConsolidatedDb();
  const row = mkRow('300000001', 'fp-new-a');
  const counts = await upsertConsolidatedRows(fake.db as never, [row], BXR_ENTITY_ID, '10064394', 'CAMH', '10027973', '10148376');
  assert.equal(fake.upserts.length, 1);
  const sql = fake.upserts[0]!.sql;
  assert.match(sql, /on conflict \(business_entity_id, charge_debit_id\) where charge_debit_id is not null do update set/);
  assert.match(sql, /where claims\.audit_row\.cmd_customer_id is null or claims\.audit_row\.cmd_customer_id = excluded\.cmd_customer_id/);
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
  const updateClause = sql.slice(sql.indexOf('do update set'));
  assert.ok(!/\brow_fingerprint = excluded\./.test(updateClause)); //   write-once
  assert.ok(!/\blast_fu_note = excluded\./.test(updateClause)); //     feed-absent — never null-overwrite
  assert.ok(!/\bclaim_frequency = excluded\./.test(updateClause));
  assert.ok(/\bcharge_debit_id = excluded\.charge_debit_id/.test(updateClause));
  assert.ok(/\bsource_filter_id = excluded\.source_filter_id/.test(updateClause));
  assert.ok(/\bcharge_amount_cents = excluded\.charge_amount_cents/.test(updateClause)); // key identity → feed fields assertable
  assert.equal(counts.inserted, 1);
});

test('upsertConsolidatedRows: legacy match routes through the FINGERPRINT arbiter and stamps the key', async () => {
  const fake = fakeConsolidatedDb({ fingerprintOwners: [{ row_fingerprint: 'fp-legacy', charge_debit_id: null }] });
  const row = mkRow('300000002', 'fp-legacy');
  const counts = await upsertConsolidatedRows(fake.db as never, [row], BXR_ENTITY_ID, '10064394', 'CAMH', '10027973', '10148376');
  assert.equal(fake.upserts.length, 1);
  const sql = fake.upserts[0]!.sql;
  assert.match(sql, /on conflict \(business_entity_id, row_fingerprint\) do update set/);
  assert.match(sql, /where claims\.audit_row\.charge_debit_id is null or claims\.audit_row\.charge_debit_id = excluded\.charge_debit_id/);
  // The fake reports non-inserted rows as updates → stamped_legacy counts them… here the
  // single tuple reports inserted=true (fake convention), so it lands as an insert.
  assert.equal(counts.inserted + counts.stamped_legacy, 1);
});

// --- honest empty recording (item 6) -----------------------------------------------------

const CONS_STATS_BASE = {
  scope: 'CONSOLIDATED' as const, customers_total: 17, customers_processed: 17, customers_failed: 0,
  customers_header_mismatch: 0, customers_skipped_budget: 0, customers_empty: 1,
  customers_empty_unexpected: 0, rows_fetched: 8225, mapped_valid: 8225, skipped: 0,
  skipped_by_label: {}, inserted: 100, updated: 8100, all_rows_skipped_customers: 0,
  per_customer: [{ customer_id: '10033951', facility: 'WRC', outcome: 'empty' as const }],
};

function fakeIngestRunDb() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  let guc: string | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (/set_config/i.test(s)) { guc = params?.[0] == null ? null : String(params[0]); return { rowCount: 1, rows: [{ set_config: guc }] }; }
      if (/current_setting/i.test(s)) return { rowCount: 1, rows: [{ v: guc }] };
      if (/^insert into claims\.audit_ingest_run/i.test(s)) { inserts.push({ sql: s, params: params ?? [] }); return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  return { db: { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client }, inserts };
}

test('recordAuditIngestRun: customers_empty is persisted; expected-empty alone stays ok', async () => {
  const fake = fakeIngestRunDb();
  await recordAuditIngestRun(fake.db as never, BXR_ENTITY_ID,
    { scope: 'CONSOLIDATED', sourceReportId: '10064394', writerUser: 'claims_audit_writer_svc', startedAt: '2026-07-29T02:40:00Z' },
    CONS_STATS_BASE as never);
  const { sql, params } = fake.inserts[0]!;
  assert.match(sql, /customers_empty/);
  assert.equal(params[1], 'CONSOLIDATED');
  assert.equal(params[4], 'ok'); //    WRC-style expected empty — not partial
  assert.equal(params[11], 1); //      customers_empty value (col 12)
});

test('recordAuditIngestRun: an UNEXPECTED empty marks the run partial (the raced-night fix)', async () => {
  const fake = fakeIngestRunDb();
  await recordAuditIngestRun(fake.db as never, BXR_ENTITY_ID,
    { scope: 'CONSOLIDATED', sourceReportId: '10064394', writerUser: 'claims_audit_writer_svc', startedAt: '2026-07-29T02:40:00Z' },
    { ...CONS_STATS_BASE, customers_empty_unexpected: 1 } as never);
  assert.equal(fake.inserts[0]!.params[4], 'partial');
});

test('recordAuditIngestRun: quarantined rows mark the run partial (fail-loud TOB path)', async () => {
  const fake = fakeIngestRunDb();
  await recordAuditIngestRun(fake.db as never, BXR_ENTITY_ID,
    { scope: 'CONSOLIDATED', sourceReportId: '10064394', writerUser: 'claims_audit_writer_svc', startedAt: '2026-07-29T02:40:00Z' },
    { ...CONS_STATS_BASE, rows_quarantined: 2 } as never);
  assert.equal(fake.inserts[0]!.params[4], 'partial');
});

test('billingAuditCron (OP path): SUCCESS-empty counts + unexpected detection via injected seed', async () => {
  const fake = fakeConsolidatedDb();
  const stats = await billingAuditCron({
    scope: 'OP',
    customers: [
      { customerId: '10033951', facilityCode: 'WRC', businessEntityId: BXR_ENTITY_ID },
      { customerId: '10031212', facilityCode: 'TREAT_WA', businessEntityId: BXR_ENTITY_ID },
    ],
    fetchZip: async () => null, // both SUCCESS-empty
    zipToCsvTexts: () => [],
    writeDb: fake.db as never,
    businessEntityId: BXR_ENTITY_ID,
    sourceReportId: '10073210',
    expectedEmptyCustomerIds: EXPECTED_EMPTY_AUDIT_CUSTOMERS,
    hasPriorRows: async (facility) => facility === 'TREAT_WA', // data-bearing customer went empty
  });
  assert.equal(stats.customers_empty, 2);
  assert.equal(stats.customers_empty_unexpected, 1); // WRC allowlisted; TREAT_WA is the alarm
  const treatWa = stats.per_customer.find((c) => c.facility === 'TREAT_WA');
  assert.match(treatWa?.reason ?? '', /UNEXPECTED/);
});

// --- the consolidated cron loop -----------------------------------------------------------

test('consolidatedAuditCron: B+C per customer, scope split, OP soak deferral, quarantine marking, roster fallback', async () => {
  const ipRow = cRow(C_BASE); //                                        863 → IP
  const opRow = cRow({ ...C_BASE, 'Charge/Debit ID': '778812346', 'Type of Bill': '893', 'Charge Billed Revenue Code': '0912', 'Charge Claim ID': '900002' });
  const badTobRow = cRow({ ...C_BASE, 'Charge/Debit ID': '778812347', 'Type of Bill': '999' });
  // Professional row (both blank) — CAMH is IP-rostered, so it scopes IP via fallback and WRITES.
  const profRow = cRow({ ...C_BASE, 'Charge/Debit ID': '778812348', 'Type of Bill': '', 'Charge Billed Revenue Code': '', 'Claim Type': 'Professional', 'Charge Claim ID': '900004' });
  const csvB = toCsv(CONSOLIDATED_HEADERS, [ipRow, opRow, badTobRow, profRow]);
  const fake = fakeConsolidatedDb();
  const zipSentinel = Buffer.from('zip');

  const stats = await consolidatedAuditCron({
    customers: [
      { customerId: '10027973', facilityCode: 'CAMH', businessEntityId: BXR_ENTITY_ID },
      { customerId: '10033951', facilityCode: 'WRC', businessEntityId: BXR_ENTITY_ID },
    ],
    fetchZip: async (customerId, filterId) => {
      if (customerId === '10033951') return null; //       WRC: both filters empty
      return filterId === 'FILTER-B' ? zipSentinel : null; // CAMH: B has rows, C empty
    },
    filterBId: 'FILTER-B',
    filterCId: 'FILTER-C',
    zipToCsvTexts: () => [csvB],
    writeDb: fake.db as never,
    businessEntityId: BXR_ENTITY_ID,
    sourceReportId: '10064394',
    writeOpScopeRows: false, //                            the soak deferral
    expectedEmptyCustomerIds: EXPECTED_EMPTY_AUDIT_CUSTOMERS,
    hasPriorRows: async () => true,
  });

  assert.equal(stats.scope, 'CONSOLIDATED');
  assert.equal(stats.rows_fetched, 4);
  assert.equal(stats.rows_scope_ip, 2); //                 863 row + the fallback-scoped professional row
  assert.equal(stats.rows_scope_op, 1);
  assert.equal(stats.rows_op_scope_deferred, 1); //        OP row counted, NOT written
  assert.equal(stats.rows_scope_fallback, 1); //           the professional row (provenance counter)
  assert.equal(stats.rows_quarantined, 1); //              the 999 TOB row (fail-loud stays)
  assert.match(Object.keys(stats.quarantined_by_label).join(' '), /type_of_bill: unrecognized "999"/);
  assert.equal(stats.customers_empty, 1); //               WRC (allowlisted → not unexpected)
  assert.equal(stats.customers_empty_unexpected, 0);
  assert.equal(stats.customers_processed, 2);
  // The IP row AND the fallback professional row reached the writer: one statement, two tuples.
  assert.equal(fake.upserts.length, 1);
  assert.equal(fake.upserts[0]!.params.length, 46 * 2);
  const camh = stats.per_customer.find((c) => c.facility === 'CAMH');
  assert.match(camh?.reason ?? '', /B:4 C:0 quarantined:1/);
});

test('consolidatedAuditCron: writeOpScopeRows=true writes both scopes (the cutover mode)', async () => {
  const csv = toCsv(CONSOLIDATED_HEADERS, [
    cRow(C_BASE),
    cRow({ ...C_BASE, 'Charge/Debit ID': '778812348', 'Type of Bill': '893', 'Charge Billed Revenue Code': '0912', 'Charge Claim ID': '900003' }),
  ]);
  const fake = fakeConsolidatedDb();
  const stats = await consolidatedAuditCron({
    customers: [{ customerId: '10027973', facilityCode: 'CAMH', businessEntityId: BXR_ENTITY_ID }],
    fetchZip: async (_c, filterId) => (filterId === 'B' ? Buffer.from('zip') : null),
    filterBId: 'B', filterCId: 'C',
    zipToCsvTexts: () => [csv],
    writeDb: fake.db as never,
    businessEntityId: BXR_ENTITY_ID,
    sourceReportId: '10064394',
    writeOpScopeRows: true,
    expectedEmptyCustomerIds: EXPECTED_EMPTY_AUDIT_CUSTOMERS,
  });
  assert.equal(stats.rows_op_scope_deferred, 0);
  assert.equal(fake.upserts.length, 1);
  // Both rows in one statement: 46 insert columns (scope_source added by 0074) × 2 tuples.
  assert.equal(fake.upserts[0]!.params.length, 46 * 2);
});

// --- config ---------------------------------------------------------------------------------

test('AUDIT_CONSOLIDATED_CUSTOMERS: the 17-customer union, IP-first, no duplicates', () => {
  assert.equal(AUDIT_CONSOLIDATED_CUSTOMERS.length, 17);
  assert.equal(AUDIT_CONSOLIDATED_CUSTOMERS.length, AUDIT_IP_CUSTOMERS.length + AUDIT_OP_CUSTOMERS.length);
  assert.equal(new Set(AUDIT_CONSOLIDATED_CUSTOMERS.map((c) => c.customerId)).size, 17);
  assert.equal(AUDIT_CONSOLIDATED_CUSTOMERS[0]!.customerId, AUDIT_IP_CUSTOMERS[0]!.customerId);
  // HOUSTON_MH / TREAT_CO / TREAT_VA stay excluded (INVALID CRITERIA, probes 2026-07-29).
  const ids = new Set(AUDIT_CONSOLIDATED_CUSTOMERS.map((c) => c.customerId));
  for (const excluded of ['10035976', '10035974', '10036125']) assert.ok(!ids.has(excluded));
});

test('consolidatedAuditReportIds: env-var-only, throws with NAMES (never values) on a missing var', () => {
  assert.deepEqual(
    consolidatedAuditReportIds({
      CMD_AUDIT_CONSOLIDATED_REPORT_ID: '10064394',
      CMD_AUDIT_CONSOLIDATED_FILTER_B_ID: '10148376',
      CMD_AUDIT_CONSOLIDATED_FILTER_C_ID: '10148377',
    }),
    { reportId: '10064394', filterBId: '10148376', filterCId: '10148377' },
  );
  assert.throws(
    () => consolidatedAuditReportIds({ CMD_AUDIT_CONSOLIDATED_REPORT_ID: '10064394' }),
    /CMD_AUDIT_CONSOLIDATED_FILTER_B_ID/,
  );
});

test('consolidatedOpWriteEnabled: off by default; affirmative values only', () => {
  assert.equal(consolidatedOpWriteEnabled({}), false);
  assert.equal(consolidatedOpWriteEnabled({ CMD_AUDIT_CONSOLIDATED_OP_WRITE: '0' }), false);
  assert.equal(consolidatedOpWriteEnabled({ CMD_AUDIT_CONSOLIDATED_OP_WRITE: 'off' }), false);
  assert.equal(consolidatedOpWriteEnabled({ CMD_AUDIT_CONSOLIDATED_OP_WRITE: '1' }), true);
  assert.equal(consolidatedOpWriteEnabled({ CMD_AUDIT_CONSOLIDATED_OP_WRITE: 'true' }), true);
  assert.equal(consolidatedOpWriteEnabled({ CMD_AUDIT_CONSOLIDATED_OP_WRITE: 'ON' }), true);
});
