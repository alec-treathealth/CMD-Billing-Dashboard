-- 0061_vob_employer_rollback.sql   — DRAFT. Reverses 0061. Apply as `postgres`.
-- Order: restore the 0060 view (drops the employer dependency) BEFORE dropping the columns.

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

drop index if exists vob.idx_vob_indigo_employer_norm;

alter table vob.indigo_vob
  drop column if exists employer_norm,
  drop column if exists employer_name;
