-- 0046 — claims.user_grid_views: per-user saved column layouts for the Collections Explorer grid.
--
-- WHY: the explorer grid (Session B of the collections-explorer feedback spec) lets a user pick
-- WHICH columns show and in WHAT order, and save that as a named, private template that survives a
-- refresh and a fresh login. This is per-user UI state — non-PHI, non-tenant, single-owner.
--
-- SCHEMA CHOICE (claims, not collections): the owner key FKs to claims.app_user, and the app's ONLY
-- user-initiated write path is the SECURITY DEFINER pattern that already lives in claims
-- (upsert_app_user / delete_app_user / log_access, 0025/0026/0017). Co-locating keeps the FK
-- same-schema and the write functions beside their siblings. The FEATURE is surfaced only in the
-- Collections Explorer tab; this is purely where the row lives, not where it renders.
--
-- OWNERSHIP MODEL (matches app_user exactly):
--   • Reads  — claims_reader SELECTs the table directly, app-layer scoped `where app_user_id = <uid>`
--     (mirrors appUserFor). RLS reader policy is role-permissive; the app's WHERE is the scope.
--   • Writes — the app (least-privilege claims_reader) has NO direct DML; it EXECUTEs the three
--     SECURITY DEFINER functions below (owned by claims_admin), passing the SERVER-RESOLVED caller
--     uuid. A user can only ever touch their OWN views because the Server Action passes its own
--     authenticated uid and NEVER a client-supplied id — the same discipline as upsert_app_user.
--
-- FK CASCADE (not RESTRICT): a deleted user's private view templates are meaningless clutter with no
-- shared or downstream dependency (unlike tenant FKs, which RESTRICT to protect shared data). ON
-- DELETE CASCADE also lets claims.delete_app_user clean them up with no extra code.
--
-- CONSTRAINTS: (app_user_id, view_name) unique (no dup names per user; same name across users is
-- fine); a PARTIAL unique index enforces AT MOST ONE is_default=true per user AT THE DB LEVEL, not
-- just in app logic. columns is a jsonb ARRAY of column-key strings whose ORDER is the display order
-- and whose MEMBERSHIP is visibility (no separate hidden list). Key allowlisting + count bound are
-- enforced in the pure sanitizer (server) + the save function; the table CHECK only pins the shape.
--
-- PHI: none (column KEYS + a user's own label; never a patient value). Idempotent: table/index IF
-- NOT EXISTS; CREATE OR REPLACE functions; REVOKE+GRANT reapplied. Rollback drops the table (cascades
-- its functions? no — functions are separate objects; the rollback drops both). One transaction; the
-- claims_admin membership dance mirrors 0025/0026. DEPENDENCY: 0025 (claims.app_user + roles).

grant claims_admin to postgres;

-- 1. Table -------------------------------------------------------------------
create table if not exists claims.user_grid_views (
  id           bigint generated always as identity primary key,
  app_user_id  uuid  not null references claims.app_user (user_id) on delete cascade,
  view_name    text  not null,
  columns      jsonb not null,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint user_grid_views_name_len_ck  check (char_length(view_name) between 1 and 80),
  constraint user_grid_views_columns_arr_ck check (jsonb_typeof(columns) = 'array'),
  constraint user_grid_views_name_uq       unique (app_user_id, view_name)
);
alter table claims.user_grid_views owner to claims_admin;

-- At most ONE default view per user, enforced by the DB (partial unique index).
create unique index if not exists user_grid_views_one_default
  on claims.user_grid_views (app_user_id) where is_default;

-- 2. Grants: reader SELECTs (app-layer scoped) for list; no direct DML (writes via fns below). ---
revoke all on claims.user_grid_views from public, anon, authenticated, service_role;
grant select on claims.user_grid_views to claims_reader;

-- 3. RLS (mirrors app_user: admin RW, reader permissive SELECT; app WHERE is the real scope). -----
alter table claims.user_grid_views enable row level security;

drop policy if exists user_grid_views_admin_rw on claims.user_grid_views;
create policy user_grid_views_admin_rw on claims.user_grid_views
  for all to claims_admin using (true) with check (true);

drop policy if exists user_grid_views_reader_select on claims.user_grid_views;
create policy user_grid_views_reader_select on claims.user_grid_views
  for select to claims_reader using (true);

-- 4. Write functions (SECURITY DEFINER, owned by claims_admin; integrity + owner-scoping only —
-- AUTHENTICATION/AUTHORIZATION is the Server Action's job, exactly as in 0026). Every op is scoped
-- to p_user, which the action fills with the server-resolved caller uid (never client input). -----

-- Create or update a named view for p_user. Optionally make it the default (clears any prior default
-- FIRST so the partial unique index is never transiently violated). Returns the row id.
create or replace function claims.save_grid_view(
  p_user         uuid,
  p_name         text,
  p_columns      jsonb,
  p_make_default boolean
) returns bigint
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_id bigint;
begin
  if p_user is null then
    raise exception 'save_grid_view: user required' using errcode = 'check_violation';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 80 then
    raise exception 'save_grid_view: invalid view_name' using errcode = 'check_violation';
  end if;
  if p_columns is null or jsonb_typeof(p_columns) <> 'array'
     or jsonb_array_length(p_columns) not between 1 and 64 then
    raise exception 'save_grid_view: columns must be a 1..64-element array' using errcode = 'check_violation';
  end if;

  if coalesce(p_make_default, false) then
    update claims.user_grid_views
       set is_default = false, updated_at = now()
     where app_user_id = p_user and is_default;
  end if;

  insert into claims.user_grid_views (app_user_id, view_name, columns, is_default)
  values (p_user, p_name, p_columns, coalesce(p_make_default, false))
  on conflict (app_user_id, view_name) do update
     set columns    = excluded.columns,
         is_default = case when coalesce(p_make_default, false) then true
                           else claims.user_grid_views.is_default end,
         updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Make p_name the caller's default (and clear the others). Raises if the named view doesn't exist.
create or replace function claims.set_default_grid_view(p_user uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null or p_name is null then
    raise exception 'set_default_grid_view: user and view_name required' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from claims.user_grid_views where app_user_id = p_user and view_name = p_name) then
    raise exception 'set_default_grid_view: view not found' using errcode = 'no_data_found';
  end if;
  update claims.user_grid_views
     set is_default = (view_name = p_name), updated_at = now()
   where app_user_id = p_user;
end;
$$;

-- Delete one of the caller's views by name (no-op if absent).
create or replace function claims.delete_grid_view(p_user uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null or p_name is null then
    raise exception 'delete_grid_view: user and view_name required' using errcode = 'check_violation';
  end if;
  delete from claims.user_grid_views where app_user_id = p_user and view_name = p_name;
end;
$$;

alter function claims.save_grid_view(uuid, text, jsonb, boolean) owner to claims_admin;
alter function claims.set_default_grid_view(uuid, text)          owner to claims_admin;
alter function claims.delete_grid_view(uuid, text)               owner to claims_admin;

revoke execute on function claims.save_grid_view(uuid, text, jsonb, boolean) from public, anon, authenticated;
grant  execute on function claims.save_grid_view(uuid, text, jsonb, boolean) to claims_reader;
revoke execute on function claims.set_default_grid_view(uuid, text) from public, anon, authenticated;
grant  execute on function claims.set_default_grid_view(uuid, text) to claims_reader;
revoke execute on function claims.delete_grid_view(uuid, text) from public, anon, authenticated;
grant  execute on function claims.delete_grid_view(uuid, text) to claims_reader;

revoke claims_admin from postgres;
