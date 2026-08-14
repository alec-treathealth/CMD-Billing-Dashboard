-- Rollback for 0101_cmd_explorer_employer_name.sql.
--
-- ⚠ ORDER: if 0102 (rollup swap carrying employer_name) has been applied, roll THAT back first —
--   dropping this column while the matview still selects it breaks the matview's next REFRESH.
-- ⚠ DATA: dropping the column discards every stamped employer value. The one-shot backfill filter
--   (10148786) can re-supply them, but the owner ruled it single-use — treat this rollback as
--   destructive and confirm before running.

alter table collections.cmd_explorer_rows
  drop column if exists employer_name;
