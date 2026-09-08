-- ============================================================================================
-- ROLLBACK for Veris 037 — 835 claim + service-line grain.
--
-- 037 is purely additive (two new tables, their indexes, grants and policies), so the rollback
-- is a clean drop and restores the schema exactly as it stood at 036.
--
-- ⚠ DESTRUCTIVE ONCE THE EMISSION PR IS LIVE. Dropping these discards every claim and service
--   line ingested since. It is safe only while both tables are EMPTY, which is their state
--   until the era_ingest.ts emission change ships — 037 creates the tables and nothing writes
--   to them. Check before running:
--       select (select count(*) from staging.era_835_claim)        as claims,
--              (select count(*) from staging.era_835_service_line) as lines;
--   Both zero → safe. Non-zero → this discards remittance detail that has no other home; the
--   source 835s are re-downloadable from CMD, but a re-ingest is the recovery, not this script.
--
-- ⚠ staging.era_835_adjustment IS NOT TOUCHED and must not be. Its `claim_line_id` points at
--   staging.claim_line — a DIFFERENT, pre-existing table (the BILLED side, ~150,900 rows) — not
--   at anything 037 created. Nothing in 037 added a column or constraint to it.
-- ============================================================================================

-- ⚠ Runs as postgres. No SET ROLE needed to DROP: claims_admin's objects are droppable by an
--   operator that can SET ROLE to it, and the forward migration's RESET ROLE already returned us.
--
-- Policies first. Dropping a table drops its policies anyway, but naming them keeps this script
-- honest if a future edit turns the table drops into something narrower.
drop policy if exists era_835_line_writer_select     on staging.era_835_service_line;
drop policy if exists era_835_line_writer_insert     on staging.era_835_service_line;
drop policy if exists era_835_line_reader_isolation  on staging.era_835_service_line;
drop policy if exists era_835_claim_writer_select    on staging.era_835_claim;
drop policy if exists era_835_claim_writer_insert    on staging.era_835_claim;
drop policy if exists era_835_claim_reader_isolation on staging.era_835_claim;

-- Grants, explicitly. Same reasoning: the table drop revokes them, but a partial future rollback
-- must not silently leave cmd_rollup_writer holding INSERT on a table it can no longer see.
revoke insert on staging.era_835_service_line from cmd_rollup_writer;
revoke insert on staging.era_835_claim        from cmd_rollup_writer;
revoke select on staging.era_835_service_line from claims_reader;
revoke select on staging.era_835_claim        from claims_reader;

-- ⚠ ORDER MATTERS. era_835_service_line.claim_id FKs to era_835_claim, so the claim table cannot
--   be dropped first — Postgres raises 2BP01 (dependent_objects_still_exist). Child, then parent.
drop table if exists staging.era_835_service_line;
drop table if exists staging.era_835_claim;

-- Verification after running — both should return 0 rows:
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'staging' and c.relname in ('era_835_claim','era_835_service_line');
--   select policyname from pg_policies
--    where schemaname = 'staging' and tablename in ('era_835_claim','era_835_service_line');
