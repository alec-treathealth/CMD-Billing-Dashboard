-- 0081 ROLLBACK — drop the four trigram GIN search indexes from the charge rollup.
--
-- ⚠ Same apply path as 0081 forward: DROP INDEX CONCURRENTLY cannot run inside a transaction
--   block — run each statement as its own single-statement autocommit query (Supabase MCP
--   execute_sql), never via apply_migration. (Plain DROP INDEX would also work but takes an
--   ACCESS EXCLUSIVE lock on the matview, blocking readers for the drop's duration.)
--
-- Search behavior after rollback: `ilike` degrades gracefully to the pre-0081 seq scan —
-- slower, not broken. No code revert is required (the ::text-cast removal is index-agnostic).

drop index concurrently if exists collections.cmd_charge_rollup_facility_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_payer_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_cpt_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_revenue_trgm;
