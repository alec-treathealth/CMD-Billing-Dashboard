/**
 * Supabase Postgres data access for the ingest loader.
 *
 * Phase 2 / Decision 1: connects over node-postgres as the least-privilege
 * `claims_admin` role (NOT the service-role key, NOT PostgREST). All table
 * references are schema-qualified to the dedicated `claims` schema. Every value
 * is bound as a `$n` parameter — no value is ever interpolated into SQL.
 * Writes are batched set-operations, never row-by-row loops.
 */
import pg from 'pg';
import { verifyFullSsl } from './ssl.js';
import type { TypedClaim } from './types.js';

const BATCH = 500;

export type Db = pg.Pool;

/**
 * Build the admin connection pool from a Postgres connection string
 * (CLAIMS_ADMIN_DATABASE_URL). TLS is verify-full (Phase 3 hardening): the
 * pooler's certificate chain is verified against the Supabase Root CA and its
 * hostname is checked, so the connection is proof against an active MITM — not
 * just encrypted. See src/ssl.ts.
 */
export function makeClient(connectionString: string): Db {
  return new pg.Pool({
    connectionString,
    ssl: verifyFullSsl(),
    max: 4,
    application_name: 'claims-ingest',
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Refresh the non-PHI dashboard aggregate materialized views (migration 0009)
 * after an ingest changes claims.claims. Delegates to the SECURITY DEFINER
 * function claims.refresh_aggregate_matviews(), which issues both REFRESH
 * MATERIALIZED VIEW CONCURRENTLY statements as the function owner so that
 * claims_admin does not need to be the matview owner. CONCURRENTLY takes no
 * read lock — the dashboard keeps serving the previous snapshot during rebuild.
 * Aggregate-only — no PHI.
 */
export async function refreshAggregateMatviews(db: Db): Promise<void> {
  await db.query('select claims.refresh_aggregate_matviews()');
}

export interface RawRowInsert {
  source_year: number;
  source_file_id: string;
  source_row_num: number;
  raw: Record<string, string>;
}

/**
 * Idempotent raw landing: upsert on the (source_file_id, source_row_num) unique
 * key. Returns a map of source_row_num -> claims_raw.id for every input row
 * (whether freshly inserted or already present — ON CONFLICT DO UPDATE always
 * returns the row). Re-ingestion of the same cell collapses onto the same key;
 * legitimate business-row duplication is preserved (duplicates carry different
 * source_row_num). The identity ids are small sequential bigints, well within
 * Number's safe range, so Number() is safe here (pg returns bigint as text).
 */
export async function upsertClaimsRaw(db: Db, rows: RawRowInsert[]): Promise<Map<number, number>> {
  const idByRowNum = new Map<number, number>();
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      params.push(r.source_year, r.source_file_id, r.source_row_num, JSON.stringify(r.raw));
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb)`;
    });
    const sql =
      `insert into claims.claims_raw (source_year, source_file_id, source_row_num, raw) ` +
      `values ${tuples.join(', ')} ` +
      `on conflict (source_file_id, source_row_num) ` +
      `do update set raw = excluded.raw, source_year = excluded.source_year ` +
      `returning id, source_row_num`;
    const res = await db.query<{ id: string; source_row_num: number }>(sql, params);
    for (const row of res.rows) idByRowNum.set(Number(row.source_row_num), Number(row.id));
  }
  return idByRowNum;
}

/**
 * Which of these claims_raw_ids already have a typed `claims` row. Drives the
 * explicit check-then-insert idempotency (kept deliberately simple/debuggable,
 * not a merge). Uses `= any($1)` so the id list is a single bound array param.
 */
export async function fetchExistingClaimRawIds(db: Db, rawIds: number[]): Promise<Set<number>> {
  const existing = new Set<number>();
  for (const batch of chunk(rawIds, BATCH)) {
    const res = await db.query<{ claims_raw_id: string }>(
      'select claims_raw_id from claims.claims where claims_raw_id = any($1::bigint[])',
      [batch],
    );
    for (const row of res.rows) existing.add(Number(row.claims_raw_id));
  }
  return existing;
}

/**
 * Column order for typed-claim inserts. CLAIM_COLS and the per-row value array
 * in insertClaims MUST stay aligned. `collection_rate` is a generated column and
 * is intentionally absent; `id`/`created_at` use defaults.
 */
const CLAIM_COLS = [
  'claims_raw_id',
  'source_year',
  'facility_name',
  'date_of_service',
  'hcpcs_code',
  'revenue_code',
  'patient_name',
  'patient_last',
  'patient_first',
  'member_id_raw',
  'member_id_norm',
  'group_number',
  'employer_name',
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
  'payer_name',
] as const;

/** Batch-insert typed claims. Returns the number of rows inserted. */
export async function insertClaims(db: Db, claims: TypedClaim[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(claims, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((c) => {
      const b = params.length;
      // Order MUST match CLAIM_COLS. Money fields are canonical numeric strings
      // (or null); Postgres coerces text -> numeric(12,2) / date exactly.
      params.push(
        c.claims_raw_id,
        c.source_year,
        c.facility_name,
        c.date_of_service,
        c.hcpcs_code,
        c.revenue_code,
        c.patient_name,
        c.patient_last,
        c.patient_first,
        c.member_id_raw,
        c.member_id_norm,
        c.group_number,
        c.employer_name,
        c.charge_amount,
        c.allowed_amount,
        c.paid_amount,
        c.adjustment,
        c.balance_due_pt,
        c.payer_name,
      );
      const ph = CLAIM_COLS.map((_, i) => `$${b + i + 1}`);
      return `(${ph.join(', ')})`;
    });
    const sql =
      `insert into claims.claims (${CLAIM_COLS.join(', ')}) ` +
      `values ${tuples.join(', ')} returning id`;
    const res = await db.query(sql, params);
    inserted += res.rowCount ?? res.rows.length;
  }
  return inserted;
}
