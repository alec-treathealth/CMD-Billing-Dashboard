-- 0105 ROLLBACK — drop collections.cmd_patient_directory and its sync state.
--
-- ⚠ ORDERING: the full-book patient search reads collections.cmd_patient_directory. Roll the CODE
--   back first (or the search returns an empty directory and silently finds nobody — searchCmd-
--   ExplorerPatientName raises `directory_unavailable` on 42P01 rather than returning "no matches",
--   precisely so this ordering mistake is loud). Only then drop the tables.
--
-- DATA LOSS: yes, and it is safe. Every row here is DERIVED from collections.cmd_explorer_rows —
--   ciphertext copied verbatim plus two keyed HMAC tokens. Nothing in it is a source of truth, and
--   re-running `tsx src/collections/patientDirectorySync.ts --commit` rebuilds it exactly (~686k
--   rows scanned, ~11k inserted). No PHI is destroyed that does not still exist on the base table.
--
-- IDEMPOTENT: DROP ... IF EXISTS throughout; re-running is a no-op.

drop table if exists collections.cmd_patient_directory;
drop table if exists collections.cmd_patient_directory_state;

-- Policies and grants are dropped with the tables — nothing further to revoke.
--
-- Verification:
--   select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
--    where n.nspname='collections' and c.relname like 'cmd_patient_directory%';   -- expect 0
