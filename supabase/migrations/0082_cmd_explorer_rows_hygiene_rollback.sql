-- 0082 ROLLBACK — recreate the two dropped indexes and reset the per-table autovacuum
-- settings to the cluster defaults.
--
-- NOTE: plain CREATE INDEX here takes a SHARE lock on cmd_explorer_rows (blocks the hourly
-- ingest writers for the build's duration, ~10-30s). If rolling back on a live system during
-- ingest hours, prefer running the two creates as CREATE INDEX CONCURRENTLY via single-statement
-- autocommit execute_sql calls instead (CONCURRENTLY cannot run inside this file's transaction).

-- 1. Recreate the dropped indexes ----------------------------------------------
create index if not exists cmd_explorer_ingested_at
  on collections.cmd_explorer_rows using btree (ingested_at);

create index if not exists cmd_explorer_primary_payer
  on collections.cmd_explorer_rows using btree (primary_payer);

-- 2. Reset autovacuum reloptions to defaults ------------------------------------
alter table collections.cmd_explorer_rows reset (
  autovacuum_vacuum_scale_factor,
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_analyze_scale_factor
);
