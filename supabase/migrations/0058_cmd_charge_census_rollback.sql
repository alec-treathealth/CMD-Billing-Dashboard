-- Rollback for 0058 — drops collections.cmd_charge_census + collections.cmd_census_run.
--
-- DROP TABLE cascades to each table's policies, indexes, UNIQUE constraint, and identity sequence
-- (and the sequence-USAGE grants vanish with it) — so no separate policy/index/grant teardown is
-- needed. Drop order is unconstrained: cmd_charge_census.last_run_id is an UNENFORCED soft reference
-- to cmd_census_run.id (NO foreign key by design), so neither table depends on the other at the
-- catalog level; census is dropped first for readability.
--
-- Additive forward migration (two NEW tables, no data transform) → clean reversal. Any census data is
-- lost on rollback — acceptable: census is a re-derivable existence cache (a feed re-pull under a
-- re-applied 0058 repopulates), not a system of record.
--
-- Roles (claims_reader, cmd_rollup_writer) are shared/pre-existing and are NEVER dropped (0019
-- precedent: created only-if-absent, never DROP ROLE).

drop table if exists collections.cmd_charge_census;
drop table if exists collections.cmd_census_run;
