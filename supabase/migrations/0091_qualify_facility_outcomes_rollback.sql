-- ROLLBACK for 0095 — drop collections.qualify_facility_outcomes.
--
-- ⚠ ROLL THE CODE BACK FIRST. loadQualifyFacilityOutcomes selects this table; dropping it while the
--   deployed code still reads it raises 42P01 on the Qualify read path. The loader is fail-soft on
--   42P01 specifically (the 0078 precedent) so it degrades to the census snapshot rather than 500ing
--   — but do not rely on that: revert the code deploy, confirm it is live, then run this.
--
-- What is lost: the completed-stay averages. The auth-fit factor falls back to the in-progress
-- census snapshot, which means it returns to never firing the overrun penalty for any facility —
-- including the four measured at or over their authorization (10026624 ~1.10, 10025950 ~1.05,
-- PCMH ~1.03, LSMH ~1.00). That is the pre-0095 behaviour, and it is wrong; roll back only if the
-- SOURCE of these numbers is in doubt, not because the numbers are inconvenient.
--
-- Recoverable: the seed is measured data reproducible from the source project, and re-applying 0095
-- restores it exactly.
--
-- OWNERSHIP: postgres — no SET ROLE (see the 0095 header). Policies and grants drop with the table.

drop table if exists collections.qualify_facility_outcomes;

-- Verification: the table and its policies are gone
-- select count(*) from pg_policies
--  where schemaname='collections' and tablename='qualify_facility_outcomes';   -- expect 0
-- select to_regclass('collections.qualify_facility_outcomes');                 -- expect null
