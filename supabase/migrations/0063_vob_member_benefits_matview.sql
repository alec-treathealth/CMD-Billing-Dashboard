-- 0063_vob_member_benefits_matview.sql   — Apply as `postgres` (owns schema vob) via apply_migration.
--
-- Purpose (performance): the market filter + employer type-ahead added in the Collections/Qualify
-- search build join to vob.member_benefits_current — a PLAIN (non-materialized) view that recomputes
-- "latest VOB row per member_id_bidx" via a sort + DISTINCT ON over the whole vob.indigo_vob table on
-- EVERY reference. Measured cost: ~0.7–1.1s just to rebuild that set, so every market-filtered
-- grid/summary/ranking query ran ~1.7s and the employer type-ahead ~2.3s warm / 5.2s cold — a
-- reader-pool-saturation risk, not just slow UX.
--
-- Fix: materialize latest-per-member ONCE per VOB load (the data is static between loads, so matview
-- staleness is a non-issue) and index the hot columns. The app repoints the market semi-join +
-- employer-options query at this matview; vob.member_benefits_current is left in place (superseded for
-- those hot paths) for any full-benefit display use.
--
-- Definition MIRRORS vob.member_benefits_current exactly (0060 + 0061): newest VOB wins per member,
-- ordered by (member_id_bidx, vob_created_at desc nulls last, monday_item_id desc). Same column list.

-- pg_trgm is already installed and was relocated to schema `claims` by migration 0003 (so
-- claims_reader can use it). We reference its operator class SCHEMA-QUALIFIED (claims.gin_trgm_ops)
-- rather than relying on an ambient search_path — the apply_migration session's search_path does not
-- include `claims`, and unqualified `gin_trgm_ops` fails to resolve there.

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

-- UNIQUE index on the dedup key: REQUIRED for REFRESH ... CONCURRENTLY, and the membership lookup key.
create unique index member_benefits_latest_bidx on vob.member_benefits_latest (member_id_bidx);
-- Funding market filter (equality / = any(...)).
create index member_benefits_latest_funding on vob.member_benefits_latest (funding);
-- Employer type-ahead: a leading-wildcard ILIKE '%q%' cannot use a btree — a trigram GIN can.
create index member_benefits_latest_employer_trgm on vob.member_benefits_latest using gin (employer_norm claims.gin_trgm_ops);

-- Reader grants (matview grants are SEPARATE from the base view's). USAGE on schema vob already held.
grant select on vob.member_benefits_latest to claims_reader, consolidated_reader;

-- Least-privilege refresh: a SECURITY DEFINER function owned by postgres (which owns the matview +
-- base table) lets the loader's cmd_rollup_writer role refresh WITHOUT owning the matview. REFRESH ...
-- CONCURRENTLY is transactional (safe inside a function) and never blocks concurrent readers. Empty
-- search_path with a fully-qualified target closes the SECURITY DEFINER search_path-hijack vector.
create or replace function vob.refresh_member_benefits_latest() returns void
  language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view concurrently vob.member_benefits_latest;
end;
$$;
revoke all on function vob.refresh_member_benefits_latest() from public;
grant execute on function vob.refresh_member_benefits_latest() to cmd_rollup_writer;
