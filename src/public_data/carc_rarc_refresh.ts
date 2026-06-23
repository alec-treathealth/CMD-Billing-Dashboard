/**
 * Phase 0-B: refresh ref.carc_code + ref.rarc_code from public code lists, then
 * backfill ref.remittance_code (the 98-row seed) for any CARC present in
 * staging.era_adjustment but missing a description.
 *
 * PHI-safe: these are X12 code descriptions — zero patient data. Logs counts only.
 * Writes as claims_admin (CLAIMS_ADMIN_DATABASE_URL), batched, $n-parameterized,
 * no named prepared statements (pooler 6543).
 *
 * SOURCE (env-configurable, no scraping of variable HTML):
 *   CARC_SOURCE_URL / RARC_SOURCE_URL point at a TSV with columns:
 *     code <TAB> short_description <TAB> start_date(YYYY-MM-DD|"") <TAB> stop_date(""|date)
 *   Canonical public mirrors that publish this shape:
 *     - X12 EDR: https://x12.org/codes  (export to TSV)
 *     - WPC / state Medicaid mirrors (e.g. MassHealth RA/RARC XLSX -> TSV)
 *   If a URL is unset, the matching local fallback data/ref/{carc,rarc}.tsv is used.
 */
import { readFileSync, existsSync } from 'node:fs';
import { makeClient, type Db } from '../db.js';

interface CodeRow {
  code: string;
  description: string;
  start_date: string | null;
  stop_date: string | null;
}

const BATCH = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseTsv(text: string): CodeRow[] {
  const rows: CodeRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [code, description, start, stop] = line.split('\t');
    if (!code || !description) continue;
    rows.push({
      code: code.trim(),
      description: description.trim(),
      start_date: start?.trim() || null,
      stop_date: stop?.trim() || null,
    });
  }
  return rows;
}

async function loadSource(envVar: string, fallbackFile: string): Promise<CodeRow[]> {
  const url = process.env[envVar];
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${envVar} fetch failed: ${res.status}`);
    return parseTsv(await res.text());
  }
  if (existsSync(fallbackFile)) return parseTsv(readFileSync(fallbackFile, 'utf8'));
  throw new Error(`No source for ${envVar} and no fallback at ${fallbackFile}`);
}

async function upsertCarc(db: Db, rows: CodeRow[]): Promise<number> {
  let n = 0;
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      params.push(r.code, r.description, r.start_date, r.stop_date);
      return `($${b + 1}, $${b + 2}, $${b + 3}::date, $${b + 4}::date, 'carc_rarc_refresh')`;
    });
    const res = await db.query(
      `insert into ref.carc_code (carc_code, short_description, start_date, stop_date, ingested_by) ` +
        `values ${tuples.join(', ')} ` +
        `on conflict (carc_code) do update set ` +
        `short_description = excluded.short_description, ` +
        `start_date = excluded.start_date, stop_date = excluded.stop_date`,
      params,
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

async function upsertRarc(db: Db, rows: CodeRow[]): Promise<number> {
  let n = 0;
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      // SUPPLEMENTAL vs INFORMATIONAL: WPC lists informational RARCs with an 'Alert:' prefix.
      const type = /^alert:/i.test(r.description) ? 'INFORMATIONAL' : 'SUPPLEMENTAL';
      params.push(r.code, type, r.description, r.start_date, r.stop_date);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::date, $${b + 5}::date, 'carc_rarc_refresh')`;
    });
    const res = await db.query(
      `insert into ref.rarc_code (rarc_code, rarc_type, short_description, start_date, stop_date, ingested_by) ` +
        `values ${tuples.join(', ')} ` +
        `on conflict (rarc_code) do update set ` +
        `rarc_type = excluded.rarc_type, short_description = excluded.short_description, ` +
        `start_date = excluded.start_date, stop_date = excluded.stop_date`,
      params,
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/**
 * Backfill ref.remittance_code descriptions for CARCs that appear in
 * staging.era_adjustment but are missing/blank in the 98-row seed. Pull the
 * description from the freshly loaded ref.carc_code. Reports the gap first.
 */
async function backfillRemittanceCode(db: Db): Promise<{ gap: number; filled: number }> {
  const gapRes = await db.query<{ n: string }>(
    `select count(distinct ea.carc_code) as n
       from staging.era_adjustment ea
       left join ref.remittance_code rc on rc.code = ea.carc_code
      where rc.code is null`,
  );
  const gap = Number(gapRes.rows[0]?.n ?? 0);

  const filled = await db.query(
    `insert into ref.remittance_code (code, code_type, description, category, ingested_by)
     select distinct ea.carc_code, 'CARC', cc.short_description, 'OTHER_REVIEW', 'carc_rarc_refresh'
       from staging.era_adjustment ea
       join ref.carc_code cc on cc.carc_code = ea.carc_code
       left join ref.remittance_code rc on rc.code = ea.carc_code
      where rc.code is null
     on conflict (code, code_type) do nothing`,
  );
  return { gap, filled: filled.rowCount ?? 0 };
}

async function main(): Promise<void> {
  const url = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!url) throw new Error('Missing CLAIMS_ADMIN_DATABASE_URL (check, do not log, this var)');
  const db = makeClient(url);
  try {
    const carc = await loadSource('CARC_SOURCE_URL', 'data/ref/carc.tsv');
    const rarc = await loadSource('RARC_SOURCE_URL', 'data/ref/rarc.tsv');
    const carcN = await upsertCarc(db, carc);
    const rarcN = await upsertRarc(db, rarc);
    const bf = await backfillRemittanceCode(db);
    // Counts only — never the descriptions themselves in bulk.
    console.log(
      `[carc_rarc_refresh] CARC upserted=${carcN}/${carc.length} ` +
        `RARC upserted=${rarcN}/${rarc.length} ` +
        `remittance_code gap=${bf.gap} backfilled=${bf.filled}`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[carc_rarc_refresh] failed:', err.message);
  process.exit(1);
});
