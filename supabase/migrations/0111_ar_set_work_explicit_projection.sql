-- 0111 — ar_set_work: explicit projection (no SELECT *) + the assignee must be a staff app_user.
--
-- WHY: Qodo #348 round 1, findings 3 + 5. 0109's ar_set_work read its prior row with `select *` into
--   a %rowtype although the event logic compares four columns — a later column addition would
--   silently widen a runtime definer's projection (root CLAUDE.md standing rule: never SELECT *). And
--   the definer accepted any (uuid, email) pair for the assignee; the Server Action now resolves the
--   assignee server-side and checks tenant membership, and this function adds the DB-side half:
--   the uuid must be an existing admin / super_admin app user (tenancy is app-layer, where the
--   tenant slug is known; the definer has only the entity uuid).
-- PHI DISCIPLINE: unchanged — no PHI column is touched.
-- OWNERSHIP: claims_admin (claims plane) — `set role claims_admin`.
-- IDEMPOTENT: CREATE OR REPLACE; grants re-asserted.
-- DEPENDENCY: 0109 (the table + function), 0025 (claims.app_user).
-- Rollback: 0111_ar_set_work_explicit_projection_rollback.sql (restores the 0109 body).

set role claims_admin;

create or replace function claims.ar_set_work(
  p_user           uuid,
  p_email          text,
  p_entity         uuid,
  p_claim          text,
  p_status         text,
  p_assignee_user  uuid,
  p_assignee_email text,
  p_due            date,
  p_resolution     text
) returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_had            boolean;
  v_old_status     text;
  v_old_assignee   text;
  v_old_due        date;
  v_old_resolution text;
begin
  if p_user is null or p_email is null or char_length(p_email) not between 3 and 320 or p_entity is null then
    raise exception 'ar_set_work: actor and entity required' using errcode = 'check_violation';
  end if;
  if p_claim is null or p_claim !~ '^[0-9]{1,20}$' then
    raise exception 'ar_set_work: claim id must be a CMD numeric id' using errcode = 'check_violation';
  end if;
  if p_status is null or p_status not in ('open', 'in_progress', 'waiting_payer', 'appeal', 'resolved', 'dismissed') then
    raise exception 'ar_set_work: invalid work status' using errcode = 'check_violation';
  end if;
  if (p_assignee_user is null) <> (p_assignee_email is null) then
    raise exception 'ar_set_work: assignee id and email must be set together' using errcode = 'check_violation';
  end if;
  if p_assignee_email is not null and char_length(p_assignee_email) not between 3 and 320 then
    raise exception 'ar_set_work: invalid assignee email' using errcode = 'check_violation';
  end if;
  if p_assignee_user is not null and not exists (
    select 1 from claims.app_user where user_id = p_assignee_user and role in ('super_admin', 'admin')
  ) then
    raise exception 'ar_set_work: assignee must be an admin or super_admin app user' using errcode = 'check_violation';
  end if;
  if p_resolution is not null and char_length(p_resolution) not between 1 and 60 then
    raise exception 'ar_set_work: invalid resolution code' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim) then
    raise exception 'ar_set_work: unknown claim' using errcode = 'check_violation';
  end if;

  select work_status, assignee_email, due_on, resolution_code
    into v_old_status, v_old_assignee, v_old_due, v_old_resolution
    from claims.ar_claim_work
   where business_entity_id = p_entity and cmd_claim_id = p_claim;
  v_had := found;

  insert into claims.ar_claim_work
    (business_entity_id, cmd_claim_id, work_status, assignee_user_id, assignee_email, due_on, resolution_code, updated_by_user_id, updated_by_email)
  values (p_entity, p_claim, p_status, p_assignee_user, lower(p_assignee_email), p_due, p_resolution, p_user, lower(p_email))
  on conflict (business_entity_id, cmd_claim_id) do update set
    work_status = excluded.work_status,
    assignee_user_id = excluded.assignee_user_id,
    assignee_email = excluded.assignee_email,
    due_on = excluded.due_on,
    resolution_code = excluded.resolution_code,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_by_email = excluded.updated_by_email,
    updated_at = now();

  if (not v_had and p_status <> 'open') or (v_had and v_old_status is distinct from p_status) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'status', p_user, lower(p_email), case when v_had then v_old_status else 'open' end, p_status);
  end if;
  if (not v_had and p_assignee_email is not null) or (v_had and v_old_assignee is distinct from lower(p_assignee_email)) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'assign', p_user, lower(p_email), case when v_had then v_old_assignee end, lower(p_assignee_email));
  end if;
  if (not v_had and p_due is not null) or (v_had and v_old_due is distinct from p_due) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'due', p_user, lower(p_email), case when v_had then v_old_due::text end, p_due::text);
  end if;
  if (not v_had and p_resolution is not null) or (v_had and v_old_resolution is distinct from p_resolution) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'resolution', p_user, lower(p_email), case when v_had then v_old_resolution end, p_resolution);
  end if;
end;
$$;

alter function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text) owner to claims_admin;
revoke execute on function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text) from public, anon, authenticated;
grant  execute on function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text) to claims_reader;

reset role;

-- Verification (run manually after apply)
-- select prosrc !~* 'select \*' as no_select_star from pg_proc where proname = 'ar_set_work';  -- t
-- select has_function_privilege('claims_reader', 'claims.ar_set_work(uuid,text,uuid,text,text,uuid,text,date,text)', 'EXECUTE'); -- t
