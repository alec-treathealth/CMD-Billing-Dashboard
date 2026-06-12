-- 0003: Schema separation + least-privilege roles + RLS for the claims data.
--
-- Context: project dbpabchpvipipkzkogta is SHARED. public.cmd_transactions and
-- public.cmd_facility_daily_summary belong to unrelated CMD billing work. Phase 1
-- landed claims_raw/claims in `public` with RLS OFF and Supabase's default
-- anon/authenticated grants intact — i.e. PHI was reachable via the REST API.
-- This migration closes that by (a) moving both tables into a dedicated `claims`
-- schema that is NOT exposed to PostgREST, (b) revoking the public-facing roles,
-- (c) creating two least-privilege roles, (d) enabling RLS with explicit policies.
--
-- Runtime (Phase 2, Decision 1): the query library connects as claims_reader and
-- the ingest as claims_admin over node-postgres. Those roles get LOGIN + password
-- OUT OF BAND (never in this committed file); see .env. This migration creates
-- them as privilege roles only.
--
-- Idempotency note: the plan called for `DROP ROLE IF EXISTS` before CREATE ROLE.
-- Because the runtime credential (LOGIN + password) is provisioned out of band,
-- dropping the role on a re-run would silently destroy that credential. We instead
-- create the roles only-if-absent and (re)apply every grant/policy unconditionally
-- (REVOKE+GRANT, DROP POLICY IF EXISTS + CREATE POLICY) — idempotent AND
-- credential-preserving.

-- 1. Dedicated schema -------------------------------------------------------
create schema if not exists claims;

-- 2. Move the two tables. Indexes, identity sequences, the FK, and all other
--    constraints follow the table automatically (catalog re-point, no rebuild,
--    no row movement). Guarded so a re-run is a no-op.
do $$
begin
  if to_regclass('public.claims_raw') is not null then
    execute 'alter table public.claims_raw set schema claims';
  end if;
  if to_regclass('public.claims') is not null then
    execute 'alter table public.claims set schema claims';
  end if;
end $$;

-- 3. Move pg_trgm into `claims` so claims_reader can use similarity()/% WITHOUT
--    any privilege on `public`. The GIN trgm indexes reference the opclass by OID
--    and keep working across the move; pg_trgm has no other dependents here.
do $$
declare s text;
begin
  select n.nspname into s
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if s is distinct from 'claims' then
    execute 'alter extension pg_trgm set schema claims';
  end if;
end $$;

-- 4. Roles (privilege-only here; LOGIN + password provisioned out of band) ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'claims_admin') then
    create role claims_admin nologin;
  end if;
end $$;

-- Resolve unqualified names (incl. the pg_trgm operators now in `claims`) for
-- both roles' sessions.
alter role claims_reader set search_path = claims;
alter role claims_admin  set search_path = claims;

-- 5. Strip the inherited public-facing grants from the PHI tables, then grant
--    precisely. REVOKE is idempotent.
revoke all on claims.claims     from public, anon, authenticated, service_role;
revoke all on claims.claims_raw from public, anon, authenticated, service_role;

-- Reader: USAGE on the schema + SELECT on claims.claims ONLY. No claims_raw
-- (verbatim PHI source cells), no writes, nothing on public.
grant usage  on schema claims to claims_reader;
grant select on claims.claims to claims_reader;

-- Admin (ingest): full use of the schema.
grant usage, create on schema claims to claims_admin;
grant all on claims.claims     to claims_admin;
grant all on claims.claims_raw to claims_admin;
grant usage, select on all sequences in schema claims to claims_admin;

-- 6. RLS ---------------------------------------------------------------------
alter table claims.claims     enable row level security;
alter table claims.claims_raw enable row level security;

-- Reader: permissive SELECT on claims only.
drop policy if exists claims_reader_select on claims.claims;
create policy claims_reader_select on claims.claims
  for select to claims_reader using (true);

-- Admin: permissive ALL on both tables (ingest path).
drop policy if exists claims_admin_all on claims.claims;
create policy claims_admin_all on claims.claims
  for all to claims_admin using (true) with check (true);

drop policy if exists claims_admin_all_raw on claims.claims_raw;
create policy claims_admin_all_raw on claims.claims_raw
  for all to claims_admin using (true) with check (true);
