-- Rollback for 0065_vob_sync_state_rls.sql. Apply as `postgres`.
-- Removes the sync_state policies. Leaves RLS enabled (default-deny) — the pre-0065 state that
-- blocked the writer; restore write access by re-applying 0065 or disabling RLS deliberately.

drop policy if exists vob_sync_state_rw on vob.sync_state;
drop policy if exists vob_sync_state_ro on vob.sync_state;
