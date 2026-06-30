-- 0026: in-app user management — read bridge to auth.users + admin write functions for claims.app_user.
--
-- The dashboard's "Manage users" surface (admins + super_admins) needs to (a) LIST who exists in
-- Supabase Auth and what dashboard role they hold, and (b) assign / change / revoke roles. The app
-- runs as the least-privilege claims_reader, which cannot read auth.users (owner supabase_auth_admin,
-- holds password hashes) and cannot write claims.app_user. These SECURITY DEFINER functions are the
-- narrow, audited bridges — the SAME pattern as claims.log_query / log_access / verify_identity.
--
--   • claims.list_app_users()  — owner postgres (the only role here that may read auth.users), projects
--     ONLY id / email / confirmed-status / created_at (NEVER password/token columns) LEFT JOINed to the
--     role row. No grant to any role on auth.users; the app reaches only this fixed projection.
--   • claims.upsert_app_user() / claims.delete_app_user() — owner claims_admin (owns app_user); enforce
--     data integrity (role/entity bounds + coherence) and the LAST-SUPER-ADMIN guard (cannot demote or
--     remove the final super_admin → no unmanageable lockout). EXECUTE granted to claims_reader.
--
-- AUTHORIZATION (who may manage whom — caller role, entity scope, no self-edit) is enforced in the
-- Server Action (app/lib/admin-actions.ts), which has the verified session; these functions cannot see
-- it and intentionally do NOT re-implement it. They guarantee DATA INTEGRITY only.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, REVOKE+GRANT. No dynamic SQL; search_path pinned; every value
-- is a bound parameter. The claims schema + roles + claims.app_user exist already (0003 / 0025). The
-- claims_admin membership dance mirrors 0017/0018. Applied to project dbpabchpvipipkzkogta via Supabase MCP.

-- ---------------------------------------------------------------------------
-- READ bridge: list all Supabase Auth users + their dashboard role (if any).
-- Owner postgres (it alone may read auth.users here); projects only non-secret columns. SECURITY
-- DEFINER + pinned search_path; everything fully schema-qualified so the definer body cannot be
-- hijacked by a caller search_path. Returns the staff roster (emails are staff identity, non-PHI);
-- the calling action gates this behind canManageUsers.
-- ---------------------------------------------------------------------------
create or replace function claims.list_app_users()
returns table (
  user_id         uuid,
  email           text,
  email_confirmed boolean,
  created_at      timestamptz,
  role            text,
  entity          text
)
language sql
security definer
set search_path = pg_catalog
as $$
  select u.id,
         u.email::text,
         (u.email_confirmed_at is not null),
         u.created_at,
         a.role,
         a.entity
  from auth.users u
  left join claims.app_user a on a.user_id = u.id
  order by (a.role is not null) desc, u.email;
$$;

revoke execute on function claims.list_app_users() from public, anon, authenticated;
grant  execute on function claims.list_app_users() to claims_reader;

-- ---------------------------------------------------------------------------
-- WRITE functions, owned by claims_admin (owns app_user). Supabase `postgres` is not a superuser; to
-- set the owner it must transiently join claims_admin. Runs in one transaction; role graph unchanged.
-- ---------------------------------------------------------------------------
grant claims_admin to postgres;

-- Assign / change a user's role. Re-validates the table's bounds for clean caller errors and refuses to
-- demote the LAST super_admin (would leave the system unmanageable). The user_id is a real auth uid the
-- action resolved via list_app_users; no auth.users access is needed here.
create or replace function claims.upsert_app_user(
  p_user_id uuid,
  p_email   text,
  p_role    text,
  p_entity  text
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user_id is null then
    raise exception 'upsert_app_user: user_id required' using errcode = 'check_violation';
  end if;
  if p_role not in ('super_admin', 'admin', 'user') then
    raise exception 'upsert_app_user: invalid role' using errcode = 'check_violation';
  end if;
  if p_entity is not null and p_entity not in ('bxr', 'indigo') then
    raise exception 'upsert_app_user: invalid entity' using errcode = 'check_violation';
  end if;
  if not ((p_role = 'super_admin' and p_entity is null)
          or (p_role in ('admin', 'user') and p_entity is not null)) then
    raise exception 'upsert_app_user: super_admin takes no entity; admin/user require one'
      using errcode = 'check_violation';
  end if;
  if p_email is null or length(p_email) not between 3 and 320 then
    raise exception 'upsert_app_user: invalid email' using errcode = 'check_violation';
  end if;

  -- Last-super-admin guard: block a change that demotes the only remaining super_admin.
  if p_role <> 'super_admin'
     and exists (select 1 from claims.app_user where user_id = p_user_id and role = 'super_admin')
     and (select count(*) from claims.app_user where role = 'super_admin') <= 1 then
    raise exception 'upsert_app_user: cannot demote the last super admin'
      using errcode = 'check_violation';
  end if;

  insert into claims.app_user (user_id, email, role, entity)
  values (p_user_id, lower(p_email), p_role, p_entity)
  on conflict (user_id) do update
    set role = excluded.role, entity = excluded.entity, email = excluded.email, updated_at = now();
end;
$$;

-- Revoke a user (delete the role row → unprovisioned). Refuses to remove the last super_admin.
create or replace function claims.delete_app_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user_id is null then
    raise exception 'delete_app_user: user_id required' using errcode = 'check_violation';
  end if;
  if exists (select 1 from claims.app_user where user_id = p_user_id and role = 'super_admin')
     and (select count(*) from claims.app_user where role = 'super_admin') <= 1 then
    raise exception 'delete_app_user: cannot remove the last super admin'
      using errcode = 'check_violation';
  end if;
  delete from claims.app_user where user_id = p_user_id;
end;
$$;

alter function claims.upsert_app_user(uuid, text, text, text) owner to claims_admin;
alter function claims.delete_app_user(uuid)                    owner to claims_admin;

revoke execute on function claims.upsert_app_user(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function claims.upsert_app_user(uuid, text, text, text) to claims_reader;
revoke execute on function claims.delete_app_user(uuid) from public, anon, authenticated;
grant  execute on function claims.delete_app_user(uuid) to claims_reader;

revoke claims_admin from postgres;
