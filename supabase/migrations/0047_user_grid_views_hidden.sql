-- 0047 — claims.user_grid_views: add hidden_columns for the "persist full order + visibility" model.
--
-- WHY: 0046 stored `columns` as a jsonb array whose MEMBERSHIP = visibility (visible cols only, in
-- order). The Collections Explorer column picker now persists the FULL column order — all columns,
-- including hidden ones — with visibility tracked separately, so a hidden column keeps its position
-- when re-shown. `columns` now carries the full display order; `hidden_columns` carries which of
-- those keys are hidden.
--
-- BACKWARD COMPAT (non-breaking): hidden_columns is NULLABLE with NO default. Rows written by 0046
-- keep hidden_columns = NULL, which the reader treats as LEGACY: `columns` is visible-in-order and
-- any allowlisted key NOT present is hidden — exactly 0046's semantics. New writes always set
-- hidden_columns to a (possibly empty) jsonb array, so NULL vs array cleanly discriminates the two
-- formats. No backfill, no table rewrite (ADD COLUMN nullable-no-default is metadata-only).
--
-- ZERO-DOWNTIME FN STRATEGY: save_grid_view gains a p_hidden jsonb argument. Adding an argument makes
-- a NEW overload (uuid,text,jsonb,jsonb,boolean) rather than replacing the existing 4-arg one — so we
-- ADD the 5-arg version and DELIBERATELY KEEP the 4-arg version. During the window between applying
-- this migration and the new app finishing its deploy, the still-running old code calls the 4-arg fn
-- (which continues to work, writing legacy-shaped rows with hidden_columns = NULL); the new code calls
-- the 5-arg fn. Overload resolution is unambiguous (different arg counts). A LATER cleanup migration
-- drops the 4-arg overload once the new code is confirmed live. set_default_grid_view /
-- delete_grid_view are unchanged.
--
-- PHI: none (column KEYS only; never a patient value). Idempotent: ADD COLUMN IF NOT EXISTS; constraint
-- dropped+recreated; CREATE OR REPLACE for the 5-arg fn; grants reapplied. One transaction; the
-- claims_admin membership dance mirrors 0046. DEPENDENCY: 0046 (table + roles + sibling fns).

grant claims_admin to postgres;

-- 1. Column: which of `columns` are hidden. NULL = legacy row (0046 semantics); array = new format.
alter table claims.user_grid_views
  add column if not exists hidden_columns jsonb;

alter table claims.user_grid_views
  drop constraint if exists user_grid_views_hidden_arr_ck;
alter table claims.user_grid_views
  add constraint user_grid_views_hidden_arr_ck
  check (hidden_columns is null or jsonb_typeof(hidden_columns) = 'array');

-- 2. Add the 5-arg save_grid_view (keeps the 4-arg overload — see ZERO-DOWNTIME note above). ---------
-- TODO(cleanup): drop the 4-arg save_grid_view(uuid,text,jsonb,boolean) overload in a follow-up migration once the 5-arg path is confirmed stable in prod (kept only for the zero-downtime deploy window).
create or replace function claims.save_grid_view(
  p_user         uuid,
  p_name         text,
  p_columns      jsonb,
  p_hidden       jsonb,
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
  -- hidden is optional (null tolerated for safety) but, when present, must be a bounded array.
  if p_hidden is not null
     and (jsonb_typeof(p_hidden) <> 'array' or jsonb_array_length(p_hidden) > 64) then
    raise exception 'save_grid_view: hidden must be a <=64-element array' using errcode = 'check_violation';
  end if;

  if coalesce(p_make_default, false) then
    update claims.user_grid_views
       set is_default = false, updated_at = now()
     where app_user_id = p_user and is_default;
  end if;

  insert into claims.user_grid_views (app_user_id, view_name, columns, hidden_columns, is_default)
  values (p_user, p_name, p_columns, coalesce(p_hidden, '[]'::jsonb), coalesce(p_make_default, false))
  on conflict (app_user_id, view_name) do update
     set columns        = excluded.columns,
         hidden_columns = excluded.hidden_columns,
         is_default     = case when coalesce(p_make_default, false) then true
                               else claims.user_grid_views.is_default end,
         updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;

alter function claims.save_grid_view(uuid, text, jsonb, jsonb, boolean) owner to claims_admin;
revoke execute on function claims.save_grid_view(uuid, text, jsonb, jsonb, boolean) from public, anon, authenticated;
grant  execute on function claims.save_grid_view(uuid, text, jsonb, jsonb, boolean) to claims_reader;

revoke claims_admin from postgres;
