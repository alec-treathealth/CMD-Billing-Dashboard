/**
 * Supabase data access for the ingest loader. Uses the service-role key
 * (loader-only; never shipped to the app — see CLAUDE.md Phase 2+ RLS note).
 * All writes are batched set-operations, never row-by-row loops.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TypedClaim } from './types.js';

const BATCH = 500;

export type Db = SupabaseClient;

export function makeClient(url: string, serviceRoleKey: string): Db {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
 * (whether freshly inserted or already present). Re-ingestion of the same cell
 * collapses onto the same key; legitimate business-row duplication is preserved
 * because duplicates carry different source_row_num.
 */
export async function upsertClaimsRaw(db: Db, rows: RawRowInsert[]): Promise<Map<number, number>> {
  const idByRowNum = new Map<number, number>();
  for (const batch of chunk(rows, BATCH)) {
    const { data, error } = await db
      .from('claims_raw')
      .upsert(batch, { onConflict: 'source_file_id,source_row_num' })
      .select('id, source_row_num');
    if (error) throw new Error(`claims_raw upsert failed: ${error.message}`);
    for (const r of data ?? []) idByRowNum.set(r.source_row_num as number, r.id as number);
  }
  return idByRowNum;
}

/**
 * Which of these claims_raw_ids already have a typed `claims` row. Drives the
 * explicit check-then-insert idempotency (kept deliberately simple/debuggable,
 * not a merge).
 */
export async function fetchExistingClaimRawIds(db: Db, rawIds: number[]): Promise<Set<number>> {
  const existing = new Set<number>();
  for (const batch of chunk(rawIds, BATCH)) {
    const { data, error } = await db
      .from('claims')
      .select('claims_raw_id')
      .in('claims_raw_id', batch);
    if (error) throw new Error(`claims existing-check failed: ${error.message}`);
    for (const r of data ?? []) existing.add(r.claims_raw_id as number);
  }
  return existing;
}

/** Batch-insert typed claims. Returns the number of rows inserted. */
export async function insertClaims(db: Db, claims: TypedClaim[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(claims, BATCH)) {
    const { data, error } = await db.from('claims').insert(batch).select('id');
    if (error) throw new Error(`claims insert failed: ${error.message}`);
    inserted += (data ?? []).length;
  }
  return inserted;
}
