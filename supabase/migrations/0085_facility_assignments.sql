-- 0085 — collections.facility_assignments: the append-only manual-assignment store for the
--        Facility Resolution workflow, plus its SECURITY DEFINER write function.
--
-- WHY: the deterministic engine (0086) attributes what the data can prove — measured 2026-08-04:
--   $7,472,871.90 of the $29,081,575.38 'No Facility' bucket by member inference, plus whatever
--   the tie-break and lever methods add — and leaves the residual UNRESOLVED rather than guessing.
--   The remainder (~$20.95M across 265 members with zero named-facility evidence anywhere) can
--   only be attributed by a human who knows the book. This table records those human calls with a
--   full audit trail: who, when, why, and what superseded what. Nothing here mutates ingest
--   output; cmd_explorer_rows is never touched.
--
-- GRAIN + KEY: one CURRENT assignment per charge, where "charge" is EXACTLY the 0059 rollup
--   grain — the group key of collections.cmd_explorer_charge_rollup:
--     (business_entity_id, member_id_bidx, charge_date, cpt_code, coalesce(revenue_code,''),
--      facility, charge_amount)
--   stored here with NULL-proof normalizations (cpt_key = coalesce(cpt_code,''), revenue_key =
--   coalesce(revenue_code,'')) so equality joins never silently drop NULL keys.
--   ⚠ NOT the rollup's `id`: that column is the LATEST snapshot's line id per group (0059 L136),
--   so a new snapshot for the same charge CHANGES it across refreshes. The composite is the
--   stable identity. member_id_prefix_bidx is omitted — it is functionally dependent on
--   member_id_bidx (an HMAC of a prefix of the same input), so it adds no selectivity.
--
-- SCOPE GUARD: assignments are accepted ONLY for charges whose facility_label is exactly
--   'No Facility' — the Facility Resolution workflow's population. Assigning over a REAL facility
--   label would silently fork the book's ground truth; if that is ever wanted it is a deliberate
--   future migration, not a quiet widening.
--
-- APPEND-ONLY + SUPERSESSION: assignment CONTENT is immutable. A correction INSERTS a new row and
--   stamps the old row's supersession columns. Because the one-current-per-charge partial unique
--   index is checked per statement, the write function must free the index BEFORE it can insert
--   the successor — so supersession is stamped in two steps inside ONE transaction:
--     step 1: superseded_at = now()          (old row leaves the index's WHERE clause)
--     step 2: INSERT the successor rows
--     step 3: superseded_by = successor id   (completing the pointer)
--   The immutability trigger permits EXACTLY those two transitions and nothing else; DELETE is
--   refused outright. Readers only ever see committed states, which are always fully stamped.
--   "Current" everywhere means superseded_at IS NULL.
--
-- WRITE PATH: collections.save_facility_assignments() below — SECURITY DEFINER owned by
--   claims_admin, EXECUTE granted to claims_reader ONLY (the 0047 claims.save_grid_view
--   precedent). The app-side Server Action performs the role gate (admin/super_admin) BEFORE
--   calling; the function enforces shape, bounds, vocabulary (facility_code must exist in
--   collections.facilities) and that every charge key matches a real rollup charge. Direct
--   INSERT/UPDATE/DELETE on the table are granted to NO app role.
--
-- PHI DISCIPLINE: member_id_bidx is the keyed-HMAC blind index (0036) — a non-reversible token,
--   already SELECT-visible to claims_reader on the rollup; no new exposure. No ciphertext, no
--   plaintext identifiers. `note` is operator free text: the UI labels it "no PHI", bounds it to
--   500 chars, and it is NEVER logged or echoed into error messages.
-- OWNERSHIP: table + trigger + function born owned by claims_admin via SET ROLE (the standing
--   posture for TABLES; the postgres-owned form is for the 0080/0083 matview family only).
-- IDEMPOTENT: IF NOT EXISTS on table/indexes, CREATE OR REPLACE on functions, DROP TRIGGER IF
--   EXISTS before CREATE TRIGGER, DROP POLICY IF EXISTS before CREATE POLICY, grants reapplied
--   unconditionally. Re-running converges.
-- DEPENDENCY: collections.facilities (FK target) and collections.cmd_explorer_charge_rollup
--   (existence check inside the write function). Independent of 0084. 0086 depends on THIS.
-- Rollback: 0085_facility_assignments_rollback.sql

set role claims_admin;

-- 1. Table ---------------------------------------------------------------------
create table if not exists collections.facility_assignments (
  id                 bigint generated always as identity primary key,
  business_entity_id uuid        not null,
  -- charge identity: the 0059 rollup group key, NULL-proofed
  member_id_bidx     text        not null,
  charge_date        date        not null,
  cpt_key            text        not null, -- coalesce(cpt_code, '')
  revenue_key        text        not null, -- coalesce(revenue_code, '')
  facility_label     text        not null, -- the label as ingested ('No Facility' in this workflow)
  charge_amount      numeric(12,2) not null,
  -- the human call
  facility_code      text        not null references collections.facilities(facility_code),
  note               text        not null,
  assigned_by        uuid        not null,
  assigned_by_email  text        not null,
  assigned_at        timestamptz not null default now(),
  -- supersession metadata (the ONLY mutable columns; see trigger)
  superseded_at      timestamptz,
  superseded_by      bigint      references collections.facility_assignments(id),
  constraint facility_assignments_note_ck
    check (char_length(note) between 1 and 500),
  constraint facility_assignments_email_ck
    check (char_length(assigned_by_email) between 3 and 320),
  -- a successor pointer implies the row is stamped superseded (never a dangling pointer)
  constraint facility_assignments_supersede_order_ck
    check (superseded_by is null or superseded_at is not null),
  constraint facility_assignments_sentinel_ck
    check (facility_label = 'No Facility')
);

-- One CURRENT assignment per charge. Composite leads with business_entity_id (tenancy rule).
create unique index if not exists facility_assignments_current_charge
  on collections.facility_assignments
     (business_entity_id, member_id_bidx, charge_date, cpt_key, revenue_key,
      facility_label, charge_amount)
  where superseded_at is null;

-- History lookups by charge (the UI's per-charge audit trail).
create index if not exists facility_assignments_charge_history
  on collections.facility_assignments
     (business_entity_id, member_id_bidx, charge_date, assigned_at desc);

comment on table collections.facility_assignments is
  'Append-only manual facility attributions for the Facility Resolution workflow. Content is '
  'immutable; corrections insert a superseding row and stamp superseded_at/superseded_by on the '
  'replaced row (collections.save_facility_assignments, one transaction). Current = '
  'superseded_at IS NULL.';

-- 2. Immutability trigger --------------------------------------------------------
-- Permitted UPDATE transitions, content byte-identical in both:
--   T1: superseded_at NULL -> NOT NULL (superseded_by may stay NULL — the mid-transaction state)
--   T2: superseded_at unchanged NOT NULL, superseded_by NULL -> NOT NULL (pointer completion)
-- Everything else, and every DELETE, is refused. Enforced in the database so no future code path
-- can quietly edit history.
create or replace function collections.facility_assignments_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'facility_assignments is append-only: DELETE is not permitted (id %)', old.id;
  end if;
  -- content immutability (applies to every UPDATE)
  if new.id                   is distinct from old.id
     or new.business_entity_id is distinct from old.business_entity_id
     or new.member_id_bidx    is distinct from old.member_id_bidx
     or new.charge_date       is distinct from old.charge_date
     or new.cpt_key           is distinct from old.cpt_key
     or new.revenue_key       is distinct from old.revenue_key
     or new.facility_label    is distinct from old.facility_label
     or new.charge_amount     is distinct from old.charge_amount
     or new.facility_code     is distinct from old.facility_code
     or new.note              is distinct from old.note
     or new.assigned_by       is distinct from old.assigned_by
     or new.assigned_by_email is distinct from old.assigned_by_email
     or new.assigned_at       is distinct from old.assigned_at then
    raise exception 'facility_assignments: content is immutable (id %)', old.id;
  end if;
  -- T1
  if old.superseded_at is null then
    if new.superseded_at is null then
      raise exception 'facility_assignments: UPDATE may only stamp supersession (id %)', old.id;
    end if;
    return new;
  end if;
  -- T2
  if old.superseded_by is null then
    if new.superseded_at is distinct from old.superseded_at or new.superseded_by is null then
      raise exception 'facility_assignments: only the successor pointer may be completed (id %)', old.id;
    end if;
    return new;
  end if;
  raise exception 'facility_assignments: row % is superseded and immutable', old.id;
end;
$$;

drop trigger if exists facility_assignments_guard on collections.facility_assignments;
create trigger facility_assignments_guard
  before update or delete on collections.facility_assignments
  for each row execute function collections.facility_assignments_guard();

-- 3. RLS ------------------------------------------------------------------------
-- Reads are app-scoped (the cmd_explorer_rows posture: permissive SELECT for claims_reader; the
-- app filters business_entity_id explicitly through entityScope). Writes have NO policy and NO
-- grant for any app role — the only write path is the definer function below, which runs as the
-- table owner (claims_admin), and table owners are not subject to their own RLS absent FORCE.
alter table collections.facility_assignments enable row level security;

drop policy if exists facility_assignments_reader_select on collections.facility_assignments;
create policy facility_assignments_reader_select
  on collections.facility_assignments
  for select to claims_reader
  using (true);

revoke all on collections.facility_assignments from public, anon, authenticated, service_role;
grant select on collections.facility_assignments to claims_reader;

-- 4. The write function -----------------------------------------------------------
-- Bulk, atomic, supersede-then-insert-then-point. p_charges is a JSONB array of charge keys:
--   [{"business_entity_id": "<uuid>", "member_id_bidx": "<hmac>", "charge_date": "YYYY-MM-DD",
--     "cpt_key": "<text>", "revenue_key": "<text>", "facility_label": "No Facility",
--     "charge_amount": "<numeric>"}, …]
-- Every element must identify a charge that EXISTS at the rollup grain — the function refuses to
-- record an assignment for a charge the book does not contain. Returns the number of assignments
-- written. Raises (rolling everything back) on any invalid element: partial writes are impossible.
create or replace function collections.save_facility_assignments(
  p_user          uuid,
  p_email         text,
  p_facility_code text,
  p_note          text,
  p_charges       jsonb
) returns integer
language plpgsql
security definer
set search_path = collections, pg_catalog
as $$
declare
  v_count integer;
  v_bad   integer;
begin
  if p_user is null then
    raise exception 'save_facility_assignments: user required' using errcode = 'check_violation';
  end if;
  if p_email is null or char_length(p_email) not between 3 and 320 then
    raise exception 'save_facility_assignments: invalid email' using errcode = 'check_violation';
  end if;
  if p_note is null or char_length(p_note) not between 1 and 500 then
    raise exception 'save_facility_assignments: note must be 1..500 chars' using errcode = 'check_violation';
  end if;
  if p_facility_code is null
     or not exists (select 1 from collections.facilities f where f.facility_code = p_facility_code) then
    raise exception 'save_facility_assignments: unknown facility_code' using errcode = 'check_violation';
  end if;
  if p_charges is null or jsonb_typeof(p_charges) <> 'array'
     or jsonb_array_length(p_charges) not between 1 and 500 then
    raise exception 'save_facility_assignments: charges must be a 1..500-element array' using errcode = 'check_violation';
  end if;

  create temp table _fa_incoming on commit drop as
  select distinct
    (c->>'business_entity_id')::uuid          as business_entity_id,
    c->>'member_id_bidx'                       as member_id_bidx,
    (c->>'charge_date')::date                  as charge_date,
    coalesce(c->>'cpt_key', '')                as cpt_key,
    coalesce(c->>'revenue_key', '')            as revenue_key,
    c->>'facility_label'                       as facility_label,
    (c->>'charge_amount')::numeric(12,2)       as charge_amount
  from jsonb_array_elements(p_charges) c;

  if exists (select 1 from _fa_incoming
              where business_entity_id is null or member_id_bidx is null or member_id_bidx = ''
                 or charge_date is null or charge_amount is null
                 or facility_label is distinct from 'No Facility') then
    raise exception 'save_facility_assignments: malformed or out-of-scope charge key' using errcode = 'check_violation';
  end if;

  -- Every incoming key must be a real charge at the rollup grain.
  select count(*) into v_bad
  from _fa_incoming i
  where not exists (
    select 1 from collections.cmd_explorer_charge_rollup r
     where r.business_entity_id = i.business_entity_id
       and r.member_id_bidx     = i.member_id_bidx
       and r.charge_date        = i.charge_date
       and coalesce(r.cpt_code, '')     = i.cpt_key
       and coalesce(r.revenue_code, '') = i.revenue_key
       and r.facility           = i.facility_label
       and r.charge_amount      = i.charge_amount);
  if v_bad > 0 then
    raise exception 'save_facility_assignments: % charge key(s) do not match any rollup charge', v_bad
      using errcode = 'check_violation';
  end if;

  -- Step 1 (trigger transition T1): stamp superseded_at on the old current rows, freeing the
  -- partial unique index for the successor inserts. Pointer completed in step 3.
  update collections.facility_assignments a
     set superseded_at = now()
    from _fa_incoming i
   where a.superseded_at      is null
     and a.business_entity_id = i.business_entity_id
     and a.member_id_bidx     = i.member_id_bidx
     and a.charge_date        = i.charge_date
     and a.cpt_key            = i.cpt_key
     and a.revenue_key        = i.revenue_key
     and a.facility_label     = i.facility_label
     and a.charge_amount      = i.charge_amount;

  -- Step 2: insert the successor rows.
  create temp table _fa_new on commit drop as
  with ins as (
    insert into collections.facility_assignments
      (business_entity_id, member_id_bidx, charge_date, cpt_key, revenue_key,
       facility_label, charge_amount, facility_code, note, assigned_by, assigned_by_email)
    select i.business_entity_id, i.member_id_bidx, i.charge_date, i.cpt_key, i.revenue_key,
           i.facility_label, i.charge_amount, p_facility_code, p_note, p_user, p_email
    from _fa_incoming i
    returning id, business_entity_id, member_id_bidx, charge_date, cpt_key, revenue_key,
              facility_label, charge_amount
  )
  select * from ins;

  -- Step 3 (trigger transition T2): complete the successor pointers on the rows stamped in step 1.
  update collections.facility_assignments a
     set superseded_by = n.id
    from _fa_new n
   where a.superseded_at is not null
     and a.superseded_by is null
     and a.business_entity_id = n.business_entity_id
     and a.member_id_bidx     = n.member_id_bidx
     and a.charge_date        = n.charge_date
     and a.cpt_key            = n.cpt_key
     and a.revenue_key        = n.revenue_key
     and a.facility_label     = n.facility_label
     and a.charge_amount      = n.charge_amount
     and a.id                 <> n.id;

  select count(*) into v_count from _fa_new;
  return v_count;
end;
$$;

alter function collections.save_facility_assignments(uuid, text, text, text, jsonb)
  owner to claims_admin;
revoke execute on function collections.save_facility_assignments(uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function collections.save_facility_assignments(uuid, text, text, text, jsonb)
  to claims_reader;

reset role;

-- 5. Verification (run manually after apply) ------------------------------------
-- Table + partial unique index + trigger exist:
--   select indexname from pg_indexes where schemaname='collections' and tablename='facility_assignments';
--   select tgname from pg_trigger
--    where tgrelid='collections.facility_assignments'::regclass and not tgisinternal;
-- Immutability (each must FAIL with the guard's message):
--   update collections.facility_assignments set note = 'x' where superseded_at is null;
--   delete from collections.facility_assignments where true;
-- Write + supersede round trip (as claims_reader, with a REAL sentinel charge key from
-- collections.cmd_explorer_charge_rollup): call save_facility_assignments twice with two
-- different facility codes, then expect exactly one current row, one superseded row whose
-- superseded_by points at the current row's id:
--   select count(*) filter (where superseded_at is null)     as current_rows,
--          count(*) filter (where superseded_at is not null) as superseded_rows,
--          count(*) filter (where superseded_at is not null and superseded_by is null) as half_stamped
--     from collections.facility_assignments;                 -- half_stamped must be 0
