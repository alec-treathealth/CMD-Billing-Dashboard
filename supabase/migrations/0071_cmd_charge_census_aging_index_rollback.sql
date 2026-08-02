-- 0071 ROLLBACK — drop the AR-aging support index.
--
-- Reverses 0071_cmd_charge_census_aging_index.sql. The index carries no data and no grant/RLS state,
-- so dropping it is lossless (reads fall back to a sort of the entity slice). If the LIVE index was
-- built with CREATE INDEX CONCURRENTLY, prefer DROP INDEX CONCURRENTLY off-tick (cannot run inside
-- apply_migration's single txn); the plain form below is transaction-safe for branch/CI teardown.
--
-- OWNERSHIP: postgres-owned table → plain DDL, no `set role`. IDEMPOTENT: `if exists`.

drop index if exists collections.cmd_charge_census_ent_charge_date;
