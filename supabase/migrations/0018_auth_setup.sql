-- 0018: auth_config.allowed_emails — the SINGLE source of truth for who may sign in.
--
-- Per-user login replaces Vercel Deployment Protection as the primary PHI gate. This
-- migration creates the allowlist table + the signup-blocking auth hook. The Next app
-- (middleware + requireExecutive) reads the table to authorize each request, and the
-- Supabase Auth "Before User Created" hook consults the SAME table so a non-allowlisted
-- address can never even create an account.
--
-- The email is a staff identity (NOT patient PHI), but this is auth-control data: RLS
-- lets an authenticated user read ONLY their own row; only claims_admin (owner) writes.
-- Edit the allowlist in the Supabase dashboard (no redeploy).
--
-- Idempotent: CREATE ... IF NOT EXISTS / OR REPLACE, DROP POLICY IF EXISTS, REVOKE+GRANT,
-- ON CONFLICT DO NOTHING. The claims schema + roles exist already (migration 0003).
-- Applied to project dbpabchpvipipkzkogta via Supabase MCP.

-- Supabase `postgres` is not a superuser; to own objects as claims_admin it must be a
-- transient member of claims_admin. Runs in one transaction; role graph unchanged after.
-- (Same dance as 0004/0017.)
grant claims_admin to postgres;

create schema if not exists auth_config authorization claims_admin;

create table if not exists auth_config.allowed_emails (
  email      text primary key,
  created_at timestamptz not null default now(),
  constraint allowed_emails_email_ck
    check (length(email) between 3 and 320 and email = lower(email))
);
alter table auth_config.allowed_emails owner to claims_admin;

-- Seed the initial allowed users (lowercased). More are added in the dashboard.
insert into auth_config.allowed_emails (email) values
  ('alec@treathealth.ai'),
  ('derek@treathealth.ai'),
  ('blake@treathealth.ai')
on conflict (email) do nothing;

-- App read path: an authenticated user may SELECT only their OWN row (RLS). The app
-- (Supabase client carrying the user JWT) does `select email where email = me` and
-- treats a returned row as "authorized". anon/public get nothing.
grant usage  on schema auth_config            to authenticated;
grant select on auth_config.allowed_emails    to authenticated;
revoke all   on auth_config.allowed_emails    from anon, public;

alter table auth_config.allowed_emails enable row level security;
drop policy if exists allowed_emails_own_row on auth_config.allowed_emails;
create policy allowed_emails_own_row on auth_config.allowed_emails
  for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

-- ---------------------------------------------------------------------------
-- Signup gate: Supabase Auth "Before User Created" hook (the current, recommended
-- mechanism for invite-only signups). Runs BEFORE insert into auth.users. Returns
-- '{}' to allow, or {error:{...}} to reject (message surfaced to the client). Allows
-- ONLY emails present in the allowlist. SECURITY DEFINER (owner claims_admin) so it
-- reads the allowlist regardless of the auth admin's own grants; search_path pinned;
-- EXECUTE granted ONLY to supabase_auth_admin.
-- ---------------------------------------------------------------------------
create or replace function auth_config.restrict_signup_to_allowlist(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = auth_config, pg_catalog
as $$
declare
  v_email text;
begin
  v_email := lower(event -> 'user' ->> 'email');

  if v_email is not null
     and exists (select 1 from auth_config.allowed_emails where email = v_email) then
    return '{}'::jsonb;  -- allow
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This email is not authorized. Accounts are provisioned by an administrator.'
    )
  );
end;
$$;

alter function auth_config.restrict_signup_to_allowlist(jsonb) owner to claims_admin;
revoke execute on function auth_config.restrict_signup_to_allowlist(jsonb) from public, anon, authenticated;
grant  execute on function auth_config.restrict_signup_to_allowlist(jsonb) to supabase_auth_admin;
grant  usage   on schema auth_config to supabase_auth_admin;  -- so the hook can resolve the fn

-- Drop the transient membership; objects now belong to claims_admin.
revoke claims_admin from postgres;

-- ===========================================================================
-- MANUAL STEPS (Supabase dashboard) — required to ACTIVATE auth:
--   1. Authentication -> Hooks -> "Before User Created" -> Enable -> Postgres ->
--        schema: auth_config, function: restrict_signup_to_allowlist
--   2. Project Settings -> API -> "Exposed schemas" -> add `auth_config`
--        (lets the app read own-row via PostgREST under RLS; anon still denied).
--   3. Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel
--        (and app/.env.local locally). Until set, auth stays OFF and the app falls
--        back to Vercel Deployment Protection (safe, staged rollout).
-- ===========================================================================
