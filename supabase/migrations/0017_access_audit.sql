-- 0017: claims.access_audit — DURABLE, per-user access audit for the executive surface.
--
-- Distinct from claims.query_log (0004) on purpose. query_log is a short-lived
-- (1-hour TTL) HANDLE for the two-gate PHI re-execution flow, keyed by an app-label
-- principal ('phase5-ui' etc.). THIS table is a PERMANENT audit trail of WHO (the
-- real authenticated user: email + Supabase auth uid) accessed WHAT (an action) and
-- WHEN, plus a NON-PHI `detail` blob. Two deliberate differences from query_log:
--   1. NO expires_at — rows never expire (durable audit, HIPAA access-log intent).
--   2. APPEND-ONLY — neither delete nor update is granted, even to claims_admin.
--
-- This is the foundation that replaces the hardcoded 'phase5-ui' principal: the
-- Next app authenticates the executive via Supabase Auth, resolves the real user
-- SERVER-SIDE, and records the email + uid here for any audited action. PHI must
-- NEVER be written into `detail` — it is for non-PHI request context only (action
-- metadata, request path, row COUNTS), never patient identifiers or values.
--
-- Access mirrors query_log exactly: claims_reader has NO table rights and writes
-- ONLY through the SECURITY DEFINER claims.log_access(...) function (owner
-- claims_admin, search_path pinned to claims, pg_catalog). RLS on, admin-only
-- policy. gen_random_uuid() is core in PG13+ (no extension needed).
--
-- Idempotent: CREATE TABLE/INDEX/FUNCTION IF NOT EXISTS / OR REPLACE, REVOKE+GRANT,
-- DROP POLICY IF EXISTS + CREATE POLICY. The `claims` schema + roles already exist
-- (migration 0003). Applied to project dbpabchpvipipkzkogta via Supabase MCP.

create table if not exists claims.access_audit (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  actor_email   text not null,   -- real authenticated user email (lowercased); never PHI
  actor_user_id text not null,   -- Supabase auth user id (uuid as text); never PHI
  action        text not null,   -- short verb, e.g. 'view_account'
  detail        jsonb not null default '{}'::jsonb,  -- NON-PHI request context only

  constraint access_audit_actor_email_ck   check (length(actor_email)   between 3 and 320),
  constraint access_audit_actor_user_id_ck check (length(actor_user_id) between 1 and 200),
  constraint access_audit_action_ck        check (length(action)        between 1 and 100)
);

-- Audit reads are time- and actor-scoped.
create index if not exists access_audit_created_at on claims.access_audit (created_at);
create index if not exists access_audit_actor      on claims.access_audit (actor_email, created_at);

-- Access control: strip any default/public grants, then grant ONLY claims_admin —
-- and ONLY select + insert. No delete, no update: the audit trail is append-only
-- and durable (this is the whole point — even the admin role cannot rewrite it).
revoke all on claims.access_audit from public, anon, authenticated, service_role, claims_reader;
grant select, insert on claims.access_audit to claims_admin;

-- RLS (consistent with claims.claims / claims.query_log).
alter table claims.access_audit enable row level security;

drop policy if exists access_audit_admin_rw on claims.access_audit;
create policy access_audit_admin_rw on claims.access_audit
  for all to claims_admin using (true) with check (true);

-- Supabase's `postgres` role is NOT a superuser; to set the function's OWNER to
-- claims_admin (below) it must be a member of claims_admin. Grant that membership
-- transiently and revoke it at the end — apply_migration runs in one transaction,
-- so the role graph is unchanged afterward. (Same dance as migration 0004.)
grant claims_admin to postgres;

-- ---------------------------------------------------------------------------
-- Write path under least privilege.
--
-- The app runs as claims_reader, which has NO table rights on access_audit. It
-- records rows ONLY through this SECURITY DEFINER function, which executes as its
-- OWNER (claims_admin). search_path is pinned so a caller-controlled path cannot
-- hijack the definer body; every reference inside is schema-qualified anyway. The
-- function is a single fixed INSERT — no dynamic SQL, no escalation surface — and
-- re-validates the table's CHECK bounds up front for clean caller errors. The
-- email is lowercased here so the stored actor identity is canonical regardless of
-- how the caller cased it.
-- ---------------------------------------------------------------------------

create or replace function claims.log_access(
  p_actor_email   text,
  p_actor_user_id text,
  p_action        text,
  p_detail        jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_id uuid;
begin
  if p_actor_email is null or length(p_actor_email) not between 3 and 320 then
    raise exception 'log_access: actor_email must be 3..320 chars'
      using errcode = 'check_violation';
  end if;
  if p_actor_user_id is null or length(p_actor_user_id) not between 1 and 200 then
    raise exception 'log_access: actor_user_id must be 1..200 chars'
      using errcode = 'check_violation';
  end if;
  if p_action is null or length(p_action) not between 1 and 100 then
    raise exception 'log_access: action must be 1..100 chars'
      using errcode = 'check_violation';
  end if;

  insert into claims.access_audit (actor_email, actor_user_id, action, detail)
  values (lower(p_actor_email), p_actor_user_id, p_action, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

alter function claims.log_access(text, text, text, jsonb) owner to claims_admin;
revoke execute on function claims.log_access(text, text, text, jsonb) from public;
grant  execute on function claims.log_access(text, text, text, jsonb) to claims_reader;

-- Drop the transient membership; the function now belongs to claims_admin.
revoke claims_admin from postgres;
