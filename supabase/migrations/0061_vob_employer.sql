-- 0061_vob_employer.sql   — APPLIED to prod 2026-07-22 via MCP apply_migration (copied here for ledger parity).
-- Adds employer as a searchable MARKET dimension to vob.indigo_vob (Collections + Qualify both
-- want employer search + fully/self-funded market segmentation).
--
-- PHI NOTE: employer_name is a plan/group-level attribute — treated like collections.primary_payer
-- and .facility, which are already stored PLAINTEXT — NOT a patient identifier. Stored plaintext so
-- it can be type-ahead searched and grouped (a blind index cannot do substring/type-ahead/group-by).
-- This is a deliberate reversal of 0060's exclusion of employer_name. funding already exists (0060).

alter table vob.indigo_vob
  add column if not exists employer_name text,
  add column if not exists employer_norm text;   -- upper + whitespace-collapsed; for search/group

create index if not exists idx_vob_indigo_employer_norm on vob.indigo_vob (employer_norm);

-- Recreate the current-benefits view to expose employer + funding to the enrichment join.
-- DROP + CREATE (not CREATE OR REPLACE): we insert employer columns mid-list, and REPLACE cannot
-- reorder/rename existing view columns.
drop view if exists vob.member_benefits_current;
create view vob.member_benefits_current
  with (security_invoker = true) as
select distinct on (member_id_bidx)
  member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  policy_type, funding, employer_name, employer_norm, insurance_co, payer_id, plan_type,
  ind_deductible, ind_deductible_met, family_deductible, family_deductible_met,
  ind_oop_max, ind_oop_met, family_oop_max, family_oop_met,
  coinsurance_combined, coinsurance_ip, coinsurance_op, coinsurance_after_oop,
  vob_datetime, facility, monday_item_id, vob_created_at, schema_version, extraction_flag
from vob.indigo_vob
where member_id_bidx is not null
order by member_id_bidx, vob_created_at desc nulls last, monday_item_id desc;

-- (Future) an employer_alias crosswalk mirroring claims.payer_alias / claims.facility_alias would
-- collapse the ~11.6k free-text variants for clean market rollups. v1 groups on employer_norm.
