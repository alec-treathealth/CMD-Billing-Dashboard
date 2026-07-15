/**
 * Hermetic tests for the Billing Audit ingest (src/billingAudit/) — no real DB, no
 * network, no live keys. All PHI-shaped values are SYNTHETIC fixtures. Covers: the
 * 24-value status normalization, money→cents / date / units coercion, positional CSV
 * (duplicate OP headers preserved), header locks, diag collapse, the LOCKED Option-B
 * stable-identity fingerprint (status churn must NOT move it), mapAuditRow required
 * fields, the additive patient-name blind-index helpers, env-only auditReportIds, and
 * the upsertAuditRows ON CONFLICT DO UPDATE shape via a fake pg pool.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HMAC_KEY = 'a'.repeat(64);
const TEST_SODIUM_KEY = 'b'.repeat(64);
process.env.INDEX_HMAC_KEY = TEST_HMAC_KEY;
process.env.LIBSODIUM_KEY = TEST_SODIUM_KEY;

const { auditReportIds, AUDIT_IP_CUSTOMERS, AUDIT_OP_CUSTOMERS } = await import('../src/billingAudit/auditConfig.js');
const {
  IP_HEADERS, OP_HEADERS, headerMismatch, parsePositionalCsv, normalizeStatus,
  toIsoDate, toCents, toUnits, collapseDiagnoses, mapAuditRow,
} = await import('../src/billingAudit/auditRowMap.js');
const { upsertAuditRows, billingAuditCron, recordAuditIngestRun } = await import('../src/billingAudit/auditIngest.js');
const {
  patientNameNormalized, patientNameBlindIndex, patientNamePrefixBlindIndex,
  auditBlindIndexesForRowSafe,
} = await import('../src/collections/blindIndex.js');
const { BXR_ENTITY_ID } = await import('../src/tenants.js');

// --- fixture builders ---------------------------------------------------------------

/** Positional IP row from a name→value map (unnamed columns default to ''). */
function ipRow(values: Record<string, string>): string[] {
  const used = new Set<string>();
  return IP_HEADERS.map((h) => {
    void used; // IP has no duplicate headers
    return values[h] ?? '';
  });
}

/** Positional OP row; the duplicate 'Charge Status' gets the SAME value in both slots
 *  (probe-verified live behavior) unless a second value is passed for the dup test. */
function opRow(values: Record<string, string>, dupStatusOverride?: string): string[] {
  let statusSeen = 0;
  return OP_HEADERS.map((h) => {
    if (h === 'Charge Status') {
      statusSeen++;
      return statusSeen === 2 && dupStatusOverride !== undefined ? dupStatusOverride : (values[h] ?? '');
    }
    return values[h] ?? '';
  });
}

const IP_BASE: Record<string, string> = {
  'Patient Full Name': 'TESTPATIENT, JANE',
  'Patient Birthday': '1/2/1990',
  'Claim Primary Member ID': 'ZGP12345678',
  'Type of Bill': '863',
  'Charge From Date': '3/5/2026',
  'Charge To Date': '3/7/2026',
  'Charge CPT Code': 'H0017',
  'Charge Rev Code': '0156',
  'Charge Units': '3',
  'Charge Status': 'CLAIM AT ANTHEM BLUE CROSS CALIFORNIA',
  'Charge Claim ID': '900001',
  'Charge Patient ID': '800001',
  'Claim Type': 'Institutional',
  'Charge Amount': '$6,750.00',
  'Claim Primary Payer Name': 'ANTHEM BLUE CROSS CALIFORNIA',
  'Primary Auth #': 'AUTH-1',
  'Claim Principal Diag': 'F33.1',
  'Claim Principal Diag POA': 'Y',
  'Claim Principal Diag Description': 'Major depressive disorder',
  'Claim Diag 2': 'F41.1',
  'Claim Diag 2 POA': 'N',
  'Claim Diag 2 Description': 'Generalized anxiety disorder',
  'Office Name': 'CALIFORNIA MENTAL HEALTH LLC',
  'Provider Full Name': 'PROVIDER, TEST',
};

// --- status normalization (live 24-value vocabulary) ---------------------------------

test('normalizeStatus: fixed labels map to their categories', () => {
  assert.deepEqual(normalizeStatus('PAID'), { category: 'PAID', statusPayer: null });
  assert.deepEqual(normalizeStatus('BALANCE DUE PATIENT'), { category: 'BALANCE_DUE_PATIENT', statusPayer: null });
  assert.deepEqual(normalizeStatus('APPROVED FOR HIGHER PAYMENT'), { category: 'APPROVED_HIGHER', statusPayer: null });
  assert.deepEqual(normalizeStatus('NEEDS RENEGOTIATING'), { category: 'NEEDS_RENEGOTIATING', statusPayer: null });
  assert.deepEqual(normalizeStatus('ON HOLD'), { category: 'ON_HOLD', statusPayer: null });
});

test('normalizeStatus: CLAIM AT <X> family → AT_PAYER with the payer extracted', () => {
  assert.deepEqual(normalizeStatus('CLAIM AT AETNA'), { category: 'AT_PAYER', statusPayer: 'AETNA' });
  assert.deepEqual(normalizeStatus('CLAIM AT UMR FKA UMR WAUSAU'), { category: 'AT_PAYER', statusPayer: 'UMR FKA UMR WAUSAU' });
  // ' - SECONDARY' suffix strips INTO the payer; the raw string is preserved elsewhere.
  assert.deepEqual(normalizeStatus('CLAIM AT BLUECARD PROGRAM OF WA - SECONDARY'), {
    category: 'AT_PAYER', statusPayer: 'BLUECARD PROGRAM OF WA',
  });
  // SELF PAY is a real live value — still AT_PAYER at this layer (rule logic decides later).
  assert.deepEqual(normalizeStatus('CLAIM AT SELF PAY'), { category: 'AT_PAYER', statusPayer: 'SELF PAY' });
});

test('normalizeStatus: PENDING FOR HIGHER PAYMENT and unknowns → OTHER (raw preserved by caller)', () => {
  assert.equal(normalizeStatus('PENDING FOR HIGHER PAYMENT').category, 'OTHER');
  assert.equal(normalizeStatus('SOMETHING NEW').category, 'OTHER');
  assert.equal(normalizeStatus('').category, 'OTHER');
  assert.equal(normalizeStatus(null).category, 'OTHER');
  // Case/whitespace tolerant on the fixed labels.
  assert.equal(normalizeStatus('  paid ').category, 'PAID');
  assert.equal(normalizeStatus('claim  at   cigna').category, 'AT_PAYER');
});

// --- coercions ------------------------------------------------------------------------

test('toCents: money strings become exact integer cents', () => {
  assert.deepEqual(toCents('$6,750.00'), { ok: true, value: 675000 });
  assert.deepEqual(toCents('-$1,660.05'), { ok: true, value: -166005 });
  assert.deepEqual(toCents(''), { ok: true, value: null });
  assert.equal(toCents('abc').ok, false);
});

test('toIsoDate: M/D/YYYY and ISO accepted, garbage rejected, blank null', () => {
  assert.deepEqual(toIsoDate('3/5/2026'), { ok: true, value: '2026-03-05' });
  assert.deepEqual(toIsoDate('2026-03-05'), { ok: true, value: '2026-03-05' });
  assert.deepEqual(toIsoDate(''), { ok: true, value: null });
  assert.equal(toIsoDate('13/40/2026').ok, false);
  assert.equal(toIsoDate('2026-02-30').ok, false);
});

test('toUnits: numerics pass, blanks null, junk rejected', () => {
  assert.deepEqual(toUnits('3'), { ok: true, value: '3' });
  assert.deepEqual(toUnits('1.5'), { ok: true, value: '1.5' });
  assert.deepEqual(toUnits(''), { ok: true, value: null });
  assert.equal(toUnits('three').ok, false);
});

// --- positional CSV + header locks ----------------------------------------------------

test('parsePositionalCsv: quoted commas survive and duplicate headers stay positional', () => {
  const text = 'A,B,A\r\n"x, y",2,3\n';
  const { header, rows } = parsePositionalCsv(text);
  assert.deepEqual(header, ['A', 'B', 'A']);
  assert.deepEqual(rows, [['x, y', '2', '3']]);
});

test('headerMismatch: exact locked headers pass; drift is rejected with a label-only message', () => {
  assert.equal(headerMismatch('IP', [...IP_HEADERS]), null);
  assert.equal(headerMismatch('OP', [...OP_HEADERS]), null);
  assert.match(headerMismatch('IP', [...IP_HEADERS].slice(0, 45))!, /column count 45/);
  const swapped: string[] = [...OP_HEADERS];
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  assert.match(headerMismatch('OP', swapped)!, /column 0/);
});

test('locked header lists carry the probe-verified shapes (46 IP / 39 OP, OP dup status)', () => {
  assert.equal(IP_HEADERS.length, 46);
  assert.equal(OP_HEADERS.length, 39);
  assert.equal(OP_HEADERS.filter((h) => h === 'Charge Status').length, 2);
  assert.equal(OP_HEADERS[30], 'Current Payer Member ID');
});

// --- diag collapse ---------------------------------------------------------------------

test('collapseDiagnoses: IP keeps descriptions and positions; blank codes are skipped', () => {
  const row = ipRow({ ...IP_BASE, 'Claim Diag 4': 'Z00.0', 'Claim Diag 4 POA': 'U' });
  const diags = collapseDiagnoses(row, 'IP');
  assert.deepEqual(diags.map((d) => [d.pos, d.code, d.poa, d.desc]), [
    [1, 'F33.1', 'Y', 'Major depressive disorder'],
    [2, 'F41.1', 'N', 'Generalized anxiety disorder'],
    [4, 'Z00.0', 'U', null],
  ]);
});

test('collapseDiagnoses: OP has no descriptions and max 5 positions', () => {
  const row = opRow({ 'Claim Principal Diag': 'F10.20', 'Claim Principal Diag POA': 'Y', 'Claim Diag 5': 'F17.210' });
  const diags = collapseDiagnoses(row, 'OP');
  assert.deepEqual(diags.map((d) => [d.pos, d.code, d.desc]), [
    [1, 'F10.20', null],
    [5, 'F17.210', null],
  ]);
});

// --- mapAuditRow + the LOCKED fingerprint ----------------------------------------------

test('mapAuditRow (IP): full row maps; status/payer extracted; cents exact', () => {
  const result = mapAuditRow('IP', ipRow(IP_BASE));
  assert.ok(result.ok);
  const row = result.row;
  assert.equal(row.audit_scope, 'IP');
  assert.equal(row.cmd_claim_id, '900001');
  assert.equal(row.charge_amount_cents, 675000);
  assert.equal(row.status_category, 'AT_PAYER');
  assert.equal(row.status_payer, 'ANTHEM BLUE CROSS CALIFORNIA');
  assert.equal(row.charge_from_date, '2026-03-05');
  assert.equal(row.member_id, 'ZGP12345678');
  assert.equal(row.units, '3');
  assert.equal(row.modifier_2, null); // IP has no Modifier 2 column
  assert.equal(row.diagnoses.length, 2);
});

test('mapAuditRow (OP): member id reads from Current Payer Member ID; first dup status wins', () => {
  const result = mapAuditRow('OP', opRow({
    'Patient Full Name': 'TESTPATIENT, JOHN',
    'Current Payer Member ID': 'XYZ999',
    'Charge From Date': '4/1/2026',
    'Charge Amount': '$100.00',
    'Charge Claim ID': '900002',
    'Charge Patient ID': '800002',
    'Charge Status': 'PAID',
    'Charge Modifier 2': 'GT',
  }));
  assert.ok(result.ok);
  assert.equal(result.row.member_id, 'XYZ999');
  assert.equal(result.row.status_category, 'PAID');
  assert.equal(result.row.modifier_2, 'GT');
  assert.equal(result.row.units, null); // OP has no Charge Units column
});

test('mapAuditRow: required-field skips carry column labels only (never cell values)', () => {
  const noClaim = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Charge Claim ID': '' }));
  assert.deepEqual(noClaim, { ok: false, label: 'cmd_claim_id: missing' });
  const noName = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Patient Full Name': ' ' }));
  assert.deepEqual(noName, { ok: false, label: 'patient_name: missing' });
  const badMoney = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Charge Amount': 'oops' }));
  assert.deepEqual(badMoney, { ok: false, label: 'charge_amount: invalid' });
  const badDate = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Charge To Date': '2/30/2026' }));
  assert.deepEqual(badDate, { ok: false, label: 'charge_to_date: invalid' });
});

test('fingerprint: STABLE under status/note/auth churn (Option B), moves on identity change', () => {
  const base = mapAuditRow('IP', ipRow(IP_BASE));
  assert.ok(base.ok);
  // Volatile churn: status flip + new FU note + auth added — SAME fingerprint.
  const churned = mapAuditRow('IP', ipRow({
    ...IP_BASE,
    'Charge Status': 'PAID',
    'Last Public FU Note': 'called payer, reprocessing',
    'Primary Auth #': 'AUTH-2',
    'Claim Primary Payer Name': 'SOMEONE ELSE',
  }));
  assert.ok(churned.ok);
  assert.equal(churned.row.row_fingerprint, base.row.row_fingerprint);
  // Identity change: different CPT — DIFFERENT fingerprint.
  const otherCpt = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Charge CPT Code': 'H0018' }));
  assert.ok(otherCpt.ok);
  assert.notEqual(otherCpt.row.row_fingerprint, base.row.row_fingerprint);
  // Scope is fingerprinted: the same charge under OP would be a distinct row.
  assert.equal(base.row.row_fingerprint.length, 64);
});

// --- patient-name blind indexes (additive helpers) --------------------------------------

test('patient-name blind indexes: normalized, deterministic, prefix at 3 chars', () => {
  assert.equal(patientNameNormalized('  Testpatient,   Jane '), 'TESTPATIENT, JANE');
  const a = patientNameBlindIndex('TESTPATIENT, JANE');
  const b = patientNameBlindIndex('  testpatient,  jane ');
  assert.ok(a && /^[0-9a-f]{64}$/.test(a));
  assert.equal(a, b);
  const p = patientNamePrefixBlindIndex('TESTPATIENT, JANE');
  assert.ok(p && p !== a);
  assert.equal(patientNamePrefixBlindIndex('AB'), null); // below the 3-char floor
  const all = auditBlindIndexesForRowSafe('TESTPATIENT, JANE', 'ZGP12345678');
  assert.equal(all.patient_name_bidx, a);
  assert.ok(all.member_id_bidx && all.member_id_pfx3_bidx);
});

test('auditBlindIndexesForRowSafe: missing key degrades to all-null (ingest-safe)', () => {
  const saved = process.env.INDEX_HMAC_KEY;
  delete process.env.INDEX_HMAC_KEY;
  try {
    const tokens = auditBlindIndexesForRowSafe('TESTPATIENT, JANE', 'ZGP12345678');
    assert.deepEqual(tokens, {
      patient_name_bidx: null, patient_name_pfx3_bidx: null,
      member_id_bidx: null, member_id_pfx3_bidx: null,
    });
  } finally {
    process.env.INDEX_HMAC_KEY = saved;
  }
});

// --- env-only config ----------------------------------------------------------------------

test('auditReportIds: resolves from env and THROWS on a missing var (no fallbacks, names only)', () => {
  const ids = auditReportIds('IP', { CMD_IP_AUDIT_REPORT_ID: ' 1 ', CMD_IP_AUDIT_FILTER_ID: '2' });
  assert.deepEqual(ids, { reportId: '1', filterId: '2' });
  assert.throws(() => auditReportIds('OP', {}), /CMD_OP_AUDIT_REPORT_ID and CMD_OP_AUDIT_FILTER_ID/);
  assert.throws(() => auditReportIds('IP', { CMD_IP_AUDIT_REPORT_ID: '1', CMD_IP_AUDIT_FILTER_ID: ' ' }));
});

test('rosters: locked per-scope shapes (8 IP / 9 OP), all BXR-stamped, disjoint', () => {
  assert.equal(AUDIT_IP_CUSTOMERS.length, 8);
  assert.equal(AUDIT_OP_CUSTOMERS.length, 9);
  // HOUSTON_MH (10035976) + TREAT_CO (10035974) excluded (INVALID CRITERIA, 2026-07-14).
  assert.ok(!AUDIT_OP_CUSTOMERS.some((c) => c.customerId === '10035976' || c.customerId === '10035974'));
  const ip = new Set(AUDIT_IP_CUSTOMERS.map((c) => c.customerId));
  for (const c of AUDIT_OP_CUSTOMERS) assert.ok(!ip.has(c.customerId), `customer ${c.customerId} in both rosters`);
  for (const c of [...AUDIT_IP_CUSTOMERS, ...AUDIT_OP_CUSTOMERS]) assert.equal(c.businessEntityId, BXR_ENTITY_ID);
});

// --- upsert shape (fake pg pool) --------------------------------------------------------

function fakeAuditDb(): { db: unknown; sqls: string[]; paramCounts: number[]; insertedFlags: boolean[][] } {
  const sqls: string[] = [];
  const paramCounts: number[] = [];
  const insertedFlags: boolean[][] = [];
  let guc: string | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (/set_config/i.test(s)) {
        guc = params?.[0] === undefined ? null : String(params[0]);
        return { rowCount: 1, rows: [{ set_config: guc }] };
      }
      if (/current_setting/i.test(s)) return { rowCount: 1, rows: [{ v: guc }] };
      if (/^insert into claims\.audit_row/i.test(s)) {
        sqls.push(s);
        paramCounts.push(params?.length ?? 0);
        // Simulate: first tuple inserted, the rest updated.
        const tuples = (s.match(/\(\$\d+/g) ?? []).length;
        const rows = Array.from({ length: tuples }, (_, i) => ({ inserted: i === 0 }));
        insertedFlags.push(rows.map((r) => r.inserted));
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] }; // begin/commit/rollback
    },
    release: () => {},
  };
  const db = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client };
  return { db, sqls, paramCounts, insertedFlags };
}

test('upsertAuditRows: Option-B SQL shape + inserted/updated split from xmax', async () => {
  const fake = fakeAuditDb();
  const r1 = mapAuditRow('IP', ipRow(IP_BASE));
  const r2 = mapAuditRow('IP', ipRow({ ...IP_BASE, 'Charge Claim ID': '900099', 'Charge Patient ID': '800099' }));
  assert.ok(r1.ok && r2.ok);
  const counts = await upsertAuditRows(fake.db as never, [r1.row, r2.row], BXR_ENTITY_ID, '10064394', 'CAMH');
  assert.equal(fake.sqls.length, 1);
  const sql = fake.sqls[0]!;
  assert.match(sql, /on conflict \(business_entity_id, row_fingerprint\) do update set/);
  assert.match(sql, /charge_status_raw = excluded\.charge_status_raw/);
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
  // Volatile-only updates: the stable-identity columns must NOT be in the update list.
  const updateClause = sql.slice(sql.indexOf('do update set'));
  assert.ok(!/\bcharge_amount_cents = excluded\./.test(updateClause));
  assert.ok(!/\bcpt_code = excluded\./.test(updateClause));
  assert.ok(!/\brow_fingerprint = excluded\./.test(updateClause));
  // facility_code IS re-asserted on conflict — the go-forward roster stamp (0052).
  assert.ok(/\bfacility_code = excluded\.facility_code/.test(updateClause));
  // 40 insert columns × 2 tuples (facility_code added in 0052 — the go-forward Option-B stamp).
  assert.equal(fake.paramCounts[0], 40 * 2);
  assert.deepEqual(counts, { inserted: 1, updated: 1, key_skipped: 0 });
});

// --- audit_ingest_run observability write (0053) ---------------------------------------

function fakeIngestRunDb(): { db: unknown; inserts: { sql: string; params: unknown[] }[] } {
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

const CLEAN_STATS = {
  scope: 'IP' as const, customers_total: 8, customers_processed: 8, customers_failed: 0,
  customers_header_mismatch: 0, customers_skipped_budget: 0, rows_fetched: 11500, mapped_valid: 11500,
  skipped: 0, skipped_by_label: {}, inserted: 200, updated: 11300, all_rows_skipped_customers: 0,
  per_customer: [{ customer_id: 'C1', facility: 'CAMH', outcome: 'processed' as const, rows_inserted: 1, rows_updated: 2 }],
};

test('recordAuditIngestRun: non-PHI summary row — per_customer jsonb, writer_user, status ok', async () => {
  const fake = fakeIngestRunDb();
  await recordAuditIngestRun(fake.db as never, BXR_ENTITY_ID,
    { scope: 'IP', sourceReportId: '10064394', writerUser: 'claims_audit_writer_svc', startedAt: '2026-07-15T02:10:00Z' },
    CLEAN_STATS as never);
  assert.equal(fake.inserts.length, 1);
  const { sql, params } = fake.inserts[0]!;
  assert.match(sql, /insert into claims\.audit_ingest_run \(/);
  assert.match(sql, /::jsonb\)/); // per_customer cast on the last param
  assert.equal(params[0], BXR_ENTITY_ID);
  assert.equal(params[1], 'IP'); // scope
  assert.equal(params[3], 'claims_audit_writer_svc'); // writer_user
  assert.equal(params[4], 'ok'); // status — no failures
  assert.match(String(params[params.length - 1]), /"facility":"CAMH"/); // per_customer serialized
});

test('recordAuditIngestRun: status=partial when any customer failed/mismatch/budget-skip', async () => {
  const fake = fakeIngestRunDb();
  await recordAuditIngestRun(fake.db as never, BXR_ENTITY_ID,
    { scope: 'OP', sourceReportId: '10073210', writerUser: 'claims_audit_writer_svc', startedAt: '2026-07-15T02:20:00Z' },
    { ...CLEAN_STATS, scope: 'OP', customers_failed: 1 } as never);
  assert.equal(fake.inserts[0]!.params[4], 'partial');
});

// --- cron per-customer observability ---------------------------------------------------

function buildIpCsv(values: Record<string, string>): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = [...IP_HEADERS].join(',');
  const row = [...IP_HEADERS].map((h) => q(values[h] ?? '')).join(',');
  return `${header}\n${row}\n`;
}

test('billingAuditCron: per_customer records each outcome (processed/empty/header_mismatch/failed)', async () => {
  const fake = fakeAuditDb();
  const goodCsv = buildIpCsv({
    'Patient Full Name': 'TESTPATIENT JANE',
    'Charge From Date': '3/5/2026',
    'Charge Amount': '$100.00',
    'Charge Claim ID': '900001',
    'Charge Patient ID': '800001',
    'Charge Status': 'PAID',
    'Charge CPT Code': 'H0018',
  });
  const stats = await billingAuditCron({
    scope: 'IP',
    customers: [
      { customerId: 'C_PROC', facilityCode: 'FPROC', businessEntityId: BXR_ENTITY_ID },
      { customerId: 'C_EMPTY', facilityCode: 'FEMPTY', businessEntityId: BXR_ENTITY_ID },
      { customerId: 'C_MISMATCH', facilityCode: 'FMIS', businessEntityId: BXR_ENTITY_ID },
      { customerId: 'C_FAIL', facilityCode: 'FFAIL', businessEntityId: BXR_ENTITY_ID },
    ],
    fetchZip: async (id) => {
      if (id === 'C_PROC') return Buffer.from(goodCsv);
      if (id === 'C_EMPTY') return null;
      if (id === 'C_MISMATCH') return Buffer.from('Col A,Col B,Col C\n1,2,3\n');
      throw new Error('CMD run failed: INVALID CRITERIA (no identifier)');
    },
    zipToCsvTexts: (zip) => [zip.toString('utf8')],
    writeDb: fake.db as never,
    businessEntityId: BXR_ENTITY_ID,
    sourceReportId: '10064394',
    now: () => 1_000, //     constant clock — budget never trips
    budgetMs: 1_000_000,
  });

  assert.equal(stats.customers_processed, 2); // C_PROC + C_EMPTY both increment
  assert.equal(stats.customers_failed, 1);
  assert.equal(stats.customers_header_mismatch, 1);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.per_customer.length, 4);
  const by = Object.fromEntries(stats.per_customer.map((p) => [p.customer_id, p]));
  assert.equal(by['C_PROC']!.outcome, 'processed');
  assert.equal(by['C_PROC']!.rows_inserted, 1);
  assert.equal(by['C_EMPTY']!.outcome, 'empty');
  assert.equal(by['C_MISMATCH']!.outcome, 'header_mismatch');
  assert.match(by['C_MISMATCH']!.reason!, /column count 3 != expected 46/);
  assert.equal(by['C_FAIL']!.outcome, 'failed');
  assert.match(by['C_FAIL']!.reason!, /INVALID CRITERIA/);
  // reason carries a CMD/DB MESSAGE only — never a cell value (PHI discipline).
  assert.ok(!by['C_FAIL']!.reason!.includes('TESTPATIENT'));
});

test('billingAuditCron: budget guard marks remaining customers skipped_budget in per_customer', async () => {
  const fake = fakeAuditDb();
  let t = 0;
  const stats = await billingAuditCron({
    scope: 'IP',
    customers: [
      { customerId: 'C1', facilityCode: 'F1', businessEntityId: BXR_ENTITY_ID },
      { customerId: 'C2', facilityCode: 'F2', businessEntityId: BXR_ENTITY_ID },
    ],
    fetchZip: async () => null,
    zipToCsvTexts: () => [],
    writeDb: fake.db as never,
    businessEntityId: BXR_ENTITY_ID,
    sourceReportId: '10064394',
    now: () => (t += 10_000), // each call +10s; started=10s, budget 5s → both skip
    budgetMs: 5_000,
  });
  assert.equal(stats.customers_skipped_budget, 2);
  assert.equal(stats.per_customer.length, 2);
  assert.ok(stats.per_customer.every((p) => p.outcome === 'skipped_budget'));
});
