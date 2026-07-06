-- 0027: collections.business_entities — the tenant REGISTRY (BXR + Indigo).
--
-- WHY: onboarding Indigo Billing as a second real tenant. Until now the set of tenants
-- lived only as UUID literals in code (app/lib/views.ts BXR_ENTITY_ID, src/tenants.ts) +
-- the per-transaction app.business_entity_id GUC. This adds a canonical, queryable
-- registry of who the tenants are.
--
-- ⚠️ THIS IS A REGISTRY, NOT AN ENFORCEMENT MECHANISM. Nothing scopes on it yet:
--   • the tenant-scoped staging.* tables carry a bare business_entity_id uuid with NO
--     foreign key to this table (deliberately — adding FKs is out of scope here), and
--   • RLS isolation on staging.* is still enforced by
--     current_setting('app.business_entity_id')::uuid, exactly as before.
-- So creating + seeding this table changes NO existing query's behavior and touches NO
-- existing row. It is documentation-as-data + a future join target.
--
-- SCOPE NOTE: the collections.* / dashboard layer is still single-tenant (no
-- business_entity_id column on cmd_explorer_rows / daily_collections / facilities, and the
-- readers don't scope by entity). Wiring the dashboard to be multi-tenant is a SEPARATE,
-- later step — this migration does not attempt it.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; seed via INSERT ... ON CONFLICT DO UPDATE;
-- DROP POLICY IF EXISTS before CREATE POLICY; roles referenced only if present; REVOKE/GRANT
-- reapplied unconditionally. Safe to re-run.
--
-- DEPENDENCY: assumes the `collections` schema (0006) and claims_reader (0003) exist.
-- PostgREST: `collections` stays OFF Supabase's exposed-schemas list (unchanged posture).

-- 1. Table --------------------------------------------------------------------
create table if not exists collections.business_entities (
  business_entity_id  uuid        primary key,
  name                text        not null check (char_length(name) between 1 and 200),
  cmd_account_number  text                 check (char_length(cmd_account_number) <= 50),
  created_at          timestamptz not null default now()
);

comment on table collections.business_entities is
  'Tenant registry (BXR, Indigo). REGISTRY ONLY — no FK from staging.*; RLS on staging.* is still enforced via the app.business_entity_id GUC. Creating/seeding this changes no existing query behavior.';

-- 2. Seed BXR + Indigo (idempotent upsert; UUIDs are fixed constants — never regenerate) --
insert into collections.business_entities (business_entity_id, name, cmd_account_number) values
  ('af504ab6-3dcd-4aa4-a93c-27bc58de4088', 'BXR Consulting LLC', '475729'),
  ('141d459c-f371-4229-9a92-ace198e940bb', 'Indigo Billing',     '474623')
on conflict (business_entity_id) do update set
  name               = excluded.name,
  cmd_account_number = excluded.cmd_account_number;

-- 3. Grants + RLS -------------------------------------------------------------
-- Non-PHI reference data. Strip default/public grants; grant SELECT to claims_reader.
-- RLS enabled with a read-all SELECT policy (the registry lists ALL tenants — it is not
-- itself tenant-scoped, mirroring ref.remittance_code's shared-reference posture). No
-- role gets INSERT/UPDATE/DELETE: the registry is maintained by migrations (claims_admin
-- owner), not by the app or the cron writer.
revoke all on collections.business_entities from public, anon, authenticated, service_role;
grant select on collections.business_entities to claims_reader;

alter table collections.business_entities enable row level security;

drop policy if exists business_entities_reader_select on collections.business_entities;
create policy business_entities_reader_select on collections.business_entities
  for select to claims_reader using (true);

-- 4. Verification (run manually after deploy) ---------------------------------
-- select business_entity_id, name, cmd_account_number from collections.business_entities order by name;
--   expect exactly 2 rows: BXR Consulting LLC (475729), Indigo Billing (474623).
