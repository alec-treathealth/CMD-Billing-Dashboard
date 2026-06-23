/**
 * Phase 0-C: load CMS Physician Fee Schedule rates for behavioral-health HCPCS
 * into ref.cms_pfs_rate (year 2026). Gives Brain 1 a fee-schedule anchor:
 * billed_charge / facility_rate as an OON-leverage proxy.
 *
 * PHI-safe: public fee schedule data. Writes as claims_admin, batched, $n-bound.
 *
 * SOURCE: CMS PFS datastore query API (CY2026 national file). Endpoint is
 * env-configurable because CMS rotates the datastore distribution id each year:
 *   CMS_PFS_QUERY_URL = https://pfs.data.cms.gov/api/1/datastore/query/<dist-id>/0
 * Pagination via {limit, offset}. Field names vary by vintage, so the response
 * is mapped through FIELD candidates (first present wins) rather than hard-coded.
 */
import { makeClient, type Db } from '../db.js';

const YEAR = 2026;
const BATCH = 500;

const BH_HCPCS = [
  'H0001', 'H0002', 'H0004', 'H0005', 'H0006', 'H0007', 'H0010', 'H0015',
  'H0016', 'H0018', 'H0019', 'H0020', 'H0022', 'H0023', 'H0025', 'H0031',
  'H0035', 'H0036', 'H0037', 'H0038', 'H0039', 'H0040', 'H0041', 'H0043',
  'H0044', 'H0045', 'H0047', 'H0049', 'H0050',
  '90791', '90792', '90832', '90833', '90834', '90836', '90837', '90838',
  '90839', '90840', '90847', '90849', '90853', '90863',
  // 99202-99215 E/M range
  '99202', '99203', '99204', '99205', '99211', '99212', '99213', '99214', '99215',
];

const FIELD = {
  hcpcs: ['hcpcs', 'hcpcs_code', 'hcpcs_cd'],
  modifier: ['modifier', 'mod', 'mod1'],
  locality: ['locality', 'locality_code', 'loc'],
  facility: ['facility_rate', 'fac_price', 'facility_price', 'non_fac_fee'],
  nonFacility: ['non_facility_rate', 'nonfac_price', 'nonfacility_price', 'fac_fee'],
  rvuWork: ['rvu_work', 'work_rvu', 'wrvu'],
  rvuPe: ['rvu_pe_facility', 'pe_rvu_fac', 'fac_pe_rvu'],
  rvuMp: ['rvu_mp', 'mp_rvu'],
} as const;

function pick(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

interface PfsRow {
  hcpcs_code: string;
  modifier: string;
  locality: string;
  facility_rate: string | null;
  non_facility_rate: string | null;
  rvu_work: string | null;
  rvu_pe_facility: string | null;
  rvu_mp: string | null;
}

async function fetchPfs(baseUrl: string): Promise<PfsRow[]> {
  const out: PfsRow[] = [];
  for (const hcpcs of BH_HCPCS) {
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const u = new URL(baseUrl);
      u.searchParams.set('limit', '500');
      u.searchParams.set('offset', String(offset));
      u.searchParams.set('conditions[0][property]', 'hcpcs');
      u.searchParams.set('conditions[0][value]', hcpcs);
      u.searchParams.set('conditions[0][operator]', '=');
      const res = await fetch(u);
      if (!res.ok) throw new Error(`CMS PFS fetch ${hcpcs} failed: ${res.status}`);
      const body = (await res.json()) as { results?: Record<string, unknown>[] };
      const results = body.results ?? [];
      for (const r of results) {
        const code = pick(r, FIELD.hcpcs);
        const locality = pick(r, FIELD.locality);
        if (!code || !locality) continue;
        out.push({
          hcpcs_code: code,
          modifier: pick(r, FIELD.modifier) ?? '',
          locality,
          facility_rate: pick(r, FIELD.facility),
          non_facility_rate: pick(r, FIELD.nonFacility),
          rvu_work: pick(r, FIELD.rvuWork),
          rvu_pe_facility: pick(r, FIELD.rvuPe),
          rvu_mp: pick(r, FIELD.rvuMp),
        });
      }
      if (results.length < 500) break;
      offset += 500;
    }
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsert(db: Db, rows: PfsRow[]): Promise<number> {
  let n = 0;
  for (const batch of chunk(rows, BATCH)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      const b = params.length;
      params.push(
        r.hcpcs_code, r.modifier, r.locality,
        r.facility_rate, r.non_facility_rate,
        r.rvu_work, r.rvu_pe_facility, r.rvu_mp, YEAR,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::numeric, $${b + 5}::numeric, ` +
        `$${b + 6}::numeric, $${b + 7}::numeric, $${b + 8}::numeric, $${b + 9})`;
    });
    const res = await db.query(
      `insert into ref.cms_pfs_rate
         (hcpcs_code, modifier, locality, facility_rate, non_facility_rate,
          rvu_work, rvu_pe_facility, rvu_mp, year)
       values ${tuples.join(', ')}
       on conflict (hcpcs_code, modifier, locality, year) do update set
         facility_rate = excluded.facility_rate,
         non_facility_rate = excluded.non_facility_rate,
         rvu_work = excluded.rvu_work,
         rvu_pe_facility = excluded.rvu_pe_facility,
         rvu_mp = excluded.rvu_mp`,
      params,
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

async function main(): Promise<void> {
  const dbUrl = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!dbUrl) throw new Error('Missing CLAIMS_ADMIN_DATABASE_URL (check, do not log, this var)');
  const pfsUrl = process.env.CMS_PFS_QUERY_URL;
  if (!pfsUrl) throw new Error('Missing CMS_PFS_QUERY_URL (CY2026 datastore query endpoint)');
  const db = makeClient(dbUrl);
  try {
    const rows = await fetchPfs(pfsUrl);
    const upserted = await upsert(db, rows);
    const covered = new Set(rows.map((r) => r.hcpcs_code));
    const missing = BH_HCPCS.filter((c) => !covered.has(c));
    console.log(
      `[cms_pfs_loader] rows=${rows.length} upserted=${upserted} ` +
        `BH codes covered=${covered.size}/${BH_HCPCS.length} missing=[${missing.join(',')}]`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[cms_pfs_loader] failed:', err.message);
  process.exit(1);
});
