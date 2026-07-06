-- =============================================================================
-- Veris migration 019 — the "Treat Health" consolidated read path
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review artifact: S2 bundle, apply position 5 (LAST) of the ratified
-- order (016 → 018 → withTenant commit+push+prod-verify → 017 → **019**) — so
-- this policy review runs against RLS-live (WITH CHECK) tables.
--
-- WHAT: the super-admin-only cross-tenant aggregate surface ratified in the S1
--   ADR (docs/CLAUDE.md §18): "Treat Health" = BXR Consulting + Indigo
--   Consulting combined. It is NOT a tenant — no business_entity_id, no
--   core.business_entity row, ever. S2 builds the READ PATH ONLY; S5 wires
--   role/claim access (EXECUTE is granted to NOBODY here).
--
-- DESIGN (Alec's 019 gate ruling, 2026-07-02 — NO BYPASSRLS, verbatim intent):
--   * Role `consolidated_reader`: NOLOGIN, NO BYPASSRLS, NO write grants.
--     BYPASSRLS would ignore every RLS policy on every table the role could
--     ever see; a later GRANT SELECT would silently widen the cross-tenant
--     surface with zero diff on the function. Instead the bypass is ENUMERABLE
--     PER-TABLE below.
--   * THE ENUMERATED READ SET — exactly the tables core.consolidated_summary()
--     reads; this list IS the policy list, nothing else gets the policy:
--       1. core.business_entity        (entity names/ids)
--       2. staging.claim_line          (claim-line count + money aggregates)
--       3. staging.payment_residual    (open balance-due-insurance + open rows)
--     Each gets GRANT SELECT + an explicit FOR SELECT TO consolidated_reader
--     USING (true) policy. Any future table the function grows to read FAILS
--     LOUDLY (42501) until it is deliberately added here.
--   * core.consolidated_summary(): SECURITY DEFINER, OWNED BY
--     consolidated_reader (executes with exactly the enumerated read surface),
--     search_path pinned pg_catalog-first, fixed schema-qualified SQL,
--     aggregate-only PHI-denylisted return (entity names, counts, money sums —
--     no patient columns are ever touched), EXECUTE revoked from PUBLIC and
--     granted to nobody (S5 grants the super-admin path).
--
-- POLICY INTERACTION NOTE: the existing <table>_isolation policies are
--   TO public, so they also attach to consolidated_reader sessions. Policies
--   are PERMISSIVE (OR-ed): `true OR (beid = current_setting(...))` is
--   const-folded to true at plan time, so the definer function needs NO GUC —
--   and a missing GUC cannot error the consolidated path.
--
-- APPLY-PATH NOTE (mirrors the standing claims_admin grant — see the S2
--   privilege note in veris-data-notes.md): `GRANT consolidated_reader TO
--   postgres WITH SET TRUE` lets the non-superuser apply role (a) ALTER the
--   function's OWNER to consolidated_reader (owner-transfer requires
--   membership in the target role), (b) re-run CREATE OR REPLACE/DROP on later
--   applies (owner checks pass via membership), and (c) verify the role's
--   exact read surface at apply time via SET ROLE. postgres already holds
--   BYPASSRLS, so this grant widens nothing in practice. STANDING — the 019
--   rollback re-revokes it, but do not revoke it while 019 is live.
--
-- Idempotent forward: CREATE-role-if-absent; DROP POLICY IF EXISTS before
--   CREATE POLICY; unconditional REVOKE/GRANT; DROP FUNCTION IF EXISTS before
--   CREATE (owner/signature changes never wedge a re-run). Never DROP ROLE.
-- Paired rollback: 019_consolidated_read_path_rollback.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The role (CREATE-if-absent; §2 pattern — never DROP ROLE).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'consolidated_reader') THEN
    CREATE ROLE consolidated_reader NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Defensive re-assert on re-runs (a NOLOGIN/NOBYPASSRLS drift here would be a
-- silent cross-tenant widening).
ALTER ROLE consolidated_reader NOLOGIN NOBYPASSRLS;

-- Apply-path membership (see header). Within postgres's existing rights.
GRANT consolidated_reader TO postgres WITH SET TRUE;

-- ---------------------------------------------------------------------------
-- 2. The enumerated read surface: schema USAGE + per-table SELECT + explicit
--    per-table read-all policies. THIS LIST IS THE CONTRACT — extend it only
--    together with the function body, at a gate review.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA core    TO consolidated_reader;
GRANT USAGE ON SCHEMA staging TO consolidated_reader;

GRANT SELECT ON core.business_entity        TO consolidated_reader;
GRANT SELECT ON staging.claim_line          TO consolidated_reader;
GRANT SELECT ON staging.payment_residual    TO consolidated_reader;

-- Policies are owned by the table owner — create them as claims_admin.
SET ROLE claims_admin;

DROP POLICY IF EXISTS business_entity_consolidated_read ON core.business_entity;
CREATE POLICY business_entity_consolidated_read ON core.business_entity
  FOR SELECT TO consolidated_reader USING (true);

DROP POLICY IF EXISTS claim_line_consolidated_read ON staging.claim_line;
CREATE POLICY claim_line_consolidated_read ON staging.claim_line
  FOR SELECT TO consolidated_reader USING (true);

DROP POLICY IF EXISTS payment_residual_consolidated_read ON staging.payment_residual;
CREATE POLICY payment_residual_consolidated_read ON staging.payment_residual
  FOR SELECT TO consolidated_reader USING (true);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3. The definer function. Fixed, schema-qualified, aggregate-only SQL.
--    Returns one row per tenant plus one combined row (business_entity_id
--    NULL, labeled 'CONSOLIDATED (ALL TENANTS)').
--
--    LABEL RULING (Alec, 2026-07-05, at 016 release): the combined row is NOT
--    labeled "Treat Health". §18 forbids Treat Health existing as a data-path
--    entity string (it must never look like a tenant anywhere in the data
--    layer), and five BXR facility customers are named TREAT MENTAL HEALTH *
--    — a result-set string would pattern-match them. The surface is named
--    "Treat Health" at the UI layer only (S10), never in a result set.
--
--    Created as postgres, then ownership transferred to consolidated_reader
--    so SECURITY DEFINER executes with exactly the enumerated read surface
--    above.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS core.consolidated_summary();

CREATE FUNCTION core.consolidated_summary()
RETURNS TABLE (
  business_entity_id           uuid,
  entity_name                  text,
  claim_line_count             bigint,
  total_billed                 numeric,
  total_primary_paid           numeric,
  total_secondary_paid         numeric,
  total_insurance_adjustments  numeric,
  open_balance_due_insurance   numeric,
  open_residual_count          bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
  WITH cl AS (
    SELECT c.business_entity_id,
           count(*)::bigint                          AS claim_line_count,
           coalesce(sum(c.charge_amount), 0)         AS total_billed,
           coalesce(sum(c.charge_primary_paid), 0)   AS total_primary_paid,
           coalesce(sum(c.charge_secondary_paid), 0) AS total_secondary_paid,
           coalesce(sum(c.charge_insurance_adj), 0)  AS total_insurance_adjustments
      FROM staging.claim_line c
     GROUP BY c.business_entity_id
  ),
  pr AS (
    SELECT p.business_entity_id,
           coalesce(sum(p.balance_due_insurance), 0)                  AS open_balance_due_insurance,
           (count(*) FILTER (WHERE p.residual_type <> 'CLEAN'))::bigint AS open_residual_count
      FROM staging.payment_residual p
     GROUP BY p.business_entity_id
  ),
  per_entity AS (
    SELECT be.id                                        AS business_entity_id,
           be.name                                      AS entity_name,
           coalesce(cl.claim_line_count, 0)             AS claim_line_count,
           coalesce(cl.total_billed, 0)                 AS total_billed,
           coalesce(cl.total_primary_paid, 0)           AS total_primary_paid,
           coalesce(cl.total_secondary_paid, 0)         AS total_secondary_paid,
           coalesce(cl.total_insurance_adjustments, 0)  AS total_insurance_adjustments,
           coalesce(pr.open_balance_due_insurance, 0)   AS open_balance_due_insurance,
           coalesce(pr.open_residual_count, 0)          AS open_residual_count
      FROM core.business_entity be
      LEFT JOIN cl ON cl.business_entity_id = be.id
      LEFT JOIN pr ON pr.business_entity_id = be.id
  )
  -- The UNION is wrapped in a subquery because Postgres rejects expressions
  -- (business_entity_id IS NULL) in an ORDER BY applied directly to a UNION
  -- (SQLSTATE 0A000 — hit on first apply, 2026-07-05; semantics unchanged).
  SELECT * FROM (
    SELECT * FROM per_entity
    UNION ALL
    SELECT NULL::uuid,
           'CONSOLIDATED (ALL TENANTS)',
           sum(claim_line_count)::bigint,
           sum(total_billed),
           sum(total_primary_paid),
           sum(total_secondary_paid),
           sum(total_insurance_adjustments),
           sum(open_balance_due_insurance),
           sum(open_residual_count)::bigint
      FROM per_entity
  ) all_rows
  ORDER BY all_rows.business_entity_id IS NULL, all_rows.entity_name;
$fn$;

-- ALTER ... OWNER requires the NEW owner to hold CREATE on the schema
-- (42501 "permission denied for schema core" on first full apply, 2026-07-05).
-- Granted TRANSIENTLY and revoked in the same transaction — the role's end
-- state stays USAGE-only (it can never create objects in core).
GRANT CREATE ON SCHEMA core TO consolidated_reader;
ALTER FUNCTION core.consolidated_summary() OWNER TO consolidated_reader;
REVOKE CREATE ON SCHEMA core FROM consolidated_reader;

-- EXECUTE to NOBODY (Postgres auto-grants EXECUTE to PUBLIC on creation —
-- same defense-in-depth as dashboard migration 0011). S5 grants the
-- super-admin path deliberately.
REVOKE ALL ON FUNCTION core.consolidated_summary() FROM PUBLIC;

COMMENT ON FUNCTION core.consolidated_summary() IS
  'Consolidated cross-tenant surface (ADR §18; branded at the UI layer only, S10): aggregate-only, PHI-free rollup of BXR + Indigo. SECURITY DEFINER as consolidated_reader (enumerated per-table read set — see migration 019). EXECUTE granted by S5 only.';

-- ---------------------------------------------------------------------------
-- First-run verification (run after apply, as postgres):
--   -- role posture:
--   SELECT rolcanlogin, rolbypassrls FROM pg_roles
--    WHERE rolname = 'consolidated_reader';               -- f, f
--   -- combined aggregates (owner path — BXR-only data today, Indigo all-zero):
--   SET ROLE consolidated_reader;
--   SELECT * FROM core.consolidated_summary();            -- 3 rows: BXR, Indigo(0s), ALL
--   -- OUTSIDE the enumerated set must be DENIED (42501):
--   SELECT count(*) FROM staging.era_adjustment;          -- expect permission denied
--   RESET ROLE;
--   -- non-owner EXECUTE denied (42501):
--   SET ROLE claims_reader;
--   SELECT * FROM core.consolidated_summary();            -- expect permission denied
--   RESET ROLE;
-- =============================================================================
