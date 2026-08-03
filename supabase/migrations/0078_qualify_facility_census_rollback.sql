-- 0078 ROLLBACK — drops the qualify facility-census aggregate snapshot. Pure ops data (counts,
-- averages, dates — no PHI); the next sync run rebuilds it in full, so this rollback is lossless
-- modulo one sync cadence.

drop table if exists collections.qualify_facility_census;

-- Verification: select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'collections' and c.relname = 'qualify_facility_census';  -- expect 0
