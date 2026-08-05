/**
 * withTenant — the ONE way to run tenant-scoped queries against the Veris
 * core.* / staging.* tables (S2 gate ruling; see veris-data-notes.md, S2
 * "withTenant implementation constraints").
 *
 * Single-client transaction discipline on the Supavisor transaction pooler
 * (port 6543, no named prepared statements):
 *
 *   pool.connect() → BEGIN
 *     → set_config('app.business_entity_id', $1, true)   // TRANSACTION-local
 *     → callback queries on that SAME client
 *   → COMMIT   (ROLLBACK + release on any failure)
 *
 * The GUC is transaction-local (`set_config(..., true)`), so it dies with the
 * transaction — nothing can leak to whichever session the pooler hands the
 * backend to next. This restores the veris-runbook §96 standard (the runbook is
 * archived at docs/archive/veris-runbook.md as of 2026-07-28) and replaces
 * the session-scoped `set_config(..., false)` drift in veris_agent.ts /
 * hybrid_search.ts.
 *
 * Rules the type signature cannot enforce (DO NOT REGRESS):
 * - NEVER call pool.query() inside the callback — each pool.query() can land
 *   on a DIFFERENT pooled connection, escaping the transaction and its GUC.
 *   Query ONLY through the client the callback receives.
 * - NO network calls inside the callback (Anthropic, fetch, ...). A
 *   transaction must never be held open across an LLM/tool turn: one
 *   withTenant per query batch, never one per agent loop.
 * - The GUC name is a fixed literal; only the VALUE is a bound parameter.
 */
import type pg from 'pg';

/** The one GUC every Veris RLS policy reads. Fixed literal — never parameterized. */
export const TENANT_GUC = 'app.business_entity_id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside one transaction scoped to `businessEntityId`. Returns the
 * callback's result. On any failure the transaction is rolled back and the
 * error rethrown; the client is always released.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  businessEntityId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(businessEntityId)) {
    // Fail fast before touching the pool: a malformed value would otherwise
    // surface as an opaque uuid-cast error inside every RLS policy.
    throw new Error('withTenant: businessEntityId must be a canonical UUID literal');
  }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(`select set_config('${TENANT_GUC}', $1, true)`, [businessEntityId]);
    // Read-back verification: confirm the GUC actually took on THIS pooled backend before any
    // tenant-scoped query runs. On the 6543 transaction pooler a different backend can serve each
    // transaction; this is an EARLY, CLEAR abort if set_config didn't apply — in ADDITION to (not
    // instead of) the RLS WITH CHECK that DB-enforces the tenant on every write (RLS enforces; the
    // read-back diagnoses). A mismatch throws → the finally block ROLLs back (fail-closed).
    const readback = await client.query<{ v: string | null }>(
      `select current_setting('${TENANT_GUC}', true) as v`,
    );
    if (readback.rows[0]?.v !== businessEntityId) {
      throw new Error(
        'withTenant: tenant GUC read-back mismatch — refusing to run under an unset/wrong tenant scope',
      );
    }
    const result = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be unusable; release() below returns it
        // to the pool for teardown either way.
      }
    }
    client.release();
  }
}
