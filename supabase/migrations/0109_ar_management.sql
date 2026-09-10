-- 0109 — AR Management plane: claims.ar_* — the snapshot-fed aged-AR queue, its notes,
--        dispositions, event log and notification cursor.
--
-- WHY: the Claims Desk tab becomes AR MANAGEMENT (Alec, 2026-09-09): one live, claim-grain queue
--   of every open charge across every BXR facility, organised by age band (31–60d … 1–2yr), with
--   CMD's follow-up notes, the denial reasoning (CAS codes + payer/clearinghouse status history),
--   in-app notes and work dispositions, and a super-admin notification feed for every change.
--   The feed is the CMD V2 DATA SNAPSHOT (`GET /v2/customer/{c}/snapshot`) — a full per-customer
--   extract that returns 200 for 19 of BXR's 20 accounts (probed 2026-09-09; the account-level
--   endpoint for 475729 is 404 and the billing umbrella 10030472 is 401). It carries every table
--   the AR report (10051337) and the audit reports carry, plus B_PATNOTES (rep notes),
--   B_REMITTANCE (CAS at charge grain), B_CLAIMSTATUS (277/payer status history), B_ACTIVITY
--   (submission history incl. 835 CLP02) and B_CLAIM.FOLLOWUP/CTRLNO1 — so no CBI report slot is
--   consumed and the queue is not filter-limited.
--   MEASURED at recon (CAMH 10027973): 13,001 charges / 12,090 claims / 4,849 open charges =
--   $5.78M open; all 19 accounts ≈ 40k open charges ≈ $52M. B_CHARGE.STATUS is set on only ~5% of
--   charges: CMD's "CLAIM AT <payer>" display status is DERIVED (arSnapshotMap.ts documents the
--   verified rule) and stored here as status_raw / status_category via the shared normalizeStatus
--   taxonomy, so status_category means the same thing it means on claims.audit_row.
--
-- PHI DISCIPLINE (root CLAUDE.md, Standing rules): patient name / DOB / member id live ONLY on
--   claims.ar_patient as libsodium ciphertext (nonce‖ct) with keyed-HMAC blind indexes (0036
--   construction) — the claim and charge fact tables carry the opaque CMD ids only, so a queue
--   page never selects a PHI column. Free-text notes (CMD-imported and in-app) are libsodium
--   ciphertext in ar_claim_note.note_enc: rep notes routinely carry incidental PHI (the AR Build
--   Doc's cmd_ar_note ruling), so they are encrypted at rest and never searchable. denial_summary
--   and ar_claim_event.detail are PHI-FREE by contract (codes, counts, amounts, ids). Payer
--   status messages (ar_claim_status_event.status_message) are payer/clearinghouse boilerplate,
--   truncated to 300 chars at ingest — the same class of operational text as audit_row's
--   charge_status_raw, not a patient identifier.
--
-- OWNERSHIP: claims_admin owns every table and function (claims plane — `set role claims_admin`,
--   the 0049/0053/0097 posture; NOT the collections plane's postgres ownership).
--   Ingest writes as the existing least-privilege claims_audit_writer (0049) under GUC-scoped RLS
--   through withTenant(); human writes only through the three SECURITY DEFINER functions below,
--   EXECUTE to claims_reader (0097 pattern — the actor id is server-resolved, never client input);
--   reads as claims_reader with permissive SELECT policies + the app-layer tenant WHERE (R1).
--
-- IDEMPOTENT: IF NOT EXISTS on tables/indexes; DROP POLICY IF EXISTS before CREATE POLICY;
--   CREATE OR REPLACE functions; grants re-asserted. Never DROP ROLE. Safe to re-run.
-- DEPENDENCY: 0049 (claims_audit_writer + schema usage), 0025 (claims.app_user), 014
--   (core.business_entity). Applied AFTER 0108 (live ledger max at authoring, 2026-09-09).
-- Rollback: 0109_ar_management_rollback.sql

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠ RETENTION: THIS PLANE KEEPS PHI FOREVER UNLESS SOMEONE REMOVES IT.
--
-- There is no `delete` anywhere in the AR write path. A claim that leaves CMD's snapshot is marked
-- in_latest_snapshot = false and KEPT — surfacing claims CMD stopped reporting is the point of the
-- queue. So when a facility offboards, its patients' names, DOBs and member ids stay in
-- claims.ar_patient indefinitely, and there is no per-patient path for an amendment or a records
-- request. The rollback script drops the plane for ALL accounts and is not that path.
--
-- RETENTION WINDOW, RULED BY ALEC 2026-09-10: keep non-current rows 24 months from last_seen_at;
-- purge an offboarded facility within 90 days of its removal from AR_SNAPSHOT_CUSTOMERS. Nothing
-- enforces this automatically and nothing should — the purge is run by a human at offboarding.
-- The per-facility purge statements,
-- their dependency order, and the two traps that make a naive purge wrong — ar_patient is unique per
-- TENANT so it must not be deleted by customer, and notes are patient-level so a claim-only delete
-- leaves the bodies behind — are in .claude/rules/billing-audit.md under
-- "PHI retention and removal". Read that before writing a purge.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

set role claims_admin;

-- 1. Run log ------------------------------------------------------------------------------
create table if not exists claims.ar_snapshot_run (
  id                     bigint generated always as identity primary key,
  business_entity_id     uuid not null references core.business_entity (id) on delete restrict,
  cmd_customer_id        text not null,
  facility_code          text not null,
  status                 text not null default 'running'
                           check (status in ('running', 'ok', 'empty', 'error', 'not_configured', 'unauthorized')),
  error_label            text,                       -- fixed PHI-safe token only (fetch_failed / parse_failed / write_failed)
  writer_user            text not null,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  zip_bytes              int,
  snapshot_as_of         timestamptz,                -- max(B_CHARGE.LASTUPDATE) in the file — the data's own as-of
  claims_seen            int not null default 0,
  charges_seen           int not null default 0,
  patients_upserted      int not null default 0,
  claims_upserted        int not null default 0,
  charges_upserted       int not null default 0,
  remits_upserted        int not null default 0,
  status_events_upserted int not null default 0,
  notes_inserted         int not null default 0,
  created_at             timestamptz not null default now()
);
create index if not exists ar_snapshot_run_recent_idx
  on claims.ar_snapshot_run (business_entity_id, cmd_customer_id, finished_at desc);

-- 2. Patient dimension (THE PHI TABLE) ------------------------------------------------------
create table if not exists claims.ar_patient (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_customer_id         text not null,
  cmd_patient_id          text not null,
  patient_name_enc        bytea not null,           -- PHI: libsodium ciphertext (nonce‖ct)
  patient_name_bidx       text,                     -- keyed-HMAC hex (0036 construction)
  patient_name_pfx3_bidx  text,                     -- keyed-HMAC hex of the first-3-chars prefix
  patient_dob_enc         bytea,                    -- PHI
  member_id_enc           bytea,                    -- PHI
  member_id_bidx          text,
  member_id_pfx3_bidx     text,
  primary_payer_name      text,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  unique (business_entity_id, cmd_patient_id)
);
create index if not exists ar_patient_name_bidx_idx on claims.ar_patient (business_entity_id, patient_name_bidx);
create index if not exists ar_patient_name_pfx3_idx on claims.ar_patient (business_entity_id, patient_name_pfx3_bidx);
create index if not exists ar_patient_member_bidx_idx on claims.ar_patient (business_entity_id, member_id_bidx);

-- 3. Claim fact — the queue row (PHI-FREE: opaque CMD ids only) ------------------------------
create table if not exists claims.ar_claim (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_customer_id         text not null,
  facility_code           text not null,
  facility_name           text,
  cmd_claim_id            text not null,
  cmd_patient_id          text not null,
  claim_type              text,                     -- I (institutional) / P (professional)
  claim_frequency         text,                     -- 1 / 7 (corrected) / 8 (void)
  type_of_bill            text,
  admit_date              date,
  discharge_date          date,
  dos_from                date,
  dos_to                  date,
  entered_at              timestamptz,
  first_bill_date         date,
  last_bill_date          date,
  line_count              int not null default 0,
  open_line_count         int not null default 0,
  total_charges           numeric(12,2) not null default 0,
  ins_paid                numeric(12,2) not null default 0,
  pat_paid                numeric(12,2) not null default 0,
  adjustments             numeric(12,2) not null default 0,
  balance                 numeric(12,2) not null default 0,
  balance_due_to          text,                     -- I / P / O from the largest open line
  primary_payer_name      text,
  current_payer_name      text,
  current_payer_level     smallint,
  payer_type              text,
  cmd_status_text         text,                     -- the hand-applied CMD status, when set
  status_raw              text not null,            -- CMD's display status (derived; see arSnapshotMap.ts)
  status_category         text not null check (status_category in
    ('PAID', 'BALANCE_DUE_PATIENT', 'AT_PAYER', 'APPROVED_HIGHER',
     'NEEDS_RENEGOTIATING', 'ON_HOLD', 'OTHER')),
  status_payer            text,
  auth_number             text,
  payer_claim_control_no  text,
  cmd_followup_date       date,
  cpt_codes               text[] not null default '{}',
  rev_codes               text[] not null default '{}',
  last_835_status         text,                     -- CLP02 of the latest submission that got an 835
  last_835_date           date,
  last_activity_date      date,
  last_error_code         text,
  last_error_message      text,                     -- payer/clearinghouse boilerplate, ≤300 chars
  last_error_at           timestamptz,
  last_error_receiver     text,
  denial_summary          jsonb not null default '[]'::jsonb,  -- PHI-FREE: [{g, c, amt, n}]
  has_denial              boolean not null default false,
  cmd_note_count          int not null default 0,
  last_cmd_note_at        timestamptz,
  ins_last_payment_date   date,
  in_latest_snapshot      boolean not null default true,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  last_run_id             bigint,                   -- soft ref to ar_snapshot_run.id (no FK on the hot path, 0058 pattern)
  unique (business_entity_id, cmd_claim_id)
);
create index if not exists ar_claim_balance_idx    on claims.ar_claim (business_entity_id, balance desc, id desc);
create index if not exists ar_claim_dos_idx        on claims.ar_claim (business_entity_id, dos_from);
create index if not exists ar_claim_facility_idx   on claims.ar_claim (business_entity_id, facility_code);
create index if not exists ar_claim_status_idx     on claims.ar_claim (business_entity_id, status_category);
create index if not exists ar_claim_payer_idx      on claims.ar_claim (business_entity_id, current_payer_name);
create index if not exists ar_claim_patient_idx    on claims.ar_claim (business_entity_id, cmd_patient_id);
create index if not exists ar_claim_customer_run_idx on claims.ar_claim (business_entity_id, cmd_customer_id, last_run_id);

-- 4. Charge lines (PHI-FREE) ------------------------------------------------------------------
create table if not exists claims.ar_charge (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_customer_id         text not null,
  cmd_charge_id           text not null,
  cmd_claim_id            text not null,
  cmd_patient_id          text not null,
  dos_from                date,
  dos_to                  date,
  cpt_code                text,
  modifiers               text,
  rev_code                text,
  units                   numeric,
  charge_amount           numeric(12,2) not null default 0,
  allowed                 numeric(12,2),
  ins_paid                numeric(12,2) not null default 0,
  pat_paid                numeric(12,2) not null default 0,
  adjustments             numeric(12,2) not null default 0,
  balance                 numeric(12,2) not null default 0,
  balance_due_to          text,
  bill_to                 text,
  cmd_status_text         text,
  status_raw              text not null,
  status_category         text not null,
  status_payer            text,
  first_bill_date         date,
  last_bill_date          date,
  ins_last_payment_date   date,
  entered_at              timestamptz,
  in_latest_snapshot      boolean not null default true,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  unique (business_entity_id, cmd_charge_id)
);
create index if not exists ar_charge_claim_idx on claims.ar_charge (business_entity_id, cmd_claim_id);
create index if not exists ar_charge_customer_seen_idx on claims.ar_charge (business_entity_id, cmd_customer_id, last_seen_at);

-- 5. Remittance adjustments / remarks — the denial reasoning (PHI-FREE) -----------------------
create table if not exists claims.ar_remit (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_remit_id            text not null,
  cmd_claim_id            text not null,
  cmd_charge_id           text not null,
  kind                    text not null check (kind in ('A', 'R')),   -- A = CAS adjustment, R = remark code
  group_code              text,                                       -- CO / PR / PI / OA
  code                    text not null,                              -- CARC (A) or RARC (R)
  amount                  numeric(12,2),                              -- signed; null on remarks
  is_denial               boolean not null default false,
  is_adjustment           boolean not null default false,
  payer_name              text,
  payer_level             smallint,
  received_date           date,
  unique (business_entity_id, cmd_remit_id)
);
create index if not exists ar_remit_claim_idx on claims.ar_remit (business_entity_id, cmd_claim_id);

-- 6. Claim status history — clearinghouse / payer responses ------------------------------------
create table if not exists claims.ar_claim_status_event (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_status_id           text not null,
  cmd_claim_id            text not null,
  status_type             text not null,             -- INFO / WARNING / ERROR
  status_date             timestamptz,
  status_code             text,
  status_message          text,                      -- boilerplate, ≤300 chars at ingest
  action_code             text,
  action_message          text,
  receiver_name           text,
  err_fixed               text,
  unique (business_entity_id, cmd_status_id)
);
create index if not exists ar_claim_status_event_claim_idx
  on claims.ar_claim_status_event (business_entity_id, cmd_claim_id, status_date desc);

-- 7. Notes — CMD-imported + in-app, APPEND-ONLY, encrypted ------------------------------------
create table if not exists claims.ar_claim_note (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_customer_id         text not null,
  cmd_claim_id            text not null,
  source                  text not null check (source in ('cmd', 'user')),
  cmd_note_id             text,                      -- B_PATNOTES.SEQNO for source='cmd'; null for 'user'
  author_label            text not null check (char_length(author_label) between 1 and 120),
  author_user_id          uuid,                      -- set for source='user'
  note_enc                bytea not null,            -- PHI: libsodium ciphertext (nonce‖ct)
  note_type               text,
  noted_at                timestamptz not null,
  created_at              timestamptz not null default now(),
  constraint ar_claim_note_source_ck check (
    (source = 'cmd' and cmd_note_id is not null) or (source = 'user' and author_user_id is not null)
  )
);
create unique index if not exists ar_claim_note_cmd_uq
  on claims.ar_claim_note (business_entity_id, cmd_note_id) where cmd_note_id is not null;
create index if not exists ar_claim_note_claim_idx
  on claims.ar_claim_note (business_entity_id, cmd_claim_id, noted_at desc);
create index if not exists ar_claim_note_customer_idx
  on claims.ar_claim_note (business_entity_id, cmd_customer_id, source);

-- 8. Work disposition — owned by humans, never by the ingest ----------------------------------
create table if not exists claims.ar_claim_work (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_claim_id            text not null,
  work_status             text not null default 'open'
                            check (work_status in ('open', 'in_progress', 'waiting_payer', 'appeal', 'resolved', 'dismissed')),
  assignee_user_id        uuid,
  assignee_email          text check (assignee_email is null or char_length(assignee_email) between 3 and 320),
  due_on                  date,
  resolution_code         text check (resolution_code is null or char_length(resolution_code) between 1 and 60),
  updated_by_user_id      uuid not null,
  updated_by_email        text not null,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  unique (business_entity_id, cmd_claim_id)
);
create index if not exists ar_claim_work_status_idx   on claims.ar_claim_work (business_entity_id, work_status);
create index if not exists ar_claim_work_assignee_idx on claims.ar_claim_work (business_entity_id, assignee_user_id);

-- 9. Event log — every human transition; the notification feed (PHI-FREE detail) -------------
create table if not exists claims.ar_claim_event (
  id                      bigint generated always as identity primary key,
  business_entity_id      uuid not null references core.business_entity (id) on delete restrict,
  cmd_claim_id            text not null,
  event_type              text not null check (event_type in ('note', 'status', 'assign', 'due', 'resolution')),
  actor_user_id           uuid not null,
  actor_email             text not null,
  from_value              text,
  to_value                text,
  detail                  jsonb not null default '{}'::jsonb,  -- PHI-FREE
  created_at              timestamptz not null default now()
);
create index if not exists ar_claim_event_recent_idx on claims.ar_claim_event (business_entity_id, created_at desc);
create index if not exists ar_claim_event_claim_idx  on claims.ar_claim_event (business_entity_id, cmd_claim_id, created_at desc);

-- 10. Notification cursor — one row per user -------------------------------------------------
create table if not exists claims.ar_notification_seen (
  app_user_id   uuid primary key references claims.app_user (user_id) on delete cascade,
  last_seen_at  timestamptz not null default now()
);

-- 11. Grants ------------------------------------------------------------------------------
revoke all on claims.ar_snapshot_run, claims.ar_patient, claims.ar_claim, claims.ar_charge,
              claims.ar_remit, claims.ar_claim_status_event, claims.ar_claim_note,
              claims.ar_claim_work, claims.ar_claim_event, claims.ar_notification_seen
  from public, anon, authenticated, service_role, claims_audit_writer, claims_reader;

grant select, insert, update on claims.ar_snapshot_run        to claims_audit_writer;
grant select, insert, update on claims.ar_patient             to claims_audit_writer;
grant select, insert, update on claims.ar_claim               to claims_audit_writer;
grant select, insert, update on claims.ar_charge              to claims_audit_writer;
grant select, insert, update on claims.ar_remit               to claims_audit_writer;
grant select, insert, update on claims.ar_claim_status_event  to claims_audit_writer;
-- Notes are append-only for EVERY non-owner: the ingest inserts CMD notes (and reads the conflict
-- key — ON CONFLICT needs SELECT, the 0106 lesson); nobody but the owner can UPDATE or DELETE.
grant select, insert         on claims.ar_claim_note          to claims_audit_writer;

grant select on claims.ar_snapshot_run, claims.ar_patient, claims.ar_claim, claims.ar_charge,
                claims.ar_remit, claims.ar_claim_status_event, claims.ar_claim_note,
                claims.ar_claim_work, claims.ar_claim_event, claims.ar_notification_seen
  to claims_reader;

do $$
declare seq text; t text;
begin
  foreach t in array array['claims.ar_snapshot_run', 'claims.ar_patient', 'claims.ar_claim', 'claims.ar_charge',
                           'claims.ar_remit', 'claims.ar_claim_status_event', 'claims.ar_claim_note'] loop
    seq := pg_get_serial_sequence(t, 'id');
    if seq is not null then
      execute format('grant usage, select on sequence %s to claims_audit_writer', seq);
    end if;
  end loop;
end $$;

-- 12. RLS — reader permissive (R1: app-layer tenant WHERE); writer GUC-checked (0033/0049) ----
alter table claims.ar_snapshot_run        enable row level security;
alter table claims.ar_patient             enable row level security;
alter table claims.ar_claim               enable row level security;
alter table claims.ar_charge              enable row level security;
alter table claims.ar_remit               enable row level security;
alter table claims.ar_claim_status_event  enable row level security;
alter table claims.ar_claim_note          enable row level security;
alter table claims.ar_claim_work          enable row level security;
alter table claims.ar_claim_event         enable row level security;
alter table claims.ar_notification_seen   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ar_snapshot_run', 'ar_patient', 'ar_claim', 'ar_charge',
                           'ar_remit', 'ar_claim_status_event', 'ar_claim_note',
                           'ar_claim_work', 'ar_claim_event', 'ar_notification_seen'] loop
    execute format('drop policy if exists %I on claims.%I', t || '_reader_select', t);
    execute format('create policy %I on claims.%I for select to claims_reader using (true)', t || '_reader_select', t);
  end loop;
  -- Writer: select / insert / update, all pinned to the transaction GUC (1-arg current_setting RAISES when unset).
  foreach t in array array['ar_snapshot_run', 'ar_patient', 'ar_claim', 'ar_charge', 'ar_remit', 'ar_claim_status_event'] loop
    execute format('drop policy if exists %I on claims.%I', t || '_writer_select', t);
    execute format('create policy %I on claims.%I for select to claims_audit_writer using (business_entity_id = current_setting(''app.business_entity_id'')::uuid)', t || '_writer_select', t);
    execute format('drop policy if exists %I on claims.%I', t || '_writer_insert', t);
    execute format('create policy %I on claims.%I for insert to claims_audit_writer with check (business_entity_id = current_setting(''app.business_entity_id'')::uuid)', t || '_writer_insert', t);
    execute format('drop policy if exists %I on claims.%I', t || '_writer_update', t);
    execute format('create policy %I on claims.%I for update to claims_audit_writer using (business_entity_id = current_setting(''app.business_entity_id'')::uuid) with check (business_entity_id = current_setting(''app.business_entity_id'')::uuid)', t || '_writer_update', t);
  end loop;
end $$;

drop policy if exists ar_claim_note_writer_select on claims.ar_claim_note;
create policy ar_claim_note_writer_select on claims.ar_claim_note
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists ar_claim_note_writer_insert on claims.ar_claim_note;
create policy ar_claim_note_writer_insert on claims.ar_claim_note
  for insert to claims_audit_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid and source = 'cmd');

-- 13. Human write path — SECURITY DEFINER, claims_admin-owned, EXECUTE to claims_reader --------
-- The Server Action authenticates, resolves ITS OWN uid/email and the RBAC-clamped tenant, and
-- passes them here; shape and bounds are enforced here. The owner bypasses the RLS above.

-- 13a. Add an in-app note (already encrypted by the caller) + its event.
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
begin
  if p_user is null or p_email is null or char_length(p_email) not between 3 and 320 or p_entity is null then
    raise exception 'ar_add_note: actor and entity required' using errcode = 'check_violation';
  end if;
  if p_claim is null or p_claim !~ '^[0-9]{1,20}$' then
    raise exception 'ar_add_note: claim id must be a CMD numeric id' using errcode = 'check_violation';
  end if;
  -- nonce (24) + MAC (16) + at least one byte of ciphertext; 16 KB ceiling on the ciphertext.
  if p_note_enc is null or octet_length(p_note_enc) < 41 or octet_length(p_note_enc) > 16384 then
    raise exception 'ar_add_note: note ciphertext out of bounds' using errcode = 'check_violation';
  end if;
  select cmd_customer_id into v_customer
    from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim;
  if v_customer is null then
    raise exception 'ar_add_note: unknown claim' using errcode = 'check_violation';
  end if;

  insert into claims.ar_claim_note
    (business_entity_id, cmd_customer_id, cmd_claim_id, source, cmd_note_id, author_label, author_user_id, note_enc, note_type, noted_at)
  values (p_entity, v_customer, p_claim, 'user', null, lower(p_email), p_user, p_note_enc, null, now())
  returning id into v_id;

  insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value, detail)
  values (p_entity, p_claim, 'note', p_user, lower(p_email), null, null, jsonb_build_object('note_id', v_id));
  return v_id;
end;
$$;

-- 13b. Set the work disposition; one event per field that actually changed.
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
  v_old claims.ar_claim_work%rowtype;
  v_had boolean;
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
  if p_resolution is not null and char_length(p_resolution) not between 1 and 60 then
    raise exception 'ar_set_work: invalid resolution code' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from claims.ar_claim where business_entity_id = p_entity and cmd_claim_id = p_claim) then
    raise exception 'ar_set_work: unknown claim' using errcode = 'check_violation';
  end if;

  select * into v_old from claims.ar_claim_work where business_entity_id = p_entity and cmd_claim_id = p_claim;
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

  if (not v_had and p_status <> 'open') or (v_had and v_old.work_status is distinct from p_status) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'status', p_user, lower(p_email), case when v_had then v_old.work_status else 'open' end, p_status);
  end if;
  if (not v_had and p_assignee_email is not null) or (v_had and v_old.assignee_email is distinct from lower(p_assignee_email)) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'assign', p_user, lower(p_email), case when v_had then v_old.assignee_email end, lower(p_assignee_email));
  end if;
  if (not v_had and p_due is not null) or (v_had and v_old.due_on is distinct from p_due) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'due', p_user, lower(p_email), case when v_had then v_old.due_on::text end, p_due::text);
  end if;
  if (not v_had and p_resolution is not null) or (v_had and v_old.resolution_code is distinct from p_resolution) then
    insert into claims.ar_claim_event (business_entity_id, cmd_claim_id, event_type, actor_user_id, actor_email, from_value, to_value)
    values (p_entity, p_claim, 'resolution', p_user, lower(p_email), case when v_had then v_old.resolution_code end, p_resolution);
  end if;
end;
$$;

-- 13c. Move the caller's notification cursor to now.
create or replace function claims.ar_mark_notifications_seen(p_user uuid)
returns void
language plpgsql
security definer
set search_path = claims, pg_catalog
as $$
begin
  if p_user is null then
    raise exception 'ar_mark_notifications_seen: user required' using errcode = 'check_violation';
  end if;
  insert into claims.ar_notification_seen (app_user_id, last_seen_at)
  values (p_user, now())
  on conflict (app_user_id) do update set last_seen_at = now();
end;
$$;

alter function claims.ar_add_note(uuid, text, uuid, text, bytea)                                   owner to claims_admin;
alter function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text)             owner to claims_admin;
alter function claims.ar_mark_notifications_seen(uuid)                                             owner to claims_admin;

revoke execute on function claims.ar_add_note(uuid, text, uuid, text, bytea)                       from public, anon, authenticated;
grant  execute on function claims.ar_add_note(uuid, text, uuid, text, bytea)                       to claims_reader;
revoke execute on function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text) from public, anon, authenticated;
grant  execute on function claims.ar_set_work(uuid, text, uuid, text, text, uuid, text, date, text) to claims_reader;
revoke execute on function claims.ar_mark_notifications_seen(uuid)                                 from public, anon, authenticated;
grant  execute on function claims.ar_mark_notifications_seen(uuid)                                 to claims_reader;

reset role;

-- 14. Verification (run manually after apply) --------------------------------------------------
-- select has_table_privilege('claims_audit_writer', 'claims.ar_claim', 'INSERT');        -- t
-- select has_table_privilege('claims_audit_writer', 'claims.ar_claim_note', 'UPDATE');   -- f
-- select has_table_privilege('claims_reader', 'claims.ar_claim', 'SELECT');              -- t
-- select has_table_privilege('claims_reader', 'claims.ar_claim_note', 'INSERT');         -- f
-- select has_function_privilege('claims_reader', 'claims.ar_add_note(uuid,text,uuid,text,bytea)', 'EXECUTE');  -- t
-- select has_function_privilege('public', 'claims.ar_add_note(uuid,text,uuid,text,bytea)', 'EXECUTE');         -- f
-- select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'claims' and relname like 'ar\_%' order by 1;                     -- all t
-- select count(*) from pg_policies where schemaname = 'claims' and tablename like 'ar\_%'; -- 10 reader + 18 writer + 2 note = 30
-- select pg_has_role('postgres', 'claims_admin', 'SET');                                 -- t (the standing apply grant is intact)
