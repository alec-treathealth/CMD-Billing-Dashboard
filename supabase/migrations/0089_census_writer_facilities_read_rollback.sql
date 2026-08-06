-- ROLLBACK for 0089 — revoke cmd_rollup_writer's SELECT on collections.facilities.
--
-- ⚠ WHAT THIS RESTORES IS THE BUG, not a neutral prior state. Revoking sends the census sync back to
--   a 42501 on every run's care_setting read, an empty careSettings map, and a saturated
--   `conformance_gap_boards: 23 of 23` that cannot distinguish a real regression from itself.
--   Roll back only if the grant itself is judged wrong (e.g. a least-privilege review decides the
--   writer must not read the roster at all) — in which case the correct follow-up is to REMOVE the
--   care_setting assertion from the sync, not to leave an assertion that can never read its input.
--
-- The sync does NOT break on revoke: the read is fail-soft and the run still completes and upserts.
-- Only the family <-> care_setting assertion goes dark (reporting "unknown" for every facility).
--
-- NOTE: after the companion code change, a 42501 here no longer degrades silently — it raises and
--   the run is recorded 'failed' rather than quietly 'partial'. That is deliberate: a permission
--   error is an outage, not a data state. So rolling this back WILL start failing census runs
--   loudly. That is the intended behaviour, and it is the reason to prefer fixing forward.
--
-- OWNERSHIP: postgres — no SET ROLE (see the 0089 header).

revoke select on collections.facilities from cmd_rollup_writer;

-- Verification: the writer can no longer read the roster
-- select has_table_privilege('cmd_rollup_writer','collections.facilities','SELECT') as can_read;
--   -- expect false
