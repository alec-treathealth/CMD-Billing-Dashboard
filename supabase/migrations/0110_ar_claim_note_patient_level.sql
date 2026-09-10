-- 0110 — ar_claim_note: PATIENT-LEVEL CMD notes (cmd_claim_id nullable + cmd_patient_id).
--
-- WHY: measured 2026-09-09 minutes after 0109 applied and BEFORE any row landed in claims.ar_*:
--   B_PATNOTES.TYPE=0 rows carry CLAIM=0 and are PATIENT-level follow-up notes — CAMH 1,535 of
--   1,567 live notes, NASH 1,191 of 1,517 — while TYPE=2 rows carry a real B_CLAIM.SEQNO. 0109
--   required cmd_claim_id NOT NULL, which would have dropped roughly nine in ten of the rep notes the
--   AR tab exists to surface (215 of CAMH's 305 open-AR patients have them). A patient-level note
--   attaches by cmd_patient_id and renders on every one of that patient's claims; a claim-level
--   note keeps its cmd_claim_id. In-app notes (ar_add_note) stay claim-level and now also stamp the
--   patient so the two paths read the same way.
--   Filed as its own migration rather than an edit to 0109: 0109 is in the live ledger and applied
--   migrations are never edited in place (sql-migrations.md).
--
-- PHI DISCIPLINE: unchanged — note bodies stay libsodium ciphertext; cmd_patient_id is the same
--   opaque CMD key ar_claim already carries.
-- OWNERSHIP: claims_admin (claims plane) — `set role claims_admin`.
-- IDEMPOTENT: add column IF NOT EXISTS; DROP NOT NULL is idempotent; constraint dropped-then-added;
--   index IF NOT EXISTS; CREATE OR REPLACE function.
-- DEPENDENCY: 0109.
-- Rollback: 0110_ar_claim_note_patient_level_rollback.sql

set role claims_admin;

alter table claims.ar_claim_note add column if not exists cmd_patient_id text;
alter table claims.ar_claim_note alter column cmd_claim_id drop not null;
alter table claims.ar_claim_note drop constraint if exists ar_claim_note_target_ck;
alter table claims.ar_claim_note add constraint ar_claim_note_target_ck
  check (cmd_claim_id is not null or cmd_patient_id is not null);
create index if not exists ar_claim_note_patient_idx
  on claims.ar_claim_note (business_entity_id, cmd_patient_id, noted_at desc);

-- ar_add_note: identical to 0109 except it stamps cmd_patient_id from the claim.
create or replace function claims.ar_add_note(
  p_user     uuid,
  p_email    text,
  p_entity   uuid,
  p_claim    text,
  p_note_enc bytea
) returns bigint
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
declare
  v_id bigint;
  v_customer text;
  v_patient text;
begin
  if p_user is null or p_email is null or char_length(p_email) not between 3 and 320 or p_entity is null then
    raise exception 'ar_add_note: actor and entity required' using errcode = 'check_violation';
  end if;
  if p_claim is null or p_claim !~ '^[0-9]{1,20}$' then
    raise exception 'ar_add_note: claim id must be a CMD numeric id' using errcode = 'check_violation';
  end if;
  if p_note_enc is null or octet_length(p_note_enc) < 41 or octet_length(p_note_enc) > 16384 then
    raise exception 'ar_add_note: note ciphertext out of bounds' using errcode = 'check_violation';
  end if;
  select cmd_customer_id, cmd_patient_id into v_customer, v_patient
    from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim;
  if v_customer is null then
    raise exception 'ar_add_note: unknown claim' using errcode = 'check_violation';
  end if;

  insert into claims.ar_claim_note
    (business_entity_id, cmd_customer_id, cmd_claim_id, cmd_patient_id, source, cmd_note_id, author_label, author_user_id, note_enc, note_type, noted_at)
  values (p_entity, v_customer, p_claim, v_patient, 'user', null, lower(p_email), p_user, p_note_enc, null, now())
  returning id into v_id;

  insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value, detail)
  values (p_entity, p_claim, 'note', p_user, lower(p_email), null, null, jsonb_build_object('note_id', v_id));
  return v_id;
end;
$$;
alter function claims.ar_add_note(uuid, text, uuid, text, bytea) owner to claims_admin;
revoke execute on function claims.ar_add_note(uuid, text, uuid, text, bytea) from public, anon, authenticated;
grant  execute on function claims.ar_add_note(uuid, text, uuid, text, bytea) to claims_reader;

reset role;

-- Verification (run manually after apply)
-- select is_nullable from information_schema.columns where table_schema='claims' and table_name='ar_claim_note' and column_name='cmd_claim_id';  -- YES
-- select count(*) from information_schema.columns where table_schema='claims' and table_name='ar_claim_note' and column_name='cmd_patient_id'; -- 1
-- select conname from pg_constraint where conrelid = 'claims.ar_claim_note'::regclass and conname = 'ar_claim_note_target_ck';                -- 1 row
