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
import { sanitizeConnectionString, verifyFullSsl } from '../ssl.js';
import { withTenant } from '../veris/withTenant.js';
import type { CmdDailyDeposit } from './cmdExplorer.js';
import type { DailyRow, NegotiationRow, PaymentLineRow, RawRecord, RollupRow } from './types.js';

const BATCH = 500;
export type Db = pg.Pool;
/** Pool OR a checked-out client — both expose .query, so the same writers can run
 *  standalone (legacy ingest) or inside a transaction (deposit-sheet replace). */
type Queryable = { query: pg.Pool['query'] };

export function makeClient(connectionString: string): Db {
  // Strip any sslmode/ssl param so it can't override our verify-full ssl (drop the ca).
  return new pg.Pool({ connectionString: sanitizeConnectionString(connectionString), ssl: verifyFullSsl(), max: 4, application_name: 'collections-ingest' });
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
  //
  // TARGETLESS on conflict (migration-B era, 2026-07-06): the collections_daily_bucket
  // unique index gains business_entity_id (migration 0031), and a COLUMN-LIST conflict
  // target must match a unique index EXACTLY — a targetless DO NOTHING matches ANY unique
  // violation, so this frozen BXR-only workbook CLI works under BOTH index shapes (the
  // only other unique index is the bigserial pkey, which fresh inserts can never hit).
  // business_entity_id is NOT stamped here: the column's DEFAULT (BXR) covers this
  // claims_admin-path CLI; the tenant-parameterized paths stamp it explicitly.
  return insertBatched(db, DAILY_COLS, 'collections.daily_collections',
    'on conflict do nothing', rows);
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

// CMD-sourced daily collections (source_tag='cmd') — the Master BXR chart's deposit series,
// re-sourced from the live CMD report (Check+EFT per charge line, aggregated to facility-day
// by aggregateDailyDeposits). collections_raw_id is NULL (migration 0022 made it nullable):
// these rows do NOT derive from a collections_raw landing row, so the writer never touches the
// PHI-bearing collections_raw table. source_group_code is NULL (a real facility, not lineage).
// business_entity_id is stamped EXPLICITLY per tenant (migration-B era) — the DEFAULT (BXR) is
// a safety net, not the mechanism, so the Indigo path can never silently inherit BXR's tag.
const CMD_DAILY_COLS = ['collections_raw_id', 'facility_code', 'source_group_code', 'payment_date', 'checks_amount', 'eft_amount', 'gross_amount', 'source_tag', 'business_entity_id'] as const;

/**
 * Re-source ONE facility's CMD daily deposits, transactionally (idempotent, partial-safe).
 * Within ONE tenant-scoped transaction (withTenant: BEGIN → transaction-local
 * set_config('app.business_entity_id', $1, true) → queries on that same client → COMMIT):
 * DELETE this facility's prior source_tag='cmd' rows WITHIN THE PULLED payment_date SPAN,
 * then INSERT the freshly aggregated facility-day deposits, stamped with the tenant id.
 *
 * TENANT SCOPING (migration-B era, 2026-07-06): both legs are tenant-scoped. The DELETE
 * carries `business_entity_id = $4` — facility-name disjointness across tenants is believed
 * true but is NOT the isolation mechanism; without the explicit predicate a colliding
 * facility_code would let one tenant's refresh erase another's rows. The INSERT stamps
 * business_entity_id explicitly. The GUC set by withTenant is what migration C's writer
 * policies will enforce (WITH CHECK business_entity_id = current_setting(...)::uuid).
 *
 * TARGETLESS on conflict: collections_daily_bucket gains business_entity_id in migration
 * 0031, and a column-list conflict target must match a unique index exactly — targetless
 * DO NOTHING works under BOTH index shapes, making the code deploy and the 0031 apply
 * order-independent (no mixed state errors the cron). The only other unique index is the
 * bigserial pkey, which fresh inserts can never violate.
 *
 * WHY the span scope (not a facility-wide wipe): the cron's saved CMD filter windows on a
 * ROLLING window (current-month payment-received), so a run only re-supplies rows for that
 * window. Deleting all of a facility's cmd rows would erase every earlier month the filter no
 * longer returns (the Master BXR chart's whole history). We therefore delete only the
 * [min..max] payment_date span the pull actually covers and leave everything outside it intact:
 *   - normal run     → refreshes just the current window; prior months are preserved
 *   - EMPTY pull      → deletes nothing (a facility with no data in the window keeps its history)
 * Still scoped per facility_code (never a global wipe) so a partial run never touches other
 * facilities, and legacy 'workbook' rows are never touched. Re-running identical source yields
 * identical rows. (Edge: a facility-day that disappears from the window's trailing edge — i.e.
 * shrinks `max` — isn't pruned until a later pull re-covers it; acceptable vs. losing history.)
 *
 * Runs as the least-privilege cmd_rollup_writer (migration 0022 grants SELECT/INSERT/DELETE +
 * an RLS policy on daily_collections; this table is non-PHI aggregates only).
 */
export async function replaceCmdDailyForFacility(
  db: Db,
  facilityCode: string,
  rows: CmdDailyDeposit[],
  businessEntityId: string,
): Promise<{ deleted: number; inserted: number }> {
  return withTenant(db, businessEntityId, async (client) => {
    // Delete only within the pulled payment_date span (ISO 'YYYY-MM-DD' sorts chronologically).
    // No rows ⇒ no delete, so an empty window never erases the facility's earlier history.
    let deleted = 0;
    if (rows.length > 0) {
      let minDate = rows[0]!.payment_date;
      let maxDate = rows[0]!.payment_date;
      for (const r of rows) {
        if (r.payment_date < minDate) minDate = r.payment_date;
        if (r.payment_date > maxDate) maxDate = r.payment_date;
      }
      const del = await client.query(
        "delete from collections.daily_collections where source_tag = 'cmd' and facility_code = $1 and payment_date between $2 and $3 and business_entity_id = $4",
        [facilityCode, minDate, maxDate, businessEntityId],
      );
      deleted = del.rowCount ?? 0;
    }
    const tuples = rows.map((r) => [null, r.facility_code, null, r.payment_date, r.checks_amount, r.eft_amount, r.gross_amount, 'cmd', businessEntityId]);
    const inserted = tuples.length === 0
      ? 0
      : await insertBatched(
          client,
          CMD_DAILY_COLS,
          'collections.daily_collections',
          'on conflict do nothing',
          tuples,
        );
    return { deleted, inserted };
  });
}
