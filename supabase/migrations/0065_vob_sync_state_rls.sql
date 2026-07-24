-- 0065_vob_sync_state_rls.sql   — Apply as `postgres` (owns schema vob).
--
-- Problem: vob.sync_state (created in 0062) has row-level security ENABLED but no policies, so the
-- default-deny blocks the cron writer. The first supervised dispatch upserted 103 rows into
-- vob.indigo_vob fine, then failed at the sync_state insert:
--   InsufficientPrivilege: new row violates row-level security policy for table "sync_state".
-- 0062 granted table privileges (select/insert/update) but RLS is a separate gate. RLS was enabled
-- out-of-band (Supabase enables RLS on tables in API-exposed schemas); we keep it on and add the
-- SAME permissive-policy pattern vob.indigo_vob already uses (0060), rather than disabling RLS —
-- so the schema stays consistent and the Supabase security linter stays clean.
--
-- Mirrors vob.indigo_vob exactly:
--   vob_indigo_rw  -> cmd_rollup_writer  ALL     using(true) with check(true)
--   vob_indigo_ro  -> readers            SELECT  using(true)

alter table vob.sync_state enable row level security;   -- idempotent (already enabled)

drop policy if exists vob_sync_state_rw on vob.sync_state;
create policy vob_sync_state_rw on vob.sync_state
  for all to cmd_rollup_writer
  using (true) with check (true);

drop policy if exists vob_sync_state_ro on vob.sync_state;
create policy vob_sync_state_ro on vob.sync_state
  for select to claims_reader, consolidated_reader
  using (true);
