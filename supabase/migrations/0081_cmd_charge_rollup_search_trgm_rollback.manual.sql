-- 0081 manual rollback: execute each statement separately in autocommit mode.
-- Never submit this file as one transaction or through apply_migration.

drop index concurrently if exists collections.cmd_charge_rollup_facility_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_payer_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_cpt_trgm;

drop index concurrently if exists collections.cmd_charge_rollup_revenue_trgm;
