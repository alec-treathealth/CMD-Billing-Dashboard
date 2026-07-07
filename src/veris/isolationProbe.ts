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
 * Connects as claims_reader (verify-full TLS via makeClient) for the staging.* and core.*
 * assertions above. The admin URL is never used to read.
 *
 * COLLECTIONS PLANE (section 8, added with migration 0033): the collections.* readers are
 * APP-scoped — claims_reader's SELECT policy there is permissive (USING true), because the
 * dashboard readers filter by business_entity_id in the query (0032 + app viewEntityScope) and
 * run WITHOUT a GUC. GUC-based row visibility on collections is therefore a WRITER property:
 * 0033 made cmd_rollup_writer's SELECT policies USING (business_entity_id =
 * current_setting('app.business_entity_id')::uuid). So section 8 connects as the writer
 * (CMD_ROLLUP_WRITER_DATABASE_URL) and asserts, read-only: no-GUC read fails closed; BXR-GUC
 * sees only BXR (>0); Indigo-GUC sees ZERO (Indigo's empty state = perfect isolation until the
 * step-4 seed load). SKIPs if the writer URL is unset (mirrors the consolidated_reader skip).
 */
import { makeClient, type Db } from '../db.js';
import { withTenant, TENANT_GUC } from './withTenant.js';
import { retrieveAppealEvidence } from '../brain3/hybrid_search.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';
import { resolveVerisScope } from './tenantScope.js';

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

/** Collections-plane tables whose WRITER SELECT is GUC-scoped by migration 0033 (section 8). */
const COLLECTIONS_TABLES = [
  'daily_collections', 'cmd_payer_facility_monthly', 'cmd_explorer_rows',
] as const;

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

/**
 * Collections-plane counts under a tenant GUC, run over the WRITER connection (cmd_rollup_writer),
 * whose SELECT policies are GUC-scoped by 0033. Read-only (count(*) only) — never inserts.
 */
async function collectionsCountsUnderTenant(db: Db, beid: string): Promise<Record<string, number>> {
  return withTenant(db, beid, async (client) => {
    const out: Record<string, number> = {};
    for (const t of COLLECTIONS_TABLES) {
      const r = await client.query<{ n: string }>(`select count(*) as n from collections.${t}`);
      out[t] = Number(r.rows[0]?.n ?? -1);
    }
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

    // ---- 7. Authenticated-path isolation (S5): scope resolved from role+entity, ----
    // never from client input. Drives the SAME pure resolver a Veris Server Action uses
    // (src/veris/tenantScope), then runs the resolved scope through withTenant and asserts
    // row visibility. This is the isolation test "through the authenticated path".
    const bxrClaimLine = bxr['claim_line'] ?? -1;   // BXR's real count (150,900)
    const indClaimLine = ind['claim_line'] ?? -1;   // Indigo's count (0 until S7 load)

    // admin@bxr → BXR scope, sees BXR's rows.
    {
      const r = resolveVerisScope('admin', 'bxr');
      const scopedId = r.ok && r.scope.mode === 'tenant' ? r.scope.entityId : '';
      check('auth-path: admin@bxr resolves to BXR scope', scopedId === BXR_ENTITY_ID);
      // No `|| BXR_ENTITY_ID` fallback: the count MUST run under the resolver's OWN output, so a
      // resolver that returns the wrong/empty id fails the probe instead of being papered over.
      const c = await countsUnderTenant(db, scopedId);
      check('auth-path: admin@bxr sees BXR claim_line', c['claim_line'] === bxrClaimLine,
        `count=${c['claim_line']}`);
    }

    // SECURITY: admin@bxr requesting the indigo view is STILL scoped to BXR (no rescope).
    {
      const r = resolveVerisScope('admin', 'bxr', 'indigo');
      const scopedId = r.ok && r.scope.mode === 'tenant' ? r.scope.entityId : '';
      check('auth-path: forged view cannot rescope admin@bxr → indigo', scopedId === BXR_ENTITY_ID,
        r.ok ? `anomaly=${r.anomaly ?? 'none'}` : 'resolver denied');
      const c = await countsUnderTenant(db, scopedId);
      check('auth-path: admin@bxr + forged indigo view still sees BXR (not Indigo)',
        c['claim_line'] === bxrClaimLine, `count=${c['claim_line']}`);
    }

    // SECURITY: user@indigo requesting the bxr view is STILL scoped to Indigo → ZERO BXR rows.
    {
      const r = resolveVerisScope('user', 'indigo', 'bxr');
      const scopedId = r.ok && r.scope.mode === 'tenant' ? r.scope.entityId : '';
      check('auth-path: forged view cannot rescope user@indigo → bxr', scopedId === INDIGO_ENTITY_ID);
      const c = await countsUnderTenant(db, scopedId);
      check('auth-path: user@indigo + forged bxr view sees ZERO claim_line (isolation)',
        c['claim_line'] === 0 && c['claim_line'] === indClaimLine, `count=${c['claim_line']}`);
    }

    // super_admin switches between tenants (within full entitlement); default = consolidated.
    {
      const bxrView = resolveVerisScope('super_admin', null, 'bxr');
      const indView = resolveVerisScope('super_admin', null, 'indigo');
      const conView = resolveVerisScope('super_admin', null);
      check('auth-path: super_admin → bxr resolves to BXR scope',
        bxrView.ok && bxrView.scope.mode === 'tenant' && bxrView.scope.entityId === BXR_ENTITY_ID);
      check('auth-path: super_admin → indigo resolves to Indigo scope',
        indView.ok && indView.scope.mode === 'tenant' && indView.scope.entityId === INDIGO_ENTITY_ID);
      check('auth-path: super_admin default → consolidated scope',
        conView.ok && conView.scope.mode === 'consolidated');
    }

    // Defensive: a tenant-scoped role with no entity fails closed (the claims.app_user
    // CHECK prevents this; the resolver still refuses to invent a scope).
    {
      const r = resolveVerisScope('admin', null);
      check('auth-path: tenant-scoped role with no entity fails closed', r.ok === false);
    }
  } finally {
    await db.end();
  }

  // ---- 8. Collections plane isolation (writer path, migration 0033). ----
  // GUC-based row visibility on collections.* is a WRITER property (claims_reader SELECT is
  // permissive there; dashboard reads are app-scoped). So connect as cmd_rollup_writer
  // (CMD_ROLLUP_WRITER_DATABASE_URL) and assert read-only: no-GUC read fails closed; BXR-GUC sees
  // only BXR (>0); Indigo-GUC sees ZERO (isolation, until the step-4 seed load). SKIP if unset.
  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL;
  if (!writerUrl) {
    skip('collections plane isolation (section 8)', 'CMD_ROLLUP_WRITER_DATABASE_URL not set');
  } else {
    const wdb = makeClient(writerUrl);
    try {
      // Guard: only meaningful as an RLS-SUBJECT role. A bypassrls/owner role sees everything
      // regardless of GUC — fail loudly rather than emit a false PASS. (This query also proves the
      // connection, so a caught error in 8a below is the RLS/GUC guard, not a connect failure.)
      const who = await wdb.query<{ current_user: string; bypassrls: boolean }>(
        'select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls');
      check('collections: probe runs as an RLS-subject writer (not bypassrls)',
        who.rows[0]?.bypassrls === false, `role=${who.rows[0]?.current_user}`);

      // 8a. no-GUC read fails closed: the writer USING policy's 1-arg current_setting ERRORS (42704)
      // when the GUC is unset.
      try {
        const r = await wdb.query<{ n: string }>('select count(*) as n from collections.daily_collections');
        const n = Number(r.rows[0]?.n ?? -1);
        check('collections no-GUC read fails closed', n === 0, `count=${n} (zero is closed)`);
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'unknown';
        check('collections no-GUC read fails closed', code === '42704' || code === '42501',
          `errored as expected, SQLSTATE=${code}`);
      }

      // 8b. BXR-GUC sees only BXR (every collections table > 0).
      const bxr = await collectionsCountsUnderTenant(wdb, BXR_ENTITY_ID);
      check('collections BXR: GUC visible inside txn', bxr['__guc_visible'] === 1);
      for (const t of COLLECTIONS_TABLES) {
        check(`collections BXR sees its own ${t} (>0)`, (bxr[t] ?? -1) > 0, `count=${bxr[t]}`);
      }

      // 8c. Indigo-GUC sees ZERO on every collections table (perfect isolation until step-4 load).
      const ind = await collectionsCountsUnderTenant(wdb, INDIGO_ENTITY_ID);
      check('collections Indigo: GUC visible inside txn', ind['__guc_visible'] === 1);
      for (const t of COLLECTIONS_TABLES) {
        check(`collections Indigo sees ZERO ${t}`, ind[t] === 0, `count=${ind[t]}`);
      }

      // 8d. post-COMMIT GUC empty on the same writer client (Supavisor txn-pooler leak class).
      const after = await wdb.query<{ v: string | null }>(
        `select current_setting('${TENANT_GUC}', true) as v`);
      const v = after.rows[0]?.v ?? null;
      check('collections post-COMMIT GUC empty on same client', v === null || v === '',
        `value=${JSON.stringify(v)}`);
    } finally {
      await wdb.end();
    }
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
