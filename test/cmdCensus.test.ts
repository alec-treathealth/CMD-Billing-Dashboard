/**
 * Hermetic tests for the CMD charge-census ingest (Qualify v2 ②b). No live DB / LLM: PHI crypto runs
 * locally (throwaway keys below), and a fake pool/client records the withTenant + upsert query sequence.
 *
 * Locked census invariants:
 *  - ONLY charge_id + patient_name gate a row (skip+count, label-only). A blank member_id is a KEPT
 *    self-pay census row (the denominator must not drop it). Every other field: blank/unparseable → null.
 *  - Duplicate charge_id in one pull collapses to ONE row (last wins) BEFORE the insert.
 *  - Upsert = ON CONFLICT (business_entity_id, charge_id) DO UPDATE SET last_seen_at=now() + dims;
 *    RETURNING (xmax = 0) separates rows_new from rows_refreshed. All writes go through withTenant.
 *  - PHI encrypted before insert (bytea params, never plaintext); no PHI in any skip label.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type pg from 'pg';
import {
  mapCensusRow,
  mapCensusRows,
  insertCensusRows,
  type CensusPlainRow,
} from '../src/collections/cmdCensus.js';
import type { CmdExplorerFullRow, CmdExplorerPhi } from '../src/collections/cmdExplorer.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

/** 32-byte throwaway test keys (obvious dummies — NOT real secrets). Distinct per key-separation rule. */
const LIB_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const HMAC_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
beforeEach(() => {
  process.env.LIBSODIUM_KEY = LIB_KEY;
  process.env.INDEX_HMAC_KEY = HMAC_KEY;
});

// --- mapCensusRow -----------------------------------------------------------

type RowOverride = Partial<Omit<CmdExplorerFullRow, 'phi'>> & { phi?: Partial<CmdExplorerPhi> };

/** A valid 21-column report row (as mapReportRows emits), with overrides. */
function fullRow(override: RowOverride = {}): CmdExplorerFullRow {
  const { phi: phiOverride, ...rest } = override;
  return {
    rowId: '',
    charge_from_date: '5/4/2026',
    payment_received: '6/18/2026',
    cpt_code: 'H0019',
    revenue_code: '0100',
    facility: 'DALLAS MENTAL HEALTH LLC',
    charge_amount: '$5,895.00',
    allowed_amount: '$1,997.29',
    insurance_payments: '$998.64',
    adjustments: '$0.00',
    patient_balance_due: '$998.65',
    primary_payer: 'AETNA',
    charge_id: '654759712',
    charge_entered_date: '2/17/2026',
    charge_to_date: '5/4/2026',
    claim_status_raw: 'PAID',
    employer_name: null,
    ...rest,
    phi: { patient_name: 'SMITH, JOHN', member_id_raw: 'PGE081', group_number: 'GRP123', ...phiOverride },
  };
}

test('mapCensusRow: a valid row maps ok — normalized dims + derived status category', () => {
  const r = mapCensusRow(fullRow());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.row.charge_id, '654759712');
    assert.equal(r.row.charge_date, '2026-05-04'); //         M/D/YYYY → ISO
    assert.equal(r.row.charge_entered_date, '2026-02-17');
    assert.equal(r.row.charge_amount, '5895.00'); //          $5,895.00 → decimal string
    assert.equal(r.row.claim_status_category, 'PAID'); //     derived via normalizeStatus
    assert.equal(r.row.member_id, 'PGE081');
  }
});

test('mapCensusRow: SELF-PAY (blank member_id) is KEPT, member_id null — the denominator must not drop it', () => {
  for (const blank of ['', null] as const) {
    const r = mapCensusRow(fullRow({ phi: { member_id_raw: blank } }));
    assert.equal(r.ok, true, `member_id=${JSON.stringify(blank)} must be kept`);
    if (r.ok) assert.equal(r.row.member_id, null);
  }
});

test('mapCensusRow: REQUIRED charge_id blank/null → skip "charge_id: missing"', () => {
  for (const blank of ['', null] as const) {
    const r = mapCensusRow(fullRow({ charge_id: blank }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.label, 'charge_id: missing');
  }
});

test('mapCensusRow: REQUIRED patient_name blank/null → skip "patient_name: missing"', () => {
  for (const blank of ['', null] as const) {
    const r = mapCensusRow(fullRow({ phi: { patient_name: blank } }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.label, 'patient_name: missing');
  }
});

test('mapCensusRow: soft dimensions blank/unparseable → NULL, row KEPT (census divergence from mapRow)', () => {
  const r = mapCensusRow(
    fullRow({ facility: '', charge_amount: 'not-a-number', charge_from_date: '', charge_to_date: '13/99/2026', cpt_code: null }),
  );
  assert.equal(r.ok, true, 'a soft-dimension blank/garbage must NOT drop a census row');
  if (r.ok) {
    assert.equal(r.row.facility, null);
    assert.equal(r.row.charge_amount, null); //   unparseable money → null (not a skip)
    assert.equal(r.row.charge_date, null); //     blank date → null
    assert.equal(r.row.charge_to_date, null); //  invalid date → null
    assert.equal(r.row.cpt_code, null);
  }
});

test('mapCensusRow: claim_status_category is NULL when raw is blank/null, derived when present', () => {
  const blank = mapCensusRow(fullRow({ claim_status_raw: null }));
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.row.claim_status_category, null);
  const atPayer = mapCensusRow(fullRow({ claim_status_raw: 'CLAIM AT AETNA' }));
  assert.equal(atPayer.ok, true);
  if (atPayer.ok) assert.equal(atPayer.row.claim_status_category, 'AT_PAYER');
});

test('mapCensusRow: skip labels name the FIELD only — never a cell value (PHI-safe)', () => {
  const labels = [mapCensusRow(fullRow({ charge_id: '' })), mapCensusRow(fullRow({ phi: { patient_name: '' } }))]
    .filter((r): r is { ok: false; label: string } => !r.ok)
    .map((r) => r.label);
  assert.equal(labels.length, 2);
  for (const label of labels) {
    assert.match(label, /^(charge_id|patient_name): missing$/);
    assert.doesNotMatch(label, /SMITH|JOHN|PGE081|GRP123/); // no PHI ever in a label
  }
});

// --- mapCensusRows: collapse + skip counting --------------------------------

/** A parsed CMD report row (header → value) as parseReportCsv would emit. */
function reportRow(o: Record<string, string>): CmdReportRow {
  return {
    'Charge ID': '900001',
    'Patient Full Name': 'DOE, JANE',
    'Claim Primary Member ID': 'M123',
    'Primary Group Number': 'G9',
    'Charge From Date': '5/4/2026',
    'Charge Entered Date': '2/17/2026',
    'Charge To Date': '5/4/2026',
    'Charge CPT Code': 'H0019',
    'Revenue Code': '0100',
    'Charge/Debit Amount': '$5,895.00',
    'Charge Primary Payer Name': 'AETNA',
    'Facility Name': 'DALLAS MENTAL HEALTH LLC',
    'Claim Status': 'PAID',
    ...o,
  };
}

test('mapCensusRows: duplicate charge_id collapses to ONE row (last occurrence wins); blank charge_id counted', () => {
  const out = mapCensusRows([
    reportRow({ 'Charge ID': 'DUP1', 'Claim Status': 'ON HOLD' }),
    reportRow({ 'Charge ID': 'DUP1', 'Claim Status': 'PAID' }), // later snapshot wins
    reportRow({ 'Charge ID': 'UNIQ2' }),
    reportRow({ 'Charge ID': '' }), // required-field skip
  ]);
  assert.equal(out.rows.length, 2, 'DUP1 collapses to one; UNIQ2 stands; blank charge_id dropped');
  const dup = out.rows.find((r) => r.charge_id === 'DUP1');
  assert.equal(dup?.claim_status_category, 'PAID', 'last occurrence (PAID) wins the collapse');
  assert.equal(out.skipsByLabel.get('charge_id: missing'), 1);
});

// --- insertCensusRows: upsert writer via a fake tenant-scoped pool -----------

const INSERT_COL_COUNT = 19; // INSERT_COLS.length — one tuple's params

function fakeCensusPool(insertedFlags?: (tupleCount: number) => boolean[]) {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  let guc: string | null = null;
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/set_config/i.test(sql)) {
        guc = params?.[0] === undefined ? null : String(params[0]);
        return { rows: [{ set_config: guc }], rowCount: 1 };
      }
      if (/current_setting/i.test(sql)) return { rows: [{ v: guc }], rowCount: 1 };
      if (/insert into collections\.cmd_charge_census/i.test(sql)) {
        const n = (params?.length ?? 0) / INSERT_COL_COUNT;
        const flags = insertedFlags ? insertedFlags(n) : Array(n).fill(true);
        return { rows: flags.map((inserted) => ({ inserted })), rowCount: flags.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      throw new Error('pool.query() must never be used (txn escape)');
    },
  };
  return { pool: pool as unknown as pg.Pool, calls };
}

function plain(o: Partial<CensusPlainRow> = {}): CensusPlainRow {
  return {
    charge_id: 'C1',
    patient_name: 'SMITH, JOHN',
    member_id: 'PGE081',
    group_number: 'GRP123',
    charge_date: '2026-05-04',
    charge_entered_date: '2026-02-17',
    charge_to_date: '2026-05-04',
    facility: 'DALLAS MENTAL HEALTH LLC',
    cpt_code: 'H0019',
    revenue_code: '0100',
    charge_amount: '5895.00',
    primary_payer: 'AETNA',
    claim_status_raw: 'PAID',
    claim_status_category: 'PAID',
    ...o,
  };
}

test('insertCensusRows: writes through withTenant with the GUC-scoped upsert shape', async () => {
  const { pool, calls } = fakeCensusPool();
  const stats = await insertCensusRows(pool, [plain()], BXR_ENTITY_ID, 42);
  assert.deepEqual(stats, { inserted: 1, refreshed: 0 });
  // Exactly the withTenant sequence, all on one client.
  assert.deepEqual(calls.map((c) => c.sql.replace(/\s+/g, ' ').slice(0, 6)), ['BEGIN', 'select', 'select', 'insert', 'COMMIT']);
  const insertCall = calls.find((c) => /insert into collections\.cmd_charge_census/i.test(c.sql))!;
  assert.match(insertCall.sql, /on conflict \(business_entity_id, charge_id\) do update set/);
  assert.match(insertCall.sql, /last_seen_at = now\(\)/);
  assert.match(insertCall.sql, /returning \(xmax = 0\) as inserted/);
  // NEVER refresh the conflict key from EXCLUDED.
  assert.doesNotMatch(insertCall.sql, /business_entity_id = excluded/);
  assert.doesNotMatch(insertCall.sql, /charge_id = excluded/);
});

test('insertCensusRows: PHI is encrypted (bytea params, never plaintext); entity is stamped first', async () => {
  const { pool, calls } = fakeCensusPool();
  await insertCensusRows(pool, [plain()], BXR_ENTITY_ID, 7);
  const p = calls.find((c) => /insert into/i.test(c.sql))!.params!;
  assert.equal(p[0], BXR_ENTITY_ID); //          $1 business_entity_id
  assert.equal(p[1], 'C1'); //                   $2 charge_id (non-PHI)
  assert.ok(Buffer.isBuffer(p[2]), 'patient_name must be encrypted bytea');
  assert.ok(Buffer.isBuffer(p[3]), 'member_id must be encrypted bytea');
  assert.ok(Buffer.isBuffer(p[4]), 'group_number must be encrypted bytea');
  // no plaintext PHI anywhere in the params
  for (const v of p) assert.notEqual(v, 'SMITH, JOHN');
});

test('insertCensusRows: SELF-PAY (member_id null) → null ciphertext + null member blind indexes, patient still encrypted', async () => {
  const { pool, calls } = fakeCensusPool();
  await insertCensusRows(pool, [plain({ member_id: null, group_number: null })], BXR_ENTITY_ID, null);
  const p = calls.find((c) => /insert into/i.test(c.sql))!.params!;
  assert.ok(Buffer.isBuffer(p[2]), 'patient_name still encrypted');
  assert.equal(p[3], null, 'null member_id → null ciphertext');
  assert.equal(p[4], null, 'null group_number → null ciphertext');
  assert.equal(p[5], null, 'null member_id → null member_id_bidx');
  assert.equal(p[6], null, 'null member_id → null member_id_prefix_bidx');
  assert.equal(p[7], null, 'null group_number → null group_number_bidx');
});

test('insertCensusRows: duplicate charge_id in ONE call collapses to a single tuple (last wins)', async () => {
  const { pool, calls } = fakeCensusPool();
  await insertCensusRows(
    pool,
    [plain({ charge_id: 'DUP', claim_status_category: 'ON_HOLD' }), plain({ charge_id: 'DUP', claim_status_category: 'PAID' })],
    BXR_ENTITY_ID,
    1,
  );
  const insertCall = calls.find((c) => /insert into/i.test(c.sql))!;
  assert.equal(insertCall.params!.length, INSERT_COL_COUNT, 'one tuple only — no same-statement double-conflict');
  assert.equal(insertCall.params![17], 'PAID', 'last occurrence wins (claim_status_category)');
});

test('insertCensusRows: counts rows_new vs rows_refreshed from the (xmax = 0) RETURNING', async () => {
  // 3 distinct charges; the fake reports insert / update / insert.
  const { pool } = fakeCensusPool(() => [true, false, true]);
  const stats = await insertCensusRows(pool, [plain({ charge_id: 'A' }), plain({ charge_id: 'B' }), plain({ charge_id: 'C' })], BXR_ENTITY_ID, 9);
  assert.deepEqual(stats, { inserted: 2, refreshed: 1 });
});
