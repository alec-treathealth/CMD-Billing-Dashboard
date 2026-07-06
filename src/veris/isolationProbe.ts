/**
 * Veris S2 isolation probe — MANUALLY-RUN live verification of tenant
 * isolation (npm run probe:isolation). Like src/liveProbe.ts it is NEVER
 * imported by the hermetic suite.
 *
 * HARD RULE (S2 directive): this probe NEVER inserts synthetic rows into
 * production tables. Every assertion is read-only against the REAL tenants:
 *   1. no-GUC read fails closed (error or zero rows — never data);
 *   2. BXR-scoped session sees BXR's counts (claim_line etc. > 0, registry =
 *      its own row + 20 customers);
 *   3. Indigo-scoped session sees ZERO rows on every staging surface (Indigo's
 *      empty state is a perfect isolation assertion until S7) and only its own
 *      registry row + 36 customers;
 *   4. ANN/hybrid search scoped to Indigo returns nothing (and, using a
 *      nonexistent probe charge id, short-circuits BEFORE its admin persist —
 *      zero writes);
 *   5. after COMMIT the GUC is empty on the same pooled client (the
 *      Supavisor transaction-pooler leak class);
 *   6. core.consolidated_summary(): EXECUTE denied to claims_reader (42501)
 *      and its ACL carries no PUBLIC/claims_reader grant. The POSITIVE path
 *      (combined aggregates as owner; consolidated_reader denied outside the
 *      enumerated read set) requires SET ROLE consolidated_reader, which the
 *      reader URL cannot do — it runs only when VERIS_POSTGRES_DATABASE_URL is
 *      set (apply-path credentials); otherwise it is SKIPped here and executed
 *      as the 019 apply-time verification block instead.
 *
 * Connects as claims_reader (verify-full TLS via makeClient). The admin URL is
 * never used to read.
 */
import { makeClient, type Db } from '../db.js';
import { withTenant, TENANT_GUC } from './withTenant.js';
import { retrieveAppealEvidence } from '../brain3/hybrid_search.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

// Fixed table list — identifiers are string literals, never interpolated input.
const STAGING_TABLES = [
  'payer_dim', 'claim_line', 'era_adjustment', 'payment_residual',
  'brain1_features', 'brain1_scores', 'brain2_alerts',
  'claim_signatures', 'appeal_evidence',
] as const;

/** Tables that MUST be populated for BXR (live counts verified 2026-07-05). */
const BXR_POPULATED = new Set([
  'payer_dim', 'claim_line', 'era_adjustment', 'payment_residual', 'brain1_features',
]);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[isolation-probe] ${tag} — ${name}${detail ? ` (${detail})` : ''}`);
}
function skip(name: string, why: string): void {
  console.log(`[isolation-probe] SKIP — ${name} (${why})`);
}

async function countsUnderTenant(db: Db, beid: string): Promise<Record<string, number>> {
  return withTenant(db, beid, async (client) => {
    const out: Record<string, number> = {};
    for (const t of STAGING_TABLES) {
      const r = await client.query<{ n: string }>(`select count(*) as n from staging.${t}`);
      out[t] = Number(r.rows[0]?.n ?? -1);
    }
    const ent = await client.query<{ id: string }>('select id from core.business_entity');
    const cust = await client.query<{ n: string }>('select count(*) as n from core.cmd_customer');
    out['__entity_rows'] = ent.rows.length;
    out['__entity_is_self'] = ent.rows.length === 1 && ent.rows[0]?.id === beid ? 1 : 0;
    out['__customers'] = Number(cust.rows[0]?.n ?? -1);
    // Positive control: the GUC reads back inside the transaction.
    const guc = await client.query<{ v: string | null }>(
      `select current_setting('${TENANT_GUC}', true) as v`);
    out['__guc_visible'] = guc.rows[0]?.v === beid ? 1 : 0;
    return out;
  });
}

async function main(): Promise<void> {
  const readerUrl = process.env.CLAIMS_READER_DATABASE_URL;
  if (!readerUrl) throw new Error('Missing CLAIMS_READER_DATABASE_URL');

  // ---- 1. Fail-closed without a GUC (fresh pool, no withTenant yet). ----
  {
    const db = makeClient(readerUrl);
    try {
      const r = await db.query<{ n: string }>('select count(*) as n from staging.claim_line');
      const n = Number(r.rows[0]?.n ?? -1);
      check('no-GUC read fails closed', n === 0, `count=${n} (zero rows is closed)`);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      check('no-GUC read fails closed', true, `errored as expected, SQLSTATE=${code}`);
    } finally {
      await db.end();
    }
  }

  const db = makeClient(readerUrl);
  try {
    // ---- 2. BXR-scoped surface. ----
    const bxr = await countsUnderTenant(db, BXR_ENTITY_ID);
    check('BXR: GUC visible inside txn', bxr['__guc_visible'] === 1);
    for (const t of STAGING_TABLES) {
      const n = bxr[t] ?? -1;
      if (BXR_POPULATED.has(t)) check(`BXR sees its own staging.${t}`, n > 0, `count=${n}`);
      else check(`BXR staging.${t} readable`, n >= 0, `count=${n}`);
    }
    check('BXR registry: exactly its own entity row', bxr['__entity_rows'] === 1 && bxr['__entity_is_self'] === 1);
    check('BXR registry: 20 customers', bxr['__customers'] === 20, `count=${bxr['__customers']}`);

    // ---- 3. Indigo-scoped surface: ZERO rows everywhere. ----
    const ind = await countsUnderTenant(db, INDIGO_ENTITY_ID);
    check('Indigo: GUC visible inside txn', ind['__guc_visible'] === 1);
    for (const t of STAGING_TABLES) {
      check(`Indigo sees ZERO staging.${t}`, ind[t] === 0, `count=${ind[t]}`);
    }
    check('Indigo registry: exactly its own entity row', ind['__entity_rows'] === 1 && ind['__entity_is_self'] === 1);
    check('Indigo registry: 36 customers', ind['__customers'] === 36, `count=${ind['__customers']}`);

    // ---- 4. ANN/hybrid search scoped to Indigo returns nothing. ----
    // Nonexistent probe charge id -> signature miss -> [] BEFORE any persist.
    const evidence = await retrieveAppealEvidence({
      queryClaimId: 'ISOLATION_PROBE_NO_SUCH_CHARGE',
      businessEntityId: INDIGO_ENTITY_ID,
    });
    check('Indigo-scoped ANN/hybrid search returns nothing', evidence.length === 0,
      `results=${evidence.length}`);

    // ---- 5. Post-COMMIT the GUC is empty on the same client. ----
    const after = await db.query<{ v: string | null }>(
      `select current_setting('${TENANT_GUC}', true) as v`);
    const v = after.rows[0]?.v ?? null;
    check('post-COMMIT GUC empty on the same client', v === null || v === '', `value=${JSON.stringify(v)}`);

    // ---- 6. consolidated_summary(): denied to claims_reader; ACL clean. ----
    const fn = await db.query<{ oid: string; acl: string | null }>(
      `select p.oid::text as oid, p.proacl::text as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'core' and p.proname = 'consolidated_summary'`);
    if (fn.rows.length === 0) {
      skip('consolidated_summary assertions', 'function not deployed yet (pre-019)');
    } else {
      try {
        await db.query('select * from core.consolidated_summary()');
        check('claims_reader EXECUTE on consolidated_summary() denied', false, 'call SUCCEEDED');
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'unknown';
        check('claims_reader EXECUTE on consolidated_summary() denied', code === '42501',
          `SQLSTATE=${code}`);
      }
      const acl = fn.rows[0]?.acl ?? '';
      const leaked = acl.includes('claims_reader=') || /[{,]=/.test(acl);
      check('consolidated_summary() ACL has no PUBLIC/claims_reader grant', !leaked, `acl=${acl}`);
    }

    // ---- 6b. Positive consolidated path (needs SET ROLE consolidated_reader). ----
    const pgUrl = process.env.VERIS_POSTGRES_DATABASE_URL;
    if (!pgUrl || fn.rows.length === 0) {
      skip('consolidated combined aggregates + outside-set denial',
        'VERIS_POSTGRES_DATABASE_URL not set — covered by the 019 apply-time verification block');
    } else {
      const su = makeClient(pgUrl);
      const client = await su.connect();
      try {
        await client.query('begin');
        await client.query('set local role consolidated_reader');
        const rows = await client.query<{
          business_entity_id: string | null; entity_name: string; claim_line_count: string;
        }>('select * from core.consolidated_summary()');
        const all = rows.rows.find((r) => r.business_entity_id === null);
        const perEntity = rows.rows.filter((r) => r.business_entity_id !== null);
        const sum = perEntity.reduce((a, r) => a + Number(r.claim_line_count), 0);
        check('consolidated_summary(): per-entity rows + one combined row',
          rows.rows.length === 3 && !!all, `rows=${rows.rows.length}`);
        check('consolidated combined claim_line_count = sum of entities = BXR live count',
          !!all && Number(all.claim_line_count) === sum && sum === bxr['claim_line'],
          `combined=${all?.claim_line_count} sum=${sum} bxr=${bxr['claim_line']}`);
        // Populate the GUC (txn-local) first: with it unset, the tenant policy's
        // current_setting() errors 42704 at PLAN time, preempting the executor's
        // ACL check — we want to prove the GRANT boundary (42501), not the GUC
        // error. Found during 019 apply-time verification, 2026-07-05.
        await client.query(
          `select set_config('${TENANT_GUC}', $1, true)`, [BXR_ENTITY_ID]);
        try {
          await client.query('select count(*) from staging.era_adjustment');
          check('consolidated_reader DENIED outside the enumerated read set', false, 'read SUCCEEDED');
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'unknown';
          check('consolidated_reader DENIED outside the enumerated read set', code === '42501',
            `SQLSTATE=${code}`);
        }
      } finally {
        try { await client.query('rollback'); } catch { /* aborted txn is fine */ }
        client.release();
        await su.end();
      }
    }
  } finally {
    await db.end();
  }

  console.log(failures === 0
    ? '[isolation-probe] ALL PASS'
    : `[isolation-probe] ${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  // Message only — never row data.
  console.error('[isolation-probe] fatal:', (err as Error).message);
  process.exit(1);
});
