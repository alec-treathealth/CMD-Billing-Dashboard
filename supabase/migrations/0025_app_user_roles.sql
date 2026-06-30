-- 0025: claims.app_user — per-user RBAC for the dashboard (Super Admin / entity Admin / entity User).
--
-- Replaces the flat "any verified session = full access" model (invite-only, migration 0024) with
-- explicit roles:
--   • super_admin           — all three views (Consolidated / BXR / Indigo); MAY reveal PHI; MAY manage users.
--   • admin   + entity      — that entity's view ONLY; MAY reveal PHI; MAY manage users (in-app UI deferred).
--   • user    + entity      — that entity's view ONLY; NON-PHI only (CANNOT reveal patient identifiers).
--
-- The app resolves the signed-in Supabase user (uid from the verified JWT) and looks up THIS row as
-- the least-privilege claims_reader (server-side node-postgres; NEVER PostgREST). A signed-in user
-- with NO row here is UNPROVISIONED (default-deny): they can authenticate but see a "not provisioned"
-- notice until an admin grants a role. This is auth-CONTROL data (staff email + role), never patient PHI.
--
-- SAFE ROLLOUT (lockout prevention): apply this migration + the super_admin seed BEFORE deploying the
-- build that ENFORCES it. The seeded super_admin (alec@treathealth.ai) is the bootstrap admin; without
-- a seeded row the enforcing build would lock everyone out. The currently-live build does not read this
-- table, so creating it early is inert until the new build ships.
--
-- Idempotent: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY, REVOKE+GRANT, and
-- an ON CONFLICT upsert for the seed. The claims schema + roles exist already (migration 0003). The
-- claims_admin membership dance mirrors 0017/0018 (Supabase `postgres` is not a superuser, so it must
-- transiently join claims_admin to own objects). Runs in one transaction; role graph unchanged after.
-- Applied to project dbpabchpvipipkzkogta via Supabase MCP.

grant claims_admin to postgres;

create table if not exists claims.app_user (
  user_id    uuid primary key,   -- Supabase auth.users.id (the verified JWT sub); soft ref, no cross-schema FK
  email      text not null,      -- staff identity (lowercased); for display / admin / audit, NOT the match key
  role       text not null,
  entity     text,               -- NULL for super_admin; 'bxr' | 'indigo' for entity-scoped roles
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint app_user_email_ck  check (length(email) between 3 and 320 and email = lower(email)),
  constraint app_user_role_ck   check (role in ('super_admin', 'admin', 'user')),
  constraint app_user_entity_ck check (entity is null or entity in ('bxr', 'indigo')),
  -- role/entity coherence: super_admin has NO entity; admin/user MUST have one.
  constraint app_user_role_entity_ck check (
    (role = 'super_admin' and entity is null) or
    (role in ('admin', 'user') and entity is not null)
  )
);
alter table claims.app_user owner to claims_admin;

create index if not exists app_user_email on claims.app_user (email);

-- Bootstrap the super admin (idempotent). Maps the email -> the real auth.users uuid; if that user
-- does not exist yet the seed inserts nothing (and enforcement stays locked until they do — which is
-- why this account must exist before the enforcing build ships). The `do update` re-asserts the role,
-- so re-applying always leaves the bootstrap account a super_admin (there is no in-app role UI yet to
-- conflict with). Runs BEFORE `enable row level security`, so the seed is not subject to RLS.
insert into claims.app_user (user_id, email, role, entity)
select id, lower(email), 'super_admin', null
from auth.users
where lower(email) = 'alec@treathealth.ai'
on conflict (user_id) do update
  set role = 'super_admin', entity = null, email = excluded.email, updated_at = now();

-- Access: the app reads this table as claims_reader (server-side). Strip all default/implicit grants,
-- then grant ONLY claims_reader SELECT. There is NO write path from the app — provisioning is
-- admin-only (a future admin tool running as claims_admin, or direct SQL). Non-PHI, but locked down
-- by least privilege anyway.
revoke all on claims.app_user from public, anon, authenticated, service_role;
grant select on claims.app_user to claims_reader;

-- RLS on (consistent with claims.claims / query_log / access_audit). claims_admin gets full RW; the
-- reader gets a permissive SELECT policy (it must look up any signed-in user's uid). Without a reader
-- policy, RLS would return zero rows even with the SELECT grant.
alter table claims.app_user enable row level security;

drop policy if exists app_user_admin_rw on claims.app_user;
create policy app_user_admin_rw on claims.app_user
  for all to claims_admin using (true) with check (true);

drop policy if exists app_user_reader_select on claims.app_user;
create policy app_user_reader_select on claims.app_user
  for select to claims_reader using (true);

-- Drop the transient membership; the table now belongs to claims_admin.
revoke claims_admin from postgres;

-- ===========================================================================
-- PROVISIONING (manual until an in-app admin tool lands) — run as claims_admin / via SQL:
--   -- find the uuid:  select id, email from auth.users where lower(email) = '<email>';
--   insert into claims.app_user (user_id, email, role, entity)
--   values ('<uuid>', '<email-lower>', 'admin', 'bxr')   -- or ('...','...','user','indigo'), etc.
--   on conflict (user_id) do update set role = excluded.role, entity = excluded.entity,
--     email = excluded.email, updated_at = now();
-- super_admin: role='super_admin', entity=null. Entity roles: role in ('admin','user'), entity in ('bxr','indigo').
-- ===========================================================================
