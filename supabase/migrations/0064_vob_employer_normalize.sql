-- 0064_vob_employer_normalize.sql   — Apply as `postgres` (owns schema vob) via apply_migration.
--
-- Problem: the employer type-ahead is noisy — employer_norm (0061) is only upper + whitespace-
-- collapse, so "Google", "GOOGLE INC", "GOOGLE LLC", "GOOGLE PPO", "GOOGLE GHIP CHDP HSA W/NON-INT
-- BANKING", "Google, LLC." … are all SEPARATE keys and each shows as its own picker row.
--
-- Fix: an aggressive normalizer that collapses legal/plan noise. vob.normalize_employer(text):
--   1. uppercase, replace every run of non-alphanumerics with a single space, trim;
--   2. TRUNCATE at the first whole-word legal/plan token (INC, LLC, CORP, CO, PPO, HMO, GHIP, HSA,
--      PLAN, GROUP, TRUST, …) — the employer name is the leading run before the plan/legal suffix;
--   3. fall back to the cleaned string if truncation would empty it (e.g. a name that STARTS with a
--      noise word), so nothing normalizes to ''.
-- Verified on prod data (2026-07-23): all 15 "GOOGLE*" variants → one "GOOGLE" (70 members); the top
-- absorbers are real companies collapsing their own variants (WALMART, TESLA, APPLE, AMAZON, BANK OF
-- AMERICA); distinct keys 10,929 → 9,857. No cross-company over-merges observed.
--
-- The matview is redefined to COMPUTE employer_norm from employer_name via this function (instead of
-- selecting the stored 0061 column), so there is ONE source of truth in SQL and no Python/loader change
-- is needed. The app queries member_benefits_latest.employer_norm unchanged → the type-ahead + the
-- market semi-join both see the collapsed keys automatically.

create or replace function vob.normalize_employer(raw text) returns text
  language sql immutable parallel safe as $$
  select coalesce(
    -- (2) truncate at the first legal/plan token
    nullif(btrim(regexp_replace(
      -- (1) uppercase + de-punctuate + collapse whitespace
      btrim(regexp_replace(upper(raw), '[^A-Z0-9]+', ' ', 'g')),
      '\y(INC|INCORPORATED|LLC|LLP|LP|LTD|CORP|CORPORATION|COMPANY|CO|PC|PLLC|PPO|HMO|EPO|POS|HDHP|HSA|HRA|FSA|GHIP|CHDP|EPP|PLAN|PLANS|GROUP|TRUST|FUND|BENEFIT|BENEFITS|INSURANCE)\y.*$',
      '')), ''),
    -- (3) fall back to the cleaned string (never normalize to '')
    btrim(regexp_replace(upper(raw), '[^A-Z0-9]+', ' ', 'g'))
  );
$$;

-- Redefine the matview to compute employer_norm. DROP + CREATE (a matview query can't be ALTERed);
-- concurrent readers block on the lock and then see the new definition — no gap. The refresh function
-- (0063) resolves the matview by name at runtime, so it is unaffected.
drop materialized view vob.member_benefits_latest;

create materialized view vob.member_benefits_latest as
select distinct on (member_id_bidx)
  member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  policy_type, funding, employer_name,
  vob.normalize_employer(employer_name) as employer_norm,
  insurance_co, payer_id, plan_type,
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
