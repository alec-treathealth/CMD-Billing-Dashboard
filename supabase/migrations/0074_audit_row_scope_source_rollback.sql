-- 0074 ROLLBACK: drop audit_row.scope_source (+ its CHECK, dropped with the column).
--
-- ⚠ ORDERING: roll the ingest code back first (or disable the consolidated cron) —
-- post-0074 ingest writes scope_source on every consolidated upsert and would fail
-- 42703 once the column is gone. Data loss is provenance-only ('tob'/'roster_fallback'
-- stamps); recoverable by re-apply + the nightly YTD refetch.

set role claims_admin;
alter table claims.audit_row drop column if exists scope_source;
reset role;
