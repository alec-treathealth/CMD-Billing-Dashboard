/**
 * Collections Postgres data access for the loader. Connects as the least-privilege
 * `claims_admin` role (CLAIMS_ADMIN_DATABASE_URL) over node-postgres, verify-full
 * TLS via src/ssl.ts. Every value is a `$n` parameter; columns are fixed literals;
 * writes are batched. Mirrors src/db.ts.
 *
 * Idempotency:
 *   - collections_raw: upsert on (source_file_id, source_tab, source_row_num).
 *   - payment_lines / negotiation_worklist / rollup_snapshots: 1:1 with raw, so
 *     ON CONFLICT (collections_raw_id) DO NOTHING.
 *   - daily_collections: 1-raw-row→many-facility (wide blocks), so idempotency is
 *     the bucket (facility_code, source_group_code, payment_date) — ON CONFLICT
 *     DO NOTHING on the collections_daily_bucket index.
 */
import pg from 'pg';
import { verifyFullSsl } from '../ssl.js';
import type { DailyRow, NegotiationRow, PaymentLineRow, RawRecord, RollupRow } from './types.js';

const BATCH = 500;
export type Db = pg.Pool;
/** Pool OR a checked-out client — both expose .query, so the same writers can run
 *  standalone (legacy ingest) or inside a transaction (deposit-sheet replace). */
type Queryable = { query: pg.Pool['query'] };

export function makeClient(connectionString: string): Db {
  return new pg.Pool({ connectionString, ssl: verifyFullSsl(), max: 4, application_name: 'collections-ingest' });
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** Upsert raw rows; return source key -> collections_raw.id for every input. */
export async function upsertRaw(db: Queryable, rows: RawRecord[]): Promise<Map<string, number>> {
  const idByKey = new Map<string, number>();
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      params.push(r.source_file_id, r.source_tab, r.source_row_num, r.shape, r.source_group_code, r.facility_code, JSON.stringify(r.raw));
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`;
    });
    const sql =
      `insert into collections.collections_raw ` +
      `(source_file_id, source_tab, source_row_num, shape, source_group_code, facility_code, raw) ` +
      `values ${tuples.join(', ')} ` +
      `on conflict (source_file_id, source_tab, source_row_num) do update set ` +
      `shape = excluded.shape, source_group_code = excluded.source_group_code, ` +
      `facility_code = excluded.facility_code, raw = excluded.raw ` +
      `returning id, source_file_id, source_tab, source_row_num`;
    const res = await db.query<{ id: string; source_file_id: string; source_tab: string; source_row_num: number }>(sql, params);
    for (const row of res.rows) idByKey.set(rawKey(row.source_file_id, row.source_tab, Number(row.source_row_num)), Number(row.id));
  }
  return idByKey;
}

export const rawKey = (file: string, tab: string, rowNum: number): string => `${file} ${tab} ${rowNum}`;

async function insertBatched(db: Queryable, cols: readonly string[], table: string, conflict: string, rows: unknown[][]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((vals) => {
      const b = params.length;
      params.push(...vals);
      return `(${cols.map((_, i) => `$${b + i + 1}`).join(', ')})`;
    });
    const sql = `insert into ${table} (${cols.join(', ')}) values ${tuples.join(', ')} ${conflict} returning id`;
    const res = await db.query(sql, params);
    inserted += res.rowCount ?? res.rows.length;
  }
  return inserted;
}

const DAILY_COLS = ['collections_raw_id', 'facility_code', 'source_group_code', 'payment_date', 'checks_amount', 'eft_amount', 'gross_amount', 'source_tag'] as const;
export function insertDaily(db: Queryable, items: { rawId: number; row: DailyRow }[]): Promise<number> {
  const rows = items.map(({ rawId, row }) => [rawId, row.facility_code, row.source_group_code, row.payment_date, row.checks_amount, row.eft_amount, row.gross_amount, row.source_tag]);
  // Bucket key now includes source_tag (migration 0014), so workbook + deposit_sheet
  // rows for the same facility-day coexist; the resolved view picks one for display.
  return insertBatched(db, DAILY_COLS, 'collections.daily_collections',
    'on conflict (facility_code, source_group_code, payment_date, source_tag) do nothing', rows);
}

const PL_COLS = ['collections_raw_id', 'facility_code', 'source_group_code', 'service_date', 'payment_date', 'cpt_code', 'revenue_code', 'patient_name', 'patient_last', 'patient_first', 'member_id_raw', 'member_id_norm', 'group_number', 'charge_amount', 'allowed_amount', 'insurance_paid', 'adjustment', 'balance_due_pt', 'payer_name', 'recon_ok', 'paid_gt_allowed'] as const;
export function insertPaymentLines(db: Db, items: { rawId: number; row: PaymentLineRow }[]): Promise<number> {
  const rows = items.map(({ rawId, row }) => [rawId, row.facility_code, row.source_group_code, row.service_date, row.payment_date, row.cpt_code, row.revenue_code, row.patient_name, row.patient_last, row.patient_first, row.member_id_raw, row.member_id_norm, row.group_number, row.charge_amount, row.allowed_amount, row.insurance_paid, row.adjustment, row.balance_due_pt, row.payer_name, row.recon_ok, row.paid_gt_allowed]);
  return insertBatched(db, PL_COLS, 'collections.payment_lines', 'on conflict (collections_raw_id) do nothing', rows);
}

const NW_COLS = ['collections_raw_id', 'facility_code', 'source_group_code', 'client_name', 'insurance', 'alpha_prefix', 'homeplan_state', 'billed_amount', 'allowed_amount', 'negotiated_pct', 'tpp'] as const;
export function insertNegotiation(db: Db, items: { rawId: number; row: NegotiationRow }[]): Promise<number> {
  const rows = items.map(({ rawId, row }) => [rawId, row.facility_code, row.source_group_code, row.client_name, row.insurance, row.alpha_prefix, row.homeplan_state, row.billed_amount, row.allowed_amount, row.negotiated_pct, row.tpp]);
  return insertBatched(db, NW_COLS, 'collections.negotiation_worklist', 'on conflict (collections_raw_id) do nothing', rows);
}

const RU_COLS = ['collections_raw_id', 'source_file_id', 'grain', 'raw'] as const;
export function insertRollup(db: Db, items: { rawId: number; row: RollupRow }[]): Promise<number> {
  const rows = items.map(({ rawId, row }) => [rawId, row.source_file_id, row.grain, JSON.stringify(row.raw)]);
  return insertBatched(db, RU_COLS, 'collections.rollup_snapshots', 'on conflict (collections_raw_id) do nothing', rows);
}

/**
 * Re-source the deposit-Sheet daily series, transactionally (zero-wipe, idempotent).
 * Within ONE transaction: upsert the verbatim raw rows, DELETE the prior
 * source_tag='deposit_sheet' daily rows, then insert the freshly parsed ones. Legacy
 * 'workbook' rows are never touched (history preserved); a re-run with identical
 * source yields identical rows (delete-then-reinsert), so re-running adds nothing.
 * Mirrors cmdPayerIngest.writeRollup's replace-in-a-transaction model.
 */
export async function replaceDepositSheetDaily(
  db: Db,
  fileId: string,
  raws: RawRecord[],
  daily: { source_tab: string; source_row_num: number; row: DailyRow }[],
): Promise<{ rawUpserted: number; dailyDeleted: number; dailyInserted: number }> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const idByKey = await upsertRaw(client, raws);
    const del = await client.query("delete from collections.daily_collections where source_tag = 'deposit_sheet'");
    const items = daily.map((d) => {
      const id = idByKey.get(rawKey(fileId, d.source_tab, d.source_row_num));
      if (id === undefined) throw new Error(`no raw id for deposit daily row ${d.source_tab}#${d.source_row_num}`);
      return { rawId: id, row: d.row };
    });
    const inserted = await insertDaily(client, items);
    await client.query('commit');
    return { rawUpserted: idByKey.size, dailyDeleted: del.rowCount ?? 0, dailyInserted: inserted };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
