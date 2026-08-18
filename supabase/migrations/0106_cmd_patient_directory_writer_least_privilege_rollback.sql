-- 0106 ROLLBACK — restore cmd_rollup_writer's TABLE-LEVEL SELECT on collections.cmd_patient_directory.
--
-- ⚠ THIS WIDENS ACCESS TO PHI-BEARING CIPHERTEXT — it hands the writer role the ability to read every
--   tenant's encrypted patient_name, which is precisely what 0106 removed. Run it only to restore
--   0105's posture wholesale.
--
-- ⚠ IT IS ALMOST CERTAINLY NOT THE FIX YOU WANT. If the sync is raising 42501, the cause is more
--   likely the RLS policy or a NEW column added to the conflict target without a matching column
--   grant. Check which statement raised it first — the sync also writes cmd_patient_directory_state,
--   whose privileges 0106 never touched.
--
-- IDEMPOTENT: GRANT is unconditional; the policy is DROP-then-CREATE.

grant select on collections.cmd_patient_directory to cmd_rollup_writer;

drop policy if exists cmd_patient_directory_writer_select on collections.cmd_patient_directory;
create policy cmd_patient_directory_writer_select on collections.cmd_patient_directory
  for select to cmd_rollup_writer using (true);

-- Verification:
--   select has_table_privilege('cmd_rollup_writer','collections.cmd_patient_directory','SELECT'); -- true
