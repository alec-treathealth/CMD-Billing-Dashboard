-- Rollback for 0064_vob_employer_normalize.sql. Apply as `postgres`.
-- Restores the 0063 matview (stored employer_norm) and drops the normalizer function.

drop materialized view vob.member_benefits_latest;

create materialized view vob.member_benefits_latest as
select distinct on (member_id_bidx)
  member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  policy_type, funding, employer_name, employer_norm, insurance_co, payer_id, plan_type,
  ind_deductible, ind_deductible_met, family_deductible, family_deductible_met,
  ind_oop_max, ind_oop_met, family_oop_max, family_oop_met,
  coinsurance_combined, coinsurance_ip, coinsurance_op, coinsurance_after_oop,
  vob_datetime, facility, monday_item_id, vob_created_at, schema_version, extraction_flag
from vob.indigo_vob
where member_id_bidx is not null
order by member_id_bidx, vob_created_at desc nulls last, monday_item_id desc
with data;

create unique index member_benefits_latest_bidx on vob.member_benefits_latest (member_id_bidx);
create index member_benefits_latest_funding on vob.member_benefits_latest (funding);
create index member_benefits_latest_employer_trgm on vob.member_benefits_latest using gin (employer_norm claims.gin_trgm_ops);
grant select on vob.member_benefits_latest to claims_reader, consolidated_reader;

drop function if exists vob.normalize_employer(text);
