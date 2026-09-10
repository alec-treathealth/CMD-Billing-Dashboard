-- 0111 ROLLBACK — restores 0109's ar_set_work (SELECT * into a %rowtype; no assignee existence check).
-- Behaviourally equivalent for valid inputs; kept so the ledger can be walked back statement-for-statement.
set role claims_admin;
create or replace function claims.ar_set_work(p_user uuid, p_email text, p_entity uuid, p_claim text, p_status text, p_assignee_user uuid, p_assignee_email text, p_due date, p_resolution text)
returns void language plpgsql security definer set search_path = claims, pg_catalog as $$
declare v_old claims.ar_claim_work%rowtype; v_had boolean;
begin
  if p_user is null or p_email is null or char_length(p_email) not between 3 and 320 or p_entity is null then raise exception 'ar_set_work: actor and entity required' using errcode = 'check_violation'; end if;
  if p_claim is null or p_claim !~ '^[0-9]{1,20}$' then raise exception 'ar_set_work: claim id must be a CMD numeric id' using errcode = 'check_violation'; end if;
  if p_status is null or p_status not in ('open', 'in_progress', 'waiting_payer', 'appeal', 'resolved', 'dismissed') then raise exception 'ar_set_work: invalid work status' using errcode = 'check_violation'; end if;
  if (p_assignee_user is null) <> (p_assignee_email is null) then raise exception 'ar_set_work: assignee id and email must be set together' using errcode = 'check_violation'; end if;
  if p_assignee_email is not null and char_length(p_assignee_email) not between 3 and 320 then raise exception 'ar_set_work: invalid assignee email' using errcode = 'check_violation'; end if;
  if p_resolution is not null and char_length(p_resolution) not between 1 and 60 then raise exception 'ar_set_work: invalid resolution code' using errcode = 'check_violation'; end if;
  if not exists (select 1 from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim) then raise exception 'ar_set_work: unknown claim' using errcode = 'check_violation'; end if;
  select * into v_old from claims.ar_claim_work where business_entity_id = p_entity and cmd_claim_id = p_claim; v_had := found;
  insert into claims.ar_claim_work (business_entity_id, cmd_claim_id, work_status, assignee_user_id, assignee_email, due_on, resolution_code, updated_by_user_id, updated_by_email)
  values (p_entity, p_claim, p_status, p_assignee_user, lower(p_assignee_email), p_due, p_resolution, p_user, lower(p_email))
  on conflict (business_entity_id, cmd_claim_id) do update set work_status = excluded.work_status, assignee_user_id = excluded.assignee_user_id, assignee_email = excluded.assignee_email, due_on = excluded.due_on, resolution_code = excluded.resolution_code, updated_by_user_id = excluded.updated_by_user_id, updated_by_email = excluded.updated_by_email, updated_at = now();
  if (not v_had and p_status <> 'open') or (v_had and v_old.work_status is distinct from p_status) then insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value) values (p_entity, p_claim, 'status', p_user, lower(p_email), case when v_had then v_old.work_status else 'open' end, p_status); end if;
  if (not v_had and p_assignee_email is not null) or (v_had and v_old.assignee_email is distinct from lower(p_assignee_email)) then insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value) values (p_entity, p_claim, 'assign', p_user, lower(p_email), case when v_had then v_old.assignee_email end, lower(p_assignee_email)); end if;
  if (not v_had and p_due is not null) or (v_had and v_old.due_on is distinct from p_due) then insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value) values (p_entity, p_claim, 'due', p_user, lower(p_email), case when v_had then v_old.due_on::text end, p_due::text); end if;
  if (not v_had and p_resolution is not null) or (v_had and v_old.resolution_code is distinct from p_resolution) then insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value) values (p_entity, p_claim, 'resolution', p_user, lower(p_email), case when v_had then v_old.resolution_code end, p_resolution); end if;
end; $$;
reset role;
