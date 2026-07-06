-- =============================================================================
-- Veris migration 016 — staging.* FK → core.business_entity (tenancy integrity)
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review artifact: S2 bundle, apply position 1 of the 016→018→withTenant→
-- 017→019 ratified order. HOLD before live apply.
--
-- WHY: every tenant-scoped staging table carries business_entity_id uuid
--   NOT NULL, but NOTHING constrains the value to a real tenant (S2 live probe:
--   zero FKs reference core.*). A typo'd or minted UUID would silently create a
--   phantom tenant invisible to every RLS session. 014 created the registry;
--   this migration points all 9 staging tables at it.
--
-- SCOPE — the 9 live tenant-scoped staging tables (mv_payer_drift is a matview,
--   FKs don't apply; 013's era_835 table is NOT live — verified 2026-07-05):
--   payer_dim, claim_line, era_adjustment, payment_residual, brain1_features,
--   brain1_scores, brain2_alerts, claim_signatures, appeal_evidence.
--
-- PRE-FLIGHT (read-only, 2026-07-05, recorded in veris-data-notes.md): all 9
--   have business_entity_id uuid NOT NULL (catalog attnotnull — zero NULLs by
--   validated constraint); RLS-scoped counts equal pg_stat n_live_tup exactly on
--   every populated table under the BXR GUC and are zero under Indigo — every
--   live row is BXR's. The DO-block below re-asserts BOTH conditions at apply
--   time as the table owner (owner/BYPASSRLS sees all rows — the reader probe
--   cannot), because FKs do NOT catch NULLs: the guard asserts zero NULLs
--   explicitly, then zero values outside core.business_entity.
--
-- LOCKS: ADD CONSTRAINT ... NOT VALID takes a brief ACCESS EXCLUSIVE;
--   VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE. Inside one
--   apply_migration transaction the AEL is held to commit either way, so the
--   split's benefit is nil here — kept per the S2 directive (and it keeps the
--   file correct if ever re-run statement-by-statement). Row counts are small
--   (≤151k); validation is fast. ON DELETE RESTRICT: a tenant row can never be
--   deleted while data references it (matches core.cmd_customer).
--
-- Idempotent forward: FK added only if absent (pg_constraint check); VALIDATE
--   of an already-valid constraint is a documented no-op. Fixed table array +
--   format(%I) — no external input (§2 dynamic-SQL scope ruling, 2026-07-05).
-- Paired rollback: 016_staging_fk_tenancy_rollback.sql. Roll back BEFORE 014's
--   rollback (its active guard enforces this order).
-- =============================================================================

-- All 9 tables are owned by claims_admin (S2 ownership census). ALTER TABLE
-- requires ownership, and the guard must see ALL rows (owner bypasses RLS; no
-- staging table has FORCE ROW LEVEL SECURITY — verified 2026-07-05).
SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 1. Orphan pre-flight guard (ACTIVE — a comment is not a guard).
--    (a) zero NULL business_entity_id — FKs don't catch NULLs;
--    (b) zero values outside core.business_entity (names offenders, uuids only
--        — non-PHI).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t         text;
  tables    text[] := ARRAY[
    'payer_dim','claim_line','era_adjustment','payment_residual',
    'brain1_features','brain1_scores','brain2_alerts',
    'claim_signatures','appeal_evidence'
  ];
  n_null    bigint;
  n_orphan  bigint;
  orphan_ids text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM staging.%I WHERE business_entity_id IS NULL', t)
      INTO n_null;
    IF n_null > 0 THEN
      RAISE EXCEPTION
        '016 orphan guard: staging.% has % NULL business_entity_id row(s) — an FK will not catch NULLs; reconcile before applying', t, n_null;
    END IF;

    EXECUTE format(
      'SELECT count(*), string_agg(DISTINCT business_entity_id::text, '', '')
         FROM staging.%I
        WHERE business_entity_id NOT IN (SELECT id FROM core.business_entity)', t)
      INTO n_orphan, orphan_ids;
    IF n_orphan > 0 THEN
      RAISE EXCEPTION
        '016 orphan guard: staging.% has % row(s) with business_entity_id outside core.business_entity: [%] — reconcile before applying', t, n_orphan, orphan_ids;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Add the FK on each table (skip if already present), then VALIDATE.
--    Constraint name: <table>_business_entity_id_fkey (Postgres convention).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t      text;
  tables text[] := ARRAY[
    'payer_dim','claim_line','era_adjustment','payment_residual',
    'brain1_features','brain1_scores','brain2_alerts',
    'claim_signatures','appeal_evidence'
  ];
  fkname text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    fkname := t || '_business_entity_id_fkey';
    IF NOT EXISTS (
      SELECT FROM pg_constraint
       WHERE conname  = fkname
         AND conrelid = format('staging.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE staging.%I
           ADD CONSTRAINT %I FOREIGN KEY (business_entity_id)
           REFERENCES core.business_entity(id) ON DELETE RESTRICT
           NOT VALID', t, fkname);
    END IF;
    -- No-op when the constraint is already valid (documented behavior).
    EXECUTE format('ALTER TABLE staging.%I VALIDATE CONSTRAINT %I', t, fkname);
  END LOOP;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- First-run verification (run after apply):
--   -- exactly 9 validated FKs from staging.* onto core.business_entity:
--   SELECT conrelid::regclass AS child, conname, convalidated
--     FROM pg_constraint
--    WHERE contype = 'f'
--      AND confrelid = 'core.business_entity'::regclass
--    ORDER BY 1;                                   -- expect 9 rows, all convalidated = t
--   -- negative probe (MUST fail with 23503, run as claims_admin, then ROLLBACK):
--   --   BEGIN; INSERT INTO staging.brain2_alerts (business_entity_id, payer_name)
--   --   VALUES (gen_random_uuid(), 'FK_PROBE'); ROLLBACK;
-- ---------------------------------------------------------------------------
