-- 0060_vob_indigo.sql   — APPLIED to prod 2026-07-22 via MCP apply_migration (copied here for ledger parity).
-- Target: project dbpabchpvipipkzkogta (cmd-billing-dashboard). Apply as `postgres`
-- (owns schema vob; bypassrls) via Supabase apply_migration. At apply time this file
-- should be placed at supabase/migrations/0060_vob_indigo.sql in the app repo.
--
-- Purpose: land Indigo Monday-PDF VOB benefits so the Collections tab
-- (collections.cmd_explorer_rows) and Qualify tab (collections.cmd_charge_census) can be
-- enriched by member_id_bidx (the keyed-HMAC blind index; derivation validated 100% vs the
-- app's src/collections/blindIndex.ts).
--
-- PHI posture: stores ONLY pseudonymous blind-index tokens + benefit attributes. It NEVER
-- stores raw identifiers (patient_name / patient_dob / member_id / group_number) or the
-- free-text additional_notes — those stay in the local gitignored CSV only.
--
-- TENANCY: no business_entity_id column. This is a MEMBER-LEVEL table; tenant scope is
-- inherited from the collections row at JOIN time (member_id_bidx is GLOBAL across BXR +
-- Indigo — proven by 227 members shared across both). `source` is board provenance only,
-- NOT a tenant filter.

create schema if not exists vob;   -- pre-existing (owned by postgres); no-op if present

create table if not exists vob.indigo_vob (
  monday_item_id          text primary key,          -- text PK => no sequence => no sequence grant
  facility                text not null,             -- Monday status60 (admission gate; curated rows are admitted-only)
  vob_created_at          date,                       -- Monday item created_at (recency signal for dedup)
  -- match keys (keyed-HMAC blind indexes; nullable — ~4% of VOBs have no member_id)
  member_id_bidx          text,
  member_id_prefix_bidx   text,
  group_number_bidx       text,
  -- benefit attributes (verbatim extracted text; parse to numeric downstream if desired)
  policy_type             text,
  funding                 text,
  insurance_co            text,
  payer_id                text,
  plan_type               text,
  ind_deductible          text,
  ind_deductible_met      text,
  family_deductible       text,
  family_deductible_met   text,
  ind_oop_max             text,
  ind_oop_met             text,
  family_oop_max          text,
  family_oop_met          text,
  coinsurance_combined    text,
  coinsurance_ip          text,
  coinsurance_op          text,
  coinsurance_after_oop   text,
  vob_datetime            text,
  -- provenance
  schema_version          text,
  extraction_flag         text,
  source                  text not null default 'indigo_monday_1606316049',
  loaded_at               timestamptz not null default now()
);

create index if not exists idx_vob_indigo_member_bidx        on vob.indigo_vob (member_id_bidx);
create index if not exists idx_vob_indigo_member_prefix_bidx on vob.indigo_vob (member_id_prefix_bidx);
create index if not exists idx_vob_indigo_group_bidx         on vob.indigo_vob (group_number_bidx);

-- Current benefits per member: newest VOB wins. vob_created_at is a real recency signal;
-- monday_item_id desc tie-breaks (Monday ids are monotonic). vob_datetime is unreliable
-- free-text and is deliberately NOT used for ordering. security_invoker => caller's grants/RLS.
create or replace view vob.member_benefits_current
  with (security_invoker = true) as
select distinct on (member_id_bidx)
  member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  policy_type, funding, insurance_co, payer_id, plan_type,
  ind_deductible, ind_deductible_met, family_deductible, family_deductible_met,
  ind_oop_max, ind_oop_met, family_oop_max, family_oop_met,
  coinsurance_combined, coinsurance_ip, coinsurance_op, coinsurance_after_oop,
  vob_datetime, facility, monday_item_id, vob_created_at, schema_version, extraction_flag
from vob.indigo_vob
where member_id_bidx is not null
order by member_id_bidx, vob_created_at desc nulls last, monday_item_id desc;

-- RLS: enabled with explicit policies (advisory requires RLS on). No tenant predicate — tenant
-- is applied by the collections side at join time.
alter table vob.indigo_vob enable row level security;

drop policy if exists vob_indigo_rw on vob.indigo_vob;
create policy vob_indigo_rw on vob.indigo_vob
  to cmd_rollup_writer using (true) with check (true);

drop policy if exists vob_indigo_ro on vob.indigo_vob;
create policy vob_indigo_ro on vob.indigo_vob
  for select to claims_reader, consolidated_reader using (true);

-- Grants. Loader upserts => INSERT + UPDATE + SELECT (intentionally MORE than the collections
-- INSERT-only grant to cmd_rollup_writer, because this is a true upsert target). Grant to the
-- privilege-holding group role cmd_rollup_writer; cmd_rollup_writer_login inherits.
grant usage on schema vob to cmd_rollup_writer, claims_reader, consolidated_reader;
grant select, insert, update on vob.indigo_vob to cmd_rollup_writer;
grant select on vob.indigo_vob to claims_reader, consolidated_reader;
grant select on vob.member_benefits_current to cmd_rollup_writer, claims_reader, consolidated_reader;
