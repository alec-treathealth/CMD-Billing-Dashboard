-- ROLLBACK for 0045_code_intel_writer_role.sql
--
-- Removes exactly what 0045 added: the two RLS write policies and the GRANTs to
-- code_intel_writer. The role itself is NOT dropped (a login role may still inherit
-- it, and DROP ROLE fails if any object is owned by / granted to a dependent — same
-- non-destructive posture as the forward migrations, which only ever create roles
-- if-absent). To fully remove the role, revoke dependents first, out of band.
--
-- ⚠️ Revert/redeploy the app FIRST (disable the CMS sync cron) so nothing tries to
-- write ref_code / policy_change_event as this role after its grants are gone.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply
-- flow can run a rollback as a forward migration.

drop policy if exists pce_writer_insert on code_intel.policy_change_event;
drop policy if exists ref_code_writer_write on code_intel.ref_code;

revoke insert on code_intel.policy_change_event from code_intel_writer;
revoke select, insert, update on code_intel.ref_code from code_intel_writer;
revoke usage on schema code_intel from code_intel_writer;
