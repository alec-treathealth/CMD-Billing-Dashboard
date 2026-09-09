-- 0110 ROLLBACK — reverses 0110_ar_claim_note_patient_level.sql.
-- ⚠ Fails if patient-level notes (cmd_claim_id IS NULL) exist: delete them first, deliberately, or
--   do not roll back. Restores 0109's ar_add_note (no cmd_patient_id stamp).
set role claims_admin;
drop index if exists claims.ar_claim_note_patient_idx;
alter table claims.ar_claim_note drop constraint if exists ar_claim_note_target_ck;
alter table claims.ar_claim_note alter column cmd_claim_id set not null;
alter table claims.ar_claim_note drop column if exists cmd_patient_id;
create or replace function claims.ar_add_note(p_user uuid, p_email text, p_entity uuid, p_claim text, p_note_enc bytea)
returns bigint language plpgsql security definer set search_path = claims, pg_catalog as $$
declare v_id bigint; v_customer text;
begin
  if p_user is null or p_email is null or char_length(p_email) not between 3 and 320 or p_entity is null then raise exception 'ar_add_note: actor and entity required' using errcode = 'check_violation'; end if;
  if p_claim is null or p_claim !~ '^[0-9]{1,20}$' then raise exception 'ar_add_note: claim id must be a CMD numeric id' using errcode = 'check_violation'; end if;
  if p_note_enc is null or octet_length(p_note_enc) < 41 or octet_length(p_note_enc) > 16384 then raise exception 'ar_add_note: note ciphertext out of bounds' using errcode = 'check_violation'; end if;
  select cmd_customer_id into v_customer from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim;
  if v_customer is null then raise exception 'ar_add_note: unknown claim' using errcode = 'check_violation'; end if;
  insert into claims.ar_claim_note (business_entity_id, cmd_customer_id, cmd_claim_id, source, cmd_note_id, author_label, author_user_id, note_enc, note_type, noted_at)
  values (p_entity, v_customer, p_claim, 'user', null, lower(p_email), p_user, p_note_enc, null, now()) returning id into v_id;
  insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value, detail)
  values (p_entity, p_claim, 'note', p_user, lower(p_email), null, null, jsonb_build_object('note_id', v_id));
  return v_id;
end; $$;
reset role;
