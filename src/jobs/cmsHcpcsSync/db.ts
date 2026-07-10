/**
 * node-postgres data access for the CMS HCPCS sync. Mirrors src/db.ts:
 *   - connects as the least-privilege code_intel_writer role (migration 0045) via
 *     CODE_INTEL_WRITER_DATABASE_URL — NEVER claims_admin / service-role,
 *   - verify-full TLS (src/ssl.ts) — proof against active MITM, not just encrypted,
 *   - every value bound as a $n parameter (no interpolation),
 *   - writes are batched set-operations, never row-by-row loops.
 *
 * NON-PHI: touches only code_intel.ref_code + code_intel.policy_change_event.
 */
import pg from 'pg';
import { sanitizeConnectionString, verifyFullSsl } from '../../ssl.js';
import type { CodeChangeEvent, HcpcsRecord, RefCodeSnapshotRow } from './types.js';

const BATCH = 500;

export type Db = pg.Pool;

export function writerConnectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.CODE_INTEL_WRITER_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing CODE_INTEL_WRITER_DATABASE_URL (check, do not log, this var)');
  }
  return url;
}

export function makeWriterPool(connectionString: string): Db {
  return new pg.Pool({
    connectionString: sanitizeConnectionString(connectionString),
    ssl: verifyFullSsl(),
    max: 4,
    application_name: 'cms-hcpcs-sync',
  });
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface RefCodeRow {
  id: string;
  code: string;
  short_desc: string;
  long_desc: string | null;
  is_active: boolean;
}

/** Current tracked HCPCS snapshot (for the diff) + a code→id map (for event FKs). */
export async function fetchTrackedSnapshot(
  db: Db,
): Promise<{ rows: RefCodeSnapshotRow[]; idByCode: Map<string, string> }> {
  const res = await db.query<RefCodeRow>(
    `select id, code, short_desc, long_desc, is_active
       from code_intel.ref_code
      where code_type = 'hcpcs'`,
    [],
  );
  const rows: RefCodeSnapshotRow[] = [];
  const idByCode = new Map<string, string>();
  for (const r of res.rows) {
    const code = r.code.trim().toUpperCase();
    rows.push({ code, shortDesc: r.short_desc, longDesc: r.long_desc, isActive: r.is_active });
    idByCode.set(code, r.id);
  }
  return { rows, idByCode };
}

/**
 * Upsert added/revised HCPCS ref_codes. ON CONFLICT (code_type, code) refreshes the
 * description + CMS provenance and reactivates. Returns a code→id map of every row
 * touched (RETURNING), so event FKs resolve even for brand-new codes.
 */
export async function upsertRefCodes(
  db: Db,
  records: readonly HcpcsRecord[],
  sourceRef: string,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  const iso = now.toISOString();
  for (const batch of chunk(records, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      params.push(r.code, r.shortDesc, r.longDesc, r.effectiveDate, sourceRef, iso);
      // code_type is a literal 'hcpcs'; is_active true on upsert.
      return `('hcpcs', $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::date, $${b + 5}, $${b + 6}::timestamptz)`;
    });
    const sql =
      `insert into code_intel.ref_code
         (code_type, code, short_desc, long_desc, cms_effective_date, cms_source_ref, last_cms_check)
       values ${tuples.join(', ')}
       on conflict (code_type, code) do update set
         short_desc         = excluded.short_desc,
         long_desc          = excluded.long_desc,
         cms_effective_date = excluded.cms_effective_date,
         cms_source_ref     = excluded.cms_source_ref,
         last_cms_check     = excluded.last_cms_check,
         is_active          = true,
         updated_at         = excluded.last_cms_check
       returning id, code`;
    const res = await db.query<{ id: string; code: string }>(sql, params);
    for (const row of res.rows) idByCode.set(row.code.trim().toUpperCase(), row.id);
  }
  return idByCode;
}

/** Mark deleted (terminated) HCPCS codes inactive. Returns rows affected. */
export async function markCodesDeleted(
  db: Db,
  codes: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (codes.length === 0) return 0;
  let affected = 0;
  for (const batch of chunk(codes, BATCH)) {
    const res = await db.query(
      `update code_intel.ref_code
          set is_active = false, last_cms_check = $2::timestamptz, updated_at = $2::timestamptz
        where code_type = 'hcpcs' and code = any($1::text[])`,
      [batch, now.toISOString()],
    );
    affected += res.rowCount ?? 0;
  }
  return affected;
}

/**
 * Insert pending change events, idempotently. ON CONFLICT DO NOTHING against the
 * partial unique index (source, source_ref, code_id, change_type) so re-running a
 * quarter never duplicates flags. Events whose code has no resolvable id are skipped
 * (should not happen — added codes are upserted first, revised/deleted come from the
 * snapshot). Returns rows actually inserted.
 */
export async function insertChangeEvents(
  db: Db,
  events: readonly CodeChangeEvent[],
  sourceRef: string,
  idByCode: Map<string, string>,
): Promise<number> {
  const resolvable = events
    .map((e) => ({ e, codeId: idByCode.get(e.code.trim().toUpperCase()) }))
    .filter((x): x is { e: CodeChangeEvent; codeId: string } => Boolean(x.codeId));

  let inserted = 0;
  for (const batch of chunk(resolvable, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map(({ e, codeId }) => {
      const b = params.length;
      params.push(
        codeId,
        e.changeType,
        e.changeSummary,
        e.previousValue === null ? null : JSON.stringify(e.previousValue),
        e.newValue === null ? null : JSON.stringify(e.newValue),
        e.effectiveDate,
        sourceRef,
      );
      return (
        `('cms_quarterly', $${b + 7}, $${b + 1}, $${b + 2}::code_intel.change_type_enum, ` +
        `$${b + 3}, $${b + 4}::jsonb, $${b + 5}::jsonb, $${b + 6}::date, 'pending')`
      );
    });
    const sql =
      `insert into code_intel.policy_change_event
         (source, source_ref, code_id, change_type, change_summary,
          previous_value, new_value, effective_date, review_status)
       values ${tuples.join(', ')}
       on conflict (source, source_ref, code_id, change_type)
         where source_ref is not null and code_id is not null
         do nothing
       returning id`;
    const res = await db.query(sql, params);
    inserted += res.rowCount ?? res.rows.length;
  }
  return inserted;
}
