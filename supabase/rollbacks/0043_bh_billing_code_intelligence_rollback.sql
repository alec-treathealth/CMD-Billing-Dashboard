-- ROLLBACK for 0043_bh_billing_code_intelligence.sql
--
-- Drops the entire code_intel schema (all tables, indexes, RLS policies, and the
-- enum types defined within it) with CASCADE. This is DESTRUCTIVE of everything the
-- forward migration created, INCLUDING any reference/policy data loaded after 0043.
-- Because this schema is non-PHI reference data, there is no PHI loss — but any
-- hand-curated billing policies or accepted change events WOULD be lost. Export
-- first if any real data has been entered.
--
-- The claims_reader role is NOT dropped (it predates 0043, created in 0003). Its
-- grants inside code_intel disappear automatically with the schema.
--
-- ⚠️ ORDER: run 0045 rollback then 0044 rollback BEFORE this (or just run this — the
-- CASCADE removes their objects too). Either way, revert/redeploy the app first so no
-- route or cron references code_intel objects after they are gone.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/).

drop schema if exists code_intel cascade;
