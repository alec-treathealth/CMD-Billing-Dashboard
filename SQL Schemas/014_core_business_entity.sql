-- =============================================================================
-- Veris migration 014 — core.business_entity + core.cmd_customer (tenancy foundation)
-- Sequence: SQL Schemas/0NN_* (Veris). NOT supabase/migrations/. See docs/CLAUDE.md §18.
-- DB: dbpabchpvipipkzkogta (Postgres 17.6). Apply via apply_migration (postgres-level).
-- Gate-review artifact 1 of the S2 set. HOLD before live apply.
--
-- WHY: every tenant-scoped staging.* table already carries business_entity_id
--   uuid NOT NULL (migrations 001/005/010/011/012) but there was NO parent table
--   to FK to — core.* did not exist live (verified S1 + S2 read-only probe). This
--   migration creates the tenant registry the FKs (016) point at.
--
-- RATIFIED SHAPE (docs/CLAUDE.md §18 ADR + veris-data-notes.md; supersedes the
--   master plan's single cmd_customer_number text column):
--   * EXACTLY TWO data-bearing tenants: BXR Consulting (CMD account 475729) and
--     Indigo Consulting (474623). NO "Treat Health" row — it is a derived
--     super-admin-only surface, NEVER a core.business_entity row (hard guard).
--   * id is uuid PK, seeded VERBATIM from src/tenants.ts — NO gen_random_uuid()
--     default: BXR's UUID is already the live default across 139,160
--     collections.cmd_explorer_rows; a minted UUID would orphan production data.
--   * Tenant key = 6-digit CMD ACCOUNT number (unique). 8-digit CMD CUSTOMER
--     numbers map many-to-one into core.cmd_customer.
--
-- Compliance: RLS self-scoped (a tenant session sees only its own registry rows),
--   matching the pure GUC-equality isolation on staging.*. Non-PHI (names +
--   account/customer numbers only). Owned by claims_admin (owner bypasses RLS for
--   ingest/builds); claims_reader gets SELECT. No anon/authenticated grants.
--
-- Idempotent forward: CREATE ... IF NOT EXISTS; DROP POLICY IF EXISTS before
--   CREATE POLICY; seed via ON CONFLICT DO UPDATE. Paired rollback:
--   014_core_business_entity_rollback.sql (run AFTER 016 rollback — staging FKs
--   depend on core.business_entity).
-- =============================================================================

-- Schema created as the apply role (postgres), then ownership transferred to
-- claims_admin. Everything after SET ROLE is BORN OWNED by claims_admin (matches
-- staging.*/ref.* convention; owner bypasses RLS for ingest/builds). This
-- requires postgres to hold the SET option on claims_admin
-- (GRANT claims_admin TO postgres WITH SET TRUE) — see the S2 privilege note in
-- veris-data-notes.md. apply_migration runs as postgres, a non-superuser member.
CREATE SCHEMA IF NOT EXISTS core;
ALTER SCHEMA core OWNER TO claims_admin;
SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- core.business_entity — the tenant registry (exactly two rows, ever).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.business_entity (
  id                  uuid        PRIMARY KEY,   -- seeded verbatim; NO default (see header)
  name                text        NOT NULL  CHECK (char_length(name) <= 200),
  cmd_account_number  text        NOT NULL  CHECK (cmd_account_number ~ '^[0-9]{6}$'),
  status              text        NOT NULL  DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive')),
  created_at          timestamptz NOT NULL  DEFAULT now(),
  UNIQUE (cmd_account_number)
);

COMMENT ON TABLE core.business_entity IS
  'Veris tenant registry. EXACTLY two rows: BXR Consulting (475729) + Indigo Consulting (474623). "Treat Health" is a derived super-admin surface and must NEVER be a row here (ADR §18).';
COMMENT ON COLUMN core.business_entity.id IS
  'Canonical tenant UUID from src/tenants.ts. Never re-minted — BXR is live across 139,160 production rows.';
COMMENT ON COLUMN core.business_entity.cmd_account_number IS
  '6-digit CMD ACCOUNT number = the tenant key. 8-digit CUSTOMER numbers live in core.cmd_customer.';

-- ---------------------------------------------------------------------------
-- core.cmd_customer — 8-digit CMD customer numbers, many-to-one to a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.cmd_customer (
  cmd_customer_number text        PRIMARY KEY  CHECK (cmd_customer_number ~ '^[0-9]{8}$'),
  business_entity_id  uuid        NOT NULL
                        REFERENCES core.business_entity(id) ON DELETE RESTRICT,
  customer_name       text        NOT NULL  CHECK (char_length(customer_name) <= 200),
  status              text        NOT NULL  DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive')),
  created_at          timestamptz NOT NULL  DEFAULT now()
);

-- Composite index leads with the tenant column (per S2 index discipline).
CREATE INDEX IF NOT EXISTS idx_cmd_customer_entity
  ON core.cmd_customer (business_entity_id, cmd_customer_number);

COMMENT ON TABLE core.cmd_customer IS
  'Maps 8-digit CMD customer numbers (facilities/legal entities) many-to-one to a tenant account. S6 ingest tags each row with the tenant business_entity_id and persists the source customer_number.';

-- ---------------------------------------------------------------------------
-- Seed — the two tenants. Canonical UUIDs verbatim (src/tenants.ts). No 3rd row.
--
-- FAIL-LOUD SEMANTICS (Alec, S2 gate review): a re-run may update a benign field
-- (name) on an identity MATCH only. An identity MISMATCH — the same account
-- number under a different uuid, or the same uuid under a different account —
-- means someone minted a duplicate/tampered entity and MUST error, never
-- silently DO UPDATE. Guarded explicitly below (the UNIQUE(cmd_account_number)
-- constraint is a second backstop). Temp tables are ON COMMIT DROP; the whole
-- migration runs in one apply_migration transaction.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _seed_entity (id uuid, name text, cmd_account_number text) ON COMMIT DROP;
INSERT INTO _seed_entity (id, name, cmd_account_number) VALUES
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'BXR Consulting',    '475729'),
  ('141d459c-f371-4229-9a92-ace198e940bb', 'Indigo Consulting', '474623');

DO $$
DECLARE bad text;
BEGIN
  -- (1) same account number, DIFFERENT uuid  -> duplicate entity
  SELECT string_agg(format('account %s: live id %s <> seed id %s',
           e.cmd_account_number, e.id, s.id), '; ')
    INTO bad
  FROM _seed_entity s JOIN core.business_entity e
    ON e.cmd_account_number = s.cmd_account_number AND e.id <> s.id;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'core.business_entity identity mismatch (account->uuid): %', bad;
  END IF;
  -- (2) same uuid, DIFFERENT account number -> tampered tenant key
  SELECT string_agg(format('id %s: live account %s <> seed account %s',
           e.id, e.cmd_account_number, s.cmd_account_number), '; ')
    INTO bad
  FROM _seed_entity s JOIN core.business_entity e
    ON e.id = s.id AND e.cmd_account_number <> s.cmd_account_number;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'core.business_entity identity mismatch (uuid->account): %', bad;
  END IF;
END $$;

-- Guards passed: any conflict is an exact identity match. Update only `name`.
INSERT INTO core.business_entity (id, name, cmd_account_number)
SELECT id, name, cmd_account_number FROM _seed_entity
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- Seed — CMD customers (rosters: veris-data-notes.md, S1-confirmed by Alec).
-- A customer number appearing under the WRONG tenant is an error, not an upsert
-- (Alec, S2 gate review): the tenant binding is immutable; only customer_name
-- may update on a matching-tenant re-run.
CREATE TEMP TABLE _seed_customer (cmd_customer_number text, business_entity_id uuid, customer_name text) ON COMMIT DROP;
INSERT INTO _seed_customer (cmd_customer_number, business_entity_id, customer_name) VALUES
  -- BXR Consulting (475729) — 20 customers.
  ('10030472', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'BILLING SERVICE ACCOUNT'),
  ('10027973', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'CA MENTAL HEALTH'),
  ('10033950', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'DALLAS MENTAL HEALTH LLC'),
  ('10032340', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'FIRST RESPONDERS OF CALIFORNIA LLC'),
  ('10035976', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'HOUSTON MENTAL HEALTH'),
  ('10034908', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'KENTUCKY WELLNESS CENTER'),
  ('10031977', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'LONESTAR MENTAL HEALTH LLC'),
  ('10033690', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'LOS ANGELES MENTAL HEALTH'),
  ('10030911', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'NASHVILLE MENTAL HEALTH LLC'),
  ('10030471', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'PACIFIC COAST MENTAL HEALTH LLC'),
  ('10035166', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TEEN MENTAL HEALTH TEXAS'),
  ('10034666', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TELEHEALTH MH'),
  ('10029105', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TENNESSEE BEHAVIORAL HEALTH'),
  ('10030101', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH CALIFORNIA'),
  ('10035974', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH COLORADO'),
  ('10034671', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH NEVADA'),
  ('10029905', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH TENNESSEE'),
  ('10029722', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH TEXAS'),
  ('10031212', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'TREAT MENTAL HEALTH WASHINGTON LLC'),
  ('10033951', 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'WELLNESS RECOVERY CENTER LLC'),
  -- Indigo Consulting (474623) — 36 customers.
  ('10026460', '141d459c-f371-4229-9a92-ace198e940bb', '405 RECOVERY'),
  ('10029373', '141d459c-f371-4229-9a92-ace198e940bb', 'ADDICTION FREE RECOVERY SERVICES'),
  ('10029528', '141d459c-f371-4229-9a92-ace198e940bb', 'ADOLESCENT MENTAL HEALTH'),
  ('10025030', '141d459c-f371-4229-9a92-ace198e940bb', 'BILLING SERVICE ACCOUNT'),
  ('10031413', '141d459c-f371-4229-9a92-ace198e940bb', 'BRITE RECOVERY'),
  ('10028848', '141d459c-f371-4229-9a92-ace198e940bb', 'CALIFORNIA TREATMENT COLLECTIVE'),
  ('10028842', '141d459c-f371-4229-9a92-ace198e940bb', 'COVENANT HILLS TREATMENT CENTERS'),
  ('10021230', '141d459c-f371-4229-9a92-ace198e940bb', 'CROWN VIEW CO-OCCURRING INSTITUTE - 612335'),
  ('10023916', '141d459c-f371-4229-9a92-ace198e940bb', 'CROWN VIEW PSYCHIATRIC INSTITUTE'),
  ('10020687', '141d459c-f371-4229-9a92-ace198e940bb', 'HEALTHY LIFE RECOVERY'),
  ('10026624', '141d459c-f371-4229-9a92-ace198e940bb', 'HILLSIDE HORIZON FOR TEENS'),
  ('10033859', '141d459c-f371-4229-9a92-ace198e940bb', 'INTO THE LIGHT'),
  ('10032291', '141d459c-f371-4229-9a92-ace198e940bb', 'KIN WELLNESS'),
  ('10030095', '141d459c-f371-4229-9a92-ace198e940bb', 'KNOX RECOVERY'),
  ('10034063', '141d459c-f371-4229-9a92-ace198e940bb', 'MAPSONG PC'),
  ('10024431', '141d459c-f371-4229-9a92-ace198e940bb', 'MENTAL HEALTH CENTER OF SAN DIEGO'),
  ('10030319', '141d459c-f371-4229-9a92-ace198e940bb', 'MENTAL HEALTH MODESTO'),
  ('10034979', '141d459c-f371-4229-9a92-ace198e940bb', 'MENTAL HEALTH TREATMENT AND STABILIZATION CENTER OF SACRAMENTO'),
  ('10034230', '141d459c-f371-4229-9a92-ace198e940bb', 'MY TEEN MENTAL HEALTH'),
  ('10026125', '141d459c-f371-4229-9a92-ace198e940bb', 'MY TIME RECOVERY, LLC'),
  ('10033867', '141d459c-f371-4229-9a92-ace198e940bb', 'NEW ORIGINS'),
  ('10034901', '141d459c-f371-4229-9a92-ace198e940bb', 'NEXT FRONTIER RECOVERY'),
  ('10035913', '141d459c-f371-4229-9a92-ace198e940bb', 'NORTHERN CALIFORNIA MENTAL HEALTH'),
  ('10021573', '141d459c-f371-4229-9a92-ace198e940bb', 'OPUS HEALTH'),
  ('10031652', '141d459c-f371-4229-9a92-ace198e940bb', 'ORANGE COUNTY MENTAL HEALTH'),
  ('10032612', '141d459c-f371-4229-9a92-ace198e940bb', 'POSTPARTUM MENTAL HEALTH'),
  ('10035467', '141d459c-f371-4229-9a92-ace198e940bb', 'RESTORED HOPE RECOVERY'),
  ('10028595', '141d459c-f371-4229-9a92-ace198e940bb', 'REVIVAL MENTAL HEALTH'),
  ('10026159', '141d459c-f371-4229-9a92-ace198e940bb', 'SADDLEBACK RECOVERY'),
  ('10028219', '141d459c-f371-4229-9a92-ace198e940bb', 'SHINE MENTAL HEALTH'),
  ('10025950', '141d459c-f371-4229-9a92-ace198e940bb', 'SILICON VALLEY RECOVERY, LLC'),
  ('10033531', '141d459c-f371-4229-9a92-ace198e940bb', 'THE EDGE TREATMENT CENTER'),
  ('10033708', '141d459c-f371-4229-9a92-ace198e940bb', 'THE FORGE RECOVERY CENTER'),
  ('10029219', '141d459c-f371-4229-9a92-ace198e940bb', 'THRIVE MEDICAL SPECIALISTS'),
  ('10034039', '141d459c-f371-4229-9a92-ace198e940bb', 'TREADSTONE SERVICES PC'),
  ('10031547', '141d459c-f371-4229-9a92-ace198e940bb', 'VISALIA RECOVERY CENTER');

DO $$
DECLARE bad text;
BEGIN
  -- customer number already present under a DIFFERENT tenant -> error
  SELECT string_agg(format('customer %s: live tenant %s <> seed tenant %s',
           c.cmd_customer_number, c.business_entity_id, s.business_entity_id), '; ')
    INTO bad
  FROM _seed_customer s JOIN core.cmd_customer c
    ON c.cmd_customer_number = s.cmd_customer_number
   AND c.business_entity_id <> s.business_entity_id;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'core.cmd_customer tenant mismatch: %', bad;
  END IF;
END $$;

-- Guard passed: tenant binding is immutable. Update only customer_name.
INSERT INTO core.cmd_customer (cmd_customer_number, business_entity_id, customer_name)
SELECT cmd_customer_number, business_entity_id, customer_name FROM _seed_customer
ON CONFLICT (cmd_customer_number) DO UPDATE SET customer_name = EXCLUDED.customer_name;

-- ---------------------------------------------------------------------------
-- Grants. Tables are already owned by claims_admin (born under SET ROLE above),
-- so no ALTER OWNER is needed. claims_admin (as owner) issues the reader grants.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA core TO claims_reader;
GRANT SELECT ON core.business_entity TO claims_reader;
GRANT SELECT ON core.cmd_customer    TO claims_reader;

-- ---------------------------------------------------------------------------
-- RLS — self-scoped (pure GUC-equality, matching staging.*). A tenant session
-- sees ONLY its own registry rows. The cross-tenant "Treat Health" read path is
-- built later (migration 019) via a NOLOGIN consolidated_reader role with
-- per-table enumerable SELECT policies (NO BYPASSRLS) — this keeps normal-session
-- isolation absolute here.
-- ---------------------------------------------------------------------------
ALTER TABLE core.business_entity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_entity_isolation ON core.business_entity;
CREATE POLICY business_entity_isolation ON core.business_entity
  USING      (id = current_setting('app.business_entity_id')::uuid)
  WITH CHECK (id = current_setting('app.business_entity_id')::uuid);

ALTER TABLE core.cmd_customer ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cmd_customer_isolation ON core.cmd_customer;
CREATE POLICY cmd_customer_isolation ON core.cmd_customer
  USING      (business_entity_id = current_setting('app.business_entity_id')::uuid)
  WITH CHECK (business_entity_id = current_setting('app.business_entity_id')::uuid);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- First-run verification (run as claims_admin after apply):
--   SELECT id, name, cmd_account_number FROM core.business_entity ORDER BY name;
--     -> 2 rows, BXR + Indigo, canonical UUIDs.
--   SELECT business_entity_id, count(*) FROM core.cmd_customer GROUP BY 1;
--     -> BXR 20, Indigo 36 (56 total).
-- ---------------------------------------------------------------------------
