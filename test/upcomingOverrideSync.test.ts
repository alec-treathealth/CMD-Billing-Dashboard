/**
 * "Upcoming Payments" override sync + read — I/O behaviour, hermetically.
 *
 * No network, no database: the Sheets transport is the injected `fetchTab` port and the pool
 * is a fake client that simulates the withTenant GUC handshake (the same shape
 * test/cmdPayerRefresh.test.ts uses, so the hardened read-back in withTenant passes).
 *
 * What these tests are actually protecting:
 *  - REPLACE-PER-SYNC really deletes then inserts, scoped to ONE tenant, in one transaction.
 *  - The hash no-op cannot fire on a half-landed table (the unsound-min() bug class).
 *  - Fail-soft: a sheet failure writes NOTHING, so the tile keeps its last good forecast.
 *  - No network call happens inside the transaction.
 *  - A patient name never reaches the stats object that the cron logs and returns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  OVERRIDE_HEADERS,
  type OverrideGrid,
} from '../src/veris/upcomingOverrideSheet.js';
import {
  mergeUpcomingOverrides,
  upcomingOverrideSync,
  upcomingOverrides,
  type OverrideDb,
  type UpcomingOverrideSummary,
} from '../src/veris/upcomingOverride.js';

const TENANT = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'; // BXR, from src/tenants.ts
const OTHER_TENANT = '141d459c-f371-4229-9a92-ace198e940bb'; // Indigo
const PHI_NAME = 'Jordan M';

const HEADER = [...OVERRIDE_HEADERS];

function grid(...dataRows: string[][]): OverrideGrid {
  return {
    rows: [
      { rowNum: 1, cells: HEADER },
      ...dataRows.map((cells, i) => ({ rowNum: i + 2, cells })),
    ],
  };
}

const SAMPLE = grid(
  ['TMHWA', 'Regence', PHI_NAME, '08/03/2026', 'EFT', '$35,000.00'],
  ['PCMH', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$44,000.00'],
  ['KWC', 'BCBS AR', 'Multiple', '08/05/2026', 'Check', '$72,000.00'],
);

/** The hash the sync will compute for a given grid — lets tests set up a no-op state. */
function hashOf(g: OverrideGrid): string {
  return createHash('sha256').update(JSON.stringify(g.rows), 'utf8').digest('hex');
}

interface Recorder {
  db: OverrideDb;
  sqls: string[];
  deleteParams: unknown[][];
  insertParams: unknown[][];
  guc: () => string | null;
  gucAtDelete: () => string | null;
  transactions: () => { begins: number; commits: number; rollbacks: number };
}

/**
 * Fake pool. `landed` seeds what the no-op probe sees: [total rows, rows matching the hash].
 */
function recorder(landed: { total: number; matching: number } = { total: 0, matching: 0 }): Recorder {
  const sqls: string[] = [];
  const deleteParams: unknown[][] = [];
  const insertParams: unknown[][] = [];
  let guc: string | null = null;
  let gucAtDelete: string | null = null;
  let begins = 0;
  let commits = 0;
  let rollbacks = 0;

  const client = {
    async query(sql: string, params?: unknown[]) {
      sqls.push(sql);
      if (/^\s*begin/i.test(sql)) {
        begins += 1;
        return { rowCount: 0, rows: [] };
      }
      if (/^\s*commit/i.test(sql)) {
        commits += 1;
        return { rowCount: 0, rows: [] };
      }
      if (/^\s*rollback/i.test(sql)) {
        rollbacks += 1;
        return { rowCount: 0, rows: [] };
      }
      // withTenant's GUC handshake + hardened read-back.
      if (/set_config/i.test(sql)) {
        guc = params?.[0] === undefined ? null : String(params[0]);
        return { rowCount: 1, rows: [{ set_config: guc }] };
      }
      if (/current_setting/i.test(sql)) return { rowCount: 1, rows: [{ v: guc }] };
      // The no-op probe.
      if (/count\(\*\)/i.test(sql) && /expected_payment_override/i.test(sql)) {
        return { rowCount: 1, rows: [{ landed: landed.total, matching: landed.matching }] };
      }
      if (/^\s*delete/i.test(sql)) {
        gucAtDelete = guc;
        deleteParams.push(params ?? []);
        return { rowCount: landed.total, rows: [] };
      }
      if (/^\s*insert/i.test(sql)) {
        insertParams.push(params ?? []);
        return { rowCount: (params?.length ?? 0) / 9, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return {
    db: { connect: async () => client } as unknown as OverrideDb,
    sqls,
    deleteParams,
    insertParams,
    guc: () => guc,
    gucAtDelete: () => gucAtDelete,
    transactions: () => ({ begins, commits, rollbacks }),
  };
}

// --- happy path --------------------------------------------------------------

test('sync replaces the tenant rows and reports exact-cents totals', async () => {
  const r = recorder({ total: 2, matching: 0 }); // 2 stale rows at an older hash
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });

  assert.equal(stats.status, 'ok');
  assert.equal(stats.rows_parsed, 3);
  assert.equal(stats.deleted, 2);
  assert.equal(stats.inserted, 3);
  assert.deepEqual(stats.rejects, []);
  assert.deepEqual(stats.unmapped_facilities, []);
  assert.equal(stats.total_cents, 15_100_000); // $151,000.00 exactly
  assert.equal(stats.sheet_hash, hashOf(SAMPLE));
});

test('the whole replace runs in ONE committed transaction', async () => {
  const r = recorder({ total: 1, matching: 0 });
  await upcomingOverrideSync({ fetchTab: async () => SAMPLE, writeDb: r.db, businessEntityId: TENANT });
  const t = r.transactions();
  assert.equal(t.begins, 1);
  assert.equal(t.commits, 1);
  assert.equal(t.rollbacks, 0);
});

test('DELETE is scoped to the syncing tenant — by param AND under that tenant GUC', async () => {
  // On a full-replace write path, a GUC/param mistake could wipe another tenant's forecast.
  const r = recorder({ total: 5, matching: 0 });
  await upcomingOverrideSync({ fetchTab: async () => SAMPLE, writeDb: r.db, businessEntityId: TENANT });
  assert.equal(r.deleteParams.length, 1);
  assert.deepEqual(r.deleteParams[0], [TENANT]);
  assert.equal(r.gucAtDelete(), TENANT, 'DELETE must run under the tenant GUC');
  assert.notEqual(r.gucAtDelete(), OTHER_TENANT);
});

test('every INSERT row is stamped with the syncing tenant and the current hash', async () => {
  const r = recorder();
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(r.insertParams.length, 1); // one multi-row INSERT
  const params = r.insertParams[0]!;
  assert.equal(params.length, 27); // 3 rows x 9 columns
  for (let i = 0; i < params.length; i += 9) {
    assert.equal(params[i], TENANT, `row ${i / 9} tenant stamp`);
    assert.equal(params[i + 8], stats.sheet_hash, `row ${i / 9} hash stamp`);
  }
});

test('money is bound as fixed-2 TEXT, never a JS float', async () => {
  const r = recorder();
  await upcomingOverrideSync({ fetchTab: async () => SAMPLE, writeDb: r.db, businessEntityId: TENANT });
  const params = r.insertParams[0]!;
  const amounts = [params[5], params[14], params[23]];
  assert.deepEqual(amounts, ['35000.00', '44000.00', '72000.00']);
  for (const a of amounts) assert.equal(typeof a, 'string');
});

test('alias resolution happens before the write — canonical codes land, not sheet labels', async () => {
  const r = recorder();
  await upcomingOverrideSync({ fetchTab: async () => SAMPLE, writeDb: r.db, businessEntityId: TENANT });
  const params = r.insertParams[0]!;
  assert.deepEqual([params[1], params[10], params[19]], ['TREAT_WA', 'PCMH', 'KWC']);
});

// --- the no-op ---------------------------------------------------------------

test('unchanged sheet with a fully-landed set is a NO-OP with zero writes', async () => {
  const r = recorder({ total: 3, matching: 3 }); // all 3 rows already carry this hash
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'noop');
  assert.equal(stats.deleted, 0);
  assert.equal(stats.inserted, 0);
  assert.equal(r.deleteParams.length, 0, 'a no-op must not DELETE');
  assert.equal(r.insertParams.length, 0, 'a no-op must not INSERT');
  // Parse results are still reported so the operator sees rejects even on a quiet run.
  assert.equal(stats.rows_parsed, 3);
});

test('a HALF-LANDED table must NOT be declared a no-op (the unsound-min() bug class)', async () => {
  // 3 rows landed but only 2 carry the current hash — a prior run partially applied.
  // An earlier draft used min(sheet_sync_hash) = $2, which could call this a no-op and
  // freeze the forecast in a broken state forever.
  const r = recorder({ total: 3, matching: 2 });
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'ok');
  assert.equal(r.deleteParams.length, 1, 'must fall through to a full replace');
  assert.equal(stats.inserted, 3);
});

test('a hash match with the WRONG row count is not a no-op either', async () => {
  // Sheet now parses to 3 rows but only 2 are landed (both matching). Row-count equality
  // is what catches this.
  const r = recorder({ total: 2, matching: 2 });
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'ok');
  assert.equal(stats.inserted, 3);
});

test('an empty table is never a no-op — the first sync always writes', async () => {
  const r = recorder({ total: 0, matching: 0 });
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'ok');
  assert.equal(stats.inserted, 3);
});

// --- fail-soft ---------------------------------------------------------------

test('a fetch failure is FAIL-SOFT: parse_failed, zero writes, last good data survives', async () => {
  const r = recorder({ total: 3, matching: 3 });
  const stats = await upcomingOverrideSync({
    fetchTab: async () => {
      throw new Error('Sheets API 503');
    },
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'parse_failed');
  assert.equal(stats.sheet_hash, null);
  assert.equal(stats.inserted, 0);
  assert.equal(stats.deleted, 0);
  assert.equal(r.deleteParams.length, 0, 'a failed fetch must NEVER delete the last good rows');
  assert.equal(r.transactions().begins, 0, 'no transaction should even open');
});

test('header drift is FAIL-SOFT, not a crash', async () => {
  const r = recorder({ total: 3, matching: 3 });
  const drifted: OverrideGrid = { rows: [{ rowNum: 1, cells: ['Facility', 'Amount', 'Date'] }] };
  const stats = await upcomingOverrideSync({
    fetchTab: async () => drifted,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'parse_failed');
  assert.equal(r.deleteParams.length, 0);
});

test('an empty sheet DELETEs but inserts nothing — the sheet is the truth', async () => {
  // An operator clearing the tab genuinely means "no forecast". That must propagate, not
  // be treated as an error that preserves stale rows.
  const r = recorder({ total: 3, matching: 0 });
  const stats = await upcomingOverrideSync({
    fetchTab: async () => grid(),
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'ok');
  assert.equal(stats.rows_parsed, 0);
  assert.equal(stats.deleted, 3);
  assert.equal(stats.inserted, 0);
  assert.equal(r.insertParams.length, 0, 'no INSERT statement should be issued at all');
});

// --- no network inside the transaction --------------------------------------

test('the sheet is fetched BEFORE the transaction opens (no I/O inside withTenant)', async () => {
  const order: string[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (/^\s*begin/i.test(sql)) order.push('begin');
      if (/set_config/i.test(sql)) return { rowCount: 1, rows: [{ set_config: params?.[0] }] };
      if (/current_setting/i.test(sql)) return { rowCount: 1, rows: [{ v: TENANT }] };
      if (/count\(\*\)/i.test(sql)) return { rowCount: 1, rows: [{ landed: 0, matching: 0 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  await upcomingOverrideSync({
    fetchTab: async () => {
      order.push('fetch');
      return SAMPLE;
    },
    writeDb: { connect: async () => client } as unknown as OverrideDb,
    businessEntityId: TENANT,
  });
  assert.deepEqual(order, ['fetch', 'begin'], 'fetch must complete before BEGIN');
});

// --- rejects and PHI in the stats -------------------------------------------

test('rejects and unmapped facilities are surfaced in the stats, good rows still land', async () => {
  const r = recorder();
  const stats = await upcomingOverrideSync({
    fetchTab: async () =>
      grid(
        ['CAMH', 'BCBS', 'Multiple', '08/03/2026', 'EFT', '$11,000.00'],
        ['Teen Mental Health', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$2,000.00'],
        ['LSMH', 'Aetna', 'Multiple', 'bad-date', 'EFT', '$1,000.00'],
      ),
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(stats.status, 'ok');
  assert.equal(stats.rows_parsed, 1);
  assert.equal(stats.inserted, 1);
  assert.deepEqual(stats.unmapped_facilities, ['Teen Mental Health']);
  assert.deepEqual(
    stats.rejects.map((x) => [x.rowNum, x.reason]),
    [
      [3, 'unmapped_facility'],
      [4, 'bad_date'],
    ],
  );
  assert.equal(stats.total_cents, 1_100_000);
});

test('THE PHI DROP: no patient name reaches the stats the cron logs and returns', async () => {
  const r = recorder();
  const stats = await upcomingOverrideSync({
    fetchTab: async () => SAMPLE,
    writeDb: r.db,
    businessEntityId: TENANT,
  });
  assert.equal(
    JSON.stringify(stats).includes(PHI_NAME),
    false,
    'patient name leaked into the cron response body',
  );
  // Nor into any bound parameter — the DB must never receive it either.
  assert.equal(
    JSON.stringify(r.insertParams).includes(PHI_NAME),
    false,
    'patient name leaked into a bound INSERT parameter',
  );
  // The boolean DID make it through (row 1 is patient-specific).
  assert.equal(r.insertParams[0]![6], true);
  assert.equal(r.insertParams[0]![15], false);
});

test('malformed tenant id is rejected before any pool use (withTenant fail-fast)', async () => {
  const r = recorder();
  await assert.rejects(
    upcomingOverrideSync({
      fetchTab: async () => SAMPLE,
      writeDb: r.db,
      businessEntityId: 'not-a-uuid',
    }),
    /canonical UUID/i,
  );
  assert.equal(r.transactions().begins, 0);
});

// --- read path ---------------------------------------------------------------

/**
 * Fake pool for the PARTITIONED read: the totals statement is recognized by its
 * `upcoming_total` alias; the two row queries are told apart by their boundary operator
 * (`>=` upcoming vs `<` overdue) — the same distinction the live SQL carries.
 */
function readPool(
  upcomingTotal: string,
  upcomingRows: unknown[],
  overdueTotal: string = '0',
  overdueRows: unknown[] = [],
): OverrideDb {
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (/set_config/i.test(sql)) return { rowCount: 1, rows: [{ set_config: params?.[0] }] };
      if (/current_setting/i.test(sql)) return { rowCount: 1, rows: [{ v: params?.[0] ?? TENANT }] };
      if (/upcoming_total/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ upcoming_total: upcomingTotal, overdue_total: overdueTotal }],
        };
      }
      if (/expected_date >= \$2/i.test(sql)) return { rowCount: upcomingRows.length, rows: upcomingRows };
      if (/expected_date < \$2/i.test(sql)) return { rowCount: overdueRows.length, rows: overdueRows };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  // current_setting must echo the tenant for withTenant's read-back; params[0] on the
  // set_config call is the tenant, so track it.
  let guc: string | null = null;
  const tracking = {
    async query(sql: string, params?: unknown[]) {
      if (/set_config/i.test(sql)) {
        guc = String(params?.[0]);
        return { rowCount: 1, rows: [{ set_config: guc }] };
      }
      if (/current_setting/i.test(sql)) return { rowCount: 1, rows: [{ v: guc }] };
      return client.query(sql, params);
    },
    release() {},
  };
  return { connect: async () => tracking } as unknown as OverrideDb;
}

test('read partitions at the cutoff, normalizes numeric text, and carries the clock value', async () => {
  const upRow = {
    expected_date: '2026-08-03',
    facility_code: 'TREAT_WA',
    payer_label: 'Regence',
    method_label: 'EFT',
    amount: '35000.00',
    is_patient_specific: true,
  };
  const overRow = {
    expected_date: '2026-05-26',
    facility_code: 'KWC',
    payer_label: 'BCBS AR',
    method_label: 'Check',
    amount: '72000.00',
    is_patient_specific: true,
  };
  const out = await upcomingOverrides(
    readPool('35000', [upRow], '72000', [overRow]),
    TENANT,
    '2026-08-03',
  );
  assert.equal(out.cutoff, '2026-08-03', 'the ONE clock value rides in the payload');
  assert.equal(out.upcoming.total, '35000.00'); // '35000' → '35000.00'
  assert.equal(out.upcoming.rows.length, 1);
  assert.equal(out.upcoming.rows_truncated, false);
  // THE PROOF CASE: the past-dated $72,000 row lands in overdue, nowhere else.
  assert.equal(out.overdue.total, '72000.00');
  assert.deepEqual(
    out.overdue.rows.map((r) => r.expected_date),
    ['2026-05-26'],
  );
  assert.equal(out.overdue.rows_truncated, false);
});

test('read returns 0.00 partitions rather than null when there is no forecast', async () => {
  const out = await upcomingOverrides(readPool('0', []), TENANT, '2026-08-03');
  assert.equal(out.upcoming.total, '0.00');
  assert.deepEqual(out.upcoming.rows, []);
  assert.equal(out.overdue.total, '0.00');
  assert.deepEqual(out.overdue.rows, []);
});

// --- merge (Consolidated) ----------------------------------------------------

type PartRows = UpcomingOverrideSummary['upcoming']['rows'];
const part = (
  total: string,
  rows: PartRows,
  overdueTotal = '0.00',
  overdueRows: PartRows = [],
): UpcomingOverrideSummary => ({
  cutoff: '2026-08-03',
  upcoming: { total, rows, rows_truncated: false },
  overdue: { total: overdueTotal, rows: overdueRows, rows_truncated: false },
});

test('merge adds money in exact integer cents, per partition', () => {
  const merged = mergeUpcomingOverrides([
    part('0.10', [], '0.70', []),
    part('0.20', [], '0.10', []),
  ]);
  // Float addition would give 0.30000000000000004 here.
  assert.equal(merged.upcoming.total, '0.30');
  assert.equal(merged.overdue.total, '0.80');
  assert.equal(merged.cutoff, '2026-08-03');
});

test('merge concatenates rows per partition and orders them deterministically', () => {
  const a = part('44000.00', [
    {
      expected_date: '2026-08-04',
      facility_code: 'PCMH',
      payer_label: 'UHC',
      method_label: 'EFT',
      amount: '44000.00',
      is_patient_specific: false,
    },
  ]);
  const b = part(
    '35000.00',
    [
      {
        expected_date: '2026-08-03',
        facility_code: 'TREAT_WA',
        payer_label: 'Regence',
        method_label: 'EFT',
        amount: '35000.00',
        is_patient_specific: true,
      },
    ],
    '72000.00',
    [
      {
        expected_date: '2026-05-26',
        facility_code: 'KWC',
        payer_label: 'BCBS AR',
        method_label: 'Check',
        amount: '72000.00',
        is_patient_specific: true,
      },
    ],
  );
  const merged = mergeUpcomingOverrides([a, b]);
  assert.equal(merged.upcoming.total, '79000.00');
  assert.deepEqual(
    merged.upcoming.rows.map((r) => r.expected_date),
    ['2026-08-03', '2026-08-04'],
    'ascending by date regardless of input order',
  );
  // The overdue partition merges independently — no cross-partition bleed.
  assert.equal(merged.overdue.total, '72000.00');
  assert.deepEqual(
    merged.overdue.rows.map((r) => r.facility_code),
    ['KWC'],
  );
  // Reversing the input must not change the output.
  assert.deepEqual(mergeUpcomingOverrides([b, a]).upcoming.rows, merged.upcoming.rows);
});

test('merge of a single part returns it untouched', () => {
  const only = part('123.45', []);
  assert.equal(mergeUpcomingOverrides([only]), only);
});

test('merge propagates truncation from any part, per partition', () => {
  const t = part('1.00', []);
  t.upcoming.rows_truncated = true;
  const merged = mergeUpcomingOverrides([t, part('2.00', [])]);
  assert.equal(merged.upcoming.rows_truncated, true);
  assert.equal(merged.overdue.rows_truncated, false, 'truncation never bleeds across partitions');
  assert.equal(merged.upcoming.total, '3.00');
});
