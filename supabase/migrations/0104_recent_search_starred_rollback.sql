-- 0104 rollback — remove starred saved searches; restore the 0097 definer bodies verbatim.
--
-- Order matters: the 6-param recorder overload and the star toggle must drop BEFORE the columns
-- they reference. Restoring the 4-param recorder/clear bodies to their 0097 text removes the
-- starred-aware prune/clear so the column drop leaves no dangling reference.

set role claims_admin;

-- 1. Drop the 0104-only functions.
drop function if exists claims.set_qualify_search_starred(uuid, bigint, boolean);
drop function if exists claims.record_qualify_recent_search(uuid, text, text, text, text, boolean);

-- 2. Restore the 0097 bodies verbatim.
create or replace function claims.record_qualify_recent_search(
  p_user  uuid,
  p_payer text,
  p_echo  text,
  p_plan  text
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null then
    raise exception 'record_qualify_recent_search: user required' using errcode = 'check_violation';
  end if;
  if p_echo is not null and p_echo !~ '^[A-Z0-9]{1,3}$' then
    raise exception 'record_qualify_recent_search: echo must be <=3 chars [A-Z0-9]' using errcode = 'check_violation';
  end if;
  if p_payer is not null and char_length(p_payer) not between 1 and 120 then
    raise exception 'record_qualify_recent_search: invalid payer label' using errcode = 'check_violation';
  end if;
  if p_plan is not null and char_length(p_plan) not between 1 and 40 then
    raise exception 'record_qualify_recent_search: invalid plan class' using errcode = 'check_violation';
  end if;

  insert into claims.qualify_recent_search (app_user_id, payer_label, prefix_echo, plan_class)
  values (p_user, p_payer, p_echo, p_plan);

  delete from claims.qualify_recent_search
   where app_user_id = p_user
     and id not in (
       select id from claims.qualify_recent_search
        where app_user_id = p_user
        order by searched_at desc, id desc
        limit 20
     );
end;
$$;

create or replace function claims.clear_qualify_recent_searches(p_user uuid)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null then
    raise exception 'clear_qualify_recent_searches: user required' using errcode = 'check_violation';
  end if;
  delete from claims.qualify_recent_search where app_user_id = p_user;
end;
$$;

alter function claims.record_qualify_recent_search(uuid, text, text, text) owner to claims_admin;
alter function claims.clear_qualify_recent_searches(uuid)                  owner to claims_admin;
revoke execute on function claims.record_qualify_recent_search(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function claims.record_qualify_recent_search(uuid, text, text, text) to claims_reader;
revoke execute on function claims.clear_qualify_recent_searches(uuid) from public, anon, authenticated;
grant  execute on function claims.clear_qualify_recent_searches(uuid) to claims_reader;

-- 3. Drop the columns (constraint drops with its column).
alter table claims.qualify_recent_search drop column if exists resolved;
alter table claims.qualify_recent_search drop column if exists entity_type;
alter table claims.qualify_recent_search drop column if exists starred;

reset role;
