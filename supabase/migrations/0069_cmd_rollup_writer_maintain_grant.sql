-- 0069 — GRANT MAINTAIN on the charge-rollup matview to cmd_rollup_writer.
--
-- WHY: the hourly refresh job (src/collections/refreshChargeRollup.ts) now runs
-- `vacuum (analyze) collections.cmd_explorer_charge_rollup` right after REFRESH ... CONCURRENTLY, so
-- the visibility map + planner stats stay fresh and the book-wide KPI index-only scan (mig 0068)
-- keeps its Heap Fetches: 0 speed instead of decaying between the (infrequent) autovacuums. VACUUM and
-- ANALYZE require table ownership or (PG16+) the MAINTAIN privilege; the refresh runs as the
-- least-privilege cmd_rollup_writer (via the cmd_rollup_writer_login role that INHERITS it), so grant
-- MAINTAIN to the group role and the login role inherits it.
--
-- Idempotent + safe to re-run. The vacuum step is best-effort in code, so a missing grant degrades to
-- "no post-refresh vacuum" (a logged warning) rather than a failed refresh.

grant maintain on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;
