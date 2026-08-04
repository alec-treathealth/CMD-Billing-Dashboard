-- 0081 manual apply: execute each statement separately in autocommit mode.
-- Never submit this file as one transaction or through apply_migration.

create index concurrently if not exists cmd_charge_rollup_facility_trgm
  on collections.cmd_explorer_charge_rollup using gin (facility claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_payer_trgm
  on collections.cmd_explorer_charge_rollup using gin (primary_payer claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_cpt_trgm
  on collections.cmd_explorer_charge_rollup using gin (cpt_code claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_revenue_trgm
  on collections.cmd_explorer_charge_rollup using gin (revenue_code claims.gin_trgm_ops);

analyze collections.cmd_explorer_charge_rollup;
