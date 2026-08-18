-- 0106 — cmd_rollup_writer loses SELECT on the patient_name CIPHERTEXT, keeps it on the key columns.
--
-- APPLIED LIVE 2026-08-18 IN TWO LEDGER ROWS, because the first attempt was WRONG:
--   · `0106_cmd_patient_directory_writer_least_privilege`      — the revoke (broke the sync)
--   · `0106b_cmd_patient_directory_writer_column_scoped_select` — the column-scoped re-grant (fixed it)
--   Both versions are permanent in supabase_migrations.schema_migrations. This file is the FINAL
--   state; re-running it is idempotent and reproduces what is live.
--
-- WHY: 0105 granted the writer table-level SELECT alongside INSERT. The directory holds every
--   tenant's encrypted patient_name, so a compromised writer credential could export the whole
--   encrypted patient roster — access the sync path has no use for. The reader/writer split 0105's
--   own header describes was therefore not actually enforced by 0105. Caught in review.
--
-- ⚠ THE FIRST FIX WAS A REVOKE, AND IT WAS WRONG. I asserted that `INSERT ... ON CONFLICT DO NOTHING`
--   needs no SELECT privilege (unlike DO UPDATE, which reads the row for its SET/WHERE). That is a
--   plausible reading of the docs and it is FALSE: with a conflict TARGET, Postgres must read the
--   conflicting row to know there is one, so the statement requires SELECT. Revoking it made the
--   sync fail immediately and unambiguously:
--
--     patient-directory sync failed: permission denied for table cmd_patient_directory
--
--   It failed loudly rather than silently, which is the only reason this cost minutes instead of
--   weeks — compare 0066, whose reader UPDATE grant has been INERT since June because a missing RLS
--   policy filters rather than raises. VERIFY A PRIVILEGE CLAIM BY RUNNING THE STATEMENT, not by
--   reading about it.
--
-- THE ACTUAL FIX — column-scoped SELECT, the 0103 shape. The conflict check reads the KEY columns;
--   it never reads the payload. So the writer gets SELECT on exactly
--   (business_entity_id, member_id_bidx, name_fp) and NOT on patient_name. Table-level SELECT stays
--   false. Verified live after applying, as privileges AND as behaviour:
--
--     has_table_privilege (…,'SELECT')                        false   <- table level denied
--     has_column_privilege (…,'patient_name','SELECT')         false   <- the ciphertext denied
--     has_column_privilege (…,'member_id_bidx','SELECT')       true
--     sync --commit re-scanning 5,329 rows                     completes, 0 inserted (all present)
--
-- ⚠ IF THE CONFLICT ACTION EVER BECOMES `DO UPDATE`, RE-CHECK THIS. That form reads the row for its
--   SET/WHERE and may need SELECT on the columns it touches — including patient_name, which would
--   defeat the whole point. The state table already uses DO UPDATE (an accumulator that reads its
--   prior value), which is why IT keeps full SELECT: counters and a watermark, no PHI.
--
-- PHI DISCIPLINE: strictly reduces access to PHI-bearing ciphertext. Nothing gains a privilege it
--   did not have under 0105.
-- OWNERSHIP: postgres — no `set role claims_admin` (collections plane; see 0084/0085).
-- IDEMPOTENT: REVOKE/GRANT are unconditional; the policy is DROP-then-CREATE.
-- DEPENDENCY: 0105 (applied live 2026-08-18).
-- Rollback: 0106_cmd_patient_directory_writer_least_privilege_rollback.sql

-- 1. Remove the table-level SELECT ────────────────────────────────────────────────────────────
-- This is what carried the ciphertext. Column grants below are additive to what remains.
revoke select on collections.cmd_patient_directory from cmd_rollup_writer;

-- 2. Give back ONLY the conflict key ──────────────────────────────────────────────────────────
grant select (business_entity_id, member_id_bidx, name_fp)
  on collections.cmd_patient_directory to cmd_rollup_writer;

-- 3. The RLS half ─────────────────────────────────────────────────────────────────────────────
-- ⚠ BOTH GATES OR NEITHER (0089/0090, 0101/0102). The column grant is only half: RLS is enabled on
--   this table and cmd_rollup_writer is not rolbypassrls, so without a SELECT policy the conflict
--   check would see an EMPTY table — and then every INSERT would appear to succeed while inserting
--   duplicates it could not see. That failure is silent, which is worse than the 42501 above.
drop policy if exists cmd_patient_directory_writer_select on collections.cmd_patient_directory;
create policy cmd_patient_directory_writer_select on collections.cmd_patient_directory
  for select to cmd_rollup_writer using (true);

-- 4. Verification (run manually after apply) ─────────────────────────────────────────────────
--   select has_table_privilege('cmd_rollup_writer','collections.cmd_patient_directory','SELECT')                   as must_be_false,
--          has_column_privilege('cmd_rollup_writer','collections.cmd_patient_directory','patient_name','SELECT')   as must_be_false,
--          has_column_privilege('cmd_rollup_writer','collections.cmd_patient_directory','member_id_bidx','SELECT') as must_be_true,
--          has_table_privilege('cmd_rollup_writer','collections.cmd_patient_directory','INSERT')                   as must_be_true,
--          has_table_privilege('claims_reader','collections.cmd_patient_directory','SELECT')                       as must_be_true;
--
--   ⚠ AND THEN RUN THE STATEMENT — the catalog cannot answer the RLS half (postgres is rolbypassrls).
--      Force the INSERT path by winding the watermark back and re-syncing:
--        update collections.cmd_patient_directory_state set last_row_id = <max_id - 60000> where singleton;
--        tsx src/collections/patientDirectorySync.ts --commit    -- must COMPLETE, not 42501
