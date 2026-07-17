-- 0055 ROLLBACK: revert claims.app_user role CHECKs to the pre-admissions_seat (3-role) state.
--
-- FAIL-LOUD: refuses to run if any admissions_seat row still exists — reverting the CHECK while such
-- rows are present would either fail cryptically on re-validate or (worse) leave the app's narrowRole
-- coercing those live sessions to unprovisioned. Reassign or remove those accounts FIRST
--   (e.g. update claims.app_user set role='user', entity='bxr' where role='admissions_seat';)
-- then re-run this rollback. This mirrors the widening migration's apply path (set role claims_admin).
--
-- No DROP ROLE (admissions_seat is an app_user value, not a Postgres role). Pair with reverting the
-- TS enum mirrors (rbac.ts / server.ts / admin-actions.ts) in the same revert.

set role claims_admin;

do $$
declare
  n integer;
begin
  select count(*) into n from claims.app_user where role = 'admissions_seat';
  if n > 0 then
    raise exception
      'Rollback blocked: % admissions_seat row(s) in claims.app_user. Reassign/remove them first.', n;
  end if;
end $$;

alter table claims.app_user drop constraint if exists app_user_role_ck;
alter table claims.app_user add constraint app_user_role_ck
  check (role in ('super_admin', 'admin', 'user'));

alter table claims.app_user drop constraint if exists app_user_role_entity_ck;
alter table claims.app_user add constraint app_user_role_entity_ck check (
  (role = 'super_admin' and entity is null) or
  (role in ('admin', 'user') and entity is not null)
);

-- Restore claims.upsert_app_user to its 0026 (pre-admissions_seat) form: 3-role list + original
-- coherence + original error message. Byte-identical to migration 0026's definition.
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

reset role;
