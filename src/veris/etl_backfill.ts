/**
 * etl_backfill — per-tenant, idempotent reconciliation of staging.brain1_features
 * from the S1-ratified labeled population (claim_line INNER JOIN payment_residual
 * on pr.claim_line_id = cl.id, tenant-scoped). The re-runnable loader counterpart
 * of migration `SQL Schemas/020_etl_backfill.sql` (master-plan alias
 * "0012_etl_backfill") — same mapping, same upsert, same invariants.
 *
 * RATIFIED CONTRACT (Alec, 2026-07-06): brain1_features is the FULL FEATURE
 * SURFACE, not the labeled-training subset. PENDING rows are valid state and
 * are NEVER deleted or overwritten by this loader:
 *   - upsert-only — no destructive statement of any kind exists in this module;
 *   - the outcome CASE maps only the four terminal residual types, so the SQL
 *     is structurally incapable of writing 'PENDING' (monotonic labeling);
 *   - PENDING rows are outside the INNER JOIN source — never touched at all.
 *
 * ROLE & SCOPING: runs as claims_admin (table owner — RLS bypass by ownership;
 * the standing ingest posture) via CLAIMS_ADMIN_DATABASE_URL, verify-full TLS.
 * The tenant GUC is set TRANSACTION-locally through withTenant.ts — the ONE
 * scoping path (S2). Because the owner bypasses RLS, the SQL also filters
 * explicitly on current_setting('app.business_entity_id')::uuid — the same GUC
 * withTenant set, so there is exactly one source of tenant identity per run.
 *
 * PHI: no PHI column is ever selected, logged, or emitted. The INSERT column
 * list is a fixed allowlist (BRAIN1_INSERT_COLUMNS); claim_line's encrypted
 * PHI columns (*_enc) are never referenced; the loader moves data strictly
 * DB-side (INSERT..SELECT) — row contents never enter process memory; only
 * counts are read back. test/etlBackfill.test.ts enforces this structurally.
 *
 * ROLLBACK HONESTY: loader runs are forward-only reconciliation — they are NOT
 * captured by 020's undo audit. Rolling back a loader run means re-running the
 * loader against corrected source state.
 *
 * Usage:
 *   npx tsx src/veris/etl_backfill.ts --tenant=bxr            # DRY RUN (default)
 *   npx tsx src/veris/etl_backfill.ts --tenant=bxr --commit   # execute + in-txn gates
 *   npx tsx src/veris/etl_backfill.ts --tenant=bxr --gate     # stateless gates only
 */
import type pg from 'pg';
import { makeClient } from '../db.js';
import { withTenant } from './withTenant.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

/** Fixed insert allowlist — the structural PHI firewall. Never widen casually. */
export const BRAIN1_INSERT_COLUMNS = [
  'business_entity_id', 'charge_debit_id', 'claim_line_id', 'claim_facility_id',
  'outcome', 'days_to_pay', 'was_underpayment', 'net_underpayment_amt', 'allowed_amount',
  'residual_type', 'label_is_terminal',
  'canonical_primary_payer_name', 'canonical_primary_payer_family', 'payer_type',
  'network_status', 'participates_in_era',
  'cpt_code', 'rev_code', 'tos_code', 'units', 'diagnosis_pointer_count',
  'tob_facility_type', 'tob_care_setting', 'tob_frequency', 'claim_type', 'claim_frequency',
  'billed_amount', 'dos', 'dos_year', 'dos_month', 'dos_dow', 'insurance_billing_lag',
  'claim_rendering_provider', 'charge_rendering_provider', 'is_training_eligible',
  'built_at', 'built_by',
] as const;

/**
 * The empirically verified mapping (0 mismatches on all 57,486 labeled rows,
 * 2026-07-06). days_to_pay uses payment_received_date (NOT primary_payment_date
 * — master-plan assumption superseded by evidence), NULL when negative.
 * Tenant filter reads the SAME GUC withTenant sets.
 */
const SRC_SELECT = `
  SELECT
    cl.business_entity_id,
    cl.charge_debit_id,
    cl.id AS claim_line_id,
    cl.claim_facility_id,
    CASE pr.residual_type
      WHEN 'CLEAN'                 THEN 'PAID'
      WHEN 'ALLOWED_GAP'           THEN 'PARTIAL'
      WHEN 'MATH_GAP'              THEN 'PARTIAL'
      WHEN 'BALANCE_DUE_INSURANCE' THEN 'DENIED'
    END AS outcome,
    CASE WHEN cl.payment_received_date >= cl.charge_from_date
         THEN cl.payment_received_date - cl.charge_from_date
    END AS days_to_pay,
    pr.residual_type IN ('ALLOWED_GAP','BALANCE_DUE_INSURANCE') AS was_underpayment,
    CASE pr.residual_type
      WHEN 'ALLOWED_GAP'           THEN pr.allowed_gap
      WHEN 'BALANCE_DUE_INSURANCE' THEN pr.balance_due_insurance
      ELSE 0
    END AS net_underpayment_amt,
    pr.allowed_amount,
    pr.residual_type,
    true AS label_is_terminal,
    cl.canonical_primary_payer_name,
    cl.canonical_primary_payer_family,
    cl.current_payer_type AS payer_type,
    pd.network_status,
    pd.participates_in_era,
    cl.cpt_code, cl.rev_code, cl.tos_code, cl.units,
    CASE WHEN cl.diagnosis_pointer_list IS NULL OR btrim(cl.diagnosis_pointer_list) = ''
         THEN 0
         ELSE cardinality(string_to_array(cl.diagnosis_pointer_list, ','))
    END AS diagnosis_pointer_count,
    cl.tob_facility_type, cl.tob_care_setting, cl.tob_frequency,
    cl.claim_type, cl.claim_frequency,
    cl.charge_amount AS billed_amount,
    cl.charge_from_date AS dos,
    EXTRACT(year  FROM cl.charge_from_date)::smallint AS dos_year,
    EXTRACT(month FROM cl.charge_from_date)::smallint AS dos_month,
    EXTRACT(dow   FROM cl.charge_from_date)::smallint AS dos_dow,
    cl.insurance_billing_lag,
    cl.claim_rendering_provider,
    cl.charge_rendering_provider,
    cl.is_training_eligible
  FROM staging.claim_line cl
  JOIN staging.payment_residual pr
    ON pr.claim_line_id = cl.id
   AND pr.business_entity_id = cl.business_entity_id
  LEFT JOIN staging.payer_dim pd
    ON pd.id = cl.payer_dim_id
   AND pd.business_entity_id = cl.business_entity_id
  WHERE cl.business_entity_id = current_setting('app.business_entity_id')::uuid`;

const LABEL_TUPLE_BF = `(bf.outcome, bf.days_to_pay, bf.was_underpayment, bf.net_underpayment_amt,
   bf.allowed_amount, bf.residual_type, bf.label_is_terminal, bf.claim_line_id)`;
const LABEL_TUPLE_S = `(s.outcome, s.days_to_pay, s.was_underpayment, s.net_underpayment_amt,
   s.allowed_amount, s.residual_type, s.label_is_terminal, s.claim_line_id)`;

export const BACKFILL_UPSERT_SQL = `
INSERT INTO staging.brain1_features
  (${BRAIN1_INSERT_COLUMNS.join(', ')})
SELECT s.business_entity_id, s.charge_debit_id, s.claim_line_id, s.claim_facility_id,
  s.outcome, s.days_to_pay, s.was_underpayment, s.net_underpayment_amt, s.allowed_amount,
  s.residual_type, s.label_is_terminal,
  s.canonical_primary_payer_name, s.canonical_primary_payer_family, s.payer_type,
  s.network_status, s.participates_in_era,
  s.cpt_code, s.rev_code, s.tos_code, s.units, s.diagnosis_pointer_count,
  s.tob_facility_type, s.tob_care_setting, s.tob_frequency, s.claim_type, s.claim_frequency,
  s.billed_amount, s.dos, s.dos_year, s.dos_month, s.dos_dow, s.insurance_billing_lag,
  s.claim_rendering_provider, s.charge_rendering_provider, s.is_training_eligible,
  now(), 'etl_backfill_loader'
FROM (${SRC_SELECT}) s
ON CONFLICT (business_entity_id, charge_debit_id) DO UPDATE SET
  outcome              = EXCLUDED.outcome,
  days_to_pay          = EXCLUDED.days_to_pay,
  was_underpayment     = EXCLUDED.was_underpayment,
  net_underpayment_amt = EXCLUDED.net_underpayment_amt,
  allowed_amount       = EXCLUDED.allowed_amount,
  residual_type        = EXCLUDED.residual_type,
  label_is_terminal    = EXCLUDED.label_is_terminal,
  claim_line_id        = EXCLUDED.claim_line_id,
  built_at             = EXCLUDED.built_at,
  built_by             = EXCLUDED.built_by
WHERE (brain1_features.outcome, brain1_features.days_to_pay,
       brain1_features.was_underpayment, brain1_features.net_underpayment_amt,
       brain1_features.allowed_amount, brain1_features.residual_type,
       brain1_features.label_is_terminal, brain1_features.claim_line_id)
      IS DISTINCT FROM
      (EXCLUDED.outcome, EXCLUDED.days_to_pay,
       EXCLUDED.was_underpayment, EXCLUDED.net_underpayment_amt,
       EXCLUDED.allowed_amount, EXCLUDED.residual_type,
       EXCLUDED.label_is_terminal, EXCLUDED.claim_line_id)
RETURNING (xmax = 0) AS inserted`;

/** Dry run: what WOULD change, as counts only. */
export const DRY_RUN_COUNTS_SQL = `
SELECT
  count(*)                                        AS source_rows,
  count(*) FILTER (WHERE bf.charge_debit_id IS NULL) AS would_insert,
  count(*) FILTER (WHERE bf.charge_debit_id IS NOT NULL
    AND ${LABEL_TUPLE_BF} IS DISTINCT FROM ${LABEL_TUPLE_S}) AS would_update
FROM (${SRC_SELECT}) s
LEFT JOIN staging.brain1_features bf
  ON bf.business_entity_id = s.business_entity_id
 AND bf.charge_debit_id    = s.charge_debit_id`;

/**
 * Conservation gates (the expected-vs-actual regime, ratified this session:
 * CONSERVATION, not count-equality — the table is legitimately a superset of
 * the labeled population and grows under the cron).
 * G1/G2 carry the 1% stop-tolerance; G3–G6 are absolute.
 * G3/G4 (monotonic labeling, PENDING preservation) additionally run in-txn on
 * commit against pre-captured state; their stateless forms are below.
 */
export const GATE_QUERIES = {
  /** G1 — labeled-population completeness: every ratified-join row present & labeled. */
  g1_completeness: `
    SELECT count(*) AS violations, (SELECT count(*) FROM (${SRC_SELECT}) x) AS population
    FROM (${SRC_SELECT}) s
    LEFT JOIN staging.brain1_features bf
      ON bf.business_entity_id = s.business_entity_id
     AND bf.charge_debit_id    = s.charge_debit_id
    WHERE bf.charge_debit_id IS NULL
       OR bf.outcome IS NULL OR bf.outcome = 'PENDING' OR bf.label_is_terminal IS NOT TRUE`,
  /** G2 — label correctness: stored labels match the ratified derivation. */
  g2_label_correctness: `
    SELECT count(*) AS violations, (SELECT count(*) FROM (${SRC_SELECT}) x) AS population
    FROM (${SRC_SELECT}) s
    JOIN staging.brain1_features bf
      ON bf.business_entity_id = s.business_entity_id
     AND bf.charge_debit_id    = s.charge_debit_id
    WHERE ${LABEL_TUPLE_BF} IS DISTINCT FROM ${LABEL_TUPLE_S}`,
  /** G3 (stateless form) — no row with a terminal residual sits unlabeled/PENDING. */
  g3_monotonic_stateless: `
    SELECT count(*) AS violations
    FROM staging.brain1_features bf
    JOIN staging.payment_residual pr
      ON pr.claim_line_id = bf.claim_line_id
     AND pr.business_entity_id = bf.business_entity_id
    WHERE bf.business_entity_id = current_setting('app.business_entity_id')::uuid
      AND bf.outcome = 'PENDING'`,
  /** G4 (stateless form) — PENDING rows all still carry NO residual-derived labels. */
  g4_pending_clean: `
    SELECT count(*) AS violations
    FROM staging.brain1_features bf
    WHERE bf.business_entity_id = current_setting('app.business_entity_id')::uuid
      AND bf.outcome = 'PENDING'
      AND (bf.residual_type IS NOT NULL OR bf.label_is_terminal IS TRUE)`,
  /** G5 — no-dupes invariant on the (tenant, charge) grain. */
  g5_no_dupes: `
    SELECT count(*) - count(DISTINCT (business_entity_id, charge_debit_id)) AS violations
    FROM staging.brain1_features
    WHERE business_entity_id = current_setting('app.business_entity_id')::uuid`,
  /** G6 — Indigo stays zero (run tenant-agnostically; owner bypasses RLS). */
  g6_indigo_zero: `
    SELECT count(*) AS violations
    FROM staging.brain1_features
    WHERE business_entity_id = '${INDIGO_ENTITY_ID}'`,
} as const;

const TENANTS: Record<string, string> = { bxr: BXR_ENTITY_ID, indigo: INDIGO_ENTITY_ID };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BackfillResult {
  sourceRows: number;
  inserted: number;
  updated: number;
  gates: Record<string, { violations: number; population?: number; pass: boolean }>;
}

/** Gate evaluation: G1/G2 pass within 1% of population; the rest must be 0. */
function evaluateGate(name: string, violations: number, population?: number): boolean {
  if (name.startsWith('g1') || name.startsWith('g2')) {
    if (!population || population === 0) return violations === 0;
    return violations / population <= 0.01;
  }
  return violations === 0;
}

async function runGates(client: pg.PoolClient): Promise<BackfillResult['gates']> {
  const gates: BackfillResult['gates'] = {};
  for (const [name, sql] of Object.entries(GATE_QUERIES)) {
    const res = await client.query(sql);
    const violations = Number(res.rows[0].violations);
    const population = res.rows[0].population !== undefined ? Number(res.rows[0].population) : undefined;
    gates[name] = { violations, population, pass: evaluateGate(name, violations, population) };
  }
  return gates;
}

/**
 * Execute the backfill for one tenant inside one withTenant transaction, with
 * in-txn G3/G4 verification against pre-captured state. Commit only if every
 * gate passes — a gate failure rolls the whole run back.
 */
export async function runBackfill(pool: pg.Pool, businessEntityId: string): Promise<BackfillResult> {
  return withTenant(pool, businessEntityId, async (client) => {
    // Pre-state for the stateful gates (temp tables die with the session).
    await client.query(`CREATE TEMP TABLE etl_pre_labeled ON COMMIT DROP AS
      SELECT charge_debit_id FROM staging.brain1_features
      WHERE business_entity_id = current_setting('app.business_entity_id')::uuid
        AND outcome <> 'PENDING'`);
    await client.query(`CREATE TEMP TABLE etl_pre_pending ON COMMIT DROP AS
      SELECT charge_debit_id FROM staging.brain1_features
      WHERE business_entity_id = current_setting('app.business_entity_id')::uuid
        AND outcome = 'PENDING'`);

    const upsert = await client.query(BACKFILL_UPSERT_SQL);
    const inserted = upsert.rows.filter((r) => r.inserted === true).length;
    const updated = upsert.rowCount === null ? 0 : upsert.rowCount - inserted;

    // G3 (stateful): no pre-labeled row may now be PENDING.
    const g3 = await client.query(`
      SELECT count(*) AS violations FROM staging.brain1_features bf
      JOIN etl_pre_labeled p ON p.charge_debit_id = bf.charge_debit_id
      WHERE bf.business_entity_id = current_setting('app.business_entity_id')::uuid
        AND bf.outcome = 'PENDING'`);
    // G4 (stateful): every pre-PENDING row must still exist (PENDING or newly labeled).
    const g4 = await client.query(`
      SELECT count(*) AS violations FROM etl_pre_pending p
      LEFT JOIN staging.brain1_features bf
        ON bf.charge_debit_id = p.charge_debit_id
       AND bf.business_entity_id = current_setting('app.business_entity_id')::uuid
      WHERE bf.charge_debit_id IS NULL`);

    const gates = await runGates(client);
    gates['g3_monotonic_stateful'] = { violations: Number(g3.rows[0].violations), pass: Number(g3.rows[0].violations) === 0 };
    gates['g4_pending_preserved_stateful'] = { violations: Number(g4.rows[0].violations), pass: Number(g4.rows[0].violations) === 0 };

    const allPass = Object.values(gates).every((g) => g.pass);
    if (!allPass) {
      // Throwing rolls back the entire run — a gate failure never lands.
      throw new Error('etl_backfill: conservation gate failed — transaction rolled back (see gate report)');
    }

    const src = await client.query(`SELECT count(*) AS n FROM (${SRC_SELECT}) s`);
    return { sourceRows: Number(src.rows[0].n), inserted, updated, gates };
  });
}

/** Dry run + stateless gates, no writes. */
export async function dryRun(pool: pg.Pool, businessEntityId: string): Promise<BackfillResult> {
  return withTenant(pool, businessEntityId, async (client) => {
    const res = await client.query(DRY_RUN_COUNTS_SQL);
    const gates = await runGates(client);
    return {
      sourceRows: Number(res.rows[0].source_rows),
      inserted: Number(res.rows[0].would_insert),
      updated: Number(res.rows[0].would_update),
      gates,
    };
  });
}

function reportGates(gates: BackfillResult['gates']): void {
  for (const [name, g] of Object.entries(gates)) {
    const pop = g.population !== undefined ? ` / population ${g.population}` : '';
    console.log(`[gate] ${g.pass ? 'PASS' : 'FAIL'} — ${name}: violations ${g.violations}${pop}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantArg = args.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length);
  const commit = args.includes('--commit');
  const gateOnly = args.includes('--gate');

  const businessEntityId = tenantArg ? (TENANTS[tenantArg.toLowerCase()] ?? tenantArg) : undefined;
  if (!businessEntityId || !UUID_RE.test(businessEntityId)) {
    console.error('usage: etl_backfill --tenant=bxr|indigo|<uuid> [--commit|--gate]');
    process.exit(2);
  }

  const adminUrl = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('Missing CLAIMS_ADMIN_DATABASE_URL');
  const pool = makeClient(adminUrl);

  try {
    if (commit) {
      const r = await runBackfill(pool, businessEntityId);
      console.log(`[etl_backfill] COMMIT — source ${r.sourceRows}, inserted ${r.inserted}, label-updated ${r.updated}`);
      reportGates(r.gates);
    } else {
      const r = await dryRun(pool, businessEntityId);
      console.log(`[etl_backfill] ${gateOnly ? 'GATE-ONLY' : 'DRY RUN'} — source ${r.sourceRows}, would-insert ${r.inserted}, would-update ${r.updated} (no writes)`);
      reportGates(r.gates);
    }
  } catch (err) {
    // Generic outward error — never echo row data. SQLSTATE + our message only.
    const code = (err as { code?: string }).code ?? 'n/a';
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[etl_backfill] FAILED (sqlstate ${code}): ${msg}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('etl_backfill.ts');
if (invokedDirectly) void main();
