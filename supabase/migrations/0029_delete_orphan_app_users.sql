-- 0029: claims.delete_orphan_app_users() — reap claims.app_user rows orphaned by out-of-band auth deletion.
--
-- BUG THIS FIXES: claims.app_user's PK is user_id and claims.upsert_app_user() upserts ON CONFLICT
-- (user_id) (migration 0026). When a Supabase Auth account is deleted directly in the Supabase dashboard
-- (bypassing the app's deleteUser path), the auth.users row disappears but the app_user role row remains —
-- an ORPHAN keyed on a now-dead uid. Re-inviting that same email mints a NEW auth uid, so upsert_app_user
-- keys on the new uid and INSERTS a second row instead of replacing the orphan → two app_user rows for one
-- email. This function lets the app reap the orphan(s) at invite time.
--
-- WHY A DB FUNCTION: the app runs as the least-privilege claims_reader, whose only write primitives are
-- upsert_app_user / delete_app_user — both keyed on user_id — and it cannot see an orphan through
-- claims.list_app_users() (that roster is FROM auth.users, so a dead-uid row is invisible). Deleting an
-- orphan therefore needs a bridge that can (a) read auth.users to prove a row is orphaned and (b) delete
-- from claims.app_user. Only `postgres` can do BOTH (it reads auth.users and, via rolbypassrls, writes
-- app_user under RLS) — claims_admin owns app_user but has NO auth.users read — so this is owner postgres,
-- exactly like claims.list_app_users(). SECURITY DEFINER + pinned search_path; every value is a bound
-- parameter; all objects fully schema-qualified so a caller search_path cannot hijack the body.
--
-- SAFETY: the NOT EXISTS (auth.users) guard means this can ONLY delete a provably-orphaned row (no live
-- auth account). A live/confirmed same-email row is never touched — so inviteUser()'s "assign the role to
-- the existing account" fallback keeps working. p_keep_user_id (the row the invite just upserted) is also
-- excluded belt-and-suspenders. It does NOT carry the last-super-admin guard: an orphan has no auth account
-- and can never sign in, so it is not a usable admin — reaping it cannot cause a login lockout.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + REVOKE/GRANT. No owner change (postgres, the creating role,
-- is the intended owner). The claims schema, roles, and claims.app_user exist already (0003 / 0025 / 0026).

create or replace function claims.delete_orphan_app_users(p_email text, p_keep_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_deleted integer;
begin
  if p_email is null or p_keep_user_id is null then
    raise exception 'delete_orphan_app_users: email and keep_user_id are required'
      using errcode = 'check_violation';
  end if;

  delete from claims.app_user a
  where lower(a.email) = lower(p_email)
    and a.user_id <> p_keep_user_id
    and not exists (select 1 from auth.users u where u.id = a.user_id);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function claims.delete_orphan_app_users(text, uuid) from public, anon, authenticated;
grant  execute on function claims.delete_orphan_app_users(text, uuid) to claims_reader;
