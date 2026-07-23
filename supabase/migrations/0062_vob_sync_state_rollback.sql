-- 0062_vob_sync_state_rollback.sql   — DRAFT. Reverses 0062. Apply as `postgres`.
drop table if exists vob.sync_state;
alter table vob.indigo_vob
  drop column if exists monday_updated_at,
  drop column if exists deactivated_at;
