-- 0078 — collections.qualify_facility_census: per-facility monday-census AGGREGATES for the
--        Qualify auth-fit factor + UR banner + open-bed context (qualify-v2-build-plan Phase G).
--
-- WHY: the §5 auth/LOS-fit factor (10 points), the "Next UR date" banner, and open-bed context all
--   live only on monday census boards today. Rating computation cannot call monday per request;
--   this table is the snapshot the factor reads. AGGREGATE GRAIN ON PURPOSE: one row per facility,
--   counts/averages/dates only — the monday boards' item names are PATIENT NAMES, and keeping the
--   ingest at facility grain means NO new PHI at rest, no name hashing, no reveal path (the plan's
--   "new PHI boundary" warning is answered by never crossing it). Patient-level census linkage, if
--   ever wanted, is its own reviewed migration.
--
-- PHI DISCIPLINE: zero PHI. Facility codes, board ids, counts, day averages, a UR date, bed
--   counts, timestamps. The ingest fetches monday COLUMN VALUES only (never item names) for census
--   boards; open beds are counted from the Admit Status labels ('Open Bed (Male/Female/Either)'),
--   verified live 2026-08-03.
-- OWNERSHIP: collections plane — SET ROLE claims_admin born-owned (0073/0077 pattern).
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY; GRANTs
--   unconditional and repeatable.
-- DEPENDENCY: none structural. The writer role (cmd_rollup_writer) and reader exist from 0022+.
-- Rollback: 0078_qualify_facility_census_rollback.sql

set role claims_admin;

create table if not exists collections.qualify_facility_census (
  business_entity_id uuid        not null,             -- explicit tenant scope
  facility_code   text        not null,          -- collections.facilities.facility_code (8-digit CMD customer)
  board_id        text        not null,             -- monday board id (non-PHI ops identifier)
  board_family    text        not null check (board_family in ('residential', 'outpatient')),
  admitted_count  integer     not null default 0,
  open_beds       integer,                          -- from Admit Status 'Open Bed (…)' labels — never item names
  bed_capacity    integer,                          -- Facility Info '# of Beds' (facility-grain board; names are facility names)
  avg_auth_days   numeric(6,2),                     -- avg Total Auth Days over admitted rows WITH auth set (null-guarded)
  avg_los_days    numeric(6,2),                     -- avg Days in RTC / Days in OP over admitted rows
  auth_sample     integer     not null default 0,   -- admitted rows contributing to avg_auth_days
  next_ur_date    date,                             -- soonest upcoming UR date on the board
  synced_at       timestamptz not null default now(),
  primary key (business_entity_id, facility_code)
);

reset role;

-- RLS — explicit policies (policy-less RLS default-denies the writer; the 0065 incident class).

alter table collections.qualify_facility_census enable row level security;

drop policy if exists qualify_census_ro on collections.qualify_facility_census;
create policy qualify_census_ro on collections.qualify_facility_census
  for select to claims_reader, consolidated_reader
  using (true);

drop policy if exists qualify_census_rw on collections.qualify_facility_census;
create policy qualify_census_rw on collections.qualify_facility_census
  for all to cmd_rollup_writer
  using (true) with check (true);

-- Grants — the established collections-cron writer; readers for the factor + any ops query.

grant select on collections.qualify_facility_census to claims_reader, consolidated_reader;
grant select, insert, update on collections.qualify_facility_census to cmd_rollup_writer;

-- Verification (run manually after apply)
--
-- select polname, polcmd from pg_policy
--  where polrelid = 'collections.qualify_facility_census'::regclass;          -- expect 2
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'collections' and table_name = 'qualify_facility_census'
--  order by grantee, privilege_type;
-- select count(*) from collections.qualify_facility_census;                    -- 0 until first sync
