-- Rollback 0052 — drop claims.audit_row.facility_code + its index.
-- (The backfilled values live only in this column, so dropping it fully reverts 0052.)
set role claims_admin;

drop index if exists claims.audit_row_facility_scope_idx;

alter table claims.audit_row
  drop column if exists facility_code;

reset role;
