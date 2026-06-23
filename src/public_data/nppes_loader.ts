/**
 * Phase 0-D: load NPI registry data into ref.nppes_provider.
 *
 * BLOCKER (verified 2026-06-23): staging.claim_line.claim_facility_id holds CMD
 * INTERNAL facility ids (8-digit, e.g. '10272308'), NOT NPIs. The build spec
 * assumed facility_id = NPI — false. There is no facility->NPI crosswalk in the
 * data, so this loader instead harvests any genuine 10-digit NPI from the
 * rendering-provider columns and enriches those. If none are present it exits
 * cleanly as a no-op and says so — it does not invent NPIs.
 *
 * Endpoint: https://npiregistry.cms.hhs.gov/api/?version=2.1&number={npi}
 * (free, no token; one GET per NPI, serialized). PHI-safe: NPIs + taxonomy only.
 */
import { makeClient, type Db } from '../db.js';

const BEID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const NPI_RE = /^\d{10}$/;

interface Nppes {
  npi: string;
  entity_type: number | null;
  org_name: string | null;
  taxonomy_code: string | null;
  taxonomy_desc: string | null;
  state: string | null;
  last_updated: string | null;
}

async function candidateNpis(db: Db): Promise<string[]> {
  // Rendering-provider columns are the only plausible NPI source in the schema.
  const res = await db.query<{ npi: string }>(
    `select distinct npi from (
        select claim_rendering_provider  as npi from staging.claim_line where business_entity_id = $1
        union
        select charge_rendering_provider as npi from staging.claim_line where business_entity_id = $1
     ) s where npi ~ '^[0-9]{10}$'`,
    [BEID],
  );
  return res.rows.map((r) => r.npi);
}

async function fetchNpi(npi: string): Promise<Nppes | null> {
  const u = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`;
  const res = await fetch(u);
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: any[] };
  const r = body.results?.[0];
  if (!r) return null;
  const primaryTax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? r.taxonomies?.[0];
  return {
    npi,
    entity_type: r.enumeration_type === 'NPI-1' ? 1 : r.enumeration_type === 'NPI-2' ? 2 : null,
    org_name: r.basic?.organization_name ?? null,
    taxonomy_code: primaryTax?.code ?? null,
    taxonomy_desc: primaryTax?.desc ?? null,
    state: r.addresses?.[0]?.state ?? null,
    last_updated: r.basic?.last_updated ?? null,
  };
}

async function upsert(db: Db, p: Nppes): Promise<void> {
  await db.query(
    `insert into ref.nppes_provider
       (npi, entity_type, org_name, taxonomy_code, taxonomy_desc, state, last_updated)
     values ($1, $2, $3, $4, $5, $6, $7::date)
     on conflict (npi) do update set
       entity_type = excluded.entity_type, org_name = excluded.org_name,
       taxonomy_code = excluded.taxonomy_code, taxonomy_desc = excluded.taxonomy_desc,
       state = excluded.state, last_updated = excluded.last_updated`,
    [p.npi, p.entity_type, p.org_name, p.taxonomy_code, p.taxonomy_desc, p.state, p.last_updated],
  );
}

async function main(): Promise<void> {
  const url = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!url) throw new Error('Missing CLAIMS_ADMIN_DATABASE_URL (check, do not log, this var)');
  const db = makeClient(url);
  try {
    const npis = await candidateNpis(db);
    if (npis.length === 0) {
      console.log(
        '[nppes_loader] NO-OP: no 10-digit NPIs found in rendering-provider columns. ' +
          'claim_facility_id is a CMD internal id, not an NPI — wire in a real NPI source ' +
          '(e.g. a CMD facility->NPI crosswalk) before this loader can enrich anything.',
      );
      return;
    }
    let ok = 0;
    for (const npi of npis) {
      const rec = await fetchNpi(npi);
      if (rec) {
        await upsert(db, rec);
        ok += 1;
      }
    }
    console.log(`[nppes_loader] candidate NPIs=${npis.length} enriched=${ok}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[nppes_loader] failed:', err.message);
  process.exit(1);
});
